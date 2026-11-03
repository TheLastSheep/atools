use super::{
    configured_hotkey_from_settings, default_hotkey_label, normalize_shortcut,
    should_suppress_wakeup_for_foreground_app, startup_status, MainHotkeyStartup,
};

#[test]
fn normalizes_macos_option_label_for_tauri_shortcut() {
    assert_eq!(normalize_shortcut("Option+Z"), "Alt+Z");
}

#[test]
fn leaves_alt_shortcut_unchanged() {
    assert_eq!(normalize_shortcut("Alt+Z"), "Alt+Z");
}

#[test]
fn suppresses_wakeup_when_foreground_app_matches_blacklist() {
    let settings = r#"{"wakeupBlacklist":["Terminal","Visual Studio Code"]}"#;

    assert!(should_suppress_wakeup_for_foreground_app(
        Some(settings),
        Some("terminal")
    ));
    assert!(should_suppress_wakeup_for_foreground_app(
        Some(settings),
        Some("Visual Studio Code")
    ));
    assert!(!should_suppress_wakeup_for_foreground_app(
        Some(settings),
        Some("Finder")
    ));
    assert!(!should_suppress_wakeup_for_foreground_app(
        Some(settings),
        None
    ));
}

#[test]
fn ignores_empty_or_invalid_wakeup_blacklist_settings() {
    assert!(!should_suppress_wakeup_for_foreground_app(
        Some(r#"{"wakeupBlacklist":["  ","Terminal"]}"#),
        Some("")
    ));
    assert!(!should_suppress_wakeup_for_foreground_app(
        Some(r#"{"wakeupBlacklist":"Terminal"}"#),
        Some("Terminal")
    ));
    assert!(!should_suppress_wakeup_for_foreground_app(
        Some("not-json"),
        Some("Terminal")
    ));
}

#[test]
fn command_shortcut_normalization_is_stable_for_registration_and_lookup() {
    let raw = "Command+Space";
    let normalized = normalize_shortcut(raw);
    assert_eq!(normalized, "Cmd+Space");
    assert_eq!(normalize_shortcut("Cmd+Space"), "Cmd+Space");
    assert_eq!(normalize_shortcut("command+Space"), "Cmd+Space");
}

#[test]
fn startup_uses_default_only_when_the_setting_or_field_is_missing() {
    let default = default_hotkey_label();
    assert_eq!(configured_hotkey_from_settings(None).unwrap(), default);
    assert_eq!(
        configured_hotkey_from_settings(Some("{}")).unwrap(),
        default
    );
    assert_eq!(
        configured_hotkey_from_settings(Some(r#"{"other":true}"#)).unwrap(),
        default
    );
    assert_eq!(
        configured_hotkey_from_settings(Some(r#"{"hotkey":"Command+Shift+F10"}"#)).unwrap(),
        "Command+Shift+F10"
    );
}

#[test]
fn present_non_string_hotkey_becomes_an_empty_recovery_label() {
    assert_eq!(
        configured_hotkey_from_settings(Some(r#"{"hotkey":17}"#)).unwrap(),
        ""
    );
    assert_eq!(
        configured_hotkey_from_settings(Some(r#"{"hotkey":null}"#)).unwrap(),
        ""
    );
}

#[test]
fn malformed_or_non_object_settings_are_not_misclassified_as_recoverable_hotkeys() {
    assert!(configured_hotkey_from_settings(Some("not-json")).is_err());
    assert!(configured_hotkey_from_settings(Some("[]")).is_err());
}

#[test]
fn only_the_exact_safe_hotkey_rejection_enters_startup_recovery() {
    assert_eq!(startup_status(Ok(())), Ok(MainHotkeyStartup::Registered));
    assert_eq!(
        startup_status(Err("SETTINGS_HOTKEY_REJECTED".into())),
        Ok(MainHotkeyStartup::NeedsRecovery)
    );
    assert_eq!(
        startup_status(Err("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into())).unwrap_err(),
        "SETTINGS_HOTKEY_OUTCOME_UNKNOWN"
    );
    assert_eq!(
        startup_status(Err("disk read failed".into())).unwrap_err(),
        "disk read failed"
    );
}

#[test]
fn configured_double_modifier_permission_or_platform_denial_keeps_startup_recoverable() {
    let raw = r#"{"hotkey":"Command+Command"}"#;
    let label = super::configured_hotkey_from_settings(Some(raw)).unwrap();
    for code in [
        "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED",
        "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED",
    ] {
        let marked = std::cell::Cell::new(false);
        let result = super::initialize_main_hotkey(
            &label,
            |supplied| {
                assert_eq!(supplied, "Command+Command");
                Err(code.into())
            },
            || {
                marked.set(true);
                Ok(())
            },
        );
        assert_eq!(result, Ok(MainHotkeyStartup::NeedsRecovery));
        assert!(marked.get());
    }
}
