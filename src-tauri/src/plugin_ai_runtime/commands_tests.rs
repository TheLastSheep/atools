use super::within_request_limit;
use crate::plugin_ai_runtime::types::MAX_REQUEST_BYTES;
use serde_json::Value;

#[test]
fn serialized_request_limit_accepts_exact_boundary_without_copying_past_it() {
    assert!(within_request_limit(&Value::String("x".repeat(MAX_REQUEST_BYTES - 2))).unwrap());
    assert!(!within_request_limit(&Value::String("x".repeat(MAX_REQUEST_BYTES - 1))).unwrap());
    assert!(!within_request_limit(&Value::String("\u{1}".repeat(MAX_REQUEST_BYTES / 6))).unwrap());
}
