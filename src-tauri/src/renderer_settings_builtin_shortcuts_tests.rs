use super::{build_snapshot, project_general_settings, NATIVE_SETTING_KEYS};
use serde_json::{json, Value};
use std::collections::BTreeMap;

#[test]
fn main_projection_defaults_invalid_or_absent_switches_without_exposing_unknowns() {
    for raw in [
        "{}",
        r#"{"builtinAppShortcutsEnabled":null}"#,
        r#"{"builtinAppShortcutsEnabled":false}"#,
        r#"{"builtinAppShortcutsEnabled":{"search":"invalid","esc":null}}"#,
    ] {
        let projected: Value =
            serde_json::from_str(&project_general_settings(raw).unwrap()).unwrap();
        assert_eq!(
            projected["builtinAppShortcutsEnabled"],
            json!({"search":true,"esc":true,"closePlugin":true})
        );
    }
    let raw = r#"{"theme":"dark","secret":"top-secret","builtinAppShortcutsEnabled":{"search":false,"esc":true,"killPlugin":false,"closePlugin":false,"unknown":"nested-secret"}}"#;
    let projected = project_general_settings(raw).unwrap();
    let value: Value = serde_json::from_str(&projected).unwrap();
    assert_eq!(
        value["builtinAppShortcutsEnabled"],
        json!({"search":false,"esc":true,"closePlugin":false})
    );
    assert!(!projected.contains("top-secret") && !projected.contains("nested-secret"));
    assert!(!projected.contains("killPlugin"));
}

#[test]
fn startup_and_event_projection_share_safe_existing_fields_without_changing_missing_record() {
    let mut settings: BTreeMap<String, Option<String>> = NATIVE_SETTING_KEYS
        .into_iter()
        .map(|key| (key.to_owned(), None))
        .collect();
    assert!(build_snapshot(settings.clone()).unwrap().settings["settings-general"].is_none());
    let source = json!({
        "placeholder":"search", "theme":"dark", "primaryColor":"green", "customColor":"#112233",
        "autoClear":"never", "showRecentInSearch":true, "recentRows":2, "pinnedRows":3,
        "searchMode":"list", "showMatchRecommendation":false, "tabKeyFunction":"navigate",
        "tabTargetCommand":"", "spaceOpenCommand":true, "localAppSearch":false, "autoPaste":"3s",
        "builtinAppShortcutsEnabled":{"search":false,"esc":false,"unknown":"secret"}, "authToken":"secret"
    });
    let projected = project_general_settings(&source.to_string()).unwrap();
    settings.insert("settings-general".into(), Some(source.to_string()));
    let startup = build_snapshot(settings).unwrap().settings["settings-general"]
        .clone()
        .unwrap();
    assert_eq!(startup, projected);
    let actual: Value = serde_json::from_str(&projected).unwrap();
    for key in [
        "placeholder",
        "theme",
        "primaryColor",
        "customColor",
        "autoClear",
        "showRecentInSearch",
        "recentRows",
        "pinnedRows",
        "searchMode",
        "showMatchRecommendation",
        "tabKeyFunction",
        "tabTargetCommand",
        "spaceOpenCommand",
        "localAppSearch",
        "autoPaste",
    ] {
        assert_eq!(actual[key], source[key], "existing event field {key}");
    }
    assert_eq!(
        actual["builtinAppShortcutsEnabled"],
        json!({"search":false,"esc":false,"closePlugin":true})
    );
    assert!(!projected.contains("secret"));
}
