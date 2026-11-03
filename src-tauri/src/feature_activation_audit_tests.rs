use super::*;
use atools_core::Plugin;
use serde_json::json;

fn db() -> Database {
    let db = Database::in_memory().unwrap();
    let p = Plugin {
        id: "audit".into(),
        name: "audit".into(),
        version: "1".into(),
        path: "/not-executed".into(),
        enabled: true,
        created_at: "now".into(),
        updated_at: "now".into(),
        manifest: serde_json::from_value(
            json!({"name":"audit","features":[{"code":"audit-feature","cmds":[{"type":"over"}]}]}),
        )
        .unwrap(),
    };
    db.save_plugin_with_features(&p, &p.manifest.features)
        .unwrap();
    db
}

#[test]
fn successful_activation_delivers_original_content_but_durable_task_contains_only_metadata() {
    let db = db();
    for payload in [
        json!("PRIVATE_FIXED_TEXT_😀\nsecond line"),
        json!({"privateField":"PRIVATE_FIXED_TEXT_😀", "nested":["secret"]}),
    ] {
        let run = begin(&db, "audit-feature", &Some(payload.clone()), Some("audit")).unwrap();
        let id = run.id.clone();
        let action =
            resolve_checked(&db, "audit-feature", Some(payload.clone()), Some("audit")).unwrap();
        let action = finish(
            &db,
            "audit-feature",
            Instant::now(),
            run,
            Ok(action),
            |_| {},
        )
        .unwrap();
        assert_eq!(action.payload, payload);
        let stored = db.get_task_run(&id).unwrap().unwrap();
        assert_eq!(stored.status, TaskRunStatus::Succeeded);
        let serialized = serde_json::to_string(&stored).unwrap();
        for private in [
            "PRIVATE_FIXED_TEXT",
            "privateField",
            "secret",
            "second line",
        ] {
            assert!(!serialized.contains(private));
        }
        assert_eq!(stored.input["payloadSummary"]["contentRedacted"], true);
        assert_eq!(stored.output["payload_summary"]["contentRedacted"], true);
        assert_eq!(stored.output["plugin_id"], "audit");
    }
}

#[test]
fn rejected_content_match_is_a_terminal_audited_failure_without_leaking_body() {
    let db = db();
    let payload = Some(json!("PRIVATE_NO_MATCH_".repeat(1000)));
    let run = begin(&db, "audit-feature", &payload, Some("audit")).unwrap();
    let id = run.id.clone();
    let invalid = crate::content_search::entry_type(
        &db,
        "audit-feature",
        payload.as_ref().unwrap().as_str().unwrap(),
        "audit",
    )
    .unwrap_err();
    assert!(finish(
        &db,
        "audit-feature",
        Instant::now(),
        run,
        Err(invalid),
        |_| panic!("No ready effect after rejection")
    )
    .is_err());
    let stored = db.get_task_run(&id).unwrap().unwrap();
    assert_eq!(stored.status, TaskRunStatus::Failed);
    assert!(stored.artifacts.is_empty());
    assert!(!serde_json::to_string(&stored)
        .unwrap()
        .contains("PRIVATE_NO_MATCH"));
}
