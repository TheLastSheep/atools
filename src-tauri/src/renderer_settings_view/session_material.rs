use super::session::SettingsViewRuntime;

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
