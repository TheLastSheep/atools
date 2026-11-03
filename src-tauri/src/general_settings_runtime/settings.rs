use atools_core::db::DEFAULT_SHOW_TRAY_ICON;
use serde_json::{json, Map, Value};

use super::effects::{NativeSettingChange, NativeSettingField};

const DEFAULT_HOTKEY: &str = "Option+Z";

/// Creates native effects for changed settings without parsing an unchanged legacy hotkey.
pub(super) fn native_effect_changes(
    before_raw: Option<&str>,
    after_raw: &str,
    configured_hotkey: &str,
) -> Result<Vec<NativeSettingChange>, String> {
    let before = parse_settings(before_raw)?;
    let after = parse_settings(Some(after_raw))?;
    let mut changes = Vec::new();

    let previous_hotkey = before.get("hotkey");
    let next_hotkey = after.get("hotkey");
    if previous_hotkey != next_hotkey {
        let next = next_hotkey
            .and_then(Value::as_str)
            .ok_or_else(|| "General settings field `hotkey` must be a string".to_owned())?;
        // An unchanged malformed legacy value is not a hotkey edit. When a
        // valid value really changes, rollback uses the owned Native snapshot,
        // so the old JSON value does not need to be parsed as a shortcut.
        let previous = effective_hotkey(previous_hotkey);
        if previous != Some(next) {
            changes.push(NativeSettingChange {
                field: NativeSettingField::Hotkey,
                before: Value::String(configured_hotkey.to_owned()),
                after: Value::String(next.to_owned()),
            });
        }
    }

    push_bool_change(
        &mut changes,
        &before,
        &after,
        "showTrayIcon",
        NativeSettingField::TrayIconVisible,
    )?;
    push_bool_change(
        &mut changes,
        &before,
        &after,
        "launchAtLogin",
        NativeSettingField::LaunchAtLogin,
    )?;
    push_bool_change(
        &mut changes,
        &before,
        &after,
        "superPanelEnabled",
        NativeSettingField::SuperPanelVisible,
    )?;
    push_bool_change(
        &mut changes,
        &before,
        &after,
        "floatingBallEnabled",
        NativeSettingField::FloatingBallVisible,
    )?;

    let previous_shortcuts = array_setting(&before, "appShortcuts")?;
    let next_shortcuts = array_setting(&after, "appShortcuts")?;
    if previous_shortcuts != next_shortcuts {
        changes.push(NativeSettingChange {
            field: NativeSettingField::AppShortcuts,
            before: previous_shortcuts,
            after: next_shortcuts,
        });
    }

    Ok(changes)
}

fn parse_settings(raw: Option<&str>) -> Result<Map<String, Value>, String> {
    let Some(raw) = raw else {
        return Ok(Map::new());
    };
    serde_json::from_str::<Value>(raw)
        .map_err(|_| "General settings snapshot is invalid JSON".to_owned())?
        .as_object()
        .cloned()
        .ok_or_else(|| "General settings snapshot must be a JSON object".to_owned())
}

fn effective_hotkey(value: Option<&Value>) -> Option<&str> {
    match value {
        None => Some(DEFAULT_HOTKEY),
        Some(Value::String(value)) => Some(value),
        Some(_) => None,
    }
}

fn bool_setting(settings: &Map<String, Value>, key: &str) -> Result<bool, String> {
    match settings.get(key) {
        None if key == "showTrayIcon" => Ok(DEFAULT_SHOW_TRAY_ICON),
        None => Ok(false),
        Some(Value::Bool(value)) => Ok(*value),
        Some(_) => Err(format!("General settings field `{key}` must be a boolean")),
    }
}

fn array_setting(settings: &Map<String, Value>, key: &str) -> Result<Value, String> {
    match settings.get(key) {
        None => Ok(json!([])),
        Some(Value::Array(values)) => Ok(Value::Array(values.clone())),
        Some(_) => Err(format!("General settings field `{key}` must be an array")),
    }
}

fn push_bool_change(
    changes: &mut Vec<NativeSettingChange>,
    before: &Map<String, Value>,
    after: &Map<String, Value>,
    key: &str,
    field: NativeSettingField,
) -> Result<(), String> {
    let previous = bool_setting(before, key)?;
    let next = bool_setting(after, key)?;
    if previous != next {
        changes.push(NativeSettingChange {
            field,
            before: Value::Bool(previous),
            after: Value::Bool(next),
        });
    }
    Ok(())
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod tests;
