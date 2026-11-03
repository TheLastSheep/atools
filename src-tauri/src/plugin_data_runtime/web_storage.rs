//! Private request protocol and bounded adapters for Web Storage.

use super::{
    types::Session,
    web_storage_events::{EventBody, EventTarget, WebStorageEvents},
    Sessions,
};
use atools_core::{
    db::{
        PluginWebStorageChange, PluginWebStorageError, PLUGIN_WEB_STORAGE_MAX_KEY_BYTES,
        PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES,
    },
    Database,
};
use base64::Engine;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};
use tauri::{AppHandle, Manager};

const MAX_SOURCE_URL_BYTES: usize = 8192;
const MAX_CLIENT_ID_HEX: usize = 32;

pub(super) struct ExecutionContext {
    pub app: AppHandle,
    pub runtime: Arc<Sessions>,
    pub session: Arc<Session>,
    pub invocation_id: String,
}

pub(super) fn execute(
    db: &Database,
    plugin_id: &str,
    method: &str,
    args: &[Value],
    context: Option<&ExecutionContext>,
) -> Result<Value, String> {
    if !matches!(
        method,
        "webStorage.getItem"
            | "webStorage.setItem"
            | "webStorage.removeItem"
            | "webStorage.clear"
            | "webStorage.key"
            | "webStorage.length"
            | "webStorage.keys"
            | "webStorage.entries"
            | "webStorage.event"
    ) {
        return Err("Unsupported Web Storage method".into());
    }
    let expected = match method {
        "webStorage.getItem" | "webStorage.removeItem" | "webStorage.key" | "webStorage.event" => 3,
        "webStorage.setItem" => 4,
        "webStorage.entries" => 3,
        _ => 2,
    };
    if args.len() != expected {
        return Ok(invalid_state());
    }
    let Some(client_id) = args
        .first()
        .and_then(Value::as_str)
        .filter(|value| is_hex_id(value))
    else {
        return Ok(invalid_state());
    };
    let Some(source_url) = args.get(1).and_then(Value::as_str) else {
        return Ok(invalid_state());
    };
    if source_url.len() > MAX_SOURCE_URL_BYTES {
        return Ok(invalid_state());
    }
    let client_id = client_id.to_ascii_lowercase();

    let result = match method {
        "webStorage.getItem" => {
            let key = match decode_units_arg(&args[2], PLUGIN_WEB_STORAGE_MAX_KEY_BYTES) {
                Ok(key) => key,
                Err(error) => return Ok(error),
            };
            db.plugin_web_storage_get(plugin_id, &key)
                .map(|value| {
                    value
                        .map(|value| encode_units(&value))
                        .map(Value::String)
                        .unwrap_or(Value::Null)
                })
                .map_err(storage_error)
        }
        "webStorage.setItem" => {
            let key = match decode_units_arg(&args[2], PLUGIN_WEB_STORAGE_MAX_KEY_BYTES) {
                Ok(key) => key,
                Err(error) => return Ok(error),
            };
            let value = match decode_units_arg(&args[3], PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES) {
                Ok(value) => value,
                Err(error) => return Ok(error),
            };
            let targets = match capture_targets(context, db, plugin_id) {
                Ok(targets) => targets,
                Err(_) => Vec::new(),
            };
            db.plugin_web_storage_set(plugin_id, &key, &value)
                .map(|change| {
                    stage_change(
                        context,
                        plugin_id,
                        &client_id,
                        source_url,
                        change.clone(),
                        targets,
                    );
                    change_json(change)
                })
                .map_err(storage_error)
        }
        "webStorage.removeItem" => {
            let key = match decode_units_arg(&args[2], PLUGIN_WEB_STORAGE_MAX_KEY_BYTES) {
                Ok(key) => key,
                Err(error) => return Ok(error),
            };
            let targets = match capture_targets(context, db, plugin_id) {
                Ok(targets) => targets,
                Err(_) => Vec::new(),
            };
            db.plugin_web_storage_remove(plugin_id, &key)
                .map(|change| {
                    stage_change(
                        context,
                        plugin_id,
                        &client_id,
                        source_url,
                        change.clone(),
                        targets,
                    );
                    change_json(change)
                })
                .map_err(storage_error)
        }
        "webStorage.clear" => {
            let targets = match capture_targets(context, db, plugin_id) {
                Ok(targets) => targets,
                Err(_) => Vec::new(),
            };
            db.plugin_web_storage_clear(plugin_id)
                .map(|change| {
                    stage_change(
                        context,
                        plugin_id,
                        &client_id,
                        source_url,
                        change.clone(),
                        targets,
                    );
                    change_json(change)
                })
                .map_err(storage_error)
        }
        "webStorage.key" => {
            let Some(index) = args[2].as_u64().and_then(|value| u32::try_from(value).ok()) else {
                return Ok(invalid_state());
            };
            db.plugin_web_storage_key(plugin_id, index)
                .map(|key| {
                    key.map(|key| encode_units(&key))
                        .map(Value::String)
                        .unwrap_or(Value::Null)
                })
                .map_err(storage_error)
        }
        "webStorage.length" => db
            .plugin_web_storage_length(plugin_id)
            .map(|length| json!(length))
            .map_err(storage_error),
        "webStorage.keys" => db
            .plugin_web_storage_keys(plugin_id)
            .map(|keys| json!(keys.iter().map(|key| encode_units(key)).collect::<Vec<_>>()))
            .map_err(storage_error),
        "webStorage.entries" => {
            let Some(offset) = args[2].as_u64().and_then(|value| u32::try_from(value).ok()) else {
                return Ok(invalid_state());
            };
            db.plugin_web_storage_entries(plugin_id, offset)
                .map(|page| {
                    json!({
                        "entries": page.entries.iter().map(|entry| json!({
                            "key": encode_units(&entry.key),
                            "value": encode_units(&entry.value),
                        })).collect::<Vec<_>>(),
                        "nextOffset": page.next_offset,
                    })
                })
                .map_err(storage_error)
        }
        "webStorage.event" => {
            let Some(event_id) = args[2].as_str().filter(|value| is_hex_id(value)) else {
                return Ok(invalid_state());
            };
            let Some(context) = context else {
                return Ok(invalid_state());
            };
            let Some(events) = context.app.try_state::<Arc<WebStorageEvents>>() else {
                return Ok(Value::Null);
            };
            Ok(events
                .read(
                    plugin_id,
                    &event_id.to_ascii_lowercase(),
                    &context.session.id,
                    &client_id,
                )
                .map(|body| {
                    json!({
                        "clientId": body.client_id,
                        "url": body.url,
                        "key": body.key.as_deref().map(encode_units),
                        "oldValue": body.old_value.as_deref().map(encode_units),
                        "newValue": body.new_value.as_deref().map(encode_units),
                    })
                })
                .unwrap_or(Value::Null))
        }
        _ => unreachable!("Web Storage method was checked above"),
    };
    result.or_else(|error| Ok(error))
}

