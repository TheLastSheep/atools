use super::super::intents::Operation;
use super::private_arguments;
use serde_json::json;

#[test]
fn durable_request_accepts_only_the_two_field_private_envelope() {
    let valid = json!({"operation":"open","intentId":"a".repeat(64)});
    let (operation, intent_id) = private_arguments(&valid).unwrap();
    assert_eq!(operation, Operation::Open);
    assert_eq!(intent_id, "a".repeat(64));

    let action = json!({"operation":"action","intentId":"0".repeat(64)});
    assert_eq!(private_arguments(&action).unwrap().0, Operation::Action);
}

#[test]
fn durable_request_rejects_native_options_urls_and_malformed_ids() {
    let id = "b".repeat(64);
    assert!(private_arguments(&json!({
        "operation":"open","intentId":id,"options":{"width":700}
    }))
    .is_err());
    assert!(private_arguments(&json!({
        "operation":"open","intentId":id,"url":"https://example.invalid"
    }))
    .is_err());
    assert!(private_arguments(&json!({"operation":"open","intentId":"A".repeat(64)})).is_err());
    assert!(private_arguments(&json!({"operation":"destroy","intentId":id})).is_err());
}
