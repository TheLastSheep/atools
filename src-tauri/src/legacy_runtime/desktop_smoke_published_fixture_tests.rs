use super::fixture_profile::reviewed_profile;
use super::*;

fn regex_manifest() -> Value {
    json!({"name":"regex-editor","version":"1.0.0","preload":"preload/services.js",
        "features":[{"code":"editor"}]})
}

#[test]
fn published_fixture_profile_rejects_unknown_case() {
    assert!(reviewed_profile("unregistered", &regex_manifest()).is_err());
}

#[test]
fn published_fixture_profile_requires_exact_manifest_identity_and_runtime() {
    assert!(reviewed_profile("regex-editor", &regex_manifest()).is_ok());
    for (field, value) in [
        ("name", json!("other")),
        ("version", json!("9.0.0")),
        ("preload", Value::Null),
        ("features", json!([{"code":"other"}])),
    ] {
        let mut manifest = regex_manifest();
        manifest[field] = value;
        assert!(
            reviewed_profile("regex-editor", &manifest).is_err(),
            "{field}"
        );
    }
}

#[test]
fn published_fixture_profile_allows_only_the_reviewed_webview_todo_preload() {
    let mut manifest = json!({"name":"todo-neo","version":"0.0.1","main":"index.html",
        "preload":"preload/services.js","features":[{"code":"todo"},{"code":"add"}]});
    assert_eq!(
        reviewed_profile("todo-neo", &manifest).unwrap()["runtime"],
        "web"
    );
    manifest["preload"] = json!("other-unreviewed-preload.js");
    assert!(reviewed_profile("todo-neo", &manifest).is_err());
    let timestamp = json!({"name":"com-ztools-timestamp","version":"1.0.0",
        "preload":"extra.js","features":[{"code":"com-ztools-timestamp"}]});
    assert!(reviewed_profile("com-ztools-timestamp", &timestamp).is_err());
}

#[test]
fn published_fixture_profile_registry_has_distinct_pinned_cases() {
    let registry: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/published-plugin-cases.json"
    ))
    .unwrap();
    let mut ids = std::collections::HashSet::new();
    for profile in registry["cases"].as_array().unwrap() {
        assert!(ids.insert(profile["caseId"].as_str().unwrap()));
        let digest = profile["archiveSha256"].as_str().unwrap();
        assert_eq!(digest.len(), 64);
        assert!(digest
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
        assert!(profile["fileCount"].as_u64().unwrap() > 0);
        assert!(matches!(profile["runtime"].as_str(), Some("node" | "web")));
    }
}

#[test]
fn foreground_opt_in_requires_one_value_free_reviewed_ui_switch() {
    let valid = vec![
        "fixture".into(),
        "--execute-reviewed-package".into(),
        "--require-foreground".into(),
        "--run-id".into(),
        "00000000-0000-4000-8000-000000000001".into(),
    ];
    assert_eq!(
        parse_require_foreground(&valid, true, false, false).unwrap(),
        true
    );
    assert_eq!(
        parse_require_foreground(&["fixture".into()], false, false, false).unwrap(),
        false
    );
    for invalid in [
        vec![
            "fixture".into(),
            "--execute-reviewed-package".into(),
            "--require-foreground".into(),
            "--require-foreground".into(),
        ],
        vec![
            "fixture".into(),
            "--execute-reviewed-package".into(),
            "--require-foreground=true".into(),
        ],
        vec![
            "fixture".into(),
            "--execute-reviewed-package".into(),
            "--require-foreground".into(),
            "true".into(),
        ],
    ] {
        assert!(parse_require_foreground(&invalid, true, false, false).is_err());
    }
    assert!(parse_require_foreground(&valid, false, false, false).is_err());
    assert!(parse_require_foreground(&valid, true, true, false).is_err());
    assert!(parse_require_foreground(&valid, true, false, true).is_err());
}

#[test]
fn published_fixture_profile_snapshot_reads_only_the_selected_document_and_storage() {
    let db = Database::in_memory().unwrap();
    for id in ["color-helper", "other-plugin"] {
        let plugin = serde_json::from_value(json!({"id":id,"name":id,"version":"1.0.0","path":"/inert",
            "enabled":true,"manifest":{"name":id,"version":"1.0.0"},"created_at":"now","updated_at":"now"})).unwrap();
        db.save_plugin(&plugin).unwrap();
        db.plugin_data_put(
            id,
            &atools_core::models::Document {
                id: "color/ff0000".into(),
                rev: None,
                data: json!({"name":id,"color":"#FF0000"}),
            },
        )
        .unwrap();
    }
    db.plugin_storage_set("color-helper", "collectsort", &json!(["color/ff0000"]))
        .unwrap();
    db.plugin_storage_set("other-plugin", "collectsort", &json!(["secret"]))
        .unwrap();
    let snapshot =
        published_data_snapshot(&db, &json!({"caseId":"color-helper","id":"color-helper"}))
            .unwrap();
    assert_eq!(snapshot["document"]["_id"], "color/ff0000");
    assert_eq!(snapshot["document"]["name"], "color-helper");
    assert_eq!(snapshot["document"]["color"], "#FF0000");
    assert!(snapshot["document"]["_rev"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert_eq!(snapshot["storage"]["value"], json!(["color/ff0000"]));
    assert!(!snapshot.to_string().contains("secret"));
    assert!(
        published_data_snapshot(&db, &json!({"caseId":"regex-editor","id":"other-plugin"}))
            .is_err()
    );
}
#[test]
fn published_fixture_profile_audit_reads_real_history_and_never_exports_private_fields() {
    use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
    let db = Database::in_memory().unwrap();
    let profile = json!({"caseId":"color-helper","id":"color-helper"});
    let mut run = TaskRun::new(
        crate::plugin_data_runtime::registry::tool_name("color-helper"),
        TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"request","method":"db.get","invocationId":"ephemeral"}),
    );
    run.transition(TaskRunStatus::Running).unwrap();
    run.transition(TaskRunStatus::Succeeded).unwrap();
    db.upsert_task_run(&run).unwrap();
    let clean = published_data_audit(&db, &profile).unwrap();
    assert_eq!(
        clean,
        json!({"count":1,"methods":["db.get"],"allTerminal":true,"privateMarkersAbsent":true})
    );
    for secret in [
        "ATools reviewed red",
        "#FF0000",
        "color/ff0000",
        "collectsort",
        "http://127.0.0.1:12345/data/0123456789abcdef",
    ] {
        run.output = json!({"shouldNeverAppear":secret});
        db.upsert_task_run(&run).unwrap();
        let checked = published_data_audit(&db, &profile).unwrap();
        assert_eq!(checked["privateMarkersAbsent"], false);
        assert!(!checked.to_string().contains(secret));
    }
    assert!(
        published_data_audit(&db, &json!({"caseId":"regex-editor","id":"color-helper"})).is_err()
    );
}
