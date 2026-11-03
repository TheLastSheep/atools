use super::*;

fn app(path: &str, name: &str) -> RendererAppIdentity {
    RendererAppIdentity {
        path: path.into(),
        name: name.into(),
        sub_type: RendererDirectSubtype::App,
    }
}

fn domain_storage_key(key: &str) -> &'static str {
    match key {
        HISTORY_KEY => HISTORY_STORAGE_KEY,
        PINS_KEY => PINS_STORAGE_KEY,
        _ => unreachable!("unknown renderer app state key"),
    }
}

fn set_domain_setting(db: &Database, key: &str, value: &str) -> crate::error::Result<()> {
    db.set_setting(domain_storage_key(key), value)
}

fn get_domain_setting(db: &Database, key: &str) -> crate::error::Result<Option<String>> {
    db.get_setting(domain_storage_key(key))
}

fn json(snapshot: &RendererAppStateSnapshot, key: &str) -> Vec<Value> {
    serde_json::from_str(snapshot.values[key].as_deref().unwrap()).unwrap()
}

#[test]
fn missing_domains_stay_null_and_launches_merge_aliases_in_recent_order() {
    let db = Database::in_memory().unwrap();
    let initial = db.read_renderer_app_state().unwrap();
    assert_eq!(initial.version, 1);
    assert_eq!(initial.revision, 0);
    assert_eq!(initial.values[HISTORY_KEY], None);
    assert_eq!(initial.values[PINS_KEY], None);

    db.apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
        app: app("/Applications/Editor.app", "Editor"),
        now_ms: 100,
    })
    .unwrap();
    db.apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
        app: app("/Applications/Editor.app", "Editor Beta"),
        now_ms: 200,
    })
    .unwrap();
    let result = db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/Applications/Editor.app", "Editor"),
            now_ms: 300,
        })
        .unwrap();

    let history = json(&result, HISTORY_KEY);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["name"], "Editor");
    assert_eq!(history[0]["lastUsed"], 300);
    assert_eq!(history[0]["useCount"], 2);
    assert_eq!(history[1]["name"], "Editor Beta");
    assert_eq!(history[1]["lastUsed"], 200);
    assert_eq!(history[0]["type"], "direct");
    assert_eq!(history[0]["subType"], "app");
    assert_eq!(result.values[PINS_KEY], None);
    assert_eq!(result.revision, 3);
}

#[test]
fn legacy_app_history_is_normalized_without_losing_extra_fields() {
    let db = Database::in_memory().unwrap();
    let existing = serde_json::json!([{
        "path": "/Applications/Editor.app",
        "name": "Editor",
        "type": "app",
        "lastUsed": 10,
        "useCount": 4,
        "customMetadata": {"source": "legacy"}
    }]);
    set_domain_setting(&db, HISTORY_KEY, &existing.to_string()).unwrap();

    let result = db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/Applications/Editor.app", "Editor"),
            now_ms: 20,
        })
        .unwrap();
    let history = json(&result, HISTORY_KEY);
    assert_eq!(history.len(), 1);
    assert_eq!(history[0]["type"], "direct");
    assert_eq!(history[0]["subType"], "app");
    assert_eq!(history[0]["useCount"], 5);
    assert_eq!(history[0]["customMetadata"]["source"], "legacy");
}

#[test]
fn history_uses_record_name_while_pins_use_persisted_name() {
    let db = Database::in_memory().unwrap();
    let history = serde_json::json!([{
        "path": "/app",
        "name": "Current Name",
        "persistedName": "Saved Name",
        "type": "direct",
        "subType": "app",
        "useCount": 2
    }]);
    let pins = serde_json::json!([{
        "path": "/app",
        "name": "Current Name",
        "persistedName": "Saved Name",
        "type": "direct",
        "subType": "app"
    }]);
    set_domain_setting(&db, HISTORY_KEY, &history.to_string()).unwrap();
    set_domain_setting(&db, PINS_KEY, &pins.to_string()).unwrap();

    let launch = db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/app", "Current Name"),
            now_ms: 5,
        })
        .unwrap();
    assert_eq!(json(&launch, HISTORY_KEY)[0]["useCount"], 3);

    let duplicate = db
        .apply_renderer_app_state(RendererAppStateMutation::Pin {
            app: app("/app", "Saved Name"),
        })
        .unwrap();
    assert!(duplicate.changed.is_empty());

    let removed = db
        .apply_renderer_app_state(RendererAppStateMutation::RemoveHistory {
            path: "/app".into(),
            name: Some("Current Name".into()),
        })
        .unwrap();
    assert_eq!(json(&removed, HISTORY_KEY).len(), 0);
    let unpinned = db
        .apply_renderer_app_state(RendererAppStateMutation::Unpin {
            path: "/app".into(),
            name: Some("Saved Name".into()),
        })
        .unwrap();
    assert_eq!(json(&unpinned, PINS_KEY).len(), 0);
}

