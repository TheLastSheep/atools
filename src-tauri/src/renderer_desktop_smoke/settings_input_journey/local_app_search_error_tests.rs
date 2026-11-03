use super::{add_error, is_error_code};
use serde_json::json;

#[test]
fn local_app_search_errors_are_preserved_only_from_the_fixed_allowlist() {
    let known = super::super::local_app_search_schema::NON_APP_CONTROL_MISSING;
    assert!(is_error_code(known));
    assert!(!is_error_code("settings-input-local-app-search-invented"));

    let mut report = json!({"errors": [], "passed": true});
    add_error(&mut report, known);
    assert_eq!(report["errors"], json!([known]));
    add_error(&mut report, "settings-input-local-app-search-invented");
    assert_eq!(
        report["errors"],
        json!([known, "settings-input-journey-failed"])
    );
}
