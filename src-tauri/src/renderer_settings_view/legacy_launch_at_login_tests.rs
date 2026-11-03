use serde_json::{json, Value};

use super::{
    finalize_reply, handles, inspection_reply, map_backend_error, parse_request, resolution_reply,
    Request,
};
use crate::general_settings_runtime::login_items::{LegacyLoginChoice, LegacyLoginInspection};

#[test]
fn operation_names_and_empty_inspection_payload_are_exact() {
    assert!(handles("readLaunchAtLogin"));
    assert!(handles("inspectLegacyLaunchAtLogin"));
    assert!(handles("resolveLegacyLaunchAtLogin"));
    assert!(!handles("setLaunchAtLogin"));
    assert!(matches!(
        parse_request("readLaunchAtLogin", &json!({})),
        Ok(Request::Read)
    ));
    for invalid in [json!(null), json!({"force":true}), json!([])] {
        assert!(parse_request("readLaunchAtLogin", &invalid).is_err());
    }
    assert!(matches!(
        parse_request("inspectLegacyLaunchAtLogin", &json!({})),
        Ok(Request::Inspect)
    ));
    for invalid in [json!(null), json!({"path":"/tmp/item"}), json!([])] {
        assert!(parse_request("inspectLegacyLaunchAtLogin", &invalid).is_err());
    }
}

#[test]
fn resolution_payload_accepts_only_exact_choice_expected_and_revision() {
    let revision = "a".repeat(64);
    assert!(matches!(
        parse_request(
            "resolveLegacyLaunchAtLogin",
            &json!({"choice":"turnOff","expectedModern":true,"revision":revision})
        ),
        Ok(Request::Resolve {
            choice: LegacyLoginChoice::TurnOff,
            expected_modern: true,
            ..
        })
    ));
    for invalid in [
        json!({"choice":"Migrate","expectedModern":false,"revision":"a".repeat(64)}),
        json!({"choice":"migrate","expectedModern":0,"revision":"a".repeat(64)}),
        json!({"choice":"migrate","expectedModern":false,"revision":"A".repeat(64)}),
        json!({"choice":"migrate","expectedModern":false,"revision":"a".repeat(63)}),
        json!({"choice":"migrate","expectedModern":false,"revision":"a".repeat(64),"path":"x"}),
        json!({"choice":"migrate","revision":"a".repeat(64)}),
        Value::Null,
    ] {
        assert!(parse_request("resolveLegacyLaunchAtLogin", &invalid).is_err());
    }
    assert!(parse_request("unknown", &json!({})).is_err());
}

#[test]
fn replies_require_confirmed_revision_and_selected_target() {
    let inspection = LegacyLoginInspection {
        modern_enabled: true,
        revision: "b".repeat(64),
    };
    assert_eq!(
        inspection_reply(inspection).unwrap(),
        json!({"modernEnabled":true,"revision":"b".repeat(64)})
    );
    assert!(inspection_reply(LegacyLoginInspection {
        modern_enabled: false,
        revision: "bad".into(),
    })
    .is_err());
    assert_eq!(
        resolution_reply(false, LegacyLoginChoice::TurnOff).unwrap(),
        json!({"enabled":false})
    );
    assert_eq!(
        resolution_reply(true, LegacyLoginChoice::Migrate).unwrap(),
        json!({"enabled":true})
    );
    assert!(resolution_reply(true, LegacyLoginChoice::TurnOff).is_err());
    assert!(resolution_reply(false, LegacyLoginChoice::Migrate).is_err());
}

#[test]
fn fresh_read_reply_is_exact_and_preserves_safe_backend_errors() {
    assert_eq!(super::enabled_reply(false), json!({"enabled":false}));
    let approval = finalize_reply(
        true,
        Err("SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED".to_owned()),
    )
    .unwrap_err();
    assert_eq!(
        serde_json::to_value(approval).unwrap()["code"],
        "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED"
    );
    let unknown = finalize_reply(true, Err("untrusted detail".to_owned())).unwrap_err();
    assert_eq!(
        serde_json::to_value(unknown).unwrap()["code"],
        "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE"
    );
    let legacy = finalize_reply(
        true,
        Err("SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION".to_owned()),
    )
    .unwrap_err();
    assert_eq!(
        serde_json::to_value(legacy).unwrap()["code"],
        "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION"
    );
}

#[test]
fn inactive_session_never_receives_late_success_and_backend_errors_are_fixed() {
    assert_eq!(
        finalize_reply(true, Ok(super::enabled_reply(false))).unwrap(),
        json!({"enabled":false})
    );
    assert_eq!(
        serde_json::to_value(finalize_reply(false, Ok(super::enabled_reply(false))).unwrap_err())
            .unwrap()["code"],
        "SETTINGS_SESSION_INACTIVE"
    );
    for (backend, expected) in [
        (
            "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT",
            "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT",
        ),
        (
            "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE",
            "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE",
        ),
        (
            "SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED",
            "SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED",
        ),
        (
            "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED",
            "SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED",
        ),
        (
            "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION",
            "SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION",
        ),
        (
            "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED",
            "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED",
        ),
    ] {
        assert_eq!(
            serde_json::to_value(map_backend_error(backend)).unwrap()["code"],
            expected
        );
    }
    assert_eq!(
        serde_json::to_value(map_backend_error("private path or diagnostic")).unwrap()["code"],
        "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE"
    );
}
