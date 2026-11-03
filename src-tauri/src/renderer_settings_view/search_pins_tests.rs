use super::*;
use serde_json::json;

#[test]
fn pin_and_unpin_accept_only_the_frozen_wire_shapes() {
    assert_eq!(
        parse_mutation(&json!({
            "operation":"pin",
            "app":{"path":"/Applications/Editor.app","name":"Editor"}
        }))
        .unwrap(),
        RendererAppStateMutation::Pin {
            app: RendererAppIdentity {
                path: "/Applications/Editor.app".into(),
                name: "Editor".into(),
                sub_type: RendererDirectSubtype::App,
            }
        }
    );
    assert_eq!(
        parse_mutation(&json!({"operation":"unpin","path":"/Applications/Editor.app","name":null}))
            .unwrap(),
        RendererAppStateMutation::Unpin {
            path: "/Applications/Editor.app".into(),
            name: None,
        }
    );
    assert_eq!(
        parse_mutation(
            &json!({"operation":"unpin","path":"/Applications/Editor.app","name":"Editor"})
        )
        .unwrap(),
        RendererAppStateMutation::Unpin {
            path: "/Applications/Editor.app".into(),
            name: Some("Editor".into()),
        }
    );
}

#[test]
fn pin_identity_accepts_the_local_shortcut_subtype_and_keeps_app_as_default() {
    let local = parse_mutation(&json!({
        "operation":"pin",
        "app":{"path":"/tmp/fixture.txt","name":"Fixture","subType":"local-shortcut"}
    }))
    .unwrap();
    assert_eq!(
        local,
        RendererAppStateMutation::Pin {
            app: RendererAppIdentity {
                path: "/tmp/fixture.txt".into(),
                name: "Fixture".into(),
                sub_type: RendererDirectSubtype::LocalShortcut,
            }
        }
    );
    let old_wire = parse_mutation(&json!({
        "operation":"pin",
        "app":{"path":"/Applications/Editor.app","name":"Editor"}
    }))
    .unwrap();
    assert_eq!(
        old_wire,
        RendererAppStateMutation::Pin {
            app: RendererAppIdentity {
                path: "/Applications/Editor.app".into(),
                name: "Editor".into(),
                sub_type: RendererDirectSubtype::App,
            }
        }
    );
    assert!(parse_mutation(&json!({
        "operation":"pin",
        "app":{"path":"/tmp/fixture.txt","name":"Fixture","subType":"other"}
    }))
    .is_err());
}

#[test]
fn pin_parser_rejects_unknown_fields_and_invalid_nulls() {
    for payload in [
        json!({"operation":"pin","app":{"path":"/Applications/Editor.app","name":"Editor"},"extra":true}),
        json!({"operation":"pin","app":{"path":"/Applications/Editor.app","name":"Editor","extra":true}}),
        json!({"operation":"unpin","path":"/Applications/Editor.app","name":null,"extra":true}),
        json!({"operation":"unpin","path":"/Applications/Editor.app","name":7}),
        json!({"operation":"unpin","path":"/Applications/Editor.app"}),
        json!({"operation":"other","path":"/Applications/Editor.app","name":null}),
    ] {
        assert!(parse_mutation(&payload).is_err(), "accepted {payload}");
    }
}

#[test]
fn pin_parser_applies_the_full_json_operation_byte_limit() {
    let payload = json!({
        "operation":"pin",
        "app":{"path":"/Applications/Editor.app","name":"x".repeat(MAX_OPERATION_BYTES)}
    });
    let error = parse_mutation(&payload).unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "SETTINGS_CALL_TOO_LARGE"
    );
}

#[test]
fn mutation_reply_exposes_only_version_and_safe_revision() {
    let reply = committed_reply(RendererAppStateSnapshot {
        version: 1,
        revision: 42,
        values: Default::default(),
        changed: vec!["pinned-commands".into()],
    })
    .unwrap();
    assert_eq!(reply, json!({"version":1,"revision":42}));

    let error = committed_reply(RendererAppStateSnapshot {
        version: 1,
        revision: MAX_SAFE_INTEGER + 1,
        values: Default::default(),
        changed: Vec::new(),
    })
    .unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "SETTINGS_SEARCH_PIN_COMMIT_UNKNOWN"
    );
}

#[test]
fn mutation_errors_distinguish_rejected_guard_and_unknown_storage_commit() {
    let buffers = CommandDataBuffers::new("session-a".into(), "bundle-a".into());
    let old = serde_json::to_vec(&json!({"pinned-commands":[{"path":"/old"}]})).unwrap();
    let token = buffers.store_command_settings(old).unwrap();

    let guard_error =
        AToolsError::Config(atools_core::db::RENDERER_APP_STATE_GUARD_REJECTED.to_owned());
    let mapped = map_mutation_error(&guard_error, &buffers);
    assert_eq!(
        serde_json::to_value(mapped).unwrap()["code"],
        "SETTINGS_SESSION_INACTIVE"
    );
    assert_eq!(
        buffers.command_settings_token().unwrap().as_deref(),
        Some(token.as_str())
    );

    let explicit_error = AToolsError::Config("invalid mutation".into());
    let mapped = map_mutation_error(&explicit_error, &buffers);
    assert_eq!(
        serde_json::to_value(mapped).unwrap()["code"],
        "SETTINGS_SEARCH_PIN_FAILED"
    );
    assert_eq!(
        buffers.command_settings_token().unwrap().as_deref(),
        Some(token.as_str())
    );

    let directory = tempfile::tempdir().unwrap();
    let invalid_path = directory.path().join("missing-parent").join("data.db");
    let storage_error = match atools_core::db::Database::open(&invalid_path) {
        Ok(_) => panic!("database unexpectedly opened below a missing directory"),
        Err(error) => error,
    };
    let mapped = map_mutation_error(&storage_error, &buffers);
    assert_eq!(
        serde_json::to_value(mapped).unwrap()["code"],
        "SETTINGS_SEARCH_PIN_COMMIT_UNKNOWN"
    );
    assert_eq!(buffers.command_settings_token().unwrap(), None);
}

#[test]
fn session_guard_rejects_closed_unready_or_replaced_sessions() {
    let live = PinSessionState {
        id: "session-a",
        label: "settings-a",
        bundle_revision: "revision-a",
        revoked: false,
        phase: SessionPhase::Open,
        ready: true,
        can_serve: true,
    };
    assert!(session_state_matches(live, Some(live)));
    assert!(!session_state_matches(
        live,
        Some(PinSessionState {
            revoked: true,
            ..live
        })
    ));
    assert!(!session_state_matches(
        live,
        Some(PinSessionState {
            phase: SessionPhase::Closing,
            ..live
        })
    ));
    assert!(!session_state_matches(
        live,
        Some(PinSessionState {
            ready: false,
            ..live
        })
    ));
    assert!(!session_state_matches(
        live,
        Some(PinSessionState {
            can_serve: false,
            ..live
        })
    ));
    assert!(!session_state_matches(
        live,
        Some(PinSessionState {
            id: "session-b",
            ..live
        })
    ));
    assert!(!session_state_matches(live, None));
}
