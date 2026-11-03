//! Bound settings-child operations for original local launch shortcuts.
use std::sync::Arc;

use atools_core::{
    db::{
        bounded_json_serialized_size, RendererLocalShortcut, RendererLocalShortcutIdentity,
        RendererLocalShortcutMutation, RendererLocalShortcutType, RendererLocalShortcutWrite,
    },
    AToolsError,
};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};
use tokio::sync::OwnedSemaphorePermit;

use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    local_shortcut_files::{self, PathFailure},
    local_shortcut_protocol::{parse_request, Request},
    phase::SessionPhase,
    session::SessionView,
    validation::{ensure_still_active, inactive_session, invalid_payload, BridgeError},
};

#[cfg(test)]
use super::local_shortcut_protocol::MAX_OPERATION_BYTES;

const MAX_READ_RESPONSE_BYTES: usize = 256 * 1024;
const MAX_RESPONSE_BYTES: usize = 96 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const EVENT_NAME: &str = "atools://renderer-local-shortcuts";

const READ_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_LOCAL_SHORTCUT_READ_FAILED",
    "Local launch shortcuts could not be read",
);
const WRITE_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_LOCAL_SHORTCUT_WRITE_FAILED",
    "Local launch shortcuts could not be updated",
);
const COMMIT_UNKNOWN: BridgeError = BridgeError::new(
    "SETTINGS_LOCAL_SHORTCUT_COMMIT_UNKNOWN",
    "The local shortcut write result is unknown; reload settings to confirm",
);
const PICKER_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_LOCAL_SHORTCUT_PICKER_FAILED",
    "The native local shortcut picker could not be opened",
);
const PICKER_UNSUPPORTED: BridgeError = BridgeError::new(
    "SETTINGS_LOCAL_SHORTCUT_PICKER_UNSUPPORTED",
    "Native local shortcut selection is available only on macOS",
);
const TARGET_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_LOCAL_SHORTCUT_TARGET_UNAVAILABLE",
    "The selected local shortcut is unavailable",
);
const OPEN_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_LOCAL_SHORTCUT_OPEN_FAILED",
    "The local shortcut could not be opened",
);

pub(crate) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "readLocalShortcuts"
            | "addLocalShortcut"
            | "addLocalShortcutByPath"
            | "deleteLocalShortcut"
            | "updateLocalShortcutAlias"
            | "openLocalShortcut"
            | "deleteMissingLocalShortcuts"
    )
}

pub(crate) async fn handle(
    app: AppHandle<Wry>,
    session: SessionView,
    operation: &str,
    payload: Value,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let request = parse_request(operation, &payload)?;
    ensure_ready(&app, &session)?;
    let request = match request {
        Request::Add(kind) => {
            return add_with_picker_detached(
                app,
                session,
                kind,
                operation_permit,
                call_guard,
                accounting,
            )
            .await;
        }
        request => request,
    };
    let _operation_permit = operation_permit;
    let _call_guard = call_guard;

    match request {
        Request::Read => read_all(&app, &session).await,
        Request::Add(_) => unreachable!("picker requests use the owned native task"),
        Request::AddByPath(path) => {
            let db = database(&app)?;
            let record = build_record(path).await?;
            write_mutation(
                &app,
                &session,
                db,
                RendererLocalShortcutMutation::Add { record },
                &accounting,
                success_reply(),
                false,
            )
            .await
        }
        Request::Delete(id) => {
            let db = database(&app)?;
            write_mutation(
                &app,
                &session,
                db,
                RendererLocalShortcutMutation::Remove { id },
                &accounting,
                success_reply(),
                false,
            )
            .await
        }
        Request::SetAlias { id, alias } => {
            let db = database(&app)?;
            write_mutation(
                &app,
                &session,
                db,
                RendererLocalShortcutMutation::SetAlias { id, alias },
                &accounting,
                success_reply(),
                false,
            )
            .await
        }
        Request::Open(path) => open_registered(&app, &session, path).await,
        Request::RemoveMissing => remove_missing(&app, &session, &accounting).await,
    }
}

async fn add_with_picker_detached(
    app: AppHandle<Wry>,
    session: SessionView,
    kind: RendererLocalShortcutType,
    operation_permit: OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let write_guard = accounting.track_write();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let result = add_with_picker(&app, &session, kind, &accounting).await;
        drop(call_guard);
        drop(operation_permit);
        drop(write_guard);
        let _ = sender.send(result);
    });
    receiver.await.map_err(|_| COMMIT_UNKNOWN)?
}

