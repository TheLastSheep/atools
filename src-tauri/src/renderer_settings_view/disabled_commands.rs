//! Fixed-key CAS writes for the original renderer's disabled-command list.

use std::{future::Future, sync::Arc};

use atools_core::{
    db::{
        Database, RendererDisabledCommandsWrite, RENDERER_DISABLED_COMMANDS_CONFLICT,
        RENDERER_DISABLED_COMMANDS_GUARD_REJECTED,
    },
    AToolsError,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    phase::{SessionPhase, SessionSignal},
    session::SessionView,
    validation::{
        ensure_still_active, exact_object, inactive_session, invalid_payload, string_field,
        BridgeError,
    },
};

const MAX_COMMAND_IDS: usize = 4096;
const MAX_COMMAND_ID_BYTES: usize = 16_448;
const MAX_VALUE_BYTES: usize = 128 * 1024;
const MAX_ENVELOPE_BYTES: usize = 256;
const MAX_OPERATION_BYTES: usize = MAX_VALUE_BYTES + MAX_ENVELOPE_BYTES;
const DISABLED_COMMANDS_EVENT: &str = "atools://renderer-disabled-commands";

const REVISION_CONFLICT: BridgeError = BridgeError::new(
    "SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT",
    "Disabled commands changed; reload settings before saving again",
);
const COMMIT_UNKNOWN: BridgeError = BridgeError::new(
    "SETTINGS_DISABLED_COMMANDS_COMMIT_UNKNOWN",
    "Disabled command save result is unknown; reload settings to confirm",
);
const WRITE_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_DISABLED_COMMANDS_FAILED",
    "Disabled commands could not be saved",
);

#[derive(Clone, Debug, PartialEq)]
struct DisabledCommandsMutation {
    base_token: String,
    value: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DisabledCommandsSessionState {
    id: String,
    label: String,
    bundle_revision: String,
    revoked: bool,
    phase: SessionPhase,
    ready: bool,
    can_serve: bool,
}

pub(crate) fn handles(operation: &str) -> bool {
    operation == "writeDisabledCommands"
}

/// Gives only this operation the larger explicit envelope budget. All other
/// settings operations continue through the existing 64 KiB validator.
pub(crate) fn check_payload_budget(payload: &Value) -> Result<(), BridgeError> {
    let bytes = serde_json::to_vec(payload).map_err(|_| invalid_payload())?;
    if bytes.len() > MAX_OPERATION_BYTES {
        return Err(call_too_large());
    }
    Ok(())
}

pub(crate) async fn handle(
    app: AppHandle<Wry>,
    session: SessionView,
    payload: Value,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let mutation = parse_mutation(&payload)?;
    ensure_session_ready(&app, &session)?;
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(inactive_session)?;
    let database = Arc::clone(&state.inner().db);
    mutate_and_reply(
        app,
        session,
        database,
        mutation,
        operation_permit,
        call_guard,
        accounting,
    )
    .await
}

async fn mutate_and_reply(
    app: AppHandle<Wry>,
    session: SessionView,
    database: Arc<Database>,
    mutation: DisabledCommandsMutation,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let write_guard = accounting.track_write();
    let (sender, receiver) = oneshot::channel();
    let interrupted_buffer = Arc::clone(&session.command_data);
    spawn_owned_write(
        async move { execute_mutation(&app, &session, database, mutation).await },
        sender,
        operation_permit,
        call_guard,
        write_guard,
    );

    match receiver.await {
        Ok(result) => result,
        Err(_) => {
            let _settings_read_gate = interrupted_buffer.settings_read_gate.lock().await;
            interrupted_buffer.invalidate_command_settings();
            Err(COMMIT_UNKNOWN)
        }
    }
}

fn spawn_owned_write<T: Send + 'static>(
    work: impl Future<Output = T> + Send + 'static,
    sender: oneshot::Sender<T>,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    write_guard: RuntimeActivityGuard,
) {
    tauri::async_runtime::spawn(async move {
        let result = work.await;
        let _ = sender.send(result);
        drop(call_guard);
        drop(operation_permit);
        drop(write_guard);
    });
}

