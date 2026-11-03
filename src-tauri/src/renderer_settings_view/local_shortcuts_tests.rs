use super::*;
use serde_json::json;
use std::{fs::File, sync::Arc};

#[test]
fn child_protocol_exposes_only_the_seven_local_shortcut_operations() {
    let allowed = [
        "readLocalShortcuts",
        "addLocalShortcut",
        "addLocalShortcutByPath",
        "deleteLocalShortcut",
        "updateLocalShortcutAlias",
        "openLocalShortcut",
        "deleteMissingLocalShortcuts",
    ];
    for operation in allowed {
        assert!(handles(operation), "missing {operation}");
    }
    assert!(!handles("getLocalShortcutPath"));
    assert!(!handles("openPath"));
}

#[test]
fn protocol_parses_exact_request_shapes_and_cancelable_picker_types() {
    assert!(matches!(
        parse_request("readLocalShortcuts", &json!({})).unwrap(),
        Request::Read
    ));
    assert!(matches!(
        parse_request("addLocalShortcut", &json!({"type":"file"})).unwrap(),
        Request::Add(RendererLocalShortcutType::File)
    ));
    assert!(matches!(
        parse_request("addLocalShortcut", &json!({"type":"folder"})).unwrap(),
        Request::Add(RendererLocalShortcutType::Folder)
    ));
    assert!(matches!(
        parse_request("addLocalShortcutByPath", &json!({"path":"/tmp/a"})).unwrap(),
        Request::AddByPath(path) if path == "/tmp/a"
    ));
    assert!(matches!(
        parse_request("deleteLocalShortcut", &json!({"id":"id-a"})).unwrap(),
        Request::Delete(id) if id == "id-a"
    ));
    assert!(matches!(
        parse_request("updateLocalShortcutAlias", &json!({"id":"id-a","alias":""})).unwrap(),
        Request::SetAlias { alias, .. } if alias.is_empty()
    ));
    assert!(matches!(
        parse_request("openLocalShortcut", &json!({"path":"/tmp/a"})).unwrap(),
        Request::Open(path) if path == "/tmp/a"
    ));
    assert!(matches!(
        parse_request("deleteMissingLocalShortcuts", &json!({})).unwrap(),
        Request::RemoveMissing
    ));
}

#[test]
fn protocol_rejects_extra_fields_missing_fields_bad_types_and_arbitrary_relative_paths() {
    for (operation, payload) in [
        ("readLocalShortcuts", json!({"extra":true})),
        ("addLocalShortcut", json!({"type":"app"})),
        ("addLocalShortcut", json!({"type":"file","path":"/tmp/a"})),
        ("addLocalShortcutByPath", json!({"path":"relative"})),
        ("addLocalShortcutByPath", json!({"path":"/tmp/a\0b"})),
        ("deleteLocalShortcut", json!({"id":""})),
        ("deleteLocalShortcut", json!({"id":"id-a","extra":1})),
        ("updateLocalShortcutAlias", json!({"id":"id-a"})),
        (
            "updateLocalShortcutAlias",
            json!({"id":"id-a","alias":null}),
        ),
        ("openLocalShortcut", json!({"path":"/tmp/a","reveal":true})),
        ("deleteMissingLocalShortcuts", json!({"path":"/tmp/a"})),
    ] {
        assert!(
            parse_request(operation, &payload).is_err(),
            "accepted {payload}"
        );
    }
    assert!(parse_request("unlistedOperation", &json!({})).is_err());
}

#[test]
fn requests_and_responses_keep_their_individual_byte_budgets() {
    let oversized = json!({"id":"id-a","alias":"x".repeat(MAX_OPERATION_BYTES)});
    let error = parse_request("updateLocalShortcutAlias", &oversized).unwrap_err();
    assert_eq!(
        serde_json::to_value(error).unwrap()["code"],
        "SETTINGS_CALL_TOO_LARGE"
    );
    assert!(check_response_budget(
        &json!(["x".repeat(MAX_READ_RESPONSE_BYTES)]),
        MAX_READ_RESPONSE_BYTES
    )
    .is_err());
    assert!(check_response_budget(&json!({"success":true}), MAX_RESPONSE_BYTES).is_ok());
}

#[test]
fn private_filesystem_fixture_round_trips_through_the_real_core_database() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("original.txt");
    File::create(&path).unwrap();
    let record =
        local_shortcut_files::build_record(path.to_str().unwrap().into(), "fixture-id".into())
            .unwrap();
    let database = atools_core::db::Database::in_memory().unwrap();
    let write = database
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add { record },
            || true,
        )
        .unwrap();
    assert!(write.changed);
    assert_eq!(write.revision, 1);
    let loaded = database.read_renderer_local_shortcuts().unwrap();
    assert_eq!(loaded.len(), 1);
    assert_eq!(loaded[0].path, path.to_str().unwrap());
    assert_eq!(loaded[0].kind, RendererLocalShortcutType::File);
    assert!(
        database
            .apply_renderer_local_shortcut_guarded(
                RendererLocalShortcutMutation::SetAlias {
                    id: "fixture-id".into(),
                    alias: "  edit  ".into(),
                },
                || true,
            )
            .unwrap()
            .changed
    );
    let alias = database.read_renderer_local_shortcuts().unwrap();
    assert_eq!(alias[0].alias.as_deref(), Some("edit"));

    let error = database
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Remove {
                id: "fixture-id".into(),
            },
            || false,
        )
        .unwrap_err();
    assert!(
        matches!(error, AToolsError::Config(message) if message == atools_core::db::RENDERER_LOCAL_SHORTCUTS_GUARD_REJECTED)
    );
    assert_eq!(database.read_renderer_local_shortcuts().unwrap().len(), 1);
    let removed = database
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Remove {
                id: "fixture-id".into(),
            },
            || true,
        )
        .unwrap();
    assert!(removed.changed);
    assert!(database.read_renderer_local_shortcuts().unwrap().is_empty());
}

#[test]
fn cleanup_snapshot_removes_only_paths_missing_at_observation_time() {
    let temp = tempfile::tempdir().unwrap();
    let present = temp.path().join("present.txt");
    File::create(&present).unwrap();
    let missing = temp.path().join("missing.txt");
    let records = vec![
        RendererLocalShortcut {
            id: "present".into(),
            name: "present.txt".into(),
            path: present.to_str().unwrap().into(),
            kind: RendererLocalShortcutType::File,
            added_at: 1,
            alias: None,
            icon: None,
            keywords: None,
            pinyin: None,
            pinyin_abbr: None,
        },
        RendererLocalShortcut {
            id: "missing".into(),
            name: "missing.txt".into(),
            path: missing.to_str().unwrap().into(),
            kind: RendererLocalShortcutType::File,
            added_at: 2,
            alias: None,
            icon: None,
            keywords: None,
            pinyin: None,
            pinyin_abbr: None,
        },
    ];
    let expected: Vec<_> = records
        .iter()
        .filter(|record| local_shortcut_files::missing_observation(&record.path))
        .map(|record| RendererLocalShortcutIdentity {
            id: record.id.clone(),
            path: record.path.clone(),
        })
        .collect();
    assert_eq!(expected.len(), 1);
    assert_eq!(expected[0].id, "missing");

    let database = Arc::new(atools_core::db::Database::in_memory().unwrap());
    for record in records {
        database
            .apply_renderer_local_shortcut_guarded(
                RendererLocalShortcutMutation::Add { record },
                || true,
            )
            .unwrap();
    }
    database
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::RemoveMissing { expected },
            || true,
        )
        .unwrap();
    let remaining = database.read_renderer_local_shortcuts().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "present");
}