async fn add_with_picker(
    app: &AppHandle<Wry>,
    session: &SessionView,
    kind: RendererLocalShortcutType,
    accounting: &Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    if !crate::plugin_dialog_runtime::settings_picker::supported() {
        return Err(PICKER_UNSUPPORTED);
    }
    let picker_kind = match kind {
        RendererLocalShortcutType::File => {
            crate::plugin_dialog_runtime::settings_picker::LocalSelectionKind::File
        }
        RendererLocalShortcutType::Folder => {
            crate::plugin_dialog_runtime::settings_picker::LocalSelectionKind::Folder
        }
        RendererLocalShortcutType::App => return Err(invalid_payload()),
    };
    // Subscribe before the native panel is scheduled so close cannot be missed.
    let mut signals = session.subscribe();
    let closing_session = session.clone();
    let closing = async move {
        loop {
            let signal = signals.borrow().clone();
            if closing_session.is_revoked()
                || signal.phase == SessionPhase::Closing
                || !signal.ready
            {
                return;
            }
            if signals.changed().await.is_err() {
                return;
            }
        }
    };
    let selection = crate::plugin_dialog_runtime::settings_picker::select_local_shortcut_path(
        app.clone(),
        uuid::Uuid::new_v4().to_string(),
        picker_kind,
        closing,
    )
    .await;
    ensure_ready(app, session)?;
    let path = selection.map_err(|_| PICKER_FAILED)?;
    let Some(path) = path else {
        return Ok(json!({"success":false,"error":"用户取消选择"}));
    };
    let record = build_record(path).await?;
    write_mutation(
        app,
        session,
        database(app)?,
        RendererLocalShortcutMutation::Add { record },
        accounting,
        success_reply(),
        true,
    )
    .await
}

async fn build_record(path: String) -> Result<RendererLocalShortcut, BridgeError> {
    local_shortcut_files::validate_absolute_path(&path).map_err(|_| invalid_payload())?;
    let id = uuid::Uuid::new_v4().to_string();
    tauri::async_runtime::spawn_blocking(move || local_shortcut_files::build_record(path, id))
        .await
        .map_err(|_| TARGET_FAILED)?
        .map_err(map_path_failure)
}

fn map_path_failure(error: PathFailure) -> BridgeError {
    match error {
        PathFailure::Invalid => invalid_payload(),
        PathFailure::Unavailable => TARGET_FAILED,
    }
}

async fn read_all(app: &AppHandle<Wry>, session: &SessionView) -> Result<Value, BridgeError> {
    ensure_ready(app, session)?;
    let db = database(app)?;
    let shortcuts =
        tauri::async_runtime::spawn_blocking(move || db.read_renderer_local_shortcuts())
            .await
            .map_err(|_| READ_FAILED)?
            .map_err(|_| READ_FAILED)?;
    ensure_ready(app, session)?;
    let value = serde_json::to_value(shortcuts).map_err(|_| READ_FAILED)?;
    check_response_budget(&value, MAX_READ_RESPONSE_BYTES)?;
    Ok(value)
}

