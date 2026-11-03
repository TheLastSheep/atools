use super::*;
use serde_json::json;

#[test]
fn bounded_request_counter_accepts_the_exact_limit_and_rejects_the_next_byte() {
    let empty = json!({"value":""});
    let fixed_bytes = serde_json::to_vec(&empty).unwrap().len();
    let exact = json!({"value":"x".repeat(MAX_OPERATION_BYTES - fixed_bytes)});
    let oversized = json!({"value":"x".repeat(MAX_OPERATION_BYTES - fixed_bytes + 1)});

    assert_eq!(
        bounded_json_serialized_size(&exact, MAX_OPERATION_BYTES),
        Some(MAX_OPERATION_BYTES)
    );
    assert_eq!(
        bounded_json_serialized_size(&oversized, MAX_OPERATION_BYTES),
        None
    );
    assert!(check_payload_budget(&exact).is_ok());
    let error = check_payload_budget(&oversized).unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "SETTINGS_CALL_TOO_LARGE"
    );
}
