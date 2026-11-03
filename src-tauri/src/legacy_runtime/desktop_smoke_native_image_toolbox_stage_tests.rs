use super::{FixtureState, HarnessStage};
use std::path::PathBuf;
use tokio::sync::oneshot;

#[test]
fn stage_diagnostic_accepts_only_fixed_codes() {
    assert_eq!(
        HarnessStage::parse("activation-start").unwrap().as_str(),
        "activation-start"
    );
    assert_eq!(
        HarnessStage::parse("activation-resolved").unwrap().as_str(),
        "activation-resolved"
    );
    assert_eq!(
        HarnessStage::parse("report-send-failed").unwrap().as_str(),
        "report-send-failed"
    );
    assert_eq!(
        HarnessStage::parse("panel-mount-returned")
            .unwrap()
            .as_str(),
        "panel-mount-returned"
    );
    assert!(HarnessStage::parse("/private/user/image.png").is_none());
    assert!(HarnessStage::parse("panic: arbitrary error").is_none());
}

#[test]
fn stage_checkpoint_is_token_bound_and_never_moves_backwards() {
    let (_sender, receiver) = oneshot::channel();
    let state = FixtureState::new(
        "fixture-token".into(),
        PathBuf::from("/fixture/input.png"),
        _sender,
    );
    assert!(state.update("wrong-token", "activation-start").is_err());
    assert!(state.update("fixture-token", "activation-start").is_ok());
    assert!(state
        .update("fixture-token", "panel-mount-returned")
        .is_ok());
    assert!(state
        .update("fixture-token", "panel-svelte-flush-checkpoint")
        .is_ok());
    assert!(state
        .update("fixture-token", "waiting-for-plugin-observer")
        .is_err());
    assert_eq!(state.last_stage(), "panel-svelte-flush-checkpoint");
    drop(receiver);
}

#[test]
fn terminal_diagnostics_preserve_last_nonterminal_work_stage() {
    let (_sender, receiver) = oneshot::channel();
    let state = FixtureState::new(
        "fixture-token".into(),
        PathBuf::from("/fixture/input.png"),
        _sender,
    );
    assert!(state.update("fixture-token", "activation-start").is_ok());
    assert!(state
        .update("fixture-token", "panel-mount-returned")
        .is_ok());
    assert!(state
        .update("fixture-token", "panel-svelte-flush-checkpoint")
        .is_ok());
    assert!(state.update("fixture-token", "panel-timeout").is_ok());
    assert!(state.update("fixture-token", "report-send-failed").is_ok());
    assert_eq!(state.last_stage(), "report-send-failed");
    assert_eq!(state.last_work_stage(), "panel-svelte-flush-checkpoint");
    assert!(state
        .update("fixture-token", "activation-resolved")
        .is_err());
    drop(receiver);
}

#[test]
fn report_projection_keeps_only_allowlisted_stalled_stage() {
    let (_sender, receiver) = oneshot::channel();
    let state = FixtureState::new(
        "fixture-token".into(),
        PathBuf::from("/fixture/input.png"),
        _sender,
    );
    let mut report = serde_json::json!({"stalledAtStage":"/private/user/image.png"});
    state.enrich_report(&mut report);
    assert!(report.get("stalledAtStage").is_none());
    assert_eq!(report["lastHarnessWorkStage"], "before-fixture-command");
    let mut report = serde_json::json!({"stalledAtStage":"activation-start"});
    state.enrich_report(&mut report);
    assert_eq!(report["stalledAtStage"], "activation-start");
    assert!(report["pluginDomObservations"]["framePresenceAfterTick"].is_null());
    drop(receiver);
}

#[test]
fn child_csp_checkpoints_keep_unknown_false_true_and_token_binding() {
    let (_sender, receiver) = oneshot::channel();
    let state = FixtureState::new(
        "fixture-token".into(),
        PathBuf::from("/fixture/input.png"),
        _sender,
    );
    let mut report = serde_json::json!({"passed": false});
    state.enrich_report(&mut report);
    assert!(report["pluginDomObservations"]["childCspCheckpoints"]["observerInstalled"].is_null());
    assert!(
        report["pluginDomObservations"]["childCspCheckpoints"]["moduleLeaseScriptBlocked"]
            .is_null()
    );

    assert!(state
        .observe(
            "fixture-token",
            "child-module-lease-script-csp-blocked",
            Some(true)
        )
        .is_err());
    assert!(state
        .observe("wrong-token", "child-csp-observer-installed", Some(true))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-csp-observer-installed", Some(false))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-csp-observer-installed", Some(true))
        .is_ok());
    assert!(state
        .observe(
            "fixture-token",
            "child-module-lease-script-csp-blocked",
            Some(false)
        )
        .is_err());
    state.enrich_report(&mut report);
    assert_eq!(
        report["pluginDomObservations"]["childCspCheckpoints"]["observerInstalled"],
        true
    );
    assert_eq!(
        report["pluginDomObservations"]["childCspCheckpoints"]["moduleLeaseScriptBlocked"],
        false
    );
    assert_eq!(report["passed"], false);
    assert_eq!(
        report["pluginDomObservations"]["childCspCheckpoints"]["moduleLeaseScriptBlockedInterpretation"],
        "true means the specified leased-script CSP denial was observed; false means it was not observed, not proof that no CSP denial occurred. The child observer processes at most 32 securitypolicyviolation events.",
    );

    assert!(state
        .observe(
            "fixture-token",
            "child-module-lease-script-csp-blocked",
            Some(true)
        )
        .is_ok());
    state.enrich_report(&mut report);
    assert_eq!(
        report["pluginDomObservations"]["childCspCheckpoints"]["moduleLeaseScriptBlocked"],
        true
    );
    assert_eq!(report["passed"], false);
    drop(receiver);
}