async fn remove_missing(
    app: &AppHandle<Wry>,
    session: &SessionView,
    accounting: &Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    ensure_ready(app, session)?;
    let db = database(app)?;
    let expected = tauri::async_runtime::spawn_blocking(move || {
        let shortcuts = db.read_renderer_local_shortcuts()?;
        Ok::<_, AToolsError>(
            shortcuts
                .iter()
                .filter(|shortcut| local_shortcut_files::missing_observation(&shortcut.path))
                .map(|shortcut| RendererLocalShortcutIdentity {
                    id: shortcut.id.clone(),
                    path: shortcut.path.clone(),
                })
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|_| READ_FAILED)?
    .map_err(|_| READ_FAILED)?;
    write_mutation(
        app,
        session,
        database(app)?,
        RendererLocalShortcutMutation::RemoveMissing { expected },
        accounting,
        success_reply(),
        false,
    )
    .await
}

async fn open_registered(
    app: &AppHandle<Wry>,
    session: &SessionView,
    path: String,
) -> Result<Value, BridgeError> {
    ensure_ready(app, session)?;
    let db = database(app)?;
    let shortcuts =
        tauri::async_runtime::spawn_blocking(move || db.read_renderer_local_shortcuts())
            .await
            .map_err(|_| READ_FAILED)?
            .map_err(|_| READ_FAILED)?;
    let Some(target) = shortcuts.into_iter().find(|shortcut| shortcut.path == path) else {
        return Err(TARGET_FAILED);
    };
    ensure_ready(app, session)?;
    let db = database(app)?;
    let result = crate::agent_tools::call_tool_with_audit(
        app,
        &db,
        "atools-ui",
        "open_or_reveal_path",
        json!({"path":target.path,"reveal":false}),
        true,
    )
    .await;
    ensure_ready(app, session)?;
    if result.is_error {
        return Err(OPEN_FAILED);
    }
    Ok(success_reply())
}

async fn write_mutation(
    app: &AppHandle<Wry>,
    session: &SessionView,
    db: Arc<atools_core::db::Database>,
    mutation: RendererLocalShortcutMutation,
    accounting: &Arc<RuntimeAccounting>,
    reply: Value,
    write_already_tracked: bool,
) -> Result<Value, BridgeError> {
    ensure_ready(app, session)?;
    let _write_guard = (!write_already_tracked).then(|| accounting.track_write());
    let _write_gate = session.write_gate.lock().await;
    ensure_ready(app, session)?;
    let _settings_read_gate = session.command_data.settings_read_gate.lock().await;
    ensure_ready(app, session)?;

    let guard_app = app.clone();
    let guard_session = session.clone();
    let write = tauri::async_runtime::spawn_blocking(move || {
        db.apply_renderer_local_shortcut_guarded(mutation, move || {
            ensure_ready(&guard_app, &guard_session).is_ok()
        })
    })
    .await;
    let write = match write {
        Ok(Ok(write)) => write,
        Ok(Err(error)) => {
            if matches!(&error, AToolsError::Database(_)) {
                session.command_data.invalidate_command_settings();
                session.command_data.invalidate_commands().await;
            }
            return Err(map_write_error(&error));
        }
        Err(_) => {
            session.command_data.invalidate_command_settings();
            session.command_data.invalidate_commands().await;
            return Err(COMMIT_UNKNOWN);
        }
    };
    if write.revision > MAX_SAFE_INTEGER {
        session.command_data.invalidate_command_settings();
        session.command_data.invalidate_commands().await;
        return Err(COMMIT_UNKNOWN);
    }
    if write.changed {
        session.command_data.invalidate_commands().await;
        emit_changed(app, write);
    }
    check_response_budget(&reply, MAX_RESPONSE_BYTES)?;
    Ok(reply)
}

fn map_write_error(error: &AToolsError) -> BridgeError {
    match error {
        AToolsError::Config(message)
            if message == atools_core::db::RENDERER_LOCAL_SHORTCUTS_GUARD_REJECTED =>
        {
            inactive_session()
        }
        AToolsError::Database(_) => COMMIT_UNKNOWN,
        _ => WRITE_FAILED,
    }
}

fn emit_changed(app: &AppHandle<Wry>, write: RendererLocalShortcutWrite) {
    if app
        .emit_to(
            EventTarget::webview("main"),
            EVENT_NAME,
            json!({"version":1,"revision":write.revision}),
        )
        .is_err()
    {
        tracing::warn!("Local shortcut state changed but the main renderer event was unavailable");
    }
}

fn database(app: &AppHandle<Wry>) -> Result<Arc<atools_core::db::Database>, BridgeError> {
    app.try_state::<crate::state::AppState>()
        .map(|state| Arc::clone(&state.db))
        .ok_or_else(inactive_session)
}

fn ensure_ready(app: &AppHandle<Wry>, session: &SessionView) -> Result<(), BridgeError> {
    ensure_still_active(app, session)?;
    if !session.signal().ready {
        return Err(inactive_session());
    }
    Ok(())
}

fn check_response_budget(value: &Value, max_bytes: usize) -> Result<(), BridgeError> {
    if bounded_json_serialized_size(value, max_bytes).is_none() {
        return Err(BridgeError::new(
            "SETTINGS_LOCAL_SHORTCUT_RESPONSE_TOO_LARGE",
            "Local shortcut response exceeds its size limit",
        ));
    }
    Ok(())
}

fn success_reply() -> Value {
    json!({"success":true})
}

#[cfg(test)]
#[path = "local_shortcuts_tests.rs"]
mod tests;
