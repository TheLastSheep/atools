use std::{collections::BTreeMap, sync::Arc};

use atools_core::{db::validate_renderer_general_settings_patch, Database};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::sync::Mutex;
use uuid::Uuid;

#[path = "preferences_projection.rs"]
mod projection;
pub(crate) use self::projection::project_general_settings;

struct OpeningSnapshot {
    raw: Option<String>,
    revision: String,
    value: Value,
}

pub(crate) struct SettingsPreferences {
    db: Arc<Database>,
    opening: Mutex<OpeningSnapshot>,
}

impl SettingsPreferences {
    #[cfg(test)]
    pub(super) fn height_test_preferences(raw: Option<String>) -> Self {
        Self {
            db: Arc::new(Database::in_memory().unwrap()),
            opening: Mutex::new(OpeningSnapshot {
                value: project_general_settings(raw.as_deref(), "").unwrap(),
                raw,
                revision: new_revision(),
            }),
        }
    }

    pub(crate) async fn load(app: &AppHandle, db: Arc<Database>) -> Result<Self, String> {
        let raw = crate::general_settings_runtime::commands::read_general_settings(
            app.clone(),
            Arc::clone(&db),
        )
        .await?;
        let shortcut = current_hotkey_display(app)?;
        let value = project_general_settings(raw.as_deref(), &shortcut)?;
        Ok(Self {
            db,
            opening: Mutex::new(OpeningSnapshot {
                raw,
                revision: new_revision(),
                value,
            }),
        })
    }

    pub(crate) async fn default_content_height(&self) -> Result<f64, String> {
        super::height::raw_default(self.opening.lock().await.raw.as_deref())
    }

    pub(crate) async fn snapshot(&self) -> Value {
        let opening = self.opening.lock().await;
        json!({
            "revision": opening.revision,
            "value": opening.value,
        })
    }

    pub(crate) async fn patch(
        &self,
        app: AppHandle,
        revision: String,
        changes: BTreeMap<String, Value>,
    ) -> Result<Value, String> {
        validate_patch(&changes)?;
        if let Some(height) = changes.get("windowDefaultHeight").and_then(Value::as_f64) {
            crate::window::validate_settings_content(&app, height)?;
        }
        let mut opening = self.opening.lock().await;
        if !revision_matches(&revision, &opening.revision) {
            return Err("SETTINGS_REVISION_CONFLICT".into());
        }

        let auto_only = changes.contains_key("autoCheckUpdate");
        let next_revision = new_revision();
        let expected = opening.raw.clone();
        let receipt = crate::general_settings_runtime::commands::run_renderer_patch(
            app.clone(),
            Arc::clone(&self.db),
            expected,
            changes,
        )
        .await
        .map_err(map_patch_error)?;

        auto_receipt::complete(&mut opening, next_revision, receipt, auto_only, || {
            current_hotkey_display(&app)
        })
    }
}

fn new_revision() -> String {
    Uuid::new_v4().simple().to_string()
}

pub(super) fn current_hotkey_display(app: &AppHandle) -> Result<String, String> {
    let state = crate::hotkey::read_owned_main_hotkey_state(app)?;
    let configured_fallback = if state.label().is_some() || state.startup_attempted() {
        String::new()
    } else {
        crate::hotkey::configured_hotkey(app)
    };
    projection::displayed_hotkey(&state, &configured_fallback)
}

fn revision_matches(supplied: &str, expected: &str) -> bool {
    supplied.len() == 32
        && supplied.bytes().all(|byte| byte.is_ascii_hexdigit())
        && supplied == expected
}

fn map_patch_error(error: String) -> String {
    if error == "Config error: General settings changed; reload before applying the patch" {
        "SETTINGS_REVISION_CONFLICT".into()
    } else if matches!(
        error.as_str(),
        "SETTINGS_OPACITY_RECOVERY_FAILED"
            | "SETTINGS_NATIVE_RECOVERY_FAILED"
            | "SETTINGS_HOTKEY_REJECTED"
            | "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED"
            | "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED"
            | "SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED"
            | "SETTINGS_CLOSE_SHORTCUT_REJECTED"
    ) {
        error
    } else {
        "GENERAL_SETTINGS_PATCH_FAILED".into()
    }
}

fn validate_patch(changes: &BTreeMap<String, Value>) -> Result<(), String> {
    if let Some(value) = changes.get("builtinAppShortcutsEnabled") {
        if changes.len() != 1 || value.as_object().is_none_or(|fields| fields.len() != 1) {
            return Err("Builtin shortcut settings require a single supported boolean".into());
        }
    }
    validate_renderer_general_settings_patch(changes).map_err(|error| error.to_string())
}

#[cfg(test)]
#[path = "preferences_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "preferences_builtin_shortcuts_tests.rs"]
mod builtin_shortcuts_tests;

#[cfg(test)]
mod double_modifier_errors {
    #[test]
    fn preflight_codes_survive_patch_error_sanitization() {
        for code in [
            "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED",
            "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED",
        ] {
            assert_eq!(super::map_patch_error(code.into()), code);
        }
    }
}

#[cfg(test)]
mod close_shortcut_contract {
    use super::*;
    use serde_json::json;
    #[test]
    fn child_is_single_key_while_core_retains_full_general_map_compatibility() {
        let one = BTreeMap::from([(
            "builtinAppShortcutsEnabled".into(),
            json!({"closePlugin":false}),
        )]);
        assert!(validate_patch(&one).is_ok());
        let multiple = BTreeMap::from([(
            "builtinAppShortcutsEnabled".into(),
            json!({"search":false,"closePlugin":true}),
        )]);
        assert!(validate_renderer_general_settings_patch(&multiple).is_ok());
        assert!(validate_patch(&multiple).is_err());
        let mut mixed = one;
        mixed.insert("theme".into(), json!("light"));
        assert!(validate_patch(&mixed).is_err());
    }
    #[test]
    fn close_errors_survive_the_same_patch_sanitizer() {
        for code in [
            "SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED",
            "SETTINGS_CLOSE_SHORTCUT_REJECTED",
        ] {
            assert_eq!(map_patch_error(code.into()), code);
        }
    }
}

#[path = "preferences_auto_receipt.rs"]
mod auto_receipt;
