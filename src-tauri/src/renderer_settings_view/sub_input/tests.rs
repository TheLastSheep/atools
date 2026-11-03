use std::sync::Arc;

use serde_json::json;

use super::{
    protocol::{parse_control, parse_main_input, require_main_role_labels, InputAction},
    state::{SubInputBuffer, DEFAULT_PLACEHOLDER, MAX_SAFE_INTEGER},
};

const SESSION_ID: &str = "00000000000040008000000000000001";

fn control(action: &str, generation: u64, sequence: u64) -> serde_json::Value {
    match action {
        "set" => json!({
            "action":action,"generation":generation,"sequence":sequence,
            "placeholder":"搜索","focus":true
        }),
        "remove" | "focus" | "blur" | "select" => {
            json!({"action":action,"generation":generation,"sequence":sequence})
        }
        "value" => {
            json!({"action":action,"generation":generation,"sequence":sequence,"value":"program"})
        }
        _ => unreachable!(),
    }
}

fn main_input(generation: u64, value_version: u64, sequence: u64, text: &str) -> serde_json::Value {
    json!({
        "sessionId":SESSION_ID,
        "bundleRevision":"a".repeat(64),
        "generation":generation,
        "valueVersion":value_version,
        "sequence":sequence,
        "text":text
    })
}

#[test]
fn state_transitions_normalize_empty_placeholder_and_keep_remove_value() {
    let input = SubInputBuffer::new();
    let set = parse_control(&json!({
        "action":"set","generation":1,"sequence":1,"placeholder":"","focus":false
    }))
    .unwrap();
    let set = input.apply_control(&set);
    assert!(set.applied);
    assert_eq!(set.action, InputAction::Set);
    assert!(set.snapshot.visible);
    assert_eq!(set.snapshot.placeholder, DEFAULT_PLACEHOLDER);
    assert_eq!(set.snapshot.generation, 1);
    assert_eq!(set.snapshot.revision, 2);

    let value = parse_control(&json!({
        "action":"value","generation":1,"sequence":2,"value":"你好"
    }))
    .unwrap();
    let value = input.apply_control(&value);
    assert!(value.applied);
    assert_eq!(value.snapshot.value, "你好");
    assert_eq!(value.snapshot.value_version, 1);

    let remove = parse_control(&control("remove", 2, 3)).unwrap();
    let remove = input.apply_control(&remove);
    assert!(remove.applied);
    assert!(!remove.snapshot.visible);
    assert_eq!(remove.snapshot.value, "你好");
    assert_eq!(remove.snapshot.generation, 2);
}

#[test]
fn skipped_generations_recover_and_old_owner_controls_are_rejected() {
    let input = SubInputBuffer::new();
    assert!(
        input
            .apply_control(&parse_control(&control("set", 1, 1)).unwrap())
            .applied
    );

    // Generations 2 and 3 were advanced locally while an earlier control could not queue.
    let next_owner = parse_control(&control("set", 4, 2)).unwrap();
    let next_owner = input.apply_control(&next_owner);
    assert!(next_owner.applied);
    assert_eq!(next_owner.snapshot.generation, 4);

    let old_owner = parse_control(&control("value", 1, 3)).unwrap();
    let old_owner = input.apply_control(&old_owner);
    assert!(!old_owner.applied);
    assert_eq!(old_owner.snapshot.generation, 4);
    assert_eq!(old_owner.snapshot.value, "");

    // remove also accepts a forward generation jump after local queue rejection.
    let remove = parse_control(&control("remove", 9, 3)).unwrap();
    let remove = input.apply_control(&remove);
    assert!(remove.applied);
    assert!(!remove.snapshot.visible);
    assert_eq!(remove.snapshot.generation, 9);

    let stale_owner = parse_control(&control("set", 8, 4)).unwrap();
    let stale_owner = input.apply_control(&stale_owner);
    assert!(!stale_owner.applied);
    assert_eq!(stale_owner.snapshot.generation, 9);
}

#[test]
fn user_text_before_programmatic_value_cannot_overwrite_it() {
    let input = SubInputBuffer::new();
    assert!(
        input
            .apply_control(&parse_control(&control("set", 1, 1)).unwrap())
            .applied
    );

    let user = parse_main_input(&main_input(1, 0, 1, "before")).unwrap();
    assert!(input.apply_main_input(&user).applied);

    let program = parse_control(&json!({
        "action":"value","generation":1,"sequence":2,"value":"program"
    }))
    .unwrap();
    let program = input.apply_control(&program);
    assert!(program.applied);
    assert_eq!(program.snapshot.value, "program");
    assert_eq!(program.snapshot.value_version, 1);

    let delayed_user = parse_main_input(&main_input(1, 0, 2, "stale")).unwrap();
    assert!(!input.apply_main_input(&delayed_user).applied);
    assert_eq!(input.snapshot().value, "program");

    let latest_user = parse_main_input(&main_input(1, 1, 3, "after")).unwrap();
    assert!(input.apply_main_input(&latest_user).applied);
    assert_eq!(input.snapshot().value, "after");
    assert_eq!(input.snapshot().value_version, 1);
}

#[test]
fn main_user_sequence_and_visibility_gate_updates() {
    let input = SubInputBuffer::new();
    assert!(
        input
            .apply_control(&parse_control(&control("set", 1, 1)).unwrap())
            .applied
    );
    assert!(
        input
            .apply_control(&parse_control(&control("remove", 2, 2)).unwrap())
            .applied
    );
    assert!(
        !input
            .apply_main_input(&parse_main_input(&main_input(2, 0, 1, "hidden")).unwrap())
            .applied
    );
    assert!(
        input
            .apply_control(&parse_control(&control("set", 3, 3)).unwrap())
            .applied
    );
    assert!(
        input
            .apply_main_input(&parse_main_input(&main_input(3, 0, 3, "new")).unwrap())
            .applied
    );
    assert!(
        !input
            .apply_main_input(&parse_main_input(&main_input(3, 0, 2, "late")).unwrap())
            .applied
    );
    assert_eq!(input.snapshot().value, "new");
}

