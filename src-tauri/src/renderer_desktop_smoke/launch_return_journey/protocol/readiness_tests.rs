use super::{ProbeReadyDisposition, ProbeReadyReason, ProbeReadyReceipt, ProbeReadyState};
use serde_json::json;

fn parse_ready(value: serde_json::Value) -> Result<ProbeReadyReceipt, serde_json::Error> {
    serde_json::from_value(value)
}

#[test]
fn readiness_receipt_is_closed_and_requires_all_fields() {
    assert!(parse_ready(json!({
        "token": "run-token",
        "outcome": "ready",
        "reason": "none"
    }))
    .is_ok());

    assert!(parse_ready(json!({
        "token": "run-token",
        "outcome": "ready",
        "reason": "none",
        "diagnostic": "untrusted"
    }))
    .is_err());
    assert!(parse_ready(json!({ "token": "run-token", "outcome": "ready" })).is_err());
}

#[test]
fn readiness_receipt_accepts_only_consistent_outcome_and_reason_pairs() {
    let ready = parse_ready(json!({
        "token": "run-token",
        "outcome": "ready",
        "reason": "none"
    }))
    .expect("ready receipt");
    assert!(matches!(
        ready.disposition(),
        Ok(ProbeReadyDisposition::Ready)
    ));

    let failed = parse_ready(json!({
        "token": "run-token",
        "outcome": "failed",
        "reason": "ztools_api_timeout"
    }))
    .expect("failed receipt");
    assert!(matches!(
        failed.disposition(),
        Ok(ProbeReadyDisposition::Failed(
            "launch-return-ztools-api-readiness-timeout"
        ))
    ));

    let inconsistent = parse_ready(json!({
        "token": "run-token",
        "outcome": "ready",
        "reason": "listener_ready_timeout"
    }))
    .expect("syntactically valid receipt");
    assert_eq!(
        inconsistent.disposition().err(),
        Some("launch-return-probe-ready-receipt-rejected")
    );
}

#[test]
fn eval_enqueue_after_ready_does_not_regress_the_receipt() {
    assert_eq!(
        ProbeReadyState::Ready.after_eval_enqueued(),
        ProbeReadyState::Ready
    );
    assert_eq!(
        ProbeReadyState::Pending.after_eval_enqueued(),
        ProbeReadyState::Injected
    );
    assert_eq!(
        ProbeReadyReason::ListenerReadyTimeout.error_code(),
        Some("launch-return-app-launched-listener-readiness-timeout")
    );
}