#[test]
fn child_domcontentloaded_can_precede_enter_after_observer_start() {
    let (_sender, receiver) = oneshot::channel();
    let state = FixtureState::new(
        "fixture-token".into(),
        PathBuf::from("/fixture/input.png"),
        _sender,
    );
    assert!(state
        .observe("fixture-token", "child-observer-started", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-domcontentloaded", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-enter-received", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-app-instance-present", Some(false))
        .is_ok());
    let mut report = serde_json::json!({});
    state.enrich_report(&mut report);
    let checkpoints = &report["pluginDomObservations"]["childLifecycleCheckpoints"];
    assert_eq!(checkpoints["domContentLoaded"], true);
    assert_eq!(checkpoints["enterReceived"], true);
    assert_eq!(checkpoints["appInstancePresent"], false);
    drop(receiver);
}

#[test]
fn child_enter_and_domcontentloaded_are_independent_after_observer_start() {
    let (_sender, receiver) = oneshot::channel();
    let state = FixtureState::new(
        "fixture-token".into(),
        PathBuf::from("/fixture/input.png"),
        _sender,
    );
    assert!(state
        .observe("fixture-token", "child-enter-received", Some(true))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-observer-started", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-enter-received", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-app-instance-present", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-domcontentloaded", Some(true))
        .is_ok());
    let mut report = serde_json::json!({});
    state.enrich_report(&mut report);
    let checkpoints = &report["pluginDomObservations"]["childLifecycleCheckpoints"];
    assert_eq!(checkpoints["observerStarted"], true);
    assert_eq!(checkpoints["enterReceived"], true);
    assert_eq!(checkpoints["domContentLoaded"], true);
    assert_eq!(checkpoints["appInstancePresent"], true);
    drop(receiver);
}

#[test]
fn observations_keep_unknown_distinct_from_observed_false_and_are_token_bound() {
    let (_sender, receiver) = oneshot::channel();
    let state = FixtureState::new(
        "fixture-token".into(),
        PathBuf::from("/fixture/input.png"),
        _sender,
    );
    let mut report = serde_json::json!({"passed":false});
    state.enrich_report(&mut report);
    assert!(report["pluginDomObservations"]["framePresenceAfterTick"].is_null());
    assert!(
        report["pluginDomObservations"]["childLifecycleCheckpoints"]["observerStarted"].is_null()
    );
    assert!(
        report["pluginDomObservations"]["childLifecycleCheckpoints"]["appInstancePresent"]
            .is_null()
    );
    assert!(state
        .observe("fixture-token", "child-enter-received", Some(true))
        .is_err());
    assert!(state
        .observe("wrong-token", "frame-presence-after-tick", Some(false))
        .is_err());
    assert!(state
        .observe("fixture-token", "frame-presence-after-tick", Some(false))
        .is_ok());
    assert!(state
        .observe("fixture-token", "frame-presence-after-tick", Some(true))
        .is_ok());
    assert!(state
        .observe(
            "fixture-token",
            "frame-source-assigned-after-tick",
            Some(false)
        )
        .is_ok());
    assert!(state
        .observe("fixture-token", "panel-load-error-observer-installed", None)
        .is_ok());
    assert!(state
        .observe("fixture-token", "top-window-observers-installed", None)
        .is_ok());
    assert!(state
        .observe("fixture-token", "top-window-error", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "top-window-observers-installed", None)
        .is_ok());
    assert!(state
        .observe("fixture-token", "top-window-error", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "frame-observer-installed", None)
        .is_ok());
    state.enrich_report(&mut report);
    assert_eq!(
        report["pluginDomObservations"]["framePresenceAfterTick"],
        false
    );
    assert_eq!(
        report["pluginDomObservations"]["frameSourceAssignedAfterTick"],
        false
    );
    assert_eq!(
        report["pluginDomObservations"]["frameLoadAfterSourceAttributeMutationObserved"],
        false
    );
    assert_eq!(
        report["pluginDomObservations"]["topWindowErrorObserved"],
        true
    );
    assert_eq!(
        report["pluginDomObservations"]["topUnhandledRejectionObserved"],
        false
    );
    assert_eq!(
        report["pluginDomObservations"]["panelLoadErrorObserved"],
        false
    );
    assert!(state
        .observe("fixture-token", "frame-presence-after-tick", None)
        .is_err());
    assert!(state
        .observe("fixture-token", "/private/path", Some(true))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-app-instance-present", Some(false))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-observer-started", Some(false))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-domcontentloaded", Some(true))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-enter-received", Some(true))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-observer-started", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-app-instance-present", Some(false))
        .is_err());
    assert!(state
        .observe("fixture-token", "child-enter-received", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-app-instance-present", Some(false))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-domcontentloaded", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-app-instance-present", Some(true))
        .is_ok());
    assert!(state
        .observe("fixture-token", "child-app-instance-present", Some(false))
        .is_err());
    state.enrich_report(&mut report);
    assert_eq!(
        report["pluginDomObservations"]["childLifecycleCheckpoints"]["observerStarted"],
        true
    );
    assert_eq!(
        report["pluginDomObservations"]["childLifecycleCheckpoints"]["domContentLoaded"],
        true
    );
    assert_eq!(
        report["pluginDomObservations"]["childLifecycleCheckpoints"]["enterReceived"],
        true
    );
    assert_eq!(
        report["pluginDomObservations"]["childLifecycleCheckpoints"]["appInstancePresent"],
        true
    );
    drop(receiver);
}
