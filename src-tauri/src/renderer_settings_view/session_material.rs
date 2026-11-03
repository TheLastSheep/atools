use tauri::{AppHandle, Wry};

use super::session::SettingsViewRuntime;

pub(crate) async fn acquire_for_session(
    app: &AppHandle<Wry>,
    runtime: &SettingsViewRuntime,
    session_id: &str,
) -> Result<(), String> {
    let lease = crate::renderer_window_material::acquire_settings(app)
        .await
        .map_err(|error| format!("Settings window material could not be acquired: {error}"))?;
    match runtime.install_material_lease(session_id, lease) {
        Ok(()) => Ok(()),
        Err(lease) => {
            let retry = runtime.remember_rejected_material_release(session_id, &lease);
            drop(lease);
            let Some(retry) = retry else {
                return Err(
                    "Settings session changed before its window material lease was installed"
                        .into(),
                );
            };
            match retry.release().await {
                Ok(()) => {
                    runtime.finish_material_release(session_id, true)?;
                    Err(
                        "Settings session changed before its window material lease was installed"
                            .into(),
                    )
                }
                Err(error) => {
                    let _ = runtime.finish_material_release(session_id, false);
                    Err(format!(
                        "Settings lease installation failed and release was not confirmed: {error}"
                    ))
                }
            }
        }
    }
}

pub(crate) async fn release_for_close(
    runtime: &SettingsViewRuntime,
    session_id: &str,
) -> Result<(), String> {
    loop {
        let Some(retry) = runtime.begin_material_release(session_id)? else {
            return Ok(());
        };
        match retry.release().await {
            Ok(()) => runtime.finish_material_release(session_id, true)?,
            Err(error) => {
                let _ = runtime.finish_material_release(session_id, false);
                return Err(format!(
                    "Settings window material release was not confirmed: {error}"
                ));
            }
        }
    }
}
