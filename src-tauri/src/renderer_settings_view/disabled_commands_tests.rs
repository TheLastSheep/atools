use super::*;
use serde_json::json;
use tokio::sync::Semaphore;

#[test]
fn write_payload_preserves_unknown_ids_order_and_duplicates() {
    let payload = json!({
        "baseToken":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "value":["legacy-name:text", "plugin:feature:command:window", "legacy-name:text"]
    });
    let parsed = parse_mutation(&payload).unwrap();
    assert_eq!(parsed.base_token, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    assert_eq!(
        parsed.value,
        json!([
            "legacy-name:text",
            "plugin:feature:command:window",
            "legacy-name:text"
        ])
    );
}

#[test]
fn write_payload_requires_the_exact_fixed_shape_and_nonempty_string_ids() {
    for payload in [
        json!({"baseToken":"token","value":[] ,"extra":true}),
        json!({"baseToken":"token"}),
        json!({"baseToken":"token","value":null}),
        json!({"baseToken":"token","value":[""]}),
        json!({"baseToken":"token","value":[1]}),
        json!({"baseToken":"","value":[]}),
    ] {
        assert!(parse_mutation(&payload).is_err(), "accepted {payload}");
    }
}

#[test]
fn write_payload_enforces_id_count_utf8_bytes_and_encoded_value_budget() {
    let at_limit = json!({
        "baseToken":"token",
        "value":std::iter::repeat("unknown:id").take(MAX_COMMAND_IDS).collect::<Vec<_>>()
    });
    assert!(parse_mutation(&at_limit).is_ok());

    let over_count = json!({
        "baseToken":"token",
        "value":std::iter::repeat("unknown:id").take(MAX_COMMAND_IDS + 1).collect::<Vec<_>>()
    });
    assert!(parse_mutation(&over_count).is_err());

    let byte_limit = json!({"baseToken":"token","value":["汉".repeat(5482)]});
    assert!(parse_mutation(&byte_limit).is_ok());
    let over_byte_limit = json!({"baseToken":"token","value":["汉".repeat(5483)]});
    assert!(parse_mutation(&over_byte_limit).is_err());

    let over_value_budget = json!({
        "baseToken":"token",
        "value":vec!["x".repeat(MAX_COMMAND_ID_BYTES - 64); 8]
    });
    let error = parse_mutation(&over_value_budget).unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "SETTINGS_CALL_TOO_LARGE"
    );
}

#[test]
fn request_envelope_stays_within_the_additional_256_byte_budget() {
    let within = json!({"baseToken":"t".repeat(128),"value":[]});
    assert!(check_payload_budget(&within).is_ok());

    let beyond = json!({"baseToken":"t".repeat(MAX_OPERATION_BYTES),"value":[]});
    let error = check_payload_budget(&beyond).unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "SETTINGS_CALL_TOO_LARGE"
    );
}

#[test]
fn core_errors_map_to_fixed_safe_codes() {
    assert_eq!(
        serde_json::to_value(map_mutation_error(&AToolsError::Config(
            RENDERER_DISABLED_COMMANDS_GUARD_REJECTED.into()
        )))
        .unwrap()["code"],
        "SETTINGS_SESSION_INACTIVE"
    );
    assert_eq!(
        serde_json::to_value(map_mutation_error(&AToolsError::Config(
            RENDERER_DISABLED_COMMANDS_CONFLICT.into()
        )))
        .unwrap()["code"],
        "SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT"
    );
    assert_eq!(
        serde_json::to_value(map_mutation_error(&AToolsError::Config(
            "private database detail".into()
        )))
        .unwrap()["code"],
        "SETTINGS_DISABLED_COMMANDS_FAILED"
    );

    let directory = tempfile::tempdir().unwrap();
    let invalid_path = directory.path().join("missing-parent").join("data.sqlite");
    let storage_error = match Database::open(&invalid_path) {
        Ok(_) => panic!("database unexpectedly opened below a missing directory"),
        Err(error) => error,
    };
    assert_eq!(
        serde_json::to_value(map_mutation_error(&storage_error)).unwrap()["code"],
        "SETTINGS_DISABLED_COMMANDS_COMMIT_UNKNOWN"
    );
}

