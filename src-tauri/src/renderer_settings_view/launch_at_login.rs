//! Session-bound bridge for the host's OS login item.

use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::{oneshot, OwnedSemaphorePermit};

use super::{
    accounting::{RuntimeAccounting, RuntimeActivityGuard},
    session::SessionView,
    validation::{
        ensure_still_active, exact_object, inactive_session, invalid_payload, BridgeError,
    },
};

const CONFLICT: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT",
    "Login item state changed; reopen settings and try again",
);
const UNAVAILABLE: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE",
    "Login item state could not be confirmed",
);
const UNSUPPORTED: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED",
    "Login item changes are unsupported on this platform",
);
const APPROVAL_REQUIRED: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED",
    "Login item changes require approval in System Settings",
);
const LEGACY_CONFIGURATION: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION",
    "An existing login item configuration must be resolved before changes can be made",
);
const RECOVERY_FAILED: BridgeError = BridgeError::new(
    "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED",
    "Login item state recovery failed; reopen settings before continuing",
);

struct Mutation {
    enabled: bool,
    expected: bool,
}

pub(crate) fn handles(operation: &str) -> bool {
    operation == "setLaunchAtLogin"
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
    ensure_still_active(&app, &session)?;
    let coordinator = app
        .try_state::<crate::general_settings_runtime::GeneralSettingsCoordinator>()
        .map(|state| state.inner().clone())
        .ok_or_else(inactive_session)?;
    let write_guard = accounting.track_write();
    let (sender, receiver) = oneshot::channel();
    let work_app = app.clone();
    let work_session = session.clone();
    let reply_app = app.clone();
    let reply_session = session.clone();
    let requested = mutation.enabled;
    let expected = mutation.expected;

    tauri::async_runtime::spawn(async move {
        let result = coordinator
            .run(move || async move {
                ensure_still_active(&work_app, &work_session)
                    .map_err(|_| "SETTINGS_SESSION_INACTIVE".to_owned())?;
                let backend_app = work_app.clone();
                let actual = tauri::async_runtime::spawn_blocking(move || {
                    crate::general_settings_runtime::login_items::read_apply(
                        &backend_app,
                        Some(expected),
                        Some(requested),
                    )
                })
                .await
                .map_err(|_| "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED".to_owned())??;
                if actual != requested {
                    return Err("SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE".to_owned());
                }
                Ok(actual)
            })
            .await;

        let session_active = ensure_still_active(&reply_app, &reply_session).is_ok();
        let result = finalize_reply(session_active, result, requested);
        drop(operation_permit);
        drop(call_guard);
        drop(write_guard);
        let _ = sender.send(result);
    });

    receiver.await.map_err(|_| RECOVERY_FAILED)?
}

fn parse_mutation(payload: &Value) -> Result<Mutation, BridgeError> {
    let object = exact_object(payload, &["enabled", "expected"])?;
    if object.len() != 2 {
        return Err(invalid_payload());
    }
    let enabled = object
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_payload)?;
    let expected = object
        .get("expected")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_payload)?;
    Ok(Mutation { enabled, expected })
}

fn success_reply(enabled: bool) -> Value {
    json!({"enabled":enabled})
}

fn finalize_reply(
    session_active: bool,
    outcome: Result<bool, String>,
    expected_enabled: bool,
) -> Result<Value, BridgeError> {
    if !session_active {
        return Err(inactive_session());
    }
    let enabled = match outcome {
        Ok(enabled) if enabled == expected_enabled => enabled,
        Ok(_) => return Err(UNAVAILABLE),
        Err(error) => return Err(map_backend_error(&error)),
    };
    Ok(success_reply(enabled))
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
mod tests {
    use serde_json::{json, Value};

    use super::{finalize_reply, map_backend_error, parse_mutation, success_reply};

    #[test]
    fn accepts_only_exact_boolean_expected_and_target_fields() {
        let parsed = parse_mutation(&json!({"enabled":true,"expected":false})).unwrap();
        assert!(parsed.enabled);
        assert!(!parsed.expected);
        for invalid in [
            json!({"enabled":1,"expected":false}),
            json!({"enabled":true,"expected":null}),
            json!({"enabled":true}),
            json!({"enabled":true,"expected":false,"path":"/tmp/item"}),
            Value::Null,
        ] {
            assert!(parse_mutation(&invalid).is_err());
        }
    }

    #[test]
    fn replies_with_only_the_actual_enabled_fact_and_maps_fixed_backend_failures() {
        assert_eq!(success_reply(true), json!({"enabled":true}));
        assert_eq!(
            serde_json::to_value(map_backend_error("SETTINGS_LAUNCH_AT_LOGIN_CONFLICT")).unwrap()
                ["code"],
            "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT"
        );
        assert_eq!(
            serde_json::to_value(map_backend_error("SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED"))
                .unwrap()["code"],
            "SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED"
        );
        assert_eq!(
            serde_json::to_value(map_backend_error(
                "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED"
            ))
            .unwrap()["code"],
            "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED"
        );
        assert_eq!(
            serde_json::to_value(map_backend_error(
                "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION"
            ))
            .unwrap()["code"],
            "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION"
        );
        assert_eq!(
            serde_json::to_value(map_backend_error("untrusted backend diagnostic")).unwrap()
                ["code"],
            "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE"
        );
    }

    #[test]
    fn late_result_from_an_inactive_session_never_returns_the_actual_write() {
        let result = finalize_reply(true, Ok(true), true).unwrap();
        assert_eq!(result, json!({"enabled":true}));
        let late = finalize_reply(false, Ok(true), true).unwrap_err();
        assert_eq!(
            serde_json::to_value(late).unwrap()["code"],
            "SETTINGS_SESSION_INACTIVE"
        );
    }
}
