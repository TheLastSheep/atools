//! Bounded child transport for immutable command and alias snapshots.

#[path = "command_aliases.rs"]
mod aliases;
#[path = "command_data_buffers.rs"]
mod buffers;
#[path = "command_settings.rs"]
mod settings;

pub(crate) use buffers::CommandDataBuffers;

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::OwnedSemaphorePermit;

use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    session::SessionView,
    validation::{
        ensure_still_active, exact_object, invalid_payload, require_empty_payload, string_field,
        BridgeError,
    },
};
use buffers::{DataKind, PageData, MAX_COMMAND_BYTES, MAX_PAGE_BYTES};

const MAX_OPERATION_PAYLOAD_BYTES: usize = 32 * 1024;
const MAX_REPLY_BYTES: usize = 64 * 1024;

pub(crate) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "readCommands"
            | "readCommandSettings"
            | "readAliases"
            | "readCommandDataPage"
            | "writeAliases"
            | "beginAliasWrite"
            | "appendAliasWrite"
            | "commitAliasWrite"
            | "abortAliasWrite"
    )
}

pub(crate) async fn handle(
    app: AppHandle<Wry>,
    session: SessionView,
    operation: String,
    payload: Value,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    check_operation_payload(&payload)?;
    let reply = if aliases::handles(&operation) {
        aliases::handle(
            app,
            session,
            operation,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await?
    } else {
        let result = match operation.as_str() {
            "readCommands" => read_commands(&app, &session, &payload).await,
            "readCommandSettings" => read_command_settings(&app, &session, &payload).await,
            "readCommandDataPage" => read_page(&app, &session, &payload),
            _ => Err(BridgeError::new(
                "SETTINGS_OPERATION_REJECTED",
                "Settings view operation is not allowed",
            )),
        };
        drop(operation_permit);
        drop(call_guard);
        result?
    };
    check_reply(&reply)?;
    Ok(reply)
}

async fn read_commands(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    require_empty_payload(payload)?;
    ensure_still_active(app, session)?;
    let _read_gate = session.command_data.commands_read_gate.lock().await;
    ensure_still_active(app, session)?;

    let token = match session.command_data.commands_token()? {
        Some(token) => token,
        None => {
            let capture_app = app.clone();
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                let state = capture_app
                    .try_state::<crate::state::AppState>()
                    .ok_or_else(|| "Application state is unavailable".to_owned())?;
                let bytes = crate::renderer_commands_catalog::capture(&capture_app, state.inner())?;
                if bytes.is_empty() || bytes.len() > MAX_COMMAND_BYTES {
                    return Err("Canonical command snapshot exceeds 8 MiB".to_owned());
                }
                std::str::from_utf8(&bytes)
                    .map_err(|_| "Canonical command snapshot is not UTF-8".to_owned())?;
                serde_json::from_slice::<Value>(&bytes)
                    .map_err(|_| "Canonical command snapshot is invalid JSON".to_owned())?;
                Ok::<_, String>(bytes)
            })
            .await
            .map_err(|_| command_catalog_failed())?
            .map_err(|_| command_catalog_failed())?;
            ensure_still_active(app, session)?;
            session.command_data.store_commands(bytes)?
        }
    };

    let page = session
        .command_data
        .first_page(DataKind::Commands, &token)?;
    ensure_still_active(app, session)?;
    encode_page(DataKind::Commands, page)
}

async fn read_command_settings(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    require_empty_payload(payload)?;
    ensure_still_active(app, session)?;
    let _read_gate = session.command_data.settings_read_gate.lock().await;
    ensure_still_active(app, session)?;

    let token = match session.command_data.command_settings_token()? {
        Some(token) => token,
        None => {
            let capture_app = app.clone();
            let bytes = tauri::async_runtime::spawn_blocking(move || {
                let state = capture_app
                    .try_state::<crate::state::AppState>()
                    .ok_or_else(|| "Application state is unavailable".to_owned())?;
                settings::capture(&state.inner().db)
            })
            .await
            .map_err(|_| command_settings_failed())?
            .map_err(|_| command_settings_failed())?;
            ensure_still_active(app, session)?;
            session.command_data.store_command_settings(bytes)?
        }
    };

    let page = session
        .command_data
        .first_page(DataKind::CommandSettings, &token)?;
    ensure_still_active(app, session)?;
    encode_page(DataKind::CommandSettings, page)
}

fn read_page(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    let object = exact_object(payload, &["kind", "token", "offset"])?;
    let kind = DataKind::parse(string_field(object, "kind")?)?;
    let token = string_field(object, "token")?;
    let offset = object
        .get("offset")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(invalid_payload)?;
    ensure_still_active(app, session)?;
    let page = session.command_data.next_page(kind, token, offset)?;
    ensure_still_active(app, session)?;
    encode_page(kind, page)
}

pub(super) fn encode_page(kind: DataKind, page: PageData) -> Result<Value, BridgeError> {
    if page.bytes.is_empty()
        || page.bytes.len() > MAX_PAGE_BYTES
        || page.next_offset <= page.offset
        || page.next_offset > page.total_bytes
    {
        return Err(invalid_payload());
    }
    let reply = json!({
        "version": 1,
        "kind": kind.as_str(),
        "token": page.token,
        "offset": page.offset,
        "nextOffset": page.next_offset,
        "totalBytes": page.total_bytes,
        "data": STANDARD.encode(page.bytes),
    });
    check_reply(&reply)?;
    Ok(reply)
}

pub(super) fn check_reply(reply: &Value) -> Result<(), BridgeError> {
    let bytes = serde_json::to_vec(reply).map_err(|_| invalid_payload())?;
    if bytes.len() > MAX_REPLY_BYTES {
        return Err(BridgeError::new(
            "SETTINGS_DATA_REPLY_TOO_LARGE",
            "Settings data response exceeds the 64 KiB limit",
        ));
    }
    Ok(())
}

fn check_operation_payload(payload: &Value) -> Result<(), BridgeError> {
    let bytes = serde_json::to_vec(payload).map_err(|_| invalid_payload())?;
    if bytes.len() > MAX_OPERATION_PAYLOAD_BYTES {
        return Err(BridgeError::new(
            "SETTINGS_CALL_TOO_LARGE",
            "Settings data request exceeds the 32 KiB limit",
        ));
    }
    Ok(())
}

fn command_catalog_failed() -> BridgeError {
    BridgeError::new(
        "SETTINGS_COMMANDS_READ_FAILED",
        "Canonical command snapshot could not be read",
    )
}

fn command_settings_failed() -> BridgeError {
    BridgeError::new(
        "SETTINGS_COMMAND_SETTINGS_READ_FAILED",
        "Command settings snapshot could not be read",
    )
}
