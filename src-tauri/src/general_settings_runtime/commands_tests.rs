use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::{
    native_launch_at_login_form_patch_allowed, pasteboard_dialog_field_allowed,
    validate_save_budget, GeneralSettingsExpected, PASTEBOARD_DIALOG_FIELDS,
};

#[test]
fn expected_snapshot_requires_raw_and_rejects_unknown_fields() {
    assert!(serde_json::from_str::<GeneralSettingsExpected>(r#"{"raw":null}"#).is_ok());
    assert!(serde_json::from_str::<GeneralSettingsExpected>("{}").is_err());
    assert!(serde_json::from_str::<GeneralSettingsExpected>(r#"{"raw":null,"extra":1}"#).is_err());
}

#[test]
fn save_budget_counts_json_escaping_across_the_request() {
    let expected = GeneralSettingsExpected { raw: None };
    let changes = BTreeMap::from([("placeholder".to_owned(), Value::String("\"".repeat(32_768)))]);

    assert!(validate_save_budget(&expected, &changes, false).is_err());
    assert!(validate_save_budget(
        &expected,
        &BTreeMap::from([("theme".to_owned(), json!("dark"))]),
        false
    )
    .is_ok());
}

#[test]
fn pasteboard_dialog_scope_matches_the_existing_five_fields_exactly() {
    assert_eq!(
        PASTEBOARD_DIALOG_FIELDS,
        [
            "pasteboardDockEdge",
            "pasteboardCompact",
            "clipboardRetentionDays",
            "pasteboardAttachmentBudgetBytes",
            "pasteboardExcludeSensitiveContent",
        ]
    );
    for field in PASTEBOARD_DIALOG_FIELDS {
        assert!(pasteboard_dialog_field_allowed(field));
    }
    for wrong_or_unrelated in [
        "dockEdge",
        "compact",
        "attachmentBudget",
        "excludeSensitiveContent",
        "hotkey",
    ] {
        assert!(!pasteboard_dialog_field_allowed(wrong_or_unrelated));
    }
}
#[test]
fn capture_preference_is_limited_to_the_main_and_shelf_webviews() {
    assert!(super::capture_caller_allowed("main", "main", "main"));
    assert!(super::capture_caller_allowed(
        "pasteboard-shelf",
        "pasteboard-shelf",
        "pasteboard-shelf"
    ));
    assert!(!super::capture_caller_allowed("plugin", "main", "main"));
    assert!(!super::capture_caller_allowed("main", "settings", "main"));
    assert!(!super::capture_caller_allowed(
        "pasteboard-dialog",
        "pasteboard-dialog",
        "pasteboard-dialog"
    ));
}

#[test]
fn native_launch_at_login_changes_use_the_dedicated_command() {
    let login_item = BTreeMap::from([("launchAtLogin".to_owned(), Value::Bool(true))]);
    assert!(!native_launch_at_login_form_patch_allowed(
        &login_item,
        true
    ));
    assert!(native_launch_at_login_form_patch_allowed(
        &login_item,
        false
    ));

    let other_native_change = BTreeMap::from([("showTrayIcon".to_owned(), Value::Bool(false))]);
    assert!(native_launch_at_login_form_patch_allowed(
        &other_native_change,
        true
    ));
    assert!(native_launch_at_login_form_patch_allowed(
        &other_native_change,
        false
    ));
}
