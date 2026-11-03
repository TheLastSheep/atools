#[path = "macos/gesture.rs"]
mod gesture;
#[path = "macos/session.rs"]
mod session;
#[path = "macos/state.rs"]
mod state;

use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_app_kit::NSWindow;
use std::{
    os::unix::ffi::OsStrExt,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use super::StartedDrag;

const MAX_DRAG_FILES: usize = 16;
const MAX_DRAG_PATH_BYTES: usize = 8 * 1024;
const MAX_DRAG_TOTAL_PATH_BYTES: usize = 64 * 1024;

pub(super) async fn prepare(app: &AppHandle) -> Result<(), String> {
    on_main(app, gesture::install).await
}

pub(super) async fn begin(
    app: &AppHandle,
    window_label: &str,
    paths: Vec<PathBuf>,
    cancelled: Arc<AtomicBool>,
) -> Result<StartedDrag, String> {
    if cancelled.load(Ordering::Acquire) {
        return Err("native file drag was cancelled before it started".into());
    }
    let paths = validate_paths(paths)?;
    let window = app
        .get_webview_window(window_label)
        .ok_or_else(|| format!("plugin window is unavailable: {window_label}"))?;
    let app_for_callback = app.clone();
    let cancelled_for_callback = cancelled.clone();
    let (completion_sender, completion) = oneshot::channel();
    let (ack_sender, ack_receiver) = oneshot::channel();

    window
        .with_webview(move |platform| {
            let result = begin_on_webview(
                &app_for_callback,
                platform.inner(),
                paths,
                cancelled_for_callback,
                completion_sender,
            );
            let _ = ack_sender.send(result);
        })
        .map_err(|error| format!("unable to schedule native file drag: {error}"))?;

    ack_receiver
        .await
        .map_err(|_| "native file drag start acknowledgement was interrupted".to_string())??;
    Ok(StartedDrag { completion })
}

pub(super) async fn close_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let app_for_task = app.clone();
    let label = label.to_string();
    on_main(app, move || {
        let window = app_for_task
            .get_webview_window(&label)
            .ok_or_else(|| format!("plugin window is unavailable: {label}"))?;
        let pointer = window
            .ns_window()
            .map_err(|error| format!("unable to inspect closing plugin window: {error}"))?;
        if pointer.is_null() {
            return Err("plugin native window handle is unavailable".into());
        }
        // SAFETY: Tauri returns this window's live NSWindow handle; retain it
        // and read its identity only on the main thread before the window closes.
        let native_window = unsafe { Retained::retain(pointer.cast::<NSWindow>()) }
            .ok_or_else(|| "plugin native window handle is unavailable".to_string())?;
        gesture::clear_for_window(native_window.windowNumber());
        // Any active drag still owns its session/source in the registry until
        // AppKit sends ended; there is no supported forced-cancel operation.
        Ok(())
    })
    .await
}

pub(super) async fn shutdown(app: &AppHandle) -> Result<(), String> {
    on_main(app, || {
        gesture::uninstall();
        session::shutdown();
        Ok(())
    })
    .await
}

async fn on_main<T: Send + 'static>(
    app: &AppHandle,
    task: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if MainThreadMarker::new().is_some() {
        return task();
    }

    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(task());
    })
    .map_err(|error| format!("unable to schedule native drag task: {error}"))?;
    receiver
        .await
        .map_err(|_| "native drag task acknowledgement was interrupted".to_string())?
}

