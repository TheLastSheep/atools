use serde_json::json;

use super::{close_reason, map_preferences_error, require_empty_payload};

#[test]
fn accepts_only_the_empty_object_for_no_argument_operations() {
    assert!(require_empty_payload(&json!({})).is_ok());
    assert!(require_empty_payload(&json!(null)).is_err());
    assert!(require_empty_payload(&json!({"unexpected":true})).is_err());
}

#[test]
fn close_reason_preserves_child_out_and_escape() {
    assert_eq!(
        close_reason(&json!({"reason":"child-out"})).unwrap(),
        "child-out"
    );
    assert_eq!(close_reason(&json!({"reason":"escape"})).unwrap(), "escape");
    assert!(close_reason(&json!({"reason":"main-hide"})).is_err());
    assert!(close_reason(&json!({"reason":"escape","extra":true})).is_err());
}

#[test]
fn maps_opacity_recovery_failure_to_a_fixed_user_safe_error() {
    let error = map_preferences_error("SETTINGS_OPACITY_RECOVERY_FAILED".into());
    assert_eq!(error.code, "SETTINGS_OPACITY_RECOVERY_FAILED");
    assert_eq!(
        error.message,
        "Window opacity recovery failed; check the window state before continuing"
    );

    let generic = map_preferences_error("SETTINGS_PATCH_FAILED".into());
    assert_eq!(generic.code, "SETTINGS_PATCH_FAILED");
    assert_eq!(generic.message, "General settings could not be saved");

    let native = map_preferences_error("SETTINGS_NATIVE_RECOVERY_FAILED".into());
    assert_eq!(native.code, "SETTINGS_NATIVE_RECOVERY_FAILED");
    assert_eq!(
        native.message,
        "Native settings recovery failed; reopen settings before continuing"
    );

    let rejected = map_preferences_error("SETTINGS_HOTKEY_REJECTED".into());
    assert_eq!(rejected.code, "SETTINGS_HOTKEY_REJECTED");
    assert_eq!(
        rejected.message,
        "Primary shortcut could not be registered; check for conflicts and try again"
    );
}

#[test]
fn accepts_production_and_loopback_main_roots() {
    for value in [
        "tauri://localhost/",
        "http://localhost:1420/",
        "http://127.0.0.1:1420/",
        "http://[::1]:1420/",
        "https://tauri.localhost/",
    ] {
        assert!(validate_main_root(value), "rejected {value}");
    }

    for value in [
        "https://example.test/",
        "http://localhost:1420/index.html",
        "http://localhost:1420/?query=1",
        "http://localhost:1421/",
        "http://127.0.0.1:1421/",
    ] {
        assert!(!validate_main_root(value), "accepted {value}");
    }
}

fn validate_main_root(value: &str) -> bool {
    let configured_dev_url = tauri::Url::parse("http://localhost:1420/").unwrap();
    super::is_local_root_url(
        &tauri::Url::parse(value).unwrap(),
        Some(&configured_dev_url),
    )
}

#[test]
fn double_modifier_preflight_codes_preserve_user_actionable_errors() {
    for code in [
        "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED",
        "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED",
    ] {
        assert_eq!(map_preferences_error(code.into()).code, code);
    }
}
