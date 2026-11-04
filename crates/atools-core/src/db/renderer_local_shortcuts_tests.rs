use super::*;

fn shortcut(id: &str, path: &str, name: &str) -> RendererLocalShortcut {
    RendererLocalShortcut {
        id: id.into(),
        name: name.into(),
        path: path.into(),
        kind: RendererLocalShortcutType::Folder,
        added_at: 1_700_000_000_000,
        alias: None,
        icon: None,
        keywords: Some(vec![name.into()]),
        pinyin: None,
        pinyin_abbr: None,
    }
}

fn raw_shortcuts(db: &Database) -> Option<String> {
    db.get_setting(RENDERER_LOCAL_SHORTCUTS_KEY).unwrap()
}

#[test]
fn add_alias_clear_remove_and_reopen_keep_the_public_shortcut_contract() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("local-shortcuts.sqlite");
    let db = Database::open(&path).unwrap();
    assert!(db.read_renderer_local_shortcuts().unwrap().is_empty());

    let added = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut("folder-1", "/Users/test/设计", "设计"),
            },
            || true,
        )
        .unwrap();
    assert_eq!(
        added,
        RendererLocalShortcutWrite {
            changed: true,
            revision: 1
        }
    );
    let listed = db.read_renderer_local_shortcuts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].kind, RendererLocalShortcutType::Folder);
    assert_eq!(listed[0].pinyin.as_deref(), Some("sheji"));
    assert_eq!(listed[0].pinyin_abbr.as_deref(), Some("sj"));

    let aliased = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::SetAlias {
                id: "folder-1".into(),
                alias: "  外部工具  ".into(),
            },
            || true,
        )
        .unwrap();
    assert_eq!(aliased.revision, 2);
    let listed = db.read_renderer_local_shortcuts().unwrap();
    assert_eq!(listed[0].alias.as_deref(), Some("外部工具"));
    assert_eq!(listed[0].pinyin.as_deref(), Some("waibugongju"));
    assert_eq!(listed[0].pinyin_abbr.as_deref(), Some("wbgj"));

    let raw_before_no_op = raw_shortcuts(&db);
    let no_op = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::SetAlias {
                id: "folder-1".into(),
                alias: "外部工具".into(),
            },
            || true,
        )
        .unwrap();
    assert_eq!(
        no_op,
        RendererLocalShortcutWrite {
            changed: false,
            revision: 2
        }
    );
    assert_eq!(raw_shortcuts(&db), raw_before_no_op);

    let cleared = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::SetAlias {
                id: "folder-1".into(),
                alias: " \n ".into(),
            },
            || true,
        )
        .unwrap();
    assert_eq!(cleared.revision, 3);
    drop(db);

    let reopened = Database::open(&path).unwrap();
    let listed = reopened.read_renderer_local_shortcuts().unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].alias, None);
    assert_eq!(listed[0].pinyin.as_deref(), Some("sheji"));
    let removed = reopened
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Remove {
                id: "folder-1".into(),
            },
            || true,
        )
        .unwrap();
    assert_eq!(removed.revision, 4);
    assert!(reopened.read_renderer_local_shortcuts().unwrap().is_empty());
    assert!(
        !reopened
            .apply_renderer_local_shortcut_guarded(
                RendererLocalShortcutMutation::Remove {
                    id: "missing".into(),
                },
                || true,
            )
            .unwrap()
            .changed
    );
}