#[test]
fn pins_deduplicate_aliases_and_removal_preserves_opaque_records() {
    let db = Database::in_memory().unwrap();
    let seeded = serde_json::json!([
        {"path": "opaque", "type": "plugin", "featureCode": "x", "payload": [1, 2]},
        {"path": "/app", "name": "Alpha", "type": "direct", "subType": "app"},
        {"path": "unknown", "payload": {"keep": true}}
    ]);
    set_domain_setting(&db, PINS_KEY, &seeded.to_string()).unwrap();

    let duplicate = db
        .apply_renderer_app_state(RendererAppStateMutation::Pin {
            app: app("/app", "Alpha"),
        })
        .unwrap();
    assert!(duplicate.changed.is_empty());
    assert_eq!(duplicate.revision, 0);

    let added = db
        .apply_renderer_app_state(RendererAppStateMutation::Pin {
            app: app("/app", "Beta"),
        })
        .unwrap();
    let pins = json(&added, PINS_KEY);
    assert_eq!(pins.len(), 4);
    assert_eq!(pins[3]["name"], "Beta");
    assert_eq!(pins[3]["subType"], "app");

    let unpinned = db
        .apply_renderer_app_state(RendererAppStateMutation::Unpin {
            path: "/app".into(),
            name: Some("Alpha".into()),
        })
        .unwrap();
    let pins = json(&unpinned, PINS_KEY);
    assert_eq!(pins.len(), 3);
    assert_eq!(pins[0], seeded[0]);
    assert_eq!(pins[1], seeded[2]);
    assert_eq!(pins[2]["name"], "Beta");

    let history = serde_json::json!([
        {"path": "opaque", "type": "plugin", "featureCode": "x", "lastUsed": 3},
        {"path": "/app", "name": "Alpha", "type": "app", "lastUsed": 2},
        {"path": "/app", "name": "Beta", "type": "direct", "subType": "app", "lastUsed": 1}
    ]);
    set_domain_setting(&db, HISTORY_KEY, &history.to_string()).unwrap();
    let removed = db
        .apply_renderer_app_state(RendererAppStateMutation::RemoveHistory {
            path: "/app".into(),
            name: Some("Alpha".into()),
        })
        .unwrap();
    let history = json(&removed, HISTORY_KEY);
    assert_eq!(history.len(), 2);
    assert_eq!(history[0]["type"], "plugin");
    assert_eq!(history[1]["name"], "Beta");
}

#[test]
fn reorder_changes_only_app_slots_and_rejects_incomplete_or_duplicate_orders() {
    let db = Database::in_memory().unwrap();
    let original = serde_json::json!([
        {"path": "/app", "name": "A", "type": "direct", "subType": "app"},
        {"path": "opaque", "type": "plugin", "featureCode": "p", "extra": [1]},
        {"path": "/app", "name": "B", "type": "direct", "subType": "app"},
        {"path": "unknown", "extra": true}
    ]);
    set_domain_setting(&db, PINS_KEY, &original.to_string()).unwrap();

    let reordered = db
        .apply_renderer_app_state(RendererAppStateMutation::ReorderPins {
            apps: vec![app("/app", "B"), app("/app", "A")],
        })
        .unwrap();
    let pins = json(&reordered, PINS_KEY);
    assert_eq!(pins[0]["name"], "B");
    assert_eq!(pins[1], original[1]);
    assert_eq!(pins[2]["name"], "A");
    assert_eq!(pins[3], original[3]);

    let acknowledged = db
        .apply_renderer_app_state(RendererAppStateMutation::ReorderPins {
            apps: vec![app("/app", "B"), app("/app", "A")],
        })
        .unwrap();
    assert_eq!(acknowledged.revision, reordered.revision + 1);
    assert_eq!(acknowledged.changed, vec![PINS_KEY]);
    assert_eq!(acknowledged.values, reordered.values);

    let before = reordered.values[PINS_KEY].clone();
    for apps in [
        vec![app("/app", "A")],
        vec![app("/app", "A"), app("/app", "A")],
    ] {
        assert!(db
            .apply_renderer_app_state(RendererAppStateMutation::ReorderPins { apps })
            .is_err());
        assert_eq!(get_domain_setting(&db, PINS_KEY).unwrap(), before);
    }
}

