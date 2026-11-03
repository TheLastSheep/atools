use serde_json::json;

use super::native_effect_changes;
use crate::general_settings_runtime::effects::NativeSettingField;

#[test]
fn theme_only_change_does_not_replay_native_settings() {
    let changes = native_effect_changes(Some("{}"), r#"{"theme":"dark"}"#, "Option+Z").unwrap();

    assert!(changes.is_empty());
}

#[test]
fn missing_native_fields_use_the_shared_tray_default_and_other_native_defaults() {
    let changes = native_effect_changes(
        None,
        r#"{"hotkey":"Option+Z","appShortcuts":[],"launchAtLogin":false,"showTrayIcon":true,"superPanelEnabled":false,"floatingBallEnabled":false}"#,
        "Option+Z",
    )
    .unwrap();

    assert!(changes.is_empty());
}

#[test]
fn only_the_changed_native_field_is_planned() {
    let changes = native_effect_changes(
        Some(r#"{"showTrayIcon":false}"#),
        r#"{"theme":"dark","showTrayIcon":true}"#,
        "Option+Z",
    )
    .unwrap();

    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].field, NativeSettingField::TrayIconVisible);
    assert_eq!(changes[0].before, json!(false));
    assert_eq!(changes[0].after, json!(true));
}

#[test]
fn missing_tray_value_means_visible_and_explicit_false_plans_a_hide() {
    let changes = native_effect_changes(None, r#"{"showTrayIcon":false}"#, "Option+Z").unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].field, NativeSettingField::TrayIconVisible);
    assert_eq!(changes[0].before, json!(true));
    assert_eq!(changes[0].after, json!(false));
}

#[test]
fn all_native_fields_follow_the_existing_apply_order() {
    let changes = native_effect_changes(
        Some(r#"{"hotkey":"Option+Z","showTrayIcon":false,"launchAtLogin":false,"superPanelEnabled":false,"floatingBallEnabled":false,"appShortcuts":[]}"#),
        r#"{"hotkey":"Option+X","showTrayIcon":true,"launchAtLogin":true,"superPanelEnabled":true,"floatingBallEnabled":true,"appShortcuts":[{"id":"one","shortcut":"Alt+1","targetCode":"demo","enabled":true}]}"#,
        "Option+Z",
    )
    .unwrap();

    assert_eq!(
        changes
            .iter()
            .map(|change| change.field)
            .collect::<Vec<_>>(),
        vec![
            NativeSettingField::Hotkey,
            NativeSettingField::TrayIconVisible,
            NativeSettingField::LaunchAtLogin,
            NativeSettingField::SuperPanelVisible,
            NativeSettingField::FloatingBallVisible,
            NativeSettingField::AppShortcuts,
        ]
    );
}

#[test]
fn invalid_stored_hotkey_survives_unrelated_effects_and_valid_repair_is_explicit() {
    for raw in [
        r#"{"hotkey":null,"showTrayIcon":false}"#,
        r#"{"hotkey":false,"showTrayIcon":false}"#,
        r#"{"hotkey":"","showTrayIcon":false}"#,
        r#"{"hotkey":"unsupported legacy shortcut","showTrayIcon":false}"#,
    ] {
        let after = raw.replace("\"showTrayIcon\":false", "\"showTrayIcon\":true");
        let changes = native_effect_changes(Some(raw), &after, "").unwrap();
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].field, NativeSettingField::TrayIconVisible);
    }

    let repair = native_effect_changes(
        Some(r#"{"hotkey":null}"#),
        r#"{"hotkey":"Command+Shift+F11"}"#,
        "",
    )
    .unwrap();
    assert_eq!(repair.len(), 1);
    assert_eq!(repair[0].field, NativeSettingField::Hotkey);
    assert_eq!(repair[0].before, json!(""));
    assert_eq!(repair[0].after, json!("Command+Shift+F11"));

    assert!(native_effect_changes(
        Some(r#"{"hotkey":"Option+Z"}"#),
        r#"{"hotkey":false}"#,
        "Option+Z",
    )
    .is_err());

    let explicit_repair = native_effect_changes(
        Some(r#"{"hotkey":false}"#),
        r#"{"hotkey":"Command+Shift+F11"}"#,
        "",
    )
    .unwrap();
    assert_eq!(explicit_repair.len(), 1);
    assert_eq!(explicit_repair[0].field, NativeSettingField::Hotkey);
    assert_eq!(explicit_repair[0].before, json!(""));
    assert_eq!(explicit_repair[0].after, json!("Command+Shift+F11"));
}
