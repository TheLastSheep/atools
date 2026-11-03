use super::project_general_settings;
use serde_json::json;

#[test]
fn child_projection_defaults_only_supported_switches_and_redacts_other_values() {
    for raw in [
        None,
        Some("{}"),
        Some(r#"{"builtinAppShortcutsEnabled":null}"#),
        Some(r#"{"builtinAppShortcutsEnabled":{"search":0,"esc":"false"}}"#),
    ] {
        let result = project_general_settings(raw, "").unwrap();
        assert_eq!(
            result["builtinAppShortcutsEnabled"],
            json!({"search":true,"esc":true,"closePlugin":true})
        );
    }
    let raw = r#"{"builtinAppShortcutsEnabled":{"search":false,"esc":true,"closePlugin":false,"killPlugin":false,"unknown":"private-nested"},"authToken":"private-top"}"#;
    let result = project_general_settings(Some(raw), "").unwrap();
    assert_eq!(
        result["builtinAppShortcutsEnabled"],
        json!({"search":false,"esc":true,"closePlugin":false})
    );
    let serialized = serde_json::to_string(&result).unwrap();
    for value in ["private-nested", "private-top", "killPlugin"] {
        assert!(!serialized.contains(value));
    }
}
