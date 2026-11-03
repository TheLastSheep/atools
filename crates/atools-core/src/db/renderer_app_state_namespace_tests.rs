use super::*;

#[test]
fn namespaced_domains_are_authoritative_and_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("namespaced-app-state.sqlite");
    let db = Database::open(&path).unwrap();
    let history = serde_json::json!([{
        "path": "/app",
        "name": "A",
        "type": "direct",
        "subType": "app",
        "lastUsed": 1,
        "useCount": 1
    }])
    .to_string();
    let pins = serde_json::json!([{
        "path": "/app",
        "name": "A",
        "type": "direct",
        "subType": "app"
    }])
    .to_string();
    let usage_stats = serde_json::json!([{
        "path": "/plugin",
        "type": "plugin",
        "featureCode": "open",
        "useCount": 7
    }])
    .to_string();
    let legacy_history = "legacy-history-value";
    let legacy_pins = "legacy-pins-value";
    let legacy_usage_stats = "legacy-usage-stats-value";

    db.set_setting(HISTORY_STORAGE_KEY, &history).unwrap();
    db.set_setting(PINS_STORAGE_KEY, &pins).unwrap();
    db.set_setting("ztools-renderer:command-usage-stats", &usage_stats)
        .unwrap();
    db.set_setting(HISTORY_KEY, legacy_history).unwrap();
    db.set_setting(PINS_KEY, legacy_pins).unwrap();
    db.set_setting("command-usage-stats", legacy_usage_stats)
        .unwrap();

    let initial = db.read_renderer_app_state().unwrap();
    assert_eq!(
        initial.values[HISTORY_KEY].as_deref(),
        Some(history.as_str())
    );
    assert_eq!(initial.values[PINS_KEY].as_deref(), Some(pins.as_str()));

    let recorded = db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/app", "B"),
            now_ms: 2,
        })
        .unwrap();
    assert_eq!(recorded.changed, vec![HISTORY_KEY]);
    let pinned = db
        .apply_renderer_app_state(RendererAppStateMutation::Pin {
            app: app("/app", "B"),
        })
        .unwrap();
    assert_eq!(pinned.changed, vec![PINS_KEY]);
    assert_eq!(pinned.revision, 2);
    assert_eq!(
        db.get_setting(HISTORY_KEY).unwrap().as_deref(),
        Some(legacy_history)
    );
    assert_eq!(
        db.get_setting(PINS_KEY).unwrap().as_deref(),
        Some(legacy_pins)
    );
    assert_eq!(
        db.get_setting("ztools-renderer:command-usage-stats")
            .unwrap()
            .as_deref(),
        Some(usage_stats.as_str())
    );
    assert_eq!(
        db.get_setting("command-usage-stats").unwrap().as_deref(),
        Some(legacy_usage_stats)
    );
    assert_eq!(
        db.get_setting(HISTORY_STORAGE_KEY).unwrap().as_deref(),
        recorded.values[HISTORY_KEY].as_deref()
    );
    assert_eq!(
        db.get_setting(PINS_STORAGE_KEY).unwrap().as_deref(),
        pinned.values[PINS_KEY].as_deref()
    );
    drop(db);

    let reopened = Database::open(&path).unwrap();
    let snapshot = reopened.read_renderer_app_state().unwrap();
    assert_eq!(snapshot.values[HISTORY_KEY], recorded.values[HISTORY_KEY]);
    assert_eq!(snapshot.values[PINS_KEY], pinned.values[PINS_KEY]);
    assert_eq!(snapshot.revision, 2);
    assert!(snapshot.changed.is_empty());
}
