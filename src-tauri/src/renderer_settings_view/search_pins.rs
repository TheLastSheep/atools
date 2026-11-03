//! Child-session adapter for the original settings view's search pins.

use std::sync::Arc;

use atools_core::{
    db::{
        RendererAppIdentity, RendererAppStateMutation, RendererAppStateSnapshot,
        RendererDirectSubtype,
    },
    AToolsError,
};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    command_data::CommandDataBuffers,
    phase::{SessionPhase, SessionSignal},
    session::SessionView,
    validation::{ensure_still_active, inactive_session, invalid_payload, BridgeError},
};

const MAX_OPERATION_BYTES: usize = 32 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const TARGET_UNAVAILABLE: BridgeError = BridgeError::new(
    "SETTINGS_SEARCH_PIN_TARGET_UNAVAILABLE",
    "The selected application is not in the launcher catalog",
);
const MUTATION_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_SEARCH_PIN_FAILED",
    "The application search pin could not be updated",
);
const COMMIT_UNKNOWN: BridgeError = BridgeError::new(
    "SETTINGS_SEARCH_PIN_COMMIT_UNKNOWN",
    "The application search pin result is unknown; reload settings to confirm",
);

#[derive(Clone, Copy)]
struct PinSessionState<'a> {
    id: &'a str,
    label: &'a str,
    bundle_revision: &'a str,
    revoked: bool,
    phase: SessionPhase,
    ready: bool,
    can_serve: bool,
}

pub(crate) fn handles(operation: &str) -> bool {
    operation == "mutateSearchPin"
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

    let (database, catalog) = {
        let state = app
            .try_state::<crate::state::AppState>()
            .ok_or_else(inactive_session)?;
        (
            Arc::clone(&state.db),
            Arc::clone(&state.launcher_app_catalog),
        )
    };
    if let RendererAppStateMutation::Pin { app: identity } = &mutation {
        let exists = match identity.sub_type {
            RendererDirectSubtype::App => {
                crate::renderer_app_state::catalog_contains_identity(catalog, identity).await
            }
            RendererDirectSubtype::LocalShortcut => {
                crate::renderer_app_state::local_shortcut_contains_identity(
                    Arc::clone(&database),
                    identity,
                )
                .await
            }
        }
        .map_err(|_| MUTATION_FAILED)?;
        if !exists {
            return Err(TARGET_UNAVAILABLE);
        }
        ensure_session_ready(&app, &session)?;
    }

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
    database: Arc<atools_core::db::Database>,
    mutation: RendererAppStateMutation,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let write_guard = accounting.track_write();
    let interrupted_buffer = Arc::clone(&session.command_data);
    let (sender, receiver) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let result = execute_mutation(&app, &session, database, mutation).await;
        drop(call_guard);
        drop(operation_permit);
        drop(write_guard);
        let _ = sender.send(result);
    });
    match receiver.await {
        Ok(result) => result,
        Err(_) => {
            let _settings_read_gate = interrupted_buffer.settings_read_gate.lock().await;
            interrupted_buffer.invalidate_command_settings();
            Err(COMMIT_UNKNOWN)
        }
    }
}

async fn execute_mutation(
    app: &AppHandle<Wry>,
    session: &SessionView,
    database: Arc<atools_core::db::Database>,
    mutation: RendererAppStateMutation,
) -> Result<Value, BridgeError> {
    let _write_gate = session.write_gate.lock().await;
    ensure_session_ready(app, session)?;
    let _settings_read_gate = session.command_data.settings_read_gate.lock().await;
    ensure_session_ready(app, session)?;

    let guard_app = app.clone();
    let guard_session = session.clone();
    let worker_result = tauri::async_runtime::spawn_blocking(move || {
        database.apply_renderer_app_state_guarded(mutation, move || {
            let Ok(runtime) = super::runtime(&guard_app) else {
                return false;
            };
            let Ok(current) = runtime.current_for_id(&guard_session.id) else {
                return false;
            };
            session_state_matches(session_state(&guard_session), Some(session_state(&current)))
        })
    })
    .await;
    let committed = match worker_result {
        Ok(Ok(snapshot)) => snapshot,
        Ok(Err(error)) => return Err(map_mutation_error(&error, &session.command_data)),
        Err(_) => {
            session.command_data.invalidate_command_settings();
            return Err(COMMIT_UNKNOWN);
        }
    };

    // The Core transaction owns a confirmed commit. Teardown may have closed
    // this session buffer meanwhile; invalidation is then a safe no-op.
    session.command_data.invalidate_command_settings();
    crate::renderer_app_state::emit_confirmed_snapshot(app, &committed);
    committed_reply(committed)
}

