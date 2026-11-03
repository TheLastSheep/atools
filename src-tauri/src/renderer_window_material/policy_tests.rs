use super::{Ownership, ThemePreference};

#[test]
fn theme_defaults_to_system_and_accepts_only_the_three_known_values() {
    assert_eq!(
        ThemePreference::from_general_json(None),
        ThemePreference::System
    );
    assert_eq!(
        ThemePreference::from_general_json(Some("{")),
        ThemePreference::System
    );
    assert_eq!(
        ThemePreference::from_general_json(Some(r#"{"theme":"system"}"#)),
        ThemePreference::System
    );
    assert_eq!(
        ThemePreference::from_general_json(Some(r#"{"theme":"light"}"#)),
        ThemePreference::Light
    );
    assert_eq!(
        ThemePreference::from_general_json(Some(r#"{"theme":"dark"}"#)),
        ThemePreference::Dark
    );
    assert_eq!(
        ThemePreference::from_general_json(Some(r#"{"theme":"auto"}"#)),
        ThemePreference::System
    );
}

#[test]
fn settings_release_keeps_the_original_main_effect_owned() {
    let mut ownership = Ownership::default();
    ownership.install_effect(|| Ok(())).unwrap();
    ownership.add_main_owner().unwrap();
    let lease = ownership.reserve_lease_id().unwrap();
    ownership.add_settings_lease(lease).unwrap();
    assert_eq!(ownership.total_owners(), 2);

    assert!(ownership.remove_settings_lease(lease));
    assert_eq!(ownership.total_owners(), 1);
    assert!(!ownership.should_clear_effect());
    assert!(!ownership.cleanup_pending());
}

#[test]
fn failed_apply_does_not_claim_a_view_or_owner() {
    let mut ownership = Ownership::default();
    let error = ownership
        .install_effect(|| Err("AppKit rejected effect".into()))
        .unwrap_err();
    assert_eq!(error, "AppKit rejected effect");
    assert!(!ownership.effect_owned());
    assert_eq!(ownership.total_owners(), 0);
}

#[test]
fn failed_last_release_retains_retryable_cleanup_and_retry_clears_it() {
    let mut ownership = Ownership::default();
    ownership.install_effect(|| Ok(())).unwrap();
    let lease = ownership.reserve_lease_id().unwrap();
    ownership.add_settings_lease(lease).unwrap();
    assert!(ownership.remove_settings_lease(lease));
    assert!(ownership.should_clear_effect());

    assert!(ownership
        .clear_effect(|| Err("AppKit clear failed".into()))
        .is_err());
    assert!(ownership.effect_owned());
    assert!(ownership.cleanup_pending());
    assert!(ownership.clear_effect(|| Ok(())).is_ok());
    assert!(!ownership.effect_owned());
    assert!(!ownership.cleanup_pending());
}

#[test]
fn repeated_release_is_idempotent_and_does_not_clear_another_owner() {
    let mut ownership = Ownership::default();
    ownership.install_effect(|| Ok(())).unwrap();
    ownership.add_main_owner().unwrap();
    let lease = ownership.reserve_lease_id().unwrap();
    ownership.add_settings_lease(lease).unwrap();

    assert!(ownership.remove_settings_lease(lease));
    assert!(!ownership.remove_settings_lease(lease));
    assert!(!ownership.should_clear_effect());
    assert_eq!(ownership.total_owners(), 1);
}

#[test]
fn stop_and_window_destroy_reject_queued_or_late_acquires() {
    let mut stopped = Ownership::default();
    stopped.install_effect(|| Ok(())).unwrap();
    stopped.add_main_owner().unwrap();
    let queued_lease = stopped.reserve_lease_id().unwrap();
    assert!(stopped.begin_stop());
    assert!(stopped.add_settings_lease(queued_lease).is_err());
    assert!(stopped.reserve_lease_id().is_err());
    assert!(stopped.add_main_owner().is_err());

    let mut destroyed = Ownership::default();
    destroyed.install_effect(|| Ok(())).unwrap();
    let late_lease = destroyed.reserve_lease_id().unwrap();
    destroyed.forget_destroyed_window();
    assert!(destroyed.add_settings_lease(late_lease).is_err());
    assert!(destroyed.reserve_lease_id().is_err());
    assert_eq!(destroyed.total_owners(), 0);
    assert!(!destroyed.effect_owned());
}

#[test]
fn lease_identifiers_never_wrap_or_get_reused() {
    let mut ownership = Ownership::default();
    ownership.next_lease_id = Some(u64::MAX);
    assert_eq!(ownership.reserve_lease_id().unwrap(), u64::MAX);
    assert!(ownership.reserve_lease_id().is_err());
    ownership.forget_destroyed_window();
    assert!(ownership.reserve_lease_id().is_err());
}