#[test]
fn close_clears_strings_even_while_old_arc_is_held() {
    let input = Arc::new(SubInputBuffer::new());
    assert!(
        input
            .apply_control(&parse_control(&control("set", 1, 1)).unwrap())
            .applied
    );
    assert!(
        input
            .apply_control(&parse_control(&control("value", 1, 2)).unwrap())
            .applied
    );
    let held = Arc::clone(&input);

    input.close();

    let diagnostics = held.diagnostics();
    assert!(diagnostics.closed);
    assert!(!diagnostics.visible);
    assert_eq!(diagnostics.value_bytes, 0);
    assert_eq!(diagnostics.placeholder_bytes, 0);
    assert_eq!(held.snapshot().value, "");
    let delayed = parse_main_input(&main_input(1, 1, 1, "late")).unwrap();
    let result = held.apply_main_input(&delayed);
    assert!(result.closed);
    assert!(!result.applied);
    assert_eq!(result.snapshot.value, "");
}

#[test]
fn protocol_rejects_unlisted_fields_and_non_safe_counters() {
    assert!(parse_control(&json!({
        "action":"set","generation":1,"sequence":1,"placeholder":"x","focus":true,"owner":"main"
    }))
    .is_err());
    assert!(parse_control(&json!({
        "action":"set","generation":0,"sequence":1,"placeholder":"x","focus":true
    }))
    .is_err());
    assert!(parse_control(&json!({
        "action":"set","generation":1,"sequence":MAX_SAFE_INTEGER + 1,"placeholder":"x","focus":true
    }))
    .is_err());
    assert!(parse_main_input(&main_input(1, 0, 1, "ok")).is_ok());
    assert!(parse_main_input(&json!({
        "sessionId":SESSION_ID,"bundleRevision":"a".repeat(64),"generation":1,"valueVersion":0,
        "sequence":1,"text":"x","source":"settings-child"
    }))
    .is_err());
    assert!(parse_main_input(&json!({
        "sessionId":SESSION_ID,"bundleRevision":"","generation":1,"valueVersion":0,
        "sequence":1,"text":"x"
    }))
    .is_err());
}

#[test]
fn bundle_revision_requires_exactly_64_lowercase_hex_bytes() {
    let too_short = "a".repeat(63);
    let too_long = "a".repeat(65);
    let non_hex = format!("{}g", "a".repeat(63));
    let uppercase = format!("A{}", "a".repeat(63));

    for revision in [too_short, too_long, non_hex, uppercase] {
        let mut request = main_input(1, 0, 1, "ok");
        request["bundleRevision"] = json!(revision);
        assert!(parse_main_input(&request).is_err());
    }
    assert!(parse_main_input(&main_input(1, 0, 1, "ok")).is_ok());
}

#[test]
fn rejects_text_and_placeholder_over_their_utf8_byte_limits() {
    let too_long_text = "x".repeat(16 * 1024 + 1);
    assert!(parse_main_input(&main_input(1, 0, 1, &too_long_text)).is_err());

    let too_long_placeholder = "中".repeat(171);
    assert!(parse_control(&json!({
        "action":"set","generation":1,"sequence":1,"placeholder":too_long_placeholder,"focus":true
    }))
    .is_err());
}

#[test]
fn rejects_payloads_whose_json_encoding_exceeds_the_operation_budget() {
    let escaped = "\0".repeat(5_500);
    let value = json!({
        "action":"value",
        "generation":1,
        "sequence":1,
        "value":escaped
    });
    assert!(parse_control(&value).is_err());
}

#[test]
fn main_only_route_rejects_child_roles() {
    assert!(require_main_role_labels("main", "main", "main").is_ok());
    assert!(require_main_role_labels("ztools-settings-session", "main", "main").is_err());
    assert!(require_main_role_labels("main", "main", "settings").is_err());
}

#[test]
fn diagnostics_expose_only_counters_and_utf8_lengths() {
    let input = SubInputBuffer::new();
    assert!(
        input
            .apply_control(&parse_control(&control("set", 1, 1)).unwrap())
            .applied
    );
    assert!(
        input
            .apply_control(
                &parse_control(&json!({
                    "action":"value","generation":1,"sequence":2,"value":"雪"
                }))
                .unwrap()
            )
            .applied
    );

    let diagnostics = input.diagnostics();
    assert!(!diagnostics.closed);
    assert!(diagnostics.visible);
    assert_eq!(diagnostics.generation, 1);
    assert_eq!(diagnostics.control_sequence, 2);
    assert_eq!(diagnostics.revision, 3);
    assert_eq!(diagnostics.value_version, 1);
    assert_eq!(diagnostics.value_bytes, "雪".len());
    assert_eq!(diagnostics.placeholder_bytes, "搜索".len());
}

#[tokio::test]
async fn operation_gate_serializes_each_delivery_until_the_prior_one_finishes() {
    let input = Arc::new(SubInputBuffer::new());
    let first = input.serialize_operations().await;
    let (sender, mut receiver) = tokio::sync::oneshot::channel();
    let queued_input = Arc::clone(&input);
    let queued = tokio::spawn(async move {
        let _second = queued_input.serialize_operations().await;
        let _ = sender.send(());
    });

    assert!(receiver.try_recv().is_err());
    drop(first);
    receiver.await.unwrap();
    queued.await.unwrap();
}
