use super::state;
use crate::plugin_file_drag::native::DragOutcome;
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, ProtocolObject},
    DefinedClass, MainThreadMarker, MainThreadOnly, Message,
};
use objc2_app_kit::{
    NSDragOperation, NSDraggingItem, NSDraggingSession, NSDraggingSource, NSPasteboardWriting,
    NSView, NSWorkspace,
};
use objc2_foundation::{NSArray, NSCopying, NSObject, NSObjectProtocol, NSString, NSURL};
use std::{
    ffi::CString,
    os::unix::ffi::OsStrExt,
    path::PathBuf,
    ptr::NonNull,
    sync::atomic::{AtomicU64, Ordering},
    sync::Arc,
};
use tauri::AppHandle;
use tokio::sync::oneshot;

static NEXT_DRAG_ID: AtomicU64 = AtomicU64::new(1);

pub(super) struct SourceIvars {
    id: u64,
    app: AppHandle,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = SourceIvars]
    pub(super) struct FileDragSource;

    // SAFETY: NSObjectProtocol has no additional requirements here; the class
    // inherits NSObject's implementation and is AppKit-main-thread confined.
    unsafe impl NSObjectProtocol for FileDragSource {}

    // SAFETY: The implementation obeys the AppKit protocol ABI and all
    // NSDraggingSource callbacks are restricted to the AppKit main thread.
    unsafe impl NSDraggingSource for FileDragSource {
        #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
        fn draggingSession_sourceOperationMaskForDraggingContext(
            &self,
            _session: &NSDraggingSession,
            _context: objc2_app_kit::NSDraggingContext,
        ) -> NSDragOperation {
            // File export is copy-only. Never offer Move/Delete to a destination.
            NSDragOperation::Copy
        }

        #[unsafe(method(draggingSession:endedAtPoint:operation:))]
        fn draggingSession_endedAtPoint_operation(
            &self,
            _session: &NSDraggingSession,
            _screen_point: objc2_foundation::NSPoint,
            operation: NSDragOperation,
        ) {
            // Keep a strong local owner through this Objective-C method. The
            // active record is moved to deferred_release and drained from a
            // later Tauri main-thread task, after this callback has returned.
            let _callback_owner = self.retain();
            let id = self.ivars().id;
            let app = self.ivars().app.clone();
            let outcome = drag_outcome(operation);
            complete(id, outcome);

            // The Wry 2.11.2 runtime queues this task through its event proxy;
            // it does not run inline on this callback stack.
            if let Err(error) = app.run_on_main_thread(move || release_deferred(id)) {
                tracing::warn!(%error, drag_id = id, "Unable to queue native drag cleanup; retaining until shutdown");
            }
        }
    }
);

impl FileDragSource {
    fn new(id: u64, app: AppHandle, mtm: MainThreadMarker) -> Retained<Self> {
        let allocated = mtm.alloc::<Self>().set_ivars(SourceIvars { id, app });
        // SAFETY: NSObject initialization follows allocation on the AppKit main thread.
        unsafe { msg_send![super(allocated), init] }
    }
}

pub(super) struct ActiveDrag {
    pub(super) window_number: isize,
    pub(super) _session: Retained<NSDraggingSession>,
    pub(super) _source: Retained<FileDragSource>,
    pub(super) completion: Option<oneshot::Sender<DragOutcome>>,
}

pub(super) fn begin(
    app: &AppHandle,
    view: &NSView,
    window_number: isize,
    paths: Vec<PathBuf>,
    completion: oneshot::Sender<DragOutcome>,
    cancelled: Arc<std::sync::atomic::AtomicBool>,
    mtm: MainThreadMarker,
) -> Result<(), String> {
    if completion.is_closed() {
        return Err("native file drag request no longer has a completion receiver".into());
    }
    if cancelled.load(Ordering::Acquire) {
        return Err("native file drag was cancelled before it started".into());
    }
    if state::with_state(|state| {
        state
            .active
            .values()
            .any(|drag| drag.window_number == window_number)
    })? {
        return Err("this native window already has an active file drag".into());
    }

    let items = make_drag_items(&paths, mtm)?;
    if cancelled.load(Ordering::Acquire) {
        return Err("native file drag was cancelled before it started".into());
    }
    if completion.is_closed() {
        return Err("native file drag request no longer has a completion receiver".into());
    }
    // Consume the genuine mouse-down only after file URLs and previews are
    // prepared, so a local setup error does not waste the one-shot gesture.
    let event = super::gesture::consume(window_number)?;

    let id = NEXT_DRAG_ID.fetch_add(1, Ordering::Relaxed);
    let source = FileDragSource::new(id, app.clone(), mtm);
    let source_protocol: &ProtocolObject<dyn NSDraggingSource> = ProtocolObject::from_ref(&*source);
    // SAFETY: The live WKWebView is on the main thread; the event is the
    // retained, matching left-mouse-down; items and source remain retained for
    // this call. The selector is nullable in AppKit despite the generated
    // binding's non-null return type, so preserve nil as an explicit failure.
    let session: Option<Retained<NSDraggingSession>> = unsafe {
        msg_send![view, beginDraggingSessionWithItems: &*items, event: &*event, source: source_protocol]
    };
    let Some(session) = session else {
        return Err("AppKit declined to create a native file drag session".into());
    };

    // AppKit begins the returned session on the next run-loop turn. Store both
    // strong owners before that callback can run, so the source delegate and
    // session remain live until the real ended callback.
    state::with_state(|state| {
        state.active.insert(
            id,
            ActiveDrag {
                window_number,
                _session: session,
                _source: source,
                completion: Some(completion),
            },
        );
    })?;
    Ok(())
}

