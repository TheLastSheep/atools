//! Fixed, bounded read model for the original settings command state.

use std::collections::BTreeMap;

use atools_core::db::Database;
use serde::Serialize;
use serde_json::Value;

use super::buffers::MAX_COMMAND_SETTINGS_BYTES;

pub(super) const COMMAND_SETTINGS_KEYS: [&str; 5] = [
    "ztools-renderer:disable-commands",
    "ztools-renderer:pinned-commands",
    "ztools-renderer:super-panel-pinned",
    "ztools-renderer:global-shortcuts",
    "ztools-renderer:app-shortcuts",
];

pub(super) const MAX_COMMAND_SETTINGS_RAW_KEY_BYTES: usize = 128 * 1024;
pub(super) const MAX_COMMAND_SETTINGS_RAW_TOTAL_BYTES: usize = 640 * 1024;
pub(super) const MAX_COMMAND_SETTINGS_ROWS: usize = 4096;
const MAX_COMMAND_ID_BYTES: usize = 16_448;

const CORE_READ_TOTAL_BYTES: usize = MAX_COMMAND_SETTINGS_RAW_TOTAL_BYTES
    + "ztools-renderer:disable-commands".len()
    + "ztools-renderer:pinned-commands".len()
    + "ztools-renderer:super-panel-pinned".len()
    + "ztools-renderer:global-shortcuts".len()
    + "ztools-renderer:app-shortcuts".len();

#[derive(Serialize)]
struct CommandSettingsDocument {
    #[serde(rename = "disable-commands")]
    disable_commands: Option<Value>,
    #[serde(rename = "pinned-commands")]
    pinned_commands: Option<Value>,
    #[serde(rename = "super-panel-pinned")]
    super_panel_pinned: Option<Value>,
    #[serde(rename = "global-shortcuts")]
    global_shortcuts: Option<Value>,
    #[serde(rename = "app-shortcuts")]
    app_shortcuts: Option<Value>,
}

/// Reads the exact five namespaced records in one bounded Core transaction.
/// Missing rows become JSON null; storage, parsing, and budget errors reject the
/// complete snapshot. No caller-provided key or namespace reaches Core.
pub(super) fn capture(db: &Database) -> Result<Vec<u8>, String> {
    let values = db
        .read_settings_bounded(
            &COMMAND_SETTINGS_KEYS,
            MAX_COMMAND_SETTINGS_RAW_KEY_BYTES,
            CORE_READ_TOTAL_BYTES,
        )
        .map_err(|_| "Renderer command settings could not be read".to_owned())?;
    snapshot_from_values(values)
}

fn snapshot_from_values(mut values: BTreeMap<String, Option<String>>) -> Result<Vec<u8>, String> {
    if values.len() != COMMAND_SETTINGS_KEYS.len()
        || values
            .keys()
            .any(|key| !COMMAND_SETTINGS_KEYS.contains(&key.as_str()))
        || COMMAND_SETTINGS_KEYS
            .iter()
            .any(|key| !values.contains_key(*key))
    {
        return Err("Renderer command settings key set is invalid".to_owned());
    }

    let mut raw_total_bytes = 0usize;
    let mut parsed = BTreeMap::new();
    for key in COMMAND_SETTINGS_KEYS {
        let raw = values
            .remove(key)
            .ok_or_else(|| "Renderer command settings key set is invalid".to_owned())?;
        let Some(raw) = raw else {
            parsed.insert(key, None);
            continue;
        };

        if raw.len() > MAX_COMMAND_SETTINGS_RAW_KEY_BYTES {
            return Err("Renderer command setting exceeds its byte limit".to_owned());
        }
        raw_total_bytes = raw_total_bytes
            .checked_add(raw.len())
            .ok_or_else(|| "Renderer command settings exceed their byte budget".to_owned())?;
        if raw_total_bytes > MAX_COMMAND_SETTINGS_RAW_TOTAL_BYTES {
            return Err("Renderer command settings exceed their byte budget".to_owned());
        }

        let value = serde_json::from_str::<Value>(&raw)
            .map_err(|_| "Renderer command setting JSON is invalid".to_owned())?;
        validate_setting_value(key, &value)?;
        parsed.insert(key, Some(value));
    }

    let document = CommandSettingsDocument {
        disable_commands: parsed.remove(COMMAND_SETTINGS_KEYS[0]).flatten(),
        pinned_commands: parsed.remove(COMMAND_SETTINGS_KEYS[1]).flatten(),
        super_panel_pinned: parsed.remove(COMMAND_SETTINGS_KEYS[2]).flatten(),
        global_shortcuts: parsed.remove(COMMAND_SETTINGS_KEYS[3]).flatten(),
        app_shortcuts: parsed.remove(COMMAND_SETTINGS_KEYS[4]).flatten(),
    };
    let bytes = serde_json::to_vec(&document)
        .map_err(|_| "Renderer command settings could not be encoded".to_owned())?;
    if bytes.is_empty() || bytes.len() > MAX_COMMAND_SETTINGS_BYTES {
        return Err("Renderer command settings snapshot exceeds 1 MiB".to_owned());
    }
    Ok(bytes)
}

fn validate_setting_value(key: &str, value: &Value) -> Result<(), String> {
    let rows = value
        .as_array()
        .ok_or_else(|| "Renderer command setting must be a JSON array".to_owned())?;
    if rows.len() > MAX_COMMAND_SETTINGS_ROWS {
        return Err("Renderer command setting has too many rows".to_owned());
    }

    if key == COMMAND_SETTINGS_KEYS[0] {
        for id in rows {
            let id = id
                .as_str()
                .ok_or_else(|| "Disabled command ID is invalid".to_owned())?;
            if id.is_empty() || id.len() > MAX_COMMAND_ID_BYTES {
                return Err("Disabled command ID exceeds its byte limit".to_owned());
            }
        }
        return Ok(());
    }

    for row in rows {
        if !row.is_object() {
            return Err("Renderer command setting row must be a JSON object".to_owned());
        }
    }

    if key == COMMAND_SETTINGS_KEYS[2] {
        validate_super_panel_expansion(rows)?;
    }
    Ok(())
}

/// Mirrors the original getter's one-level folder flattening for its row budget.
/// The document itself remains unchanged for the child adapter to return raw.
fn validate_super_panel_expansion(rows: &[Value]) -> Result<(), String> {
    let mut expanded_rows = 0usize;
    for row in rows {
        let folder_items = row
            .as_object()
            .filter(|object| object.get("isFolder").is_some_and(javascript_truthy))
            .and_then(|object| object.get("items"))
            .and_then(Value::as_array);
        if let Some(items) = folder_items {
            if items.iter().any(|item| !item.is_object()) {
                return Err("Super-panel folder contains an invalid row".to_owned());
            }
            expanded_rows = expanded_rows
                .checked_add(items.len())
                .ok_or_else(|| "Super-panel has too many rows".to_owned())?;
        } else {
            expanded_rows = expanded_rows
                .checked_add(1)
                .ok_or_else(|| "Super-panel has too many rows".to_owned())?;
        }
        if expanded_rows > MAX_COMMAND_SETTINGS_ROWS {
            return Err("Super-panel has too many expanded rows".to_owned());
        }
    }
    Ok(())
}

fn javascript_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => {
            if let Some(value) = value.as_i64() {
                value != 0
            } else if let Some(value) = value.as_u64() {
                value != 0
            } else if let Some(value) = value.as_f64() {
                value != 0.0
            } else {
                true
            }
        }
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[cfg(test)]
#[path = "command_settings_tests.rs"]
mod tests;
