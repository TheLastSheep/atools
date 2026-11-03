//! Only the compiled, ready Shortcuts document may read/mutate App bindings.
use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    session::SessionView,
    validation::{
        ensure_still_active, inactive_session, invalid_payload, require_empty_payload, BridgeError,
    },
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::OwnedSemaphorePermit;
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WriteRequest {
    revision: String,
    mutation: crate::app_global_shortcuts::MutationRequest,
}
pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "readAppGlobalShortcuts" | "mutateAppGlobalShortcut"
    )
}
fn ensure_ready(app: &AppHandle, session: &SessionView) -> Result<(), BridgeError> {
    ensure_still_active(app, session)?;
    let child = app
        .get_webview(&session.label)
        .ok_or_else(inactive_session)?;
    let url = child.url().map_err(|_| inactive_session())?;
    if !session.signal().ready
        || session.signal().phase != super::phase::SessionPhase::Open
        || session.bundle.revision() != session.bundle_revision
        || !super::identity::is_expected_settings_url(&url, &session.id)
        || !url
            .fragment()
            .is_some_and(|f| f == "/shortcuts" || f.starts_with("/shortcuts?_t="))
    {
        return Err(inactive_session());
    }
    Ok(())
}
pub(super) async fn handle(
    app: AppHandle,
    session: SessionView,
    operation: &str,
    payload: Value,
    permit: OwnedSemaphorePermit,
    call: RuntimeActivityGuard,
    accounting: Arc<RuntimeAccounting>,
) -> Result<Value, BridgeError> {
    ensure_ready(&app, &session)?;
    if operation == "readAppGlobalShortcuts" {
        require_empty_payload(&payload)?;
        let result = crate::app_global_shortcuts::read(&app)
            .await
            .map_err(map_error)?;
        ensure_ready(&app, &session)?;
        return Ok(result);
    }
    let request: WriteRequest = serde_json::from_value(payload).map_err(|_| invalid_payload())?;
    if request.revision.len() != 32
        || !request
            .revision
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(invalid_payload());
    }
    let write = accounting.track_write();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let _call = call;
        let _write = write;
        let _gate = session.write_gate.lock().await;
        let result = match ensure_ready(&app, &session) {
            Ok(()) => crate::app_global_shortcuts::mutate(
                &app,
                request.revision,
                request.mutation,
                session.revoked.clone(),
            )
            .await
            .map_err(map_error),
            Err(e) => Err(e),
        };
        let _ = tx.send(result);
    });
    rx.await.map_err(|_| {
        BridgeError::new(
            "SETTINGS_APP_SHORTCUT_COMMIT_UNKNOWN",
            "The write result is unknown; reload before retrying",
        )
    })?
}
fn map_error(error: String) -> BridgeError {
    if error.contains("SETTINGS_REVISION_CONFLICT")
        || error.contains(atools_core::db::APP_GLOBAL_SHORTCUT_CONFLICT)
    {
        BridgeError::new(
            "SETTINGS_REVISION_CONFLICT",
            "App shortcuts changed; reload before saving",
        )
    } else if error.contains("AUTOCOPY_UNSUPPORTED") {
        BridgeError::new(
            "SETTINGS_APP_SHORTCUT_AUTOCOPY_UNSUPPORTED",
            "Automatic copy is not supported for App bindings",
        )
    } else if error.contains("BUSY") {
        BridgeError::new(
            "SETTINGS_APP_SHORTCUT_BUSY",
            "Another hotkey operation is active",
        )
    } else {
        BridgeError::new(
            "SETTINGS_APP_SHORTCUT_WRITE_FAILED",
            "App shortcuts could not be updated",
        )
    }
}
