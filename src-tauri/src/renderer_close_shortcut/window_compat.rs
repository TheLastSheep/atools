//! Match the project's default WebviewWindow and multiwebview native Window roles.
use tauri::{AppHandle, Manager, Window};
pub(super) fn main(app: &AppHandle) -> Option<Window> {
    crate::window::main_window(app).ok()
}
#[cfg(feature = "ztools-multiwebview")]
pub(super) fn focused(app: &AppHandle) -> Option<Window> {
    app.get_focused_window()
}
#[cfg(not(feature = "ztools-multiwebview"))]
pub(super) fn focused(app: &AppHandle) -> Option<Window> {
    app.webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .map(|window| window.as_ref().window())
}
