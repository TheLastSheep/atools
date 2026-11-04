//! Alias snapshot capture, staged transfer, and detached CAS commit.

use std::sync::Arc;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

use atools_core::db::RendererCommandAliasesWrite;

use super::super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    phase::SessionPhase,
    session::SessionView,
    validation::{
        ensure_still_active, exact_object, inactive_session, invalid_payload,
        require_empty_payload, string_field, BridgeError,
    },
};
use super::{
    buffers::{
        CommandDataBuffers, DataKind, MAX_ALIAS_BYTES, MAX_ALIAS_RAW_BYTES, MAX_STAGED_BYTES,
    },
    check_reply, encode_page,
};

const ALIAS_CAS_CONFLICT: &str = "Renderer command aliases changed since the supplied snapshot";
const MAX_WRITE_CHUNK_BASE64_BYTES: usize = ((16 * 1024 + 2) / 3) * 4;

#[path = "command_aliases_errors.rs"]
mod errors;
use errors::{
    alias_read_failed, classify_core_error, commit_interrupted, revision_conflict, CoreWriteFailure,
};

pub(crate) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "readAliases"
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
    match operation.as_str() {
        "readAliases" => {
            let result = read_aliases(&app, &session, &payload).await;
            drop(operation_permit);
            drop(call_guard);
            result
        }
        "writeAliases" => {
            write_aliases(
                app,
                session,
                payload,
                operation_permit,
                call_guard,
                accounting,
            )
            .await
        }
        "beginAliasWrite" => {
            let result = begin_alias_write(&session, &payload);
            drop(operation_permit);
            drop(call_guard);
            result
        }
        "appendAliasWrite" => {
            let result = append_alias_write(&session, &payload);
            drop(operation_permit);
            drop(call_guard);
            result
        }
        "commitAliasWrite" => {
            commit_alias_write(
                app,
                session,
                payload,
                operation_permit,
                call_guard,
                accounting,
            )
            .await
        }
        "abortAliasWrite" => {
            let result = abort_alias_write(&session, &payload);
            drop(operation_permit);
            drop(call_guard);
            result
        }
        _ => Err(BridgeError::new(
            "SETTINGS_OPERATION_REJECTED",
            "Settings view operation is not allowed",
        )),
    }
}

async fn read_aliases(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    require_empty_payload(payload)?;
    ensure_still_active(app, session)?;
    let _read_gate = session.command_data.aliases_read_gate.lock().await;
    ensure_still_active(app, session)?;

    let base = match session.command_data.alias_base()? {
        Some(base) => base,
        None => {
            let read_app = app.clone();
            let (raw, value, bytes) = tauri::async_runtime::spawn_blocking(move || {
                let state = read_app
                    .try_state::<crate::state::AppState>()
                    .ok_or_else(|| "Application state is unavailable".to_owned())?;
                let snapshot = state
                    .inner()
                    .db
                    .read_renderer_command_aliases()
                    .map_err(|_| "Renderer aliases could not be read".to_owned())?;
                if snapshot
                    .raw
                    .as_ref()
                    .is_some_and(|raw| raw.len() > MAX_ALIAS_RAW_BYTES)
                {
                    return Err("Renderer alias raw value exceeds its storage bound".to_owned());
                }
                let bytes = serde_json::to_vec(&snapshot.value)
                    .map_err(|_| "Renderer alias projection could not be encoded".to_owned())?;
                if bytes.len() > MAX_ALIAS_BYTES {
                    return Err("Renderer alias projection exceeds 512 KiB".to_owned());
                }
                Ok::<_, String>((snapshot.raw, snapshot.value, bytes))
            })
            .await
            .map_err(|_| alias_read_failed())?
            .map_err(|_| alias_read_failed())?;
            ensure_still_active(app, session)?;
            session.command_data.store_alias_base(raw, value, bytes)?
        }
    };
    let page = session
        .command_data
        .first_page(DataKind::Aliases, &base.token)?;
    ensure_still_active(app, session)?;
    encode_page(DataKind::Aliases, page)
}

