//! Exact, bounded wire protocol for the settings-child local shortcut API.
use atools_core::db::{bounded_json_serialized_size, RendererLocalShortcutType};
use serde_json::{Map, Value};

use super::{
    local_shortcut_files,
    validation::{invalid_payload, BridgeError},
};

pub(super) const MAX_OPERATION_BYTES: usize = 32 * 1024;

#[derive(Debug)]
pub(super) enum Request {
    Read,
    Add(RendererLocalShortcutType),
    AddByPath(String),
    Delete(String),
    SetAlias { id: String, alias: String },
    Open(String),
    RemoveMissing,
}

pub(super) fn parse_request(operation: &str, payload: &Value) -> Result<Request, BridgeError> {
    check_payload_budget(payload)?;
    let root = payload.as_object().ok_or_else(invalid_payload)?;
    match operation {
        "readLocalShortcuts" | "deleteMissingLocalShortcuts" => {
            require_exact(root, &[])?;
            Ok(if operation == "readLocalShortcuts" {
                Request::Read
            } else {
                Request::RemoveMissing
            })
        }
        "addLocalShortcut" => {
            require_exact(root, &["type"])?;
            let kind = match root.get("type").and_then(Value::as_str) {
                Some("file") => RendererLocalShortcutType::File,
                Some("folder") => RendererLocalShortcutType::Folder,
                _ => return Err(invalid_payload()),
            };
            Ok(Request::Add(kind))
        }
        "addLocalShortcutByPath" | "openLocalShortcut" => {
            require_exact(root, &["path"])?;
            let path = path_field(root, "path")?.to_owned();
            if operation == "addLocalShortcutByPath" {
                Ok(Request::AddByPath(path))
            } else {
                Ok(Request::Open(path))
            }
        }
        "deleteLocalShortcut" => {
            require_exact(root, &["id"])?;
            Ok(Request::Delete(id_field(root, "id")?.to_owned()))
        }
        "updateLocalShortcutAlias" => {
            require_exact(root, &["id", "alias"])?;
            let id = id_field(root, "id")?.to_owned();
            let alias = root
                .get("alias")
                .and_then(Value::as_str)
                .filter(|value| value.len() <= 4 * 1024 && !value.contains('\0'))
                .ok_or_else(invalid_payload)?
                .to_owned();
            Ok(Request::SetAlias { id, alias })
        }
        _ => Err(invalid_payload()),
    }
}

pub(super) fn check_payload_budget(payload: &Value) -> Result<(), BridgeError> {
    if bounded_json_serialized_size(payload, MAX_OPERATION_BYTES).is_none() {
        return Err(BridgeError::new(
            "SETTINGS_CALL_TOO_LARGE",
            "Settings request exceeds the 32 KiB operation limit",
        ));
    }
    Ok(())
}

fn require_exact(root: &Map<String, Value>, fields: &[&str]) -> Result<(), BridgeError> {
    if root.len() != fields.len() || root.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(invalid_payload());
    }
    Ok(())
}

fn id_field<'a>(root: &'a Map<String, Value>, field: &str) -> Result<&'a str, BridgeError> {
    root.get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 256 && !value.contains('\0'))
        .ok_or_else(invalid_payload)
}

fn path_field<'a>(root: &'a Map<String, Value>, field: &str) -> Result<&'a str, BridgeError> {
    let value = root
        .get(field)
        .and_then(Value::as_str)
        .ok_or_else(invalid_payload)?;
    local_shortcut_files::validate_absolute_path(value).map_err(|_| invalid_payload())?;
    Ok(value)
}

#[cfg(test)]
#[path = "local_shortcut_protocol_tests.rs"]
mod tests;
