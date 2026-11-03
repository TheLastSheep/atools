//! Child bridge for the fixed legacy login-item resolution flow.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

use crate::general_settings_runtime::login_items::{LegacyLoginChoice, LegacyLoginInspection};

use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    session::SessionView,
    validation::{
        ensure_still_active, exact_object, inactive_session, invalid_payload,
        require_empty_payload, BridgeError,
    },
};

const CONFLICT: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT",
    "Legacy login-item state changed; refresh settings before retrying",
);
const UNAVAILABLE: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE",
    "Legacy login-item state could not be confirmed",
);
const UNSUPPORTED: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED",
    "Legacy login-item resolution is unsupported on this platform",
);
const APPROVAL_REQUIRED: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED",
    "Login item changes require approval in System Settings",
);
const LEGACY_CONFIGURATION: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION",
    "The legacy login item could not be safely resolved",
);
const RECOVERY_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED",
    "Legacy login-item recovery failed; reopen settings before continuing",
);

enum Request {
    Read,
    Inspect,
    Resolve {
        choice: LegacyLoginChoice,
        expected_modern: bool,
        revision: String,
    },
}

pub(crate) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "readLaunchAtLogin" | "inspectLegacyLaunchAtLogin" | "resolveLegacyLaunchAtLogin"
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
    ensure_still_active(&app, &session)?;
    let coordinator = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .map(|state| state.inner().clone())
        .ok_or_else(inactive_session)?;
    // A fresh read or inspection can repair durable OS/filesystem state, so
    // every operation retains write accounting through blocking completion.
    let write_guard = accounting.track_write();
    let (sender, receiver) = oneshot::channel();
    let work_app = app.clone();
    let work_session = session.clone();
    let reply_app = app.clone();
    let reply_session = session.clone();

    tauri::async_runtime::spawn(async move {
        let result = coordinator
            .run(move || async move {
                ensure_still_active(&work_app, &work_session)
                    .map_err(|_| "SETTINGS_SESSION_INACTIVE".to_owned())?;
                let backend_app = work_app.clone();
                let backend = tauri::async_runtime::spawn_blocking(move || {
                    execute_request(backend_app, request)
                })
                .await
                .map_err(|_| "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED".to_owned())??;
                Ok(backend)
            })
            .await;

        let session_active = ensure_still_active(&reply_app, &reply_session).is_ok();
        let result = finalize_reply(session_active, result);
        drop(operation_permit);
        drop(call_guard);
        drop(write_guard);
        let _ = sender.send(result);
    });

    receiver.await.map_err(|_| RECOVERY_FAILED)?
}

fn parse_request(operation: &str, payload: &Value) -> Result<Request, BridgeError> {
    match operation {
        "readLaunchAtLogin" => {
            require_empty_payload(payload)?;
            Ok(Request::Read)
        }
        "inspectLegacyLaunchAtLogin" => {
            require_empty_payload(payload)?;
            Ok(Request::Inspect)
        }
        "resolveLegacyLaunchAtLogin" => parse_resolution(payload),
        _ => Err(invalid_payload()),
    }
}

fn parse_resolution(payload: &Value) -> Result<Request, BridgeError> {
    let object = exact_object(payload, &["choice", "expectedModern", "revision"])?;
    if object.len() != 3 {
        return Err(invalid_payload());
    }
    let choice = match object.get("choice").and_then(Value::as_str) {
        Some("turnOff") => LegacyLoginChoice::TurnOff,
        Some("migrate") => LegacyLoginChoice::Migrate,
        _ => return Err(invalid_payload()),
    };
    let expected_modern = object
        .get("expectedModern")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_payload)?;
    let revision = object
        .get("revision")
        .and_then(Value::as_str)
        .filter(|revision| {
            crate::general_settings_runtime::login_items::valid_legacy_revision(revision)
        })
        .ok_or_else(invalid_payload)?
        .to_owned();
    Ok(Request::Resolve {
        choice,
        expected_modern,
        revision,
    })
}

fn execute_request(app: AppHandle<Wry>, request: Request) -> Result<Value, String> {
    match request {
        Request::Read => {
            let enabled = crate::general_settings_runtime::login_items::read(&app)?;
            Ok(enabled_reply(enabled))
        }
        Request::Inspect => {
            let inspection =
                crate::general_settings_runtime::login_items::inspect_legacy_launch_at_login(&app)?;
            inspection_reply(inspection)
                .map_err(|_| "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE".to_owned())
        }
        Request::Resolve {
            choice,
            expected_modern,
            revision,
        } => {
            let enabled =
                crate::general_settings_runtime::login_items::resolve_legacy_launch_at_login(
                    &app,
                    choice,
                    expected_modern,
                    &revision,
                )?;
            resolution_reply(enabled, choice)
        }
    }
}

fn inspection_reply(inspection: LegacyLoginInspection) -> Result<Value, BridgeError> {
    if !crate::general_settings_runtime::login_items::valid_legacy_revision(&inspection.revision) {
        return Err(UNAVAILABLE);
    }
    serde_json::to_value(inspection).map_err(|_| UNAVAILABLE)
}

fn resolution_reply(enabled: bool, choice: LegacyLoginChoice) -> Result<Value, String> {
    if enabled == choice.target_enabled() {
        Ok(enabled_reply(enabled))
    } else {
        Err("SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE".to_owned())
    }
}

fn enabled_reply(enabled: bool) -> Value {
    json!({"enabled":enabled})
}

fn finalize_reply(
    session_active: bool,
    outcome: Result<Value, String>,
) -> Result<Value, BridgeError> {
    if !session_active {
        return Err(inactive_session());
    }
    outcome.map_err(|error| map_backend_error(&error))
}

fn map_backend_error(error: &str) -> BridgeError {
    match error {
        "SETTINGS_SESSION_INACTIVE" => inactive_session(),
        "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT" => CONFLICT,
        "SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED" => UNSUPPORTED,
        "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED" => APPROVAL_REQUIRED,
        "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION" => LEGACY_CONFIGURATION,
        "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED" => RECOVERY_FAILED,
        "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE" => UNAVAILABLE,
        _ => UNAVAILABLE,
    }
}

#[cfg(test)]
#[path = "legacy_launch_at_login_tests.rs"]
mod tests;
