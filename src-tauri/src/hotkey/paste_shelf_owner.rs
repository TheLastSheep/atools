//! Exact registration attempt retained for safe shutdown after the dispatch gate closes.
use parking_lot::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

#[derive(Default)]
pub(super) struct Runtime { pub(super) shortcut: Mutex<Option<String>> }

pub(super) fn shutdown(app: &AppHandle) -> Result<(), String> {
    let Some(state) = app.try_state::<Runtime>() else { return Ok(()); };
    let shortcut = state.shortcut.lock().clone();
    if let Some(shortcut) = shortcut {
        app.global_shortcut().unregister(shortcut.as_str()).map_err(|_| "Paste shelf unregister failed")?;
        if app.global_shortcut().is_registered(shortcut.as_str()) { return Err("Paste shelf unregister readback failed".into()); }
        *state.shortcut.lock() = None;
    }
    Ok(())
}
