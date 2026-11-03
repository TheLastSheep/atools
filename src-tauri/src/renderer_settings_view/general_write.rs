//! Owned General writes, kept separate from transport dispatch.
use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    session::SessionView,
    validation::{
        changes_field, ensure_still_active, exact_object, map_preferences_error, string_field,
        BridgeError,
    },
};
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Wry};

pub(super) async fn patch(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
    operation_permit: tokio::sync::OwnedSemaphorePermit,
    call_guard: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    let object = exact_object(payload, &["revision", "changes"])?;
    let revision = string_field(object, "revision")?.to_owned();
    let changes = changes_field(object.get("changes"))?;
    let write_guard = accounting.track_write();
    let app = app.clone();
    let session = session.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let result = patch_general_work(&app, &session, revision, changes, write_guard).await;
        drop(call_guard);
        drop(operation_permit);
        let _ = sender.send(result);
    });
    receiver.await.map_err(|_| {
        BridgeError::new(
            "SETTINGS_PATCH_INTERRUPTED",
            "General settings save did not finish",
        )
    })?
}

async fn patch_general_work(
    app: &AppHandle<Wry>,
    session: &SessionView,
    revision: String,
    changes: std::collections::BTreeMap<String, Value>,
    write_guard: RuntimeActivityGuard,
) -> Result<Value, BridgeError> {
    let receipt = {
        let _write_gate = session.write_gate.lock().await;
        ensure_still_active(app, session)?;
        session
            .preferences
            .patch(app.clone(), revision, changes)
            .await
            .map_err(map_preferences_error)
    };
    drop(write_guard);
    let receipt = receipt?;
    ensure_still_active(app, session)?;
    Ok(receipt)
}