fn make_drag_items(
    paths: &[PathBuf],
    mtm: MainThreadMarker,
) -> Result<Retained<NSArray<NSDraggingItem>>, String> {
    let mut urls = Vec::with_capacity(paths.len());
    for path in paths {
        let c_path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| "native drag path contains an invalid NUL byte".to_string())?;
        let path_pointer = NonNull::new(c_path.as_ptr() as *mut std::ffi::c_char)
            .ok_or_else(|| "native drag path is invalid".to_string())?;
        // SAFETY: CString guarantees a live, NUL-terminated filesystem path for
        // this call; the earlier validation guarantees an existing regular file.
        let url = unsafe {
            NSURL::fileURLWithFileSystemRepresentation_isDirectory_relativeToURL(
                path_pointer,
                false,
                None,
            )
        };
        urls.push(url);
    }

    let workspace = NSWorkspace::sharedWorkspace();
    let mut items = Vec::with_capacity(urls.len());
    for (path, url) in paths.iter().zip(urls.iter()) {
        let writer: &ProtocolObject<dyn NSPasteboardWriting> = ProtocolObject::from_ref(&**url);
        let item = NSDraggingItem::initWithPasteboardWriter(mtm.alloc::<NSDraggingItem>(), writer);
        let icon_path = NSString::from_str(&path.to_string_lossy());
        let icon = workspace.iconForFile(&icon_path);
        let icon = icon.copy();
        icon.setSize(objc2_foundation::NSSize::new(32.0, 32.0));
        let frame = objc2_foundation::NSRect::new(
            objc2_foundation::NSPoint::new(0.0, 0.0),
            objc2_foundation::NSSize::new(32.0, 32.0),
        );
        // SAFETY: `icon` is an AppKit NSImage, the documented contents type.
        let icon_object: &AnyObject = &icon;
        unsafe { item.setDraggingFrame_contents(frame, Some(icon_object)) };
        items.push(item);
    }
    Ok(NSArray::from_retained_slice(&items))
}

fn complete(id: u64, outcome: DragOutcome) {
    let completion = state::with_existing_state(|state| {
        let mut active = state.active.remove(&id)?;
        let completion = active.completion.take();
        state.deferred_release.insert(id, active);
        completion
    })
    .ok()
    .flatten()
    .flatten();
    if let Some(completion) = completion {
        let _ = completion.send(outcome);
    }
}

fn release_deferred(id: u64) {
    let completed = state::with_existing_state(|state| state.deferred_release.remove(&id))
        .ok()
        .flatten()
        .flatten();
    // Drop session and source on the main thread, outside the delegate callback.
    drop(completed);
    let _ = state::discard_if_idle();
}

pub(super) fn shutdown() {
    let deferred = state::with_existing_state(|state| {
        state
            .deferred_release
            .drain()
            .map(|(_, drag)| drag)
            .collect::<Vec<_>>()
    })
    .ok()
    .flatten()
    .unwrap_or_default();
    // Every deferred entry has already received the actual ended callback, so
    // releasing it here is outside that callback's stack and is safe.
    drop(deferred);
    let _ = state::discard_if_idle();
}

#[cfg(test)]
mod tests {
    use super::{drag_outcome, NSDragOperation};
    use crate::plugin_file_drag::native::DragOutcome;

    #[test]
    fn source_completion_only_reports_copy_as_dropped() {
        assert_eq!(drag_outcome(NSDragOperation::Copy), DragOutcome::Dropped);
        assert_eq!(drag_outcome(NSDragOperation::None), DragOutcome::Cancelled);
        assert_eq!(drag_outcome(NSDragOperation::Move), DragOutcome::Cancelled);
    }
}

fn drag_outcome(operation: NSDragOperation) -> DragOutcome {
    if operation.contains(NSDragOperation::Copy) {
        DragOutcome::Dropped
    } else {
        DragOutcome::Cancelled
    }
}
