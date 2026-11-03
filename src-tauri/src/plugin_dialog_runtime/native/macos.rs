//! AppKit objects never leave the main thread. Only IDs and owned results cross it.
use super::{
    super::{
        observations::{note, Event},
        options::Options,
        registry::Access,
    },
    Cancellation, Lease, State,
};
use block2::RcBlock;
use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{NSModalResponseCancel, NSModalResponseOK, NSOpenPanel, NSSavePanel, NSWindow};
use objc2_foundation::{NSArray, NSString, NSURL};
use std::{cell::RefCell, collections::HashMap, path::Path, sync::Arc};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

type ResultSender = oneshot::Sender<Result<Vec<String>, String>>;
struct Entry {
    panel: Retained<NSSavePanel>,
    open: Option<Retained<NSOpenPanel>>,
    sender: ResultSender,
    access: Access,
    _lease: Lease,
}
thread_local! { static PANELS: RefCell<HashMap<String, Entry>> = RefCell::new(HashMap::new()); }

pub(super) fn begin(
    app: &AppHandle,
    window: &str,
    id: &str,
    access: Access,
    options: Options,
    cancellation: Cancellation,
    document: Option<crate::plugin_page_runtime::DocumentBinding>,
    state: Arc<State>,
) -> Result<oneshot::Receiver<Result<Vec<String>, String>>, String> {
    // Reserve before focus can leave the parent, so Rust blur-hide sees the modal.
    let lease = state.reserve(window)?;
    let (sender, receiver) = oneshot::channel();
    let app_for_main = app.clone();
    let window = window.to_string();
    let id = id.to_string();
    app.run_on_main_thread(move || {
        if cancellation.cancelled() || document.as_ref().is_some_and(|d| !d.is_active()) {
            let _ = sender.send(Err("Dialog session closed".into()));
            return;
        }
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = sender.send(Err("Native dialog requires the main thread".into()));
            return;
        };
        let Some(window) = app_for_main.get_webview_window(&window) else {
            let _ = sender.send(Err("Plugin window closed".into()));
            return;
        };
        let Ok(pointer) = window.ns_window() else {
            let _ = sender.send(Err("Native parent window unavailable".into()));
            return;
        };
        // SAFETY: Tauri supplied the current NSWindow; retain and use it only here.
        let Some(parent) = (unsafe { Retained::retain(pointer.cast::<NSWindow>()) }) else {
            let _ = sender.send(Err("Native parent window unavailable".into()));
            return;
        };
        let open = (access == Access::Open).then(|| NSOpenPanel::openPanel(mtm));
        let panel: Retained<NSSavePanel> = match &open {
            Some(open) => open.clone().into_super(),
            None => NSSavePanel::savePanel(mtm),
        };
        configure(&panel, open.as_deref(), &options);
        let callback_id = id.clone();
        let callback = RcBlock::new(move |response| finish(&callback_id, response));
        PANELS.with(|panels| {
            panels.borrow_mut().insert(
                id.clone(),
                Entry {
                    panel: panel.clone(),
                    open,
                    sender,
                    access,
                    _lease: lease,
                },
            )
        });
        note(Event::NativeBegin);
        panel.beginSheetModalForWindow_completionHandler(&parent, &callback);
    })
    .map_err(|_| "Unable to schedule native dialog".to_string())?;
    Ok(receiver)
}
fn configure(panel: &NSSavePanel, open: Option<&NSOpenPanel>, options: &Options) {
    if let Some(value) = &options.title {
        panel.setTitle(Some(&NSString::from_str(value)));
    }
    if let Some(value) = &options.message {
        panel.setMessage(Some(&NSString::from_str(value)));
    }
    if let Some(value) = &options.button_label {
        panel.setPrompt(Some(&NSString::from_str(value)));
    }
    if let Some(value) = &options.name_field_label {
        panel.setNameFieldLabel(Some(&NSString::from_str(value)));
    }
    if let Some(value) = options.shows_tag_field {
        panel.setShowsTagField(value);
    }
    panel.setShowsHiddenFiles(options.has("showHiddenFiles"));
    panel.setCanCreateDirectories(options.has("createDirectory"));
    panel.setTreatsFilePackagesAsDirectories(options.has("treatPackageAsDirectory"));
    let extensions = options.extensions();
    if !extensions.is_empty() {
        let strings: Vec<_> = extensions.iter().map(|s| NSString::from_str(s)).collect();
        #[allow(deprecated)]
        panel.setAllowedFileTypes(Some(&NSArray::from_retained_slice(&strings)));
        panel.setAllowsOtherFileTypes(false);
    }
    if let Some(path) = options.default_path.as_ref().filter(|s| !s.is_empty()) {
        let path = Path::new(path);
        // Explicit trailing slash means directory; existing-directory detection is
        // performed before reaching AppKit (see prepare_default_path).
        if path.is_absolute() && path.to_string_lossy().ends_with('/') {
            panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(
                &path.to_string_lossy(),
            ))));
        } else {
            if let Some(parent) = path.parent().filter(|p| p.is_absolute()) {
                panel.setDirectoryURL(Some(&NSURL::fileURLWithPath(&NSString::from_str(
                    &parent.to_string_lossy(),
                ))));
            }
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                panel.setNameFieldStringValue(&NSString::from_str(name));
            }
        }
    }
    if let Some(open) = open {
        open.setCanChooseFiles(options.has("openFile") || !options.has("openDirectory"));
        open.setCanChooseDirectories(options.has("openDirectory"));
        open.setAllowsMultipleSelection(options.has("multiSelections"));
        open.setResolvesAliases(!options.has("noResolveAliases"));
    }
}
fn finish(id: &str, response: isize) {
    note(Event::NativeFinish);
    let entry = PANELS.with(|panels| panels.borrow_mut().remove(id));
    let Some(entry) = entry else {
        return;
    };
    let mut paths = Vec::new();
    if response == NSModalResponseOK {
        if let Some(open) = &entry.open {
            for url in open.URLs().iter() {
                if let Some(path) = url.path() {
                    paths.push(path.to_string());
                }
            }
        } else if let Some(url) = entry.panel.URL() {
            if let Some(path) = url.path() {
                paths.push(path.to_string());
            }
        }
    }
    // AppKit's callback may precede the sheet disappearing. Explicitly order it out.
    entry.panel.orderOut(None);
    let result = if response == NSModalResponseCancel {
        Ok(vec![])
    } else if response != NSModalResponseOK || paths.is_empty() {
        Err("Native dialog did not return a selection".into())
    } else {
        super::super::options::validate_result(&paths, entry.access).map(|()| paths)
    };
    let _ = entry.sender.send(result);
}
fn cancel_main(id: &str) {
    // Remove under a short borrow, then cancel: AppKit may synchronously reenter finish.
    let entry = PANELS.with(|panels| panels.borrow_mut().remove(id));
    if let Some(entry) = entry {
        note(Event::CancelMain);
        unsafe {
            entry.panel.cancel(None);
            entry.panel.orderOut(None);
        }
        let _ = entry.sender.send(Err(
            "ERR_ATOOLS_DIALOG_CANCELLED: dialog session closed".into()
        ));
    }
}
pub(super) async fn cancel(app: &AppHandle, id: &str) -> Result<(), String> {
    if MainThreadMarker::new().is_some() {
        cancel_main(id);
        return Ok(());
    }
    let (sender, receiver) = oneshot::channel();
    let id = id.to_string();
    app.run_on_main_thread(move || {
        cancel_main(&id);
        let _ = sender.send(());
    })
    .map_err(|_| "Unable to cancel native dialog")?;
    receiver
        .await
        .map_err(|_| "Native cancellation acknowledgement interrupted".into())
}
pub(super) fn cancel_detached(app: &AppHandle, id: &str) {
    if MainThreadMarker::new().is_some() {
        cancel_main(id);
    } else {
        let id = id.to_string();
        let _ = app.run_on_main_thread(move || cancel_main(&id));
    }
}
pub(super) fn cancel_all(app: &AppHandle) {
    let close = || {
        let ids = PANELS.with(|p| p.borrow().keys().cloned().collect::<Vec<_>>());
        for id in ids {
            cancel_main(&id);
        }
    };
    if MainThreadMarker::new().is_some() {
        close();
    } else {
        let _ = app.run_on_main_thread(close);
    }
}