#[test]
fn explicit_clear_writes_empty_arrays_and_noop_clear_keeps_revision() {
    let db = Database::in_memory().unwrap();
    let cleared = db
        .apply_renderer_app_state(RendererAppStateMutation::ClearHistory)
        .unwrap();
    assert_eq!(cleared.values[HISTORY_KEY].as_deref(), Some("[]"));
    assert_eq!(cleared.values[PINS_KEY], None);
    assert_eq!(cleared.revision, 1);

    let repeated = db
        .apply_renderer_app_state(RendererAppStateMutation::ClearHistory)
        .unwrap();
    assert!(repeated.changed.is_empty());
    assert_eq!(repeated.revision, 1);

    let pins = db
        .apply_renderer_app_state(RendererAppStateMutation::ClearPins)
        .unwrap();
    assert_eq!(pins.values[PINS_KEY].as_deref(), Some("[]"));
    assert_eq!(pins.revision, 2);
}

#[test]
fn malformed_and_over_budget_state_rolls_back_without_revision_changes() {
    let db = Database::in_memory().unwrap();
    set_domain_setting(&db, HISTORY_KEY, "{invalid").unwrap();
    assert!(db.read_renderer_app_state().is_err());
    assert!(db
        .apply_renderer_app_state(RendererAppStateMutation::ClearHistory)
        .is_err());
    assert_eq!(
        get_domain_setting(&db, HISTORY_KEY).unwrap().as_deref(),
        Some("{invalid")
    );
    assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);

    let oversized_count = serde_json::to_string(&vec![Value::Null; MAX_ARRAY_ITEMS + 1]).unwrap();
    set_domain_setting(&db, HISTORY_KEY, &oversized_count).unwrap();
    assert!(db
        .apply_renderer_app_state(RendererAppStateMutation::ClearHistory)
        .is_err());
    assert_eq!(
        get_domain_setting(&db, HISTORY_KEY).unwrap().as_deref(),
        Some(oversized_count.as_str())
    );
    assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);

    for invalid_records in ["[null]", "[1]"] {
        set_domain_setting(&db, HISTORY_KEY, invalid_records).unwrap();
        assert!(db
            .apply_renderer_app_state(RendererAppStateMutation::ClearHistory)
            .is_err());
        assert_eq!(
            get_domain_setting(&db, HISTORY_KEY).unwrap().as_deref(),
            Some(invalid_records)
        );
        assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);
    }

    let payload = "x".repeat(127 * 1024);
    let near_budget = serde_json::json!([{
        "path": "/app",
        "name": "A",
        "type": "direct",
        "subType": "app",
        "lastUsed": 1,
        "payload": payload
    }])
    .to_string();
    assert!(near_budget.len() < MAX_ARRAY_BYTES);
    set_domain_setting(&db, HISTORY_KEY, &near_budget).unwrap();
    let long_name = "n".repeat(MAX_NAME_BYTES);
    assert!(db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/app", &long_name),
            now_ms: 2,
        })
        .is_err());
    assert_eq!(
        get_domain_setting(&db, HISTORY_KEY).unwrap().as_deref(),
        Some(near_budget.as_str())
    );
    assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);
}