fn begin_on_webview(
    app: &AppHandle,
    webview_pointer: *mut std::ffi::c_void,
    paths: Vec<PathBuf>,
    cancelled: Arc<AtomicBool>,
    completion: oneshot::Sender<super::DragOutcome>,
) -> Result<(), String> {
    let mtm = MainThreadMarker::new().ok_or("native file drag requires the main thread")?;
    if cancelled.load(Ordering::Acquire) {
        return Err("native file drag was cancelled before it started".into());
    }
    if webview_pointer.is_null() {
        return Err("plugin WebView native handle is unavailable".into());
    }

    // SAFETY: Tauri supplies the live WKWebView for this callback, which runs
    // on its UI thread. WKWebView is an NSView subclass and the pointer remains
    // valid for the callback's duration.
    let view = unsafe { &*webview_pointer.cast::<objc2_app_kit::NSView>() };
    let native_window = view
        .window()
        .ok_or("plugin WebView is not attached to a native window")?;
    let window_number = native_window.windowNumber();

    if cancelled.load(Ordering::Acquire) {
        return Err("native file drag was cancelled before it started".into());
    }
    session::begin(app, view, window_number, paths, completion, cancelled, mtm)
}

fn validate_paths(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() {
        return Err("native file drag requires at least one file".into());
    }
    if paths.len() > MAX_DRAG_FILES {
        return Err(format!(
            "native file drag accepts at most {MAX_DRAG_FILES} files"
        ));
    }
    let mut total_path_bytes = 0_usize;
    for path in &paths {
        if !path.is_absolute() {
            return Err("native file drag paths must be absolute".into());
        }
        let path_bytes = path.as_os_str().as_bytes().len();
        if path_bytes > MAX_DRAG_PATH_BYTES {
            return Err(format!(
                "native drag path exceeds {MAX_DRAG_PATH_BYTES} bytes"
            ));
        }
        total_path_bytes = total_path_bytes
            .checked_add(path_bytes)
            .ok_or_else(|| "native drag path byte count overflowed".to_string())?;
        if total_path_bytes > MAX_DRAG_TOTAL_PATH_BYTES {
            return Err(format!(
                "native drag paths exceed {MAX_DRAG_TOTAL_PATH_BYTES} total bytes"
            ));
        }
    }

    // Enforce aggregate bounds before touching the filesystem or asking AppKit
    // for icons. Canonicalization follows symlinks so aliases to one file are
    // rejected rather than silently emitted as duplicate drag items.
    let mut validated = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical = path
            .canonicalize()
            .map_err(|error| format!("native file drag path unavailable ({:?})", error.kind()))?;
        let metadata = canonical
            .metadata()
            .map_err(|error| format!("unable to inspect native drag file ({:?})", error.kind()))?;
        if !metadata.is_file() {
            return Err("native file drag accepts regular files only".into());
        }
        if validated.contains(&canonical) {
            return Err("native file drag contains a duplicate file".into());
        }
        validated.push(canonical);
    }
    if validated.is_empty() {
        return Err("native file drag requires at least one unique file".into());
    }
    Ok(validated)
}

#[cfg(test)]
mod tests {
    use super::{validate_paths, MAX_DRAG_FILES, MAX_DRAG_PATH_BYTES, MAX_DRAG_TOTAL_PATH_BYTES};
    use std::path::PathBuf;

    #[test]
    fn rejects_duplicate_files_and_bounds_path_count_and_size_without_echoing_paths() {
        let file = tempfile::NamedTempFile::new().expect("temporary regular file");
        let path = file.path().to_path_buf();
        let duplicate_error = validate_paths(vec![path.clone(), path.clone()]).unwrap_err();
        assert!(duplicate_error.contains("duplicate"));
        assert!(!duplicate_error.contains(&path.to_string_lossy().to_string()));

        let too_many = vec![path.clone(); MAX_DRAG_FILES + 1];
        assert!(validate_paths(too_many).unwrap_err().contains("at most"));

        let oversized_path = PathBuf::from(format!("/{}", "x".repeat(MAX_DRAG_PATH_BYTES)));
        assert!(validate_paths(vec![oversized_path])
            .unwrap_err()
            .contains("exceeds"));

        let per_path = PathBuf::from(format!("/{}", "y".repeat(MAX_DRAG_PATH_BYTES - 1)));
        let total_overflow = vec![per_path; MAX_DRAG_TOTAL_PATH_BYTES / MAX_DRAG_PATH_BYTES + 1];
        assert!(validate_paths(total_overflow)
            .unwrap_err()
            .contains("total bytes"));
    }
}
