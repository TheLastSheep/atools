use super::{
    final_runtime_drained, startup_diagnostics_required, startup_diagnostics_status,
    startup_diagnostics_verified,
};
use crate::legacy_runtime::Sessions;
use serde_json::{json, Value};

#[test]
fn required_fixture_diagnostics_fail_closed_when_report_field_is_missing() {
    assert_eq!(
        startup_diagnostics_verified(&json!({"legacySessions":0}), true),
        Some(false)
    );
    assert_eq!(
        startup_diagnostics_verified(
            &json!({"nodeStartupDiagnostics":{"captureStatus":"not_exercised","associationVerified":false}}),
            true
        ),
        Some(false)
    );
    assert_eq!(
        startup_diagnostics_verified(&json!({"legacySessions":0}), false),
        None
    );
    assert_eq!(
        startup_diagnostics_status(&json!({}), None),
        "not_applicable"
    );
    assert_eq!(
        startup_diagnostics_status(&json!({}), Some(false)),
        "not_configured"
    );
    assert_eq!(
        startup_diagnostics_status(
            &json!({"nodeStartupDiagnostics":{"captureStatus":"unexpected"}}),
            Some(false)
        ),
        "incomplete"
    );
    assert_eq!(
        startup_diagnostics_status(
            &json!({"nodeStartupDiagnostics":{"captureStatus":"not_exercised"}}),
            Some(false)
        ),
        "not_exercised"
    );
    assert_eq!(
        startup_diagnostics_status(
            &json!({"nodeStartupDiagnostics":{"associationVerified":true,"captureStatus":"verified"}}),
            Some(true)
        ),
        "verified"
    );
    assert_eq!(
        startup_diagnostics_verified(
            &json!({"nodeStartupDiagnostics":{"associationVerified":true,"captureStatus":"not_exercised"}}),
            true
        ),
        Some(false)
    );
    assert_eq!(
        startup_diagnostics_verified(
            &json!({"nodeStartupDiagnostics":{"associationVerified":true,"captureStatus":"verified"}}),
            true
        ),
        Some(true)
    );
}

#[test]
fn diagnostics_requirement_matches_only_the_two_explicit_non_worker_editor_profiles() {
    assert!(startup_diagnostics_required(
        true,
        false,
        &json!({"caseId":"local-plain-text","id":"plain-text","runtime":"node"}),
        false,
    ));
    assert!(startup_diagnostics_required(
        true,
        false,
        &json!({"caseId":"local-json-editor","id":"json-editor","runtime":"node"}),
        false,
    ));
    assert!(!startup_diagnostics_required(
        false,
        false,
        &json!({"caseId":"local-plain-text","id":"plain-text","runtime":"node"}),
        false,
    ));
    assert!(!startup_diagnostics_required(
        true,
        true,
        &json!({"caseId":"local-json-editor","id":"json-editor","runtime":"node"}),
        false,
    ));
    assert!(!startup_diagnostics_required(
        true,
        false,
        &json!({"caseId":"local-plain-text","id":"unexpected","runtime":"node"}),
        false,
    ));
}

#[test]
fn converted_deepread_requires_verified_handoff_and_exact_web_profile() {
    let profile =
        crate::plugin_source_build::converted_source_registry::profile("converted-deepread-source")
            .unwrap();
    assert!(startup_diagnostics_required(false, false, &profile, true));
    assert!(!startup_diagnostics_required(false, false, &profile, false));
    assert!(!startup_diagnostics_required(false, true, &profile, true));
    let mut wrong = profile.clone();
    wrong["version"] = json!("1.1.3");
    assert!(!startup_diagnostics_required(false, false, &wrong, true));
    wrong = profile;
    wrong["runtime"] = json!("node");
    assert!(!startup_diagnostics_required(false, false, &wrong, true));
}

fn drained_state() -> Value {
    let mut state = serde_json::Map::new();
    for key in [
        "resourceLeases",
        "legacySessions",
        "legacyOpenings",
        "pendingRequests",
        "hostSessions",
        "hostIntents",
        "hostInvocations",
        "displaySessions",
        "displayIntents",
        "displayInvocations",
        "dataSessions",
        "dataIntents",
        "dataInvocations",
        "dataPreparations",
        "activePathSnapshots",
        "activePathIntents",
        "activePathPreparations",
        "pathSnapshotBytes",
        "dialogSessions",
        "dialogIntents",
        "dialogInvocations",
        "dialogPreparations",
        "nativeDialogs",
    ] {
        state.insert(key.into(), json!(0));
    }
    state.insert("pathRuntimeAvailable".into(), json!(true));
    for key in [
        "legacyTransport",
        "hostTransport",
        "dataTransport",
        "dialogTransport",
    ] {
        state.insert(key.into(), json!(false));
    }
    Value::Object(state)
}

#[test]
fn pending_permission_request_prevents_fixture_cleanup_from_being_reported_complete() {
    let clean = drained_state();
    assert!(final_runtime_drained(&clean));
    let mut pending = clean;
    pending["pendingRequests"] = json!(1);
    assert!(!final_runtime_drained(&pending));
}

#[tokio::test]
async fn closing_fixture_window_owner_preserves_unrelated_pending_owner_without_opening_node() {
    let sessions = Sessions::default();
    let fixture_owner = "window:main:published-fixture";
    let unrelated_owner = "window:other:unrelated-plugin";
    let fixture = sessions
        .create_intent(fixture_owner.into(), "atools-ui".into(), "deepread".into())
        .unwrap();
    let unrelated = sessions
        .create_intent(unrelated_owner.into(), "atools-ui".into(), "other".into())
        .unwrap();
    *sessions.intents.lock().get(&fixture).unwrap().run_id.lock() = Some("fixture-run".into());
    *sessions
        .intents
        .lock()
        .get(&unrelated)
        .unwrap()
        .run_id
        .lock() = Some("other-run".into());
    let fixture_cancelled = sessions
        .intents
        .lock()
        .get(&fixture)
        .unwrap()
        .cancelled
        .clone();
    let unrelated_cancelled = sessions
        .intents
        .lock()
        .get(&unrelated)
        .unwrap()
        .cancelled
        .clone();

    assert_eq!(
        sessions.close_owner(fixture_owner, None).await,
        vec!["fixture-run".to_string()]
    );
    assert!(fixture_cancelled.load(std::sync::atomic::Ordering::Acquire));
    assert!(!unrelated_cancelled.load(std::sync::atomic::Ordering::Acquire));
    assert!(sessions.intents.lock().contains_key(&unrelated));
    assert!(sessions.sessions.read().is_empty());
    assert!(sessions.openings.lock().is_empty());
    assert!(sessions.server.lock().await.is_none());
}