#[test]
fn counter_and_revision_overflow_are_rejected_without_writes() {
    let db = Database::in_memory().unwrap();
    let history = serde_json::json!([{
        "path": "/app",
        "name": "A",
        "type": "app",
        "useCount": u64::MAX
    }]);
    set_domain_setting(&db, HISTORY_KEY, &history.to_string()).unwrap();
    assert!(db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/app", "A"),
            now_ms: 5,
        })
        .is_err());
    assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);

    let safe_limit_count = serde_json::json!([{
        "path": "/app",
        "name": "A",
        "type": "app",
        "useCount": MAX_SAFE_INTEGER
    }])
    .to_string();
    set_domain_setting(&db, HISTORY_KEY, &safe_limit_count).unwrap();
    assert!(db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/app", "A"),
            now_ms: 5,
        })
        .is_err());
    assert_eq!(
        get_domain_setting(&db, HISTORY_KEY).unwrap().as_deref(),
        Some(safe_limit_count.as_str())
    );
    assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);

    for invalid_count in [serde_json::json!(-1), serde_json::json!(1.5)] {
        let invalid_history = serde_json::json!([{
            "path": "/app",
            "name": "A",
            "type": "app",
            "useCount": invalid_count
        }])
        .to_string();
        set_domain_setting(&db, HISTORY_KEY, &invalid_history).unwrap();
        assert!(db
            .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
                app: app("/app", "A"),
                now_ms: 5,
            })
            .is_err());
        assert_eq!(
            get_domain_setting(&db, HISTORY_KEY).unwrap().as_deref(),
            Some(invalid_history.as_str())
        );
        assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);
    }

    let unsafe_count = serde_json::json!([{
        "path": "/app",
        "name": "A",
        "type": "app",
        "useCount": MAX_SAFE_INTEGER + 1
    }])
    .to_string();
    set_domain_setting(&db, HISTORY_KEY, &unsafe_count).unwrap();
    assert!(db
        .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
            app: app("/app", "A"),
            now_ms: 5,
        })
        .is_err());
    assert_eq!(
        get_domain_setting(&db, HISTORY_KEY).unwrap().as_deref(),
        Some(unsafe_count.as_str())
    );
    assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);

    set_domain_setting(&db, HISTORY_KEY, "[]").unwrap();
    db.set_setting(REVISION_KEY, &MAX_SAFE_INTEGER.to_string())
        .unwrap();
    assert!(db
        .apply_renderer_app_state(RendererAppStateMutation::Pin {
            app: app("/app", "A"),
        })
        .is_err());
    assert_eq!(get_domain_setting(&db, PINS_KEY).unwrap(), None);
    assert_eq!(
        db.get_setting(REVISION_KEY).unwrap().as_deref(),
        Some("9007199254740991")
    );
}

#[test]
fn unsafe_launch_timestamps_are_rejected_atomically() {
    let db = Database::in_memory().unwrap();
    for now_ms in [-1, MAX_SAFE_INTEGER as i64 + 1] {
        assert!(db
            .apply_renderer_app_state(RendererAppStateMutation::RecordLaunch {
                app: app("/app", "A"),
                now_ms,
            })
            .is_err());
        assert_eq!(get_domain_setting(&db, HISTORY_KEY).unwrap(), None);
        assert_eq!(db.get_setting(REVISION_KEY).unwrap(), None);
    }
}

#[test]
fn revision_is_monotonic_and_state_survives_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("app-state.sqlite");
    let db = Database::open(&path).unwrap();
    db.apply_renderer_app_state(RendererAppStateMutation::Pin {
        app: app("/app", "A"),
    })
    .unwrap();
    let second = db
        .apply_renderer_app_state(RendererAppStateMutation::Pin {
            app: app("/app", "B"),
        })
        .unwrap();
    assert_eq!(second.revision, 2);
    drop(db);

    let reopened = Database::open(&path).unwrap();
    let snapshot = reopened.read_renderer_app_state().unwrap();
    assert_eq!(snapshot.revision, 2);
    let pins = json(&snapshot, PINS_KEY);
    assert_eq!(pins.len(), 2);
    assert_eq!(pins[0]["name"], "A");
    assert_eq!(pins[1]["name"], "B");
}

#[path = "renderer_app_state_namespace_tests.rs"]
mod namespace_tests;
