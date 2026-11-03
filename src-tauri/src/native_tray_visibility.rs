use tauri::{AppHandle, Manager};

/// Applies a renderer tray mutation and reads back this app's native tray state.
///
/// On macOS the result comes from this process's NSStatusItem on the main
/// thread. Other platforms deliberately return unsupported rather than
/// claiming that a successful setter proves visibility.
pub(crate) fn read_apply(app: &AppHandle, target: Option<bool>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        if let Some(target) = target {
            crate::tray::set_visible(app, target)?;
        }
        return read_visible(app);
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, target);
        Err("Tray visibility readback is unsupported on this platform".into())
    }
}

#[cfg(target_os = "macos")]
fn read_visible(app: &AppHandle) -> Result<bool, String> {
    let Some(tray) = app.tray_by_id(crate::tray::TRAY_ID) else {
        return Ok(false);
    };
    tray.with_inner_tray_icon(|inner| {
        inner
            .ns_status_item()
            .is_some_and(|status_item| status_item.isVisible())
    })
    .map_err(|_| "Native tray visibility could not be read".to_owned())
}