#[test]
fn session_guard_rejects_unready_closing_revoked_or_replaced_sessions() {
    let live = DisabledCommandsSessionState {
        id: "session-a".into(),
        label: "ztools-settings-session-a".into(),
        bundle_revision: "revision-a".into(),
        revoked: false,
        phase: SessionPhase::Open,
        ready: true,
        can_serve: true,
    };
    assert!(session_state_matches(live.clone(), Some(live.clone())));
    for stale in [
        DisabledCommandsSessionState {
            revoked: true,
            ..live.clone()
        },
        DisabledCommandsSessionState {
            phase: SessionPhase::Closing,
            ..live.clone()
        },
        DisabledCommandsSessionState {
            ready: false,
            ..live.clone()
        },
        DisabledCommandsSessionState {
            can_serve: false,
            ..live.clone()
        },
        DisabledCommandsSessionState {
            id: "session-b".into(),
            ..live.clone()
        },
        DisabledCommandsSessionState {
            label: "other-child".into(),
            ..live.clone()
        },
        DisabledCommandsSessionState {
            bundle_revision: "revision-b".into(),
            ..live.clone()
        },
    ] {
        assert!(!session_state_matches(live.clone(), Some(stale)));
    }
    assert!(!session_state_matches(live, None));
}

#[test]
fn no_change_does_not_emit_and_changed_commit_reports_delivery_truthfully() {
    let mut emitted = false;
    assert!(!notify_if_changed(false, || {
        emitted = true;
        true
    }));
    assert!(!emitted);
    assert!(notify_if_changed(true, || true));
    assert!(!notify_if_changed(true, || false));
}

#[test]
fn disabled_command_notification_targets_only_the_main_webview() {
    assert_eq!(
        disabled_commands_event_target(),
        EventTarget::Webview {
            label: "main".into()
        }
    );
}

#[test]
fn success_reply_contains_only_the_frozen_fields() {
    assert_eq!(
        success_reply(RendererDisabledCommandsWrite { changed: true }, true),
        json!({
            "version":1,
            "success":true,
            "changed":true,
            "notificationDelivered":true
        })
    );
}

#[tokio::test]
async fn detached_write_keeps_accounting_and_operation_slot_until_work_finishes() {
    let accounting = RuntimeAccounting::shared();
    let semaphore = std::sync::Arc::new(Semaphore::new(1));
    let operation_permit = std::sync::Arc::clone(&semaphore)
        .acquire_owned()
        .await
        .unwrap();
    let call_guard = accounting.track_call();
    let write_guard = accounting.track_write();
    let (sender, receiver) = tokio::sync::oneshot::channel::<()>();
    let (started_sender, started_receiver) = tokio::sync::oneshot::channel::<()>();
    let (finish_sender, finish_receiver) = tokio::sync::oneshot::channel::<()>();

    spawn_owned_write(
        async move {
            let _ = started_sender.send(());
            let _ = finish_receiver.await;
        },
        sender,
        operation_permit,
        call_guard,
        write_guard,
    );
    drop(receiver);
    started_receiver.await.unwrap();
    assert_eq!(
        accounting.snapshot(),
        crate::renderer_settings_view::accounting::ActivitySnapshot {
            pending_calls: 1,
            pending_writes: 1
        }
    );
    assert_eq!(semaphore.available_permits(), 0);

    finish_sender.send(()).unwrap();
    accounting.wait_for_writes_to_finish().await;
    assert_eq!(
        accounting.snapshot(),
        crate::renderer_settings_view::accounting::ActivitySnapshot::default()
    );
    assert_eq!(semaphore.available_permits(), 1);
}
