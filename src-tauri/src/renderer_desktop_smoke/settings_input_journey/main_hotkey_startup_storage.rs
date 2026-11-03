use atools_core::Database;
use serde_json::{json, Value};
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{path::PathBuf, sync::Arc};

pub(super) const INITIAL_PLACEHOLDER: &str = "ATools R45 initial placeholder";
pub(super) const RECOVERY_PLACEHOLDER: &str = "ATools R45 recovery placeholder";

pub(super) fn prepare_general(
    profile: &super::super::profile::Profile,
    db: &Arc<Database>,
) -> Result<String, String> {
    if profile.main_hotkey_recovery_first {
        let raw = json!({
            "theme": "dark",
            "autoPaste": "off",
            "autoClear": "never",
            "opacity": 1.0,
            "placeholder": INITIAL_PLACEHOLDER,
            "hotkey": super::main_hotkey_startup_schema::INVALID_SENTINEL,
        })
        .to_string();
        db.set_setting("settings-general", &raw)
            .map_err(|_| "main-hotkey-recovery-settings-seed-failed".to_owned())?;
        return Ok(raw);
    }
    if profile.main_hotkey_recovery_second {
        let raw = db
            .get_setting("settings-general")
            .map_err(|_| "main-hotkey-recovery-settings-read-failed".to_owned())?
            .ok_or_else(|| "main-hotkey-recovery-settings-read-failed".to_owned())?;
        let value: Value = serde_json::from_str(&raw)
            .map_err(|_| "main-hotkey-recovery-settings-invalid".to_owned())?;
        if value.get("hotkey").and_then(Value::as_str)
            != Some(super::main_hotkey_startup_schema::HOTKEY_B)
        {
            return Err("main-hotkey-recovery-settings-invalid".to_owned());
        }
        return Ok(raw);
    }
    Err("main-hotkey-recovery-profile-invalid".to_owned())
}

pub(super) async fn read_general(
    profile: &super::super::profile::Profile,
) -> Result<Value, &'static str> {
    let path = profile.root.join("app-data/data.db");
    tauri::async_runtime::spawn_blocking(move || read_database_general(path))
        .await
        .map_err(|_| "settings-main-hotkey-recovery-state-invalid")?
}

fn read_database_general(path: PathBuf) -> Result<Value, &'static str> {
    let db = Database::open(&path).map_err(|_| "settings-main-hotkey-recovery-state-invalid")?;
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| "settings-main-hotkey-recovery-state-invalid")?
        .ok_or("settings-main-hotkey-recovery-state-invalid")?;
    if raw.len() > 64 * 1024 {
        return Err("settings-main-hotkey-recovery-state-invalid");
    }
    let value: Value =
        serde_json::from_str(&raw).map_err(|_| "settings-main-hotkey-recovery-state-invalid")?;
    if !value.is_object() {
        return Err("settings-main-hotkey-recovery-state-invalid");
    }
    Ok(value)
}

pub(super) fn database_identity(
    profile: &super::super::profile::Profile,
) -> (Option<String>, Option<String>) {
    #[cfg(unix)]
    {
        let metadata = std::fs::metadata(profile.root.join("app-data/data.db")).ok();
        (
            metadata.as_ref().map(|value| value.dev().to_string()),
            metadata.as_ref().map(|value| value.ino().to_string()),
        )
    }
    #[cfg(not(unix))]
    {
        let _ = profile;
        (None, None)
    }
}