fn capture_targets(
    context: Option<&ExecutionContext>,
    db: &Database,
    plugin_id: &str,
) -> Result<Vec<EventTarget>, String> {
    let Some(context) = context else {
        return Ok(Vec::new());
    };
    let candidates = context
        .runtime
        .store
        .lock()
        .sessions
        .values()
        .filter(|session| session.owner.plugin == plugin_id)
        .cloned()
        .collect::<Vec<_>>();
    Ok(candidates
        .into_iter()
        .filter(|session| *session.active.lock() && super::validate_session(db, session).is_ok())
        .map(|session| target_from_session(&session))
        .collect())
}

fn stage_change(
    context: Option<&ExecutionContext>,
    plugin_id: &str,
    client_id: &str,
    source_url: &str,
    change: PluginWebStorageChange,
    targets: Vec<EventTarget>,
) {
    if !change.changed {
        return;
    }
    let Some(context) = context else {
        return;
    };
    let Some(events) = context.app.try_state::<Arc<WebStorageEvents>>() else {
        return;
    };
    let body = EventBody {
        client_id: client_id.into(),
        url: source_url.into(),
        key: change.key,
        old_value: change.old_value,
        new_value: change.new_value,
    };
    events.stage(
        &context.invocation_id,
        plugin_id,
        &context.session.id,
        body,
        targets,
    );
}

fn decode_units_arg(value: &Value, max_bytes: usize) -> Result<Vec<u16>, Value> {
    let Some(encoded) = value.as_str() else {
        return Err(invalid_state());
    };
    let max_encoded = ((max_bytes + 2) / 3) * 4;
    if encoded.len() > max_encoded {
        return Err(quota_error());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| invalid_state())?;
    if bytes.len() > max_bytes {
        return Err(quota_error());
    }
    if bytes.len() % 2 != 0 || base64::engine::general_purpose::STANDARD.encode(&bytes) != encoded {
        return Err(invalid_state());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

fn encode_units(units: &[u16]) -> String {
    let bytes = units
        .iter()
        .flat_map(|unit| unit.to_le_bytes())
        .collect::<Vec<_>>();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn change_json(change: PluginWebStorageChange) -> Value {
    json!({
        "key": change.key.as_deref().map(encode_units),
        "oldValue": change.old_value.as_deref().map(encode_units),
        "newValue": change.new_value.as_deref().map(encode_units),
        "changed": change.changed,
    })
}

fn storage_error(error: PluginWebStorageError) -> Value {
    match error {
        PluginWebStorageError::QuotaExceeded => quota_error(),
        PluginWebStorageError::InvalidInput | PluginWebStorageError::StorageUnavailable => {
            invalid_state()
        }
    }
}

fn quota_error() -> Value {
    json!({
        "error": true,
        "name": "QuotaExceededError",
        "message": "Web Storage quota exceeded",
    })
}

pub(super) fn invalid_state() -> Value {
    json!({
        "error": true,
        "name": "InvalidStateError",
        "message": "Web Storage operation is invalid or unavailable",
    })
}

fn is_hex_id(value: &str) -> bool {
    value.len() == MAX_CLIENT_ID_HEX && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn authorized_session_ids(
    context: &ExecutionContext,
    db: &Database,
    plugin_id: &str,
) -> HashSet<String> {
    context
        .runtime
        .store
        .lock()
        .sessions
        .values()
        .filter(|session| session.owner.plugin == plugin_id)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .filter(|session| *session.active.lock() && super::validate_session(db, session).is_ok())
        .map(|session| session.id.clone())
        .collect()
}

pub(super) fn target_from_session(session: &Session) -> EventTarget {
    EventTarget {
        session_id: session.id.clone(),
        window: session.owner.window.clone(),
        plugin_id: session.owner.plugin.clone(),
        instance_id: session.owner.instance.clone(),
    }
}