async fn execute_mutation(
    app: &AppHandle<Wry>,
    session: &SessionView,
    database: Arc<Database>,
    mutation: DisabledCommandsMutation,
) -> Result<Value, BridgeError> {
    let _write_gate = session.write_gate.lock().await;
    ensure_session_ready(app, session)?;
    let _settings_read_gate = session.command_data.settings_read_gate.lock().await;
    ensure_session_ready(app, session)?;
    let expected = session
        .command_data
        .command_settings_disabled_commands_base(&mutation.base_token)?;

    let expected_session = session_state(session);
    let guard_app = app.clone();
    let guard_session = session.clone();
    let desired = mutation.value;
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        database.mutate_renderer_disabled_commands_guarded(&expected, &desired, || {
            let Ok(runtime) = super::runtime(&guard_app) else {
                return false;
            };
            let Ok(current) = runtime.current_for_id(&guard_session.id) else {
                return false;
            };
            session_state_matches(expected_session, Some(session_state(&current)))
        })
    })
    .await;

    // Any CAS outcome expires the compare base; on an unknown commit this also
    // prevents a retry from applying an old value without a fresh read.
    session.command_data.invalidate_command_settings();
    let committed = match outcome {
        Ok(Ok(write)) => write,
        Ok(Err(error)) => return Err(map_mutation_error(&error)),
        Err(_) => return Err(COMMIT_UNKNOWN),
    };

    let notification_delivered = notify_main_if_changed(app, committed.changed);
    Ok(success_reply(committed, notification_delivered))
}

fn parse_mutation(payload: &Value) -> Result<DisabledCommandsMutation, BridgeError> {
    check_payload_budget(payload)?;
    let object = exact_object(payload, &["baseToken", "value"])?;
    if object.len() != 2 {
        return Err(invalid_payload());
    }
    let base_token = string_field(object, "baseToken")?.to_owned();
    let value = object
        .get("value")
        .and_then(Value::as_array)
        .ok_or_else(invalid_payload)?;
    validate_ids(value)?;
    let desired = Value::Array(value.clone());
    let encoded = serde_json::to_vec(&desired).map_err(|_| invalid_payload())?;
    if encoded.len() > MAX_VALUE_BYTES {
        return Err(call_too_large());
    }
    Ok(DisabledCommandsMutation {
        base_token,
        value: desired,
    })
}

fn validate_ids(value: &[Value]) -> Result<(), BridgeError> {
    if value.len() > MAX_COMMAND_IDS {
        return Err(invalid_payload());
    }
    for id in value {
        let Some(id) = id.as_str() else {
            return Err(invalid_payload());
        };
        if id.is_empty() || id.len() > MAX_COMMAND_ID_BYTES {
            return Err(invalid_payload());
        }
    }
    Ok(())
}

fn ensure_session_ready(app: &AppHandle<Wry>, session: &SessionView) -> Result<(), BridgeError> {
    ensure_still_active(app, session)?;
    if !session.signal().ready {
        return Err(inactive_session());
    }
    Ok(())
}

fn session_state(session: &SessionView) -> DisabledCommandsSessionState {
    let signal: SessionSignal = session.signal();
    DisabledCommandsSessionState {
        id: session.id.clone(),
        label: session.label.clone(),
        bundle_revision: session.bundle_revision.clone(),
        revoked: session.is_revoked(),
        phase: signal.phase,
        ready: signal.ready,
        can_serve: super::lifecycle::session_can_serve(session),
    }
}

fn session_state_matches(
    expected: DisabledCommandsSessionState,
    current: Option<DisabledCommandsSessionState>,
) -> bool {
    let Some(current) = current else { return false };
    !expected.revoked
        && !current.revoked
        && expected.phase != SessionPhase::Closing
        && current.phase != SessionPhase::Closing
        && expected.ready
        && current.ready
        && expected.can_serve
        && current.can_serve
        && expected.id == current.id
        && expected.label == current.label
        && expected.bundle_revision == current.bundle_revision
}

fn map_mutation_error(error: &AToolsError) -> BridgeError {
    match error {
        AToolsError::Config(message) if message == RENDERER_DISABLED_COMMANDS_GUARD_REJECTED => {
            inactive_session()
        }
        AToolsError::Config(message) if message == RENDERER_DISABLED_COMMANDS_CONFLICT => {
            REVISION_CONFLICT
        }
        AToolsError::Database(_) => COMMIT_UNKNOWN,
        _ => WRITE_FAILED,
    }
}

fn notify_main_if_changed(app: &AppHandle<Wry>, changed: bool) -> bool {
    notify_if_changed(changed, || {
        app.emit_to(
            disabled_commands_event_target(),
            DISABLED_COMMANDS_EVENT,
            (),
        )
        .is_ok()
    })
}

fn disabled_commands_event_target() -> EventTarget {
    EventTarget::webview("main")
}

fn notify_if_changed(changed: bool, emit: impl FnOnce() -> bool) -> bool {
    if changed {
        emit()
    } else {
        false
    }
}

fn success_reply(committed: RendererDisabledCommandsWrite, notification_delivered: bool) -> Value {
    json!({
        "version": 1,
        "success": true,
        "changed": committed.changed,
        "notificationDelivered": notification_delivered,
    })
}

fn call_too_large() -> BridgeError {
    BridgeError::new(
        "SETTINGS_CALL_TOO_LARGE",
        "Disabled command settings request exceeds its byte limit",
    )
}

#[cfg(test)]
#[path = "disabled_commands_tests.rs"]
mod tests;