#[test]
fn raw_unknown_metadata_and_numeric_tokens_survive_append_and_alias_edit() {
    let db = Database::in_memory().unwrap();
    let raw = r#"[ { "id":"legacy", "name":"设计", "path":"/tmp/design", "type":"file", "addedAt":1, "unknownNumber":9007199254740993, "precise":1.234567890123456789012345, "opaqueText":"brace } , quote: \"kept\"", "unknownObject":{"keep":[true,null]} } ]"#;
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, raw).unwrap();
    assert_eq!(db.read_renderer_local_shortcuts().unwrap().len(), 1);

    db.apply_renderer_local_shortcut_guarded(
        RendererLocalShortcutMutation::SetAlias {
            id: "legacy".into(),
            alias: "别名".into(),
        },
        || true,
    )
    .unwrap();
    let after_edit = raw_shortcuts(&db).unwrap();
    assert!(after_edit.contains("9007199254740993"));
    assert!(after_edit.contains("1.234567890123456789012345"));
    assert!(after_edit.contains(r#""opaqueText":"brace } , quote: \"kept\""#));
    assert!(after_edit.contains("\"unknownObject\""));
    assert!(after_edit.contains("\"alias\":\"别名\""));

    db.apply_renderer_local_shortcut_guarded(
        RendererLocalShortcutMutation::Add {
            record: shortcut("new", "/tmp/new", "新项目"),
        },
        || true,
    )
    .unwrap();
    let after_append = raw_shortcuts(&db).unwrap();
    assert!(after_append.contains("9007199254740993"));
    assert!(after_append.contains("1.234567890123456789012345"));
    assert!(after_append.contains("\"unknownObject\""));
    assert_eq!(db.read_renderer_local_shortcuts().unwrap().len(), 2);
}

#[test]
fn duplicate_legacy_rows_remain_readable_and_remove_deletes_every_matching_id() {
    let db = Database::in_memory().unwrap();
    let raw = r#"[{"id":"duplicate","name":"First","path":"/same","type":"file","addedAt":1,"opaque":9007199254740993},{"id":"duplicate","name":"Second","path":"/same","type":"folder","addedAt":2,"opaque":1.2300}]"#;
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, raw).unwrap();
    assert_eq!(db.read_renderer_local_shortcuts().unwrap().len(), 2);

    assert!(db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut("third", "/same", "Third"),
            },
            || true,
        )
        .is_err());
    assert_eq!(raw_shortcuts(&db).as_deref(), Some(raw));
    assert_eq!(
        db.get_setting("ztools-renderer:local-shortcuts-revision")
            .unwrap(),
        None
    );

    db.apply_renderer_local_shortcut_guarded(
        RendererLocalShortcutMutation::SetAlias {
            id: "duplicate".into(),
            alias: "Only first".into(),
        },
        || true,
    )
    .unwrap();
    let listed = db.read_renderer_local_shortcuts().unwrap();
    assert_eq!(listed[0].alias.as_deref(), Some("Only first"));
    assert_eq!(listed[1].alias, None);
    let removed = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Remove {
                id: "duplicate".into(),
            },
            || true,
        )
        .unwrap();
    assert!(removed.changed);
    assert!(db.read_renderer_local_shortcuts().unwrap().is_empty());
}

#[test]
fn remove_missing_uses_both_observed_identity_fields() {
    let db = Database::in_memory().unwrap();
    let raw = r#"[{"id":"old","name":"Old","path":"/replaced","type":"file","addedAt":1},{"id":"live","name":"Live","path":"/live","type":"folder","addedAt":2}]"#;
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, raw).unwrap();
    let result = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::RemoveMissing {
                expected: vec![
                    RendererLocalShortcutIdentity {
                        id: "old".into(),
                        path: "/old-observation".into(),
                    },
                    RendererLocalShortcutIdentity {
                        id: "live".into(),
                        path: "/live".into(),
                    },
                ],
            },
            || true,
        )
        .unwrap();
    assert!(result.changed);
    let remaining = db.read_renderer_local_shortcuts().unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, "old");

    let no_op = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::RemoveMissing {
                expected: vec![RendererLocalShortcutIdentity {
                    id: "old".into(),
                    path: "/old-observation".into(),
                }],
            },
            || true,
        )
        .unwrap();
    assert!(!no_op.changed);
    assert_eq!(db.read_renderer_local_shortcuts().unwrap()[0].id, "old");
}

#[test]
fn sqlite_immediate_writes_from_separate_connections_preserve_both_updates() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("cross-connection.sqlite");
    let first = Database::open(&path).unwrap();
    let second = Database::open(&path).unwrap();

    first
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut("one", "/one", "One"),
            },
            || true,
        )
        .unwrap();
    second
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut("two", "/two", "Two"),
            },
            || true,
        )
        .unwrap();

    assert_eq!(first.read_renderer_local_shortcuts().unwrap().len(), 2);
    assert_eq!(second.read_renderer_local_shortcuts().unwrap().len(), 2);
    assert_eq!(
        second
            .get_setting("ztools-renderer:local-shortcuts-revision")
            .unwrap()
            .as_deref(),
        Some("2")
    );
}

#[test]
fn utf8_identity_limits_are_measured_in_bytes_at_the_exact_boundary() {
    let db = Database::in_memory().unwrap();
    let id = format!("{}a", "你".repeat(85));
    let path = format!("/{}", "你".repeat(5461));
    assert_eq!(id.len(), 256);
    assert_eq!(path.len(), 16 * 1024);
    let mut exact = shortcut(&id, &path, "目录");
    exact.kind = RendererLocalShortcutType::App;
    assert!(
        db.apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add { record: exact },
            || true,
        )
        .unwrap()
        .changed
    );

    for (invalid_id, invalid_path) in [
        (format!("{}ab", "你".repeat(85)), path.clone()),
        ("other".into(), format!("{path}a")),
    ] {
        let result = db.apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut(&invalid_id, &invalid_path, "目录"),
            },
            || true,
        );
        assert!(result.is_err());
    }
    assert_eq!(db.read_renderer_local_shortcuts().unwrap().len(), 1);
    assert_eq!(
        db.get_setting("ztools-renderer:local-shortcuts-revision")
            .unwrap()
            .as_deref(),
        Some("1")
    );
}

