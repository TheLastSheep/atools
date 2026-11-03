use std::{path::PathBuf, sync::atomic::AtomicBool, sync::Arc};
use tauri::AppHandle;
use tokio::sync::oneshot;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DragOutcome {
    Dropped,
    /// The source only permits Copy. `None` is reported here whether the user
    /// cancelled or the destination declined the drag; AppKit does not tell us
    /// which of those happened.
    Cancelled,
}

pub(crate) struct StartedDrag {
    pub(crate) completion: oneshot::Receiver<DragOutcome>,
}

#[cfg(target_os = "macos")]
#[path = "native/macos.rs"]
mod platform;

pub(crate) fn supported() -> bool {
    // Deferred pending native acceptance and the cancellation/start race fix.
    // Default builds must not advertise or authorize the unfinished capability.
    cfg!(all(target_os = "macos", feature = "experimental-file-drag"))
}

#[cfg(target_os = "macos")]
pub(crate) async fn prepare(app: &AppHandle) -> Result<(), String> {
    platform::prepare(app).await
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn prepare(_app: &AppHandle) -> Result<(), String> {
    // This is a harmless no-op for startup. `supported()` remains false and
    // `begin` fails explicitly on platforms without AppKit file dragging.
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) async fn begin(
    app: &AppHandle,
    window: &str,
    paths: Vec<PathBuf>,
    cancelled: Arc<AtomicBool>,
) -> Result<StartedDrag, String> {
    platform::begin(app, window, paths, cancelled).await
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn begin(
    _app: &AppHandle,
    _window: &str,
    _paths: Vec<PathBuf>,
    _cancelled: Arc<AtomicBool>,
) -> Result<StartedDrag, String> {
    Err("native file dragging is unsupported on this platform".into())
}

#[cfg(target_os = "macos")]
pub(crate) async fn close_window(app: &AppHandle, label: &str) -> Result<(), String> {
    platform::close_window(app, label).await
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn close_window(_app: &AppHandle, _label: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "macos")]
pub(crate) async fn shutdown(app: &AppHandle) -> Result<(), String> {
    platform::shutdown(app).await
}

#[cfg(not(target_os = "macos"))]
pub(crate) async fn shutdown(_app: &AppHandle) -> Result<(), String> {
    Ok(())
}
