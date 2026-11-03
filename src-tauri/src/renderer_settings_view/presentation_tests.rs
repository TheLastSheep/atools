use super::{
    allow_focus_with_policy, focus_request_count, settings_input_identifier, FocusPhase,
    HiddenSmokePolicy,
};

#[test]
fn accepts_only_the_settings_input_profile_run_id() {
    let run_id = "abcdef0123456789abcdef0123456789";
    assert_eq!(
        settings_input_identifier(run_id).as_deref(),
        Some("dev.atools.renderer-settings-input.abcdef0123456789abcdef0123456789")
    );
    assert!(settings_input_identifier("ABCDEF0123456789ABCDEF0123456789").is_none());
    assert!(settings_input_identifier("abcdef0123456789abcdef012345678").is_none());
    assert!(settings_input_identifier("abcdef01-2345-6789-abcd-ef0123456789").is_none());
}

#[test]
fn production_focus_remains_allowed_without_policy() {
    for phase in [
        FocusPhase::ChildInitialFocus,
        FocusPhase::SessionFocus,
        FocusPhase::ValueEcho,
        FocusPhase::ChildDelivery,
    ] {
        assert!(allow_focus_with_policy(None, phase));
    }
    let policy = HiddenSmokePolicy::default();
    assert_eq!(policy.suppressed_focus_requests(), 0);
}

#[test]
fn hidden_profile_suppresses_only_fixed_settings_focus_phases() {
    let policy = HiddenSmokePolicy::default();
    for phase in [
        FocusPhase::ChildInitialFocus,
        FocusPhase::SessionFocus,
        FocusPhase::ValueEcho,
        FocusPhase::ChildDelivery,
    ] {
        assert!(!allow_focus_with_policy(Some(&policy), phase));
    }
    assert_eq!(policy.suppressed_focus_requests(), 6);
    assert_eq!(
        [
            FocusPhase::ChildInitialFocus,
            FocusPhase::SessionFocus,
            FocusPhase::ValueEcho,
            FocusPhase::ChildDelivery,
        ]
        .map(focus_request_count),
        [1, 3, 1, 1]
    );
}

#[cfg(feature = "legacy-node-smoke")]
#[test]
fn launch_return_hidden_scope_is_distinct_from_legacy_and_bound_to_run_and_root() {
    use super::LaunchReturnScope;
    let scope = LaunchReturnScope {
        run_id: "abcdef0123456789abcdef0123456789".into(),
        root: "/private/tmp/atools-renderer-smoke-abcdef0123456789abcdef0123456789".into(),
    };
    assert!(!HiddenSmokePolicy::default().authorizes_launch_return(&scope));
    let policy = HiddenSmokePolicy {
        launch_return_scope: Some(scope.clone()),
        ..HiddenSmokePolicy::default()
    };
    assert!(policy.authorizes_launch_return(&scope));
    assert!(!policy.authorizes_launch_return(&LaunchReturnScope {
        run_id: "00000000000040008000000000000002".into(),
        ..scope.clone()
    }));
    assert!(!policy.authorizes_launch_return(&LaunchReturnScope {
        root: "/private/tmp/another-fixture".into(),
        ..scope
    }));
    for phase in [
        FocusPhase::ChildInitialFocus,
        FocusPhase::SessionFocus,
        FocusPhase::ValueEcho,
        FocusPhase::ChildDelivery,
    ] {
        assert!(!allow_focus_with_policy(Some(&policy), phase));
    }
    assert_eq!(policy.suppressed_focus_requests(), 6);
}