fn begin_alias_write(session: &SessionView, payload: &Value) -> Result<Value, BridgeError> {
    let object = exact_object(payload, &["baseToken", "totalBytes"])?;
    let base_token = string_field(object, "baseToken")?;
    let total_bytes = object
        .get("totalBytes")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .filter(|bytes| *bytes > 0 && *bytes <= MAX_STAGED_BYTES)
        .ok_or_else(invalid_payload)?;
    let reservation = session
        .command_data
        .begin_alias_write(base_token, total_bytes)?;
    let reply = json!({"writeToken":reservation.write_token,"offset":0});
    check_reply(&reply)?;
    Ok(reply)
}

fn append_alias_write(session: &SessionView, payload: &Value) -> Result<Value, BridgeError> {
    let object = exact_object(payload, &["writeToken", "offset", "data"])?;
    let write_token = string_field(object, "writeToken")?;
    let data = match object
        .get("data")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= MAX_WRITE_CHUNK_BASE64_BYTES)
    {
        Some(data) => data,
        None => {
            session.command_data.discard_staged_write(write_token);
            return Err(invalid_payload());
        }
    };
    let offset = match object
        .get("offset")
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
    {
        Some(offset) => offset,
        None => {
            session.command_data.discard_staged_write(write_token);
            return Err(invalid_payload());
        }
    };
    let chunk = match decode_write_chunk(data) {
        Ok(chunk) => chunk,
        Err(error) => {
            session.command_data.discard_staged_write(write_token);
            return Err(error);
        }
    };
    let next_offset = session
        .command_data
        .append_alias_write(write_token, offset, &chunk)?;
    let reply = json!({"writeToken":write_token,"offset":next_offset});
    check_reply(&reply)?;
    Ok(reply)
}

fn decode_write_chunk(data: &str) -> Result<Vec<u8>, BridgeError> {
    if data.is_empty() || data.len() > MAX_WRITE_CHUNK_BASE64_BYTES {
        return Err(invalid_payload());
    }
    let chunk = STANDARD.decode(data).map_err(|_| invalid_payload())?;
    if chunk.is_empty() || chunk.len() > 16 * 1024 {
        return Err(invalid_payload());
    }
    Ok(chunk)
}

fn abort_alias_write(session: &SessionView, payload: &Value) -> Result<Value, BridgeError> {
    let object = exact_object(payload, &["writeToken"])?;
    let write_token = string_field(object, "writeToken")?;
    let aborted = session.command_data.abort_staged_write(write_token)?;
    let reply = json!({"aborted":aborted});
    check_reply(&reply)?;
    Ok(reply)
}

async fn write_aliases(
    app: AppHandle<Wry>,
    session: SessionView,
    payload: Value,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let object = exact_object(&payload, &["baseToken", "value"])?;
    let base_token = string_field(object, "baseToken")?.to_owned();
    let value = object.get("value").cloned().ok_or_else(invalid_payload)?;
    let bytes = serde_json::to_vec(&value).map_err(|_| invalid_payload())?;
    if bytes.len() > MAX_STAGED_BYTES {
        return Err(invalid_payload());
    }
    let reservation = session
        .command_data
        .reserve_inline_write(&base_token, bytes)?;
    commit_reserved(
        app,
        session,
        reservation.write_token,
        operation_permit,
        call_guard,
        accounting,
    )
    .await
}

async fn commit_alias_write(
    app: AppHandle<Wry>,
    session: SessionView,
    payload: Value,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let object = exact_object(&payload, &["writeToken"])?;
    let write_token = string_field(object, "writeToken")?.to_owned();
    if !session.command_data.staged_write_ready(&write_token)? {
        return Err(invalid_payload());
    }
    commit_reserved(
        app,
        session,
        write_token,
        operation_permit,
        call_guard,
        accounting,
    )
    .await
}

async fn commit_reserved(
    app: AppHandle<Wry>,
    session: SessionView,
    write_token: String,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let write_guard = accounting.track_write();
    let (sender, receiver) = oneshot::channel();
    let interrupted_buffers = Arc::clone(&session.command_data);
    let interrupted_token = write_token.clone();
    tauri::async_runtime::spawn(async move {
        let result = execute_commit(&app, &session, &write_token).await;
        let _ = sender.send(result);
        drop(call_guard);
        drop(operation_permit);
        drop(write_guard);
    });
    receiver.await.map_err(move |_| {
        interrupted_buffers.finish_alias_write_failure(&interrupted_token, true);
        commit_interrupted()
    })?
}

