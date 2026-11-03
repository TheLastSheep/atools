use super::*;

#[test]
fn host_window_ids_and_private_intent_ids_are_bounded_and_exact() {
    assert!(validate_window_id("frontend_window_42").is_ok());
    assert!(validate_window_id("../window").is_err());
    assert!(validate_window_id(&"x".repeat(97)).is_err());
    assert!(is_private_id(&"a".repeat(64)));
    assert!(!is_private_id(&"A".repeat(64)));
    assert!(!is_private_id(&"a".repeat(63)));
}

#[test]
fn generated_private_intent_tokens_are_64_lowercase_hex_chars() {
    let id = private_id();
    assert!(is_private_id(&id));
}
