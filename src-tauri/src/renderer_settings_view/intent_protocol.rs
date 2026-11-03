//! Fixed, bounded native intent consumption protocol.
use super::{
    open_claims::{ClaimId, MainKey, SessionKey},
    validation::{invalid_payload, BridgeError},
};
use serde_json::Value;
use tokio::sync::oneshot;

pub(crate) const ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
pub(crate) const MAX_SEQUENCE: u64 = 9_007_199_254_740_991;

pub(crate) struct PendingIntent {
    pub(crate) id: String,
    pub(crate) sequence: u64,
    pub(crate) session: SessionKey,
    pub(crate) claim: ClaimId,
    pub(crate) main: MainKey,
    pub(crate) reply: oneshot::Sender<bool>,
}

pub(crate) struct IntentAck {
    pub(crate) id: String,
    pub(crate) sequence: u64,
    pub(crate) accepted: bool,
}

pub(crate) fn parse_ack(value: &Value) -> Result<IntentAck, BridgeError> {
    // Inspect only the closed fixed fields before any clone/serialization.
    // An oversized string or nested attacker value is rejected without creating
    // another allocation proportional to that value on this quota-free path.
    let object = value
        .as_object()
        .filter(|object| object.len() == 3)
        .ok_or_else(invalid_payload)?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| {
            id.len() == 32
                && id
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(invalid_payload)?;
    let sequence = object
        .get("sequence")
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= MAX_SEQUENCE)
        .ok_or_else(invalid_payload)?;
    let accepted = object
        .get("accepted")
        .and_then(Value::as_bool)
        .ok_or_else(invalid_payload)?;
    Ok(IntentAck {
        id: id.to_owned(),
        sequence,
        accepted,
    })
}

pub(crate) fn is_shortcuts_route(url: &tauri::Url, session_id: &str) -> bool {
    super::identity::is_expected_settings_url(url, session_id)
        && url
            .fragment()
            .is_some_and(|f| f == "/shortcuts" || f.starts_with("/shortcuts?_t="))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn accepted_ack_requires_shortcuts_but_refusal_allows_other_legal_routes() {
        let id = "00000000000040008000000000000001";
        let url = |route| {
            tauri::Url::parse(&format!(
                "atools-settings://{id}.localhost/index.html#{route}"
            ))
            .unwrap()
        };
        assert!(is_shortcuts_route(&url("/shortcuts"), id));
        assert!(is_shortcuts_route(&url("/shortcuts?_t=1"), id));
        assert!(!is_shortcuts_route(&url("/about"), id));
        assert!(super::super::identity::is_expected_settings_url(
            &url("/about"),
            id
        ));
        assert!(!is_shortcuts_route(&url("/shortcuts?_t=01"), id));
    }

    #[test]
    fn oversize_and_nested_ack_fields_reject_before_copying_payload() {
        let valid = json!({"id":"a".repeat(32),"sequence":1,"accepted":true});
        let oversized = Value::String("a".repeat(1024 * 1024));
        let nested = json!({"unexpected":[{"nested":"a".repeat(1024 * 1024)}]});
        for field in ["id", "sequence", "accepted"] {
            for invalid in [&oversized, &nested] {
                let mut packet = valid.clone();
                packet[field] = invalid.clone();
                assert!(parse_ack(&packet).is_err(), "invalid field {field}");
            }
        }
        let mut unexpected = valid;
        unexpected["extra"] = nested;
        assert!(parse_ack(&unexpected).is_err());
    }

    #[test]
    fn ack_is_an_exact_fixed_safe_integer_packet() {
        let valid = json!({"id":"a".repeat(32),"sequence":1,"accepted":true});
        assert!(parse_ack(&valid).is_ok());
        for value in [
            json!({"id":"a".repeat(32),"sequence":MAX_SEQUENCE+1,"accepted":true}),
            json!({"id":"A".repeat(32),"sequence":1,"accepted":true}),
            json!({"id":"a".repeat(32),"sequence":1.5,"accepted":true}),
            json!({"id":"a".repeat(32),"sequence":1,"accepted":true,"sessionId":"forged"}),
            json!({"id":"a".repeat(32),"sequence":1}),
        ] {
            assert!(parse_ack(&value).is_err());
        }
    }
}