#[test]
fn guard_and_budget_rejections_leave_data_and_revision_untouched() {
    let db = Database::in_memory().unwrap();
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, "[]").unwrap();
    let rejected = std::cell::Cell::new(false);
    let error = db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut("guarded", "/guarded", "Guarded"),
            },
            || {
                rejected.set(true);
                false
            },
        )
        .unwrap_err();
    assert!(rejected.get());
    assert!(
        matches!(error, AToolsError::Config(message) if message == RENDERER_LOCAL_SHORTCUTS_GUARD_REJECTED)
    );
    assert_eq!(raw_shortcuts(&db).as_deref(), Some("[]"));
    assert_eq!(
        db.get_setting("ztools-renderer:local-shortcuts-revision")
            .unwrap(),
        None
    );

    let mut too_large = shortcut("large", "/large", "Large");
    too_large.icon = Some("i".repeat(64 * 1024));
    too_large.keywords = Some(vec!["k".repeat(512); 128]);
    assert!(db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add { record: too_large },
            || true,
        )
        .is_err());
    assert_eq!(raw_shortcuts(&db).as_deref(), Some("[]"));
    assert_eq!(
        db.get_setting("ztools-renderer:local-shortcuts-revision")
            .unwrap(),
        None
    );

    let raw = format!(
        r#"[{{"id":"large-old","name":"Old","path":"/old","type":"file","addedAt":1,"opaque":"{}"}}]"#,
        "x".repeat(127_800)
    );
    assert!(raw.len() < records::MAX_STORED_BYTES);
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, &raw).unwrap();
    assert!(db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut("new", "/new", &"n".repeat(4 * 1024)),
            },
            || true,
        )
        .is_err());
    assert_eq!(raw_shortcuts(&db).as_deref(), Some(raw.as_str()));
    assert_eq!(
        db.get_setting("ztools-renderer:local-shortcuts-revision")
            .unwrap(),
        None
    );
}

#[test]
fn malformed_null_depth_node_and_revision_values_are_rejected_without_cleanup() {
    let db = Database::in_memory().unwrap();
    for raw in ["null", "{broken"] {
        db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, raw).unwrap();
        assert!(db.read_renderer_local_shortcuts().is_err());
        assert_eq!(raw_shortcuts(&db).as_deref(), Some(raw));
    }

    let deep = format!(
        r#"[{{"id":"deep","name":"Deep","path":"/deep","type":"file","addedAt":1,"meta":{}0{}}}]"#,
        "[".repeat(8),
        "]".repeat(8)
    );
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, &deep).unwrap();
    assert!(db.read_renderer_local_shortcuts().is_err());
    assert_eq!(raw_shortcuts(&db).as_deref(), Some(deep.as_str()));

    let at_limit_values = std::iter::repeat_n("0", 32_760)
        .collect::<Vec<_>>()
        .join(",");
    let at_limit = format!(
        r#"[{{"id":"limit","name":"Limit","path":"/limit","type":"file","addedAt":1,"meta":[{at_limit_values}]}}]"#
    );
    assert!(at_limit.len() < records::MAX_STORED_BYTES);
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, &at_limit)
        .unwrap();
    assert_eq!(db.read_renderer_local_shortcuts().unwrap().len(), 1);

    let values = std::iter::repeat_n("0", 32_767)
        .collect::<Vec<_>>()
        .join(",");
    let many_nodes = format!(
        r#"[{{"id":"nodes","name":"Nodes","path":"/nodes","type":"file","addedAt":1,"meta":[{values}]}}]"#
    );
    assert!(many_nodes.len() < records::MAX_STORED_BYTES);
    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, &many_nodes)
        .unwrap();
    assert!(db.read_renderer_local_shortcuts().is_err());
    assert_eq!(raw_shortcuts(&db).as_deref(), Some(many_nodes.as_str()));

    db.set_setting(RENDERER_LOCAL_SHORTCUTS_KEY, "[]").unwrap();
    db.set_setting(
        "ztools-renderer:local-shortcuts-revision",
        "9007199254740992",
    )
    .unwrap();
    assert!(db
        .apply_renderer_local_shortcut_guarded(
            RendererLocalShortcutMutation::Add {
                record: shortcut("revision", "/revision", "Revision"),
            },
            || true,
        )
        .is_err());
    assert_eq!(raw_shortcuts(&db).as_deref(), Some("[]"));
    assert_eq!(
        db.get_setting("ztools-renderer:local-shortcuts-revision")
            .unwrap()
            .as_deref(),
        Some("9007199254740992")
    );
}
