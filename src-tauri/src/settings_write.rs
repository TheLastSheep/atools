//! Persist non-General setting keys; General settings require the shared CAS coordinator.
use atools_core::Database;

#[tauri::command(rename = "set_setting")]
pub async fn set_setting_ai(
    state: tauri::State<'_, crate::state::AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    if key == "settings-general" {
        return Err(
            "General settings must be written with save_general_settings and an expected snapshot"
                .into(),
        );
    }
    set(&state.db, &key, &value)
}

pub(crate) fn set(db: &Database, key: &str, value: &str) -> Result<(), String> {
    if key == "settings-general" {
        return Err(
            "General settings must be written with save_general_settings and an expected snapshot"
                .into(),
        );
    }
    db.set_setting(key, value).map_err(|e| e.to_string())?;
    Ok(())
}