fn ensure_session_ready(app: &AppHandle<Wry>, session: &SessionView) -> Result<(), BridgeError> {
    ensure_still_active(app, session)?;
    if !session.signal().ready {
        return Err(inactive_session());
    }
    Ok(())
}

fn session_state(session: &SessionView) -> PinSessionState<'_> {
    let signal: SessionSignal = session.signal();
    PinSessionState {
        id: &session.id,
        label: &session.label,
        bundle_revision: &session.bundle_revision,
        revoked: session.is_revoked(),
        phase: signal.phase,
        ready: signal.ready,
        can_serve: super::lifecycle::session_can_serve(session),
    }
}

fn session_state_matches(
    expected: PinSessionState<'_>,
    current: Option<PinSessionState<'_>>,
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

fn parse_mutation(payload: &Value) -> Result<RendererAppStateMutation, BridgeError> {
    let encoded = serde_json::to_vec(payload).map_err(|_| invalid_payload())?;
    if encoded.len() > MAX_OPERATION_BYTES {
        return Err(BridgeError::new(
            "SETTINGS_CALL_TOO_LARGE",
            "Settings request exceeds the 32 KiB operation limit",
        ));
    }
    let root = payload.as_object().ok_or_else(invalid_payload)?;
    match root.get("operation").and_then(Value::as_str) {
        Some("pin") => parse_pin(root),
        Some("unpin") => parse_unpin(root),
        _ => Err(invalid_payload()),
    }
}

fn parse_pin(root: &Map<String, Value>) -> Result<RendererAppStateMutation, BridgeError> {
    if root.len() != 2 || !root.contains_key("app") {
        return Err(invalid_payload());
    }
    let app = root
        .get("app")
        .and_then(Value::as_object)
        .filter(|app| {
            (app.len() == 2 || app.len() == 3)
                && app.contains_key("path")
                && app.contains_key("name")
                && app
                    .keys()
                    .all(|key| matches!(key.as_str(), "path" | "name" | "subType"))
        })
        .ok_or_else(invalid_payload)?;
    required_string(app, "path")?;
    required_string(app, "name")?;
    let identity: RendererAppIdentity =
        serde_json::from_value(Value::Object(app.clone())).map_err(|_| invalid_payload())?;
    crate::renderer_app_state::validate_identity(&identity).map_err(|_| invalid_payload())?;
    Ok(RendererAppStateMutation::Pin { app: identity })
}

fn parse_unpin(root: &Map<String, Value>) -> Result<RendererAppStateMutation, BridgeError> {
    if root.len() != 3 || !root.contains_key("path") || !root.contains_key("name") {
        return Err(invalid_payload());
    }
    let path = required_string(root, "path")?;
    let name = match root.get("name") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => Some(value.clone()),
        _ => return Err(invalid_payload()),
    };
    crate::renderer_app_state::validate_filter(&path, name.as_deref())
        .map_err(|_| invalid_payload())?;
    Ok(RendererAppStateMutation::Unpin { path, name })
}

fn required_string(object: &Map<String, Value>, field: &str) -> Result<String, BridgeError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(invalid_payload)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MutationFailure {
    Inactive,
    CommitUnknown,
    Failed,
}

fn classify_mutation_error(error: &AToolsError) -> MutationFailure {
    match error {
        AToolsError::Config(message)
            if message == atools_core::db::RENDERER_APP_STATE_GUARD_REJECTED =>
        {
            MutationFailure::Inactive
        }
        AToolsError::Database(_) => MutationFailure::CommitUnknown,
        _ => MutationFailure::Failed,
    }
}

fn map_mutation_error(error: &AToolsError, command_data: &CommandDataBuffers) -> BridgeError {
    match classify_mutation_error(error) {
        MutationFailure::Inactive => inactive_session(),
        MutationFailure::CommitUnknown => {
            command_data.invalidate_command_settings();
            COMMIT_UNKNOWN
        }
        MutationFailure::Failed => MUTATION_FAILED,
    }
}

fn committed_reply(snapshot: RendererAppStateSnapshot) -> Result<Value, BridgeError> {
    if snapshot.revision > MAX_SAFE_INTEGER {
        return Err(COMMIT_UNKNOWN);
    }
    Ok(json!({"version":1,"revision":snapshot.revision}))
}

#[cfg(test)]
#[path = "search_pins_tests.rs"]
mod tests;
