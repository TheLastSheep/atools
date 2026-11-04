use super::*;
use crate::db::RendererDirectSubtype;
use std::sync::atomic::{AtomicBool, Ordering};

fn app(path: &str) -> RendererAppIdentity {
    RendererAppIdentity {
        path: path.into(),
        name: "Same Name".into(),
        sub_type: RendererDirectSubtype::App,
    }
}
fn create(path: &str, enabled: bool) -> AppGlobalShortcutMutation {
    AppGlobalShortcutMutation::Create {
        target: app(path),
        shortcut: "Alt+1".into(),
        enabled,
    }
}
fn write(db: &Database, change: AppGlobalShortcutMutation) -> AppGlobalShortcutWrite {
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    let plan = db
        .prepare_renderer_app_global_shortcut_write(&before, change)
        .unwrap();
    db.commit_renderer_app_global_shortcut_write_guarded(plan, || true)
        .unwrap()
}
#[test]
fn create_same_name_different_paths_are_distinct_and_disabled_is_retained() {
    let db = Database::in_memory().unwrap();
    let first = write(&db, create("/Applications/One.app", true));
    assert!(first.changed);
    assert_eq!(first.snapshot.revision, 1);
    let second = write(&db, create("/Applications/Two.app", false));
    assert_eq!(second.snapshot.bindings.len(), 2);
    assert!(second
        .snapshot
        .bindings
        .iter()
        .any(|b| b.path.ends_with("Two.app") && !b.enabled && b.public_matches));
    assert!(second
        .snapshot
        .bindings
        .iter()
        .all(|b| b.row_id.len() == 32 && b.generation.len() == 32));
    assert_ne!(
        second.snapshot.bindings[0].row_id,
        second.snapshot.bindings[1].row_id
    );
}
#[test]
fn legacy_unknown_large_number_tokens_order_and_owned_extensions_survive_all_edits() {
    let db = Database::in_memory().unwrap();
    let plugin = r#"{ "id":"plugin", "target":"plug/cmd", "big":90071992547409931234567890,"float":1.000000000000000111,"opaque":{"x":[true,null]} }"#;
    let legacy = r#"{"id":"old","shortcut":"Alt+2","target":"old label","enabled":false,"autoCopy":false,"extension":1e999}"#;
    db.set_setting(
        APP_GLOBAL_SHORTCUTS_KEY,
        &format!("[{},{}]", plugin, legacy),
    )
    .unwrap();
    let adopted = write(
        &db,
        AppGlobalShortcutMutation::Adopt {
            row_id: "old".into(),
            target: app("/Applications/One.app"),
            shortcut: "Alt+2".into(),
            enabled: false,
        },
    );
    let raw = adopted.snapshot.public_raw.as_ref().unwrap();
    assert!(raw.starts_with(&format!("[{},", plugin)));
    assert!(raw.contains("\"extension\":1e999"));
    let gen = adopted.snapshot.bindings[0].generation.clone();
    let updated = write(
        &db,
        AppGlobalShortcutMutation::Update {
            row_id: "old".into(),
            target: app("/Applications/Two.app"),
            shortcut: "Alt+3".into(),
            enabled: true,
        },
    );
    assert_ne!(updated.snapshot.bindings[0].generation, gen);
    assert!(updated
        .snapshot
        .public_raw
        .unwrap()
        .contains("\"extension\":1e999"));
    let removed = write(
        &db,
        AppGlobalShortcutMutation::Remove {
            row_id: "old".into(),
        },
    );
    assert_eq!(
        removed.snapshot.public_raw.as_deref(),
        Some(format!("[{}]", plugin).as_str())
    );
    assert!(removed.snapshot.bindings.is_empty());
}
#[test]
fn reads_never_migrate_name_matches_and_explicit_adopt_is_required() {
    let db = Database::in_memory().unwrap();
    let raw = r#"[ {"id":"old","target":"Same Name","shortcut":"Alt+1","enabled":false} ]"#;
    db.set_setting(APP_GLOBAL_SHORTCUTS_KEY, raw).unwrap();
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    assert!(before.bindings.is_empty());
    assert_eq!(before.public_raw.as_deref(), Some(raw));
    assert_eq!(
        db.get_setting(APP_GLOBAL_SHORTCUT_TARGETS_KEY).unwrap(),
        None
    );
    assert!(db
        .prepare_renderer_app_global_shortcut_write(
            &before,
            AppGlobalShortcutMutation::Update {
                row_id: "old".into(),
                target: app("/Applications/One.app"),
                shortcut: "Alt+2".into(),
                enabled: true
            }
        )
        .is_err());
    let result = write(
        &db,
        AppGlobalShortcutMutation::Adopt {
            row_id: "old".into(),
            target: app("/Applications/One.app"),
            shortcut: "Alt+2".into(),
            enabled: false,
        },
    );
    assert!(!result.snapshot.bindings[0].enabled);
}
#[test]
fn public_drift_never_restores_and_update_delete_cannot_clobber_it() {
    let db = Database::in_memory().unwrap();
    let saved = write(&db, create("/Applications/One.app", true));
    let id = saved.snapshot.bindings[0].row_id.clone();
    let drift = saved
        .snapshot
        .public_raw
        .unwrap()
        .replace("Same Name", "other label");
    db.set_setting(APP_GLOBAL_SHORTCUTS_KEY, &drift).unwrap();
    let snapshot = db.read_renderer_app_global_shortcuts().unwrap();
    assert!(!snapshot.bindings[0].public_matches);
    for change in [
        AppGlobalShortcutMutation::Remove { row_id: id.clone() },
        AppGlobalShortcutMutation::SetEnabled {
            row_id: id.clone(),
            enabled: false,
        },
    ] {
        assert!(db
            .prepare_renderer_app_global_shortcut_write(&snapshot, change)
            .is_err());
    }
    let adopted = write(
        &db,
        AppGlobalShortcutMutation::Adopt {
            row_id: id,
            target: app("/Applications/One.app"),
            shortcut: "Alt+2".into(),
            enabled: true,
        },
    );
    assert!(adopted.snapshot.bindings[0].public_matches);
    assert_ne!(
        adopted.snapshot.bindings[0].generation,
        snapshot.bindings[0].generation
    );
}
#[test]
fn stale_full_raw_even_without_revision_change_rejects_prepare_and_commit() {
    let db = Database::in_memory().unwrap();
    let original = db.read_renderer_app_global_shortcuts().unwrap();
    let plan = db
        .prepare_renderer_app_global_shortcut_write(
            &original,
            create("/Applications/One.app", true),
        )
        .unwrap();
    db.set_setting(APP_GLOBAL_SHORTCUTS_KEY, "[{}]").unwrap();
    assert!(db
        .prepare_renderer_app_global_shortcut_write(
            &original,
            create("/Applications/Two.app", true)
        )
        .is_err());
    let called = AtomicBool::new(false);
    assert!(db
        .commit_renderer_app_global_shortcut_write_guarded(plan, || {
            called.store(true, Ordering::SeqCst);
            true
        })
        .is_err());
    assert!(!called.load(Ordering::SeqCst));
    assert_eq!(
        db.get_setting(APP_GLOBAL_SHORTCUTS_KEY).unwrap().as_deref(),
        Some("[{}]")
    );
    assert_eq!(
        db.get_setting(APP_GLOBAL_SHORTCUT_TARGETS_KEY).unwrap(),
        None
    );
}
#[test]
fn authority_raw_and_revision_raw_are_both_part_of_full_cas() {
    let db = Database::in_memory().unwrap();
    let saved = write(&db, create("/Applications/One.app", true)).snapshot;
    for key in [
        APP_GLOBAL_SHORTCUT_TARGETS_KEY,
        APP_GLOBAL_SHORTCUT_REVISION_KEY,
    ] {
        let before = db.read_renderer_app_global_shortcuts().unwrap();
        let plan = db
            .prepare_renderer_app_global_shortcut_write(
                &before,
                AppGlobalShortcutMutation::SetEnabled {
                    row_id: saved.bindings[0].row_id.clone(),
                    enabled: false,
                },
            )
            .unwrap();
        let raw = db.get_setting(key).unwrap().unwrap();
        db.set_setting(key, &format!(" {} ", raw)).unwrap();
        assert!(db
            .commit_renderer_app_global_shortcut_write_guarded(plan, || true)
            .is_err());
        db.set_setting(key, &raw).unwrap();
    }
}
#[test]
fn final_guard_rolls_back_all_three_writes_and_noop_keeps_exact_raw() {
    let db = Database::in_memory().unwrap();
    db.set_setting("unrelated", "keep").unwrap();
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    let plan = db
        .prepare_renderer_app_global_shortcut_write(&before, create("/Applications/One.app", true))
        .unwrap();
    let error = db
        .commit_renderer_app_global_shortcut_write_guarded(plan, || false)
        .unwrap_err();
    assert!(error
        .to_string()
        .contains(APP_GLOBAL_SHORTCUT_GUARD_REJECTED));
    assert_eq!(db.read_renderer_app_global_shortcuts().unwrap(), before);
    let saved = write(&db, create("/Applications/One.app", false)).snapshot;
    let raw = format!(" {} ", saved.public_raw.unwrap());
    db.set_setting(APP_GLOBAL_SHORTCUTS_KEY, &raw).unwrap();
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    let result = write(
        &db,
        AppGlobalShortcutMutation::Update {
            row_id: before.bindings[0].row_id.clone(),
            target: app("/Applications/One.app"),
            shortcut: "Alt+1".into(),
            enabled: false,
        },
    );
    assert!(!result.changed);
    assert_eq!(result.snapshot, before);
    let result = write(
        &db,
        AppGlobalShortcutMutation::SetEnabled {
            row_id: before.bindings[0].row_id.clone(),
            enabled: false,
        },
    );
    assert!(!result.changed);
    assert_eq!(result.snapshot, before);
    assert_eq!(
        db.get_setting("unrelated").unwrap().as_deref(),
        Some("keep")
    );
}
#[test]
fn actual_sql_failure_after_first_write_is_atomic() {
    let db = Database::in_memory().unwrap();
    db.conn.lock().execute_batch("CREATE TRIGGER fail_authority BEFORE INSERT ON settings WHEN NEW.key='ztools-renderer:app-global-shortcut-targets' BEGIN SELECT RAISE(ABORT,'test authority failure'); END;").unwrap();
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    let plan = db
        .prepare_renderer_app_global_shortcut_write(&before, create("/Applications/One.app", true))
        .unwrap();
    assert!(db
        .commit_renderer_app_global_shortcut_write_guarded(plan, || true)
        .is_err());
    assert_eq!(db.read_renderer_app_global_shortcuts().unwrap(), before);
}
#[test]
fn invalid_authority_unknown_fields_future_versions_and_duplicate_owned_ids_reject() {
    let db = Database::in_memory().unwrap();
    let saved = write(&db, create("/Applications/One.app", true)).snapshot;
    let row = raw::rows(saved.public_raw.as_deref()).unwrap().remove(0);
    db.set_setting(
        APP_GLOBAL_SHORTCUTS_KEY,
        &format!("[{},{}]", row.get(), row.get()),
    )
    .unwrap();
    assert!(db.read_renderer_app_global_shortcuts().is_err());
    db.set_setting(
        APP_GLOBAL_SHORTCUTS_KEY,
        saved.public_raw.as_deref().unwrap(),
    )
    .unwrap();
    let authority = saved.authority_raw.unwrap();
    for bad in [
        authority.replace("\"version\":1", "\"version\":2"),
        authority.replacen("{", "{\"unknown\":0,", 1),
        authority.replace("\"kind\":\"app\"", "\"kind\":\"app\",\"unknown\":true"),
        authority.replace("\"kind\":\"app\"", "\"kind\":\"plugin\""),
    ] {
        db.set_setting(APP_GLOBAL_SHORTCUT_TARGETS_KEY, &bad)
            .unwrap();
        assert!(db.read_renderer_app_global_shortcuts().is_err());
    }
}
#[test]
fn auto_copy_true_and_non_app_identity_reject_without_changing_legacy() {
    let db = Database::in_memory().unwrap();
    let legacy =
        r#"[{"id":"old","target":"Same Name","shortcut":"Alt+1","enabled":false,"autoCopy":true}]"#;
    db.set_setting(APP_GLOBAL_SHORTCUTS_KEY, legacy).unwrap();
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    assert!(db
        .prepare_renderer_app_global_shortcut_write(
            &before,
            AppGlobalShortcutMutation::Adopt {
                row_id: "old".into(),
                target: app("/Applications/One.app"),
                shortcut: "Alt+1".into(),
                enabled: false
            }
        )
        .is_err());
    let mut non_app = app("/Applications/One.app");
    non_app.sub_type = RendererDirectSubtype::LocalShortcut;
    assert!(db
        .prepare_renderer_app_global_shortcut_write(
            &before,
            AppGlobalShortcutMutation::Create {
                target: non_app,
                shortcut: "Alt+1".into(),
                enabled: true
            }
        )
        .is_err());
    assert_eq!(db.read_renderer_app_global_shortcuts().unwrap(), before);
}
#[test]
fn quotas_depth_documents_and_revision_exhaustion_are_fail_closed() {
    let db = Database::in_memory().unwrap();
    for _ in 0..64 {
        write(&db, create("/Applications/One.app", false));
    }
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    assert!(db
        .prepare_renderer_app_global_shortcut_write(&before, create("/Applications/Two.app", false))
        .is_err());
    let db = Database::in_memory().unwrap();
    db.set_setting(
        APP_GLOBAL_SHORTCUTS_KEY,
        &format!("[{}]", vec!["{}"; 4096].join(",")),
    )
    .unwrap();
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    assert!(db
        .prepare_renderer_app_global_shortcut_write(&before, create("/Applications/One.app", false))
        .is_err());
    for bad in [
        format!("[{{\"data\":\"{}\"}}]", "x".repeat(128 * 1024)),
        "[{\"data\":[[[[[[[[]]]]]]]]}]".into(),
    ] {
        db.set_setting(APP_GLOBAL_SHORTCUTS_KEY, &bad).unwrap();
        assert!(db.read_renderer_app_global_shortcuts().is_err());
    }
    db.delete_setting(APP_GLOBAL_SHORTCUTS_KEY).unwrap();
    db.set_setting(APP_GLOBAL_SHORTCUT_REVISION_KEY, &MAX_REVISION.to_string())
        .unwrap();
    let before = db.read_renderer_app_global_shortcuts().unwrap();
    assert!(db
        .prepare_renderer_app_global_shortcut_write(&before, create("/Applications/One.app", false))
        .is_err());
}
#[test]
fn db_reopen_preserves_committed_snapshot_and_other_namespaces() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("binding.db");
    let db = Database::open(&path).unwrap();
    db.set_setting(
        "ztools-renderer:app-shortcuts",
        "[{\"keep\":12345678901234567890}]",
    )
    .unwrap();
    let snapshot = write(&db, create("/Applications/One.app", true)).snapshot;
    drop(db);
    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened.read_renderer_app_global_shortcuts().unwrap(),
        snapshot
    );
    assert_eq!(
        reopened
            .get_setting("ztools-renderer:app-shortcuts")
            .unwrap()
            .as_deref(),
        Some("[{\"keep\":12345678901234567890}]")
    );
}
