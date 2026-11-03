use super::super::state::Harness;
use atools_core::Database;
use serde_json::{Map, Value};

const SETTINGS_KEY: &str = "settings-general";
const POLICY_KEY: &str = "autoBackToSearch";
const POLICIES: &[&str] = &["immediately", "30s", "1m", "3m", "5m", "10m", "never"];
const SAVE_FAILED: &str = "settings-input-auto-back-save-failed";
const BASELINE_INVALID: &str = "settings-input-auto-back-baseline-invalid";

pub(super) async fn read_settings(harness: &Harness) -> Result<Value, &'static str> {
    let db = harness.database();
    tauri::async_runtime::spawn_blocking(move || read_settings_from_db(&db))
        .await
        .map_err(|_| SAVE_FAILED)?
}

fn read_settings_from_db(db: &Database) -> Result<Value, &'static str> {
    let raw = db
        .get_setting(SETTINGS_KEY)
        .map_err(|_| SAVE_FAILED)?
        .ok_or(SAVE_FAILED)?;
    if raw.len() > 64 * 1024 {
        return Err(SAVE_FAILED);
    }
    let value: Value = serde_json::from_str(&raw).map_err(|_| SAVE_FAILED)?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(SAVE_FAILED)
    }
}

pub(super) fn read_policy(settings: &Value) -> Result<Option<String>, &'static str> {
    match settings.get(POLICY_KEY) {
        None => Ok(None),
        Some(Value::String(value)) if POLICIES.contains(&value.as_str()) => Ok(Some(value.clone())),
        _ => Err(BASELINE_INVALID),
    }
}

pub(super) fn required_policy<'a>(facts: &'a Value, key: &str) -> Option<&'a str> {
    facts[key].as_str().filter(|value| POLICIES.contains(value))
}

pub(super) fn optional_policy(facts: &Value, key: &str) -> Option<String> {
    required_policy(facts, key).map(str::to_owned)
}

pub(super) fn policy_value(settings: &Value) -> Value {
    match read_policy(settings) {
        Ok(Some(value)) => Value::String(value),
        Ok(None) | Err(_) => Value::Null,
    }
}

pub(super) fn fact_value(facts: &Value, key: &str) -> Value {
    facts
        .get(key)
        .filter(|value| value.is_string())
        .cloned()
        .unwrap_or(Value::Null)
}

pub(super) fn unrelated_preserved(before: &Value, after: &Value) -> bool {
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return false;
    };
    fn without_policy(value: &Map<String, Value>) -> Map<String, Value> {
        value
            .iter()
            .filter(|(key, _)| key.as_str() != POLICY_KEY)
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    }
    without_policy(before) == without_policy(after)
}