async fn execute_commit(
    app: &AppHandle<Wry>,
    session: &SessionView,
    write_token: &str,
) -> Result<Value, BridgeError> {
    let _write_gate = session.write_gate.lock().await;
    if ensure_still_active(app, session).is_err() {
        session
            .command_data
            .finish_alias_write_failure(write_token, false);
        return Err(inactive_session());
    }
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(inactive_session)?;
    let database = Arc::clone(&state.inner().db);
    let worker_session = session.clone();
    let token = write_token.to_owned();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        if worker_session.command_data.is_closed()
            || worker_session.is_revoked()
            || worker_session.signal().phase == SessionPhase::Closing
        {
            worker_session
                .command_data
                .finish_alias_write_failure(&token, false);
            return Err(CommitFailure::Inactive);
        }

        let input = worker_session
            .command_data
            .take_staged_write(&token)
            .map_err(CommitFailure::Bridge)?;
        let write = match database.mutate_renderer_command_aliases_guarded(
            input.expected_raw.as_deref(),
            &input.desired,
            || {
                !worker_session.is_revoked()
                    && worker_session.signal().phase != SessionPhase::Closing
            },
        ) {
            Ok(write) => write,
            Err(error) => {
                let failure = classify_core_error(&error);
                worker_session
                    .command_data
                    .finish_alias_write_failure(&token, failure.invalidate_base());
                return Err(match failure {
                    CoreWriteFailure::RevisionConflict => CommitFailure::RevisionConflict,
                    CoreWriteFailure::SessionClosed => CommitFailure::Inactive,
                    CoreWriteFailure::InvalidCandidate => CommitFailure::Bridge(invalid_payload()),
                    CoreWriteFailure::Storage => CommitFailure::CommitInterrupted,
                });
            }
        };
        Ok(install_success(&worker_session.command_data, &token, write))
    })
    .await;

    let completed = match outcome {
        Ok(Ok(completed)) => completed,
        Ok(Err(CommitFailure::Bridge(error))) => return Err(error),
        Ok(Err(CommitFailure::Inactive)) => return Err(inactive_session()),
        Ok(Err(CommitFailure::RevisionConflict)) => return Err(revision_conflict()),
        Ok(Err(CommitFailure::CommitInterrupted)) => return Err(commit_interrupted()),
        Err(_) => {
            session
                .command_data
                .finish_alias_write_failure(write_token, true);
            return Err(commit_interrupted());
        }
    };

    let notification_delivered = if completed.changed {
        app.emit_to(
            EventTarget::webview("main"),
            "atools://renderer-command-aliases",
            (),
        )
        .is_ok()
    } else {
        false
    };
    let Some(base_token) = completed.base_token else {
        return Err(commit_interrupted());
    };
    let reply = json!({
        "version": 1,
        "success": true,
        "baseToken": base_token,
        "notificationDelivered": notification_delivered,
    });
    check_reply(&reply)?;
    Ok(reply)
}

struct InstalledCommit {
    changed: bool,
    base_token: Option<String>,
}

fn install_success(
    buffers: &CommandDataBuffers,
    write_token: &str,
    write: RendererCommandAliasesWrite,
) -> InstalledCommit {
    let changed = write.changed;
    let encoded = serde_json::to_vec(&write.value).ok();
    let base_token = encoded.and_then(|bytes| {
        match buffers.finish_alias_write_success(write_token, write.raw, &write.value, bytes) {
            Ok(token) => token,
            Err(_) => {
                buffers.finish_alias_write_failure(write_token, true);
                None
            }
        }
    });
    if base_token.is_none() {
        buffers.finish_alias_write_failure(write_token, true);
    }
    InstalledCommit {
        changed,
        base_token,
    }
}

enum CommitFailure {
    Bridge(BridgeError),
    Inactive,
    RevisionConflict,
    CommitInterrupted,
}

#[cfg(test)]
#[path = "command_aliases_tests.rs"]
mod tests;
