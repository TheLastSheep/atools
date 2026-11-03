use super::{native, probe, state::Harness};
use serde_json::json;
use tauri::{AppHandle, Wry};

pub(super) async fn record_updater_status(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let mapped = probe::main_updater(app, harness).await?;
    let native = native::native_updater_snapshot(app).await?;
    let startup_calls = mapped["startupCalls"].as_u64().unwrap_or(0);
    let verified_calls = mapped["verifiedCalls"].as_u64().unwrap_or(0);
    let idle = bool_field(&mapped, "idle");
    let unchecked = bool_field(&mapped, "unchecked");
    let has_update = bool_field(&mapped, "hasUpdate");
    let downloaded_absent = bool_field(&mapped, "hasDownloadedAbsent");
    let native_idle = native["operation"].as_str() == Some("idle");
    let native_unchecked = native["checked"].as_bool() == Some(false);
    let native_update_absent = native["update"].is_null();
    let native_error_absent = native["lastError"].is_null();
    harness.set_updater_status(json!({
        "startupCalls": startup_calls,
        "verifiedCalls": verified_calls,
        "idle": idle,
        "unchecked": unchecked,
        "hasUpdate": has_update,
        "hasDownloadedAbsent": downloaded_absent,
        "nativeIdle": native_idle,
        "nativeUnchecked": native_unchecked,
        "nativeUpdateAbsent": native_update_absent,
        "nativeErrorAbsent": native_error_absent,
    }));
    if startup_calls != 1 || verified_calls != 2 {
        return Err("settings-input-updater-startup-count-invalid");
    }
    if !idle
        || !unchecked
        || has_update
        || !downloaded_absent
        || !native_idle
        || !native_unchecked
        || !native_update_absent
        || !native_error_absent
    {
        return Err("settings-input-updater-native-snapshot-invalid");
    }
    Ok(())
}

fn bool_field(value: &serde_json::Value, key: &str) -> bool {
    value[key].as_bool() == Some(true)
}
