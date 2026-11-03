use super::*;
#[test]
fn recording_operation_generation_is_strict_bounded_and_not_coerced() {
    assert_eq!(generation(&json!({"generation":1})).unwrap(), 1);
    assert_eq!(
        generation(&json!({"generation":recording::MAX_GENERATION})).unwrap(),
        recording::MAX_GENERATION
    );
    for payload in [
        json!({}),
        json!({"generation":0}),
        json!({"generation":-1}),
        json!({"generation":1.5}),
        json!({"generation":"1"}),
        json!({"generation":recording::MAX_GENERATION+1}),
        json!({"generation":1,"shortcut":"Ctrl+Q"}),
    ] {
        assert!(generation(&payload).is_err(), "{payload}");
    }
}
#[test]
fn recording_ack_contains_only_contract_fields_with_null_inactive_mode() {
    let ack = recording::Ack {
        version: 1,
        session_id: "s".into(),
        generation: 5,
        active: false,
        mode: None,
    };
    let value = serde_json::to_value(ack).unwrap();
    assert_eq!(
        value,
        json!({"version":1,"sessionId":"s","generation":5,"active":false,"mode":null})
    );
}
