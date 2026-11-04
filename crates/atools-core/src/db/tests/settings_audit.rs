use super::*;
use crate::agent::{AuditLogEntry, AuditStatus};

#[test]
fn test_settings_crud() {
    let db = Database::in_memory().unwrap();

    // Create
    db.set_setting("key1", "value1").unwrap();
    db.set_setting("key2", "value2").unwrap();

    // Read
    assert_eq!(db.get_setting("key1").unwrap(), Some("value1".to_string()));
    assert_eq!(db.get_setting("key2").unwrap(), Some("value2".to_string()));
    assert_eq!(db.get_setting("nonexistent").unwrap(), None);

    // Update
    db.set_setting("key1", "new_value1").unwrap();
    assert_eq!(
        db.get_setting("key1").unwrap(),
        Some("new_value1".to_string())
    );

    // Delete
    assert!(db.delete_setting("key1").unwrap());
    assert_eq!(db.get_setting("key1").unwrap(), None);
    assert!(!db.delete_setting("nonexistent").unwrap());
}

#[test]
fn test_delete_audit_entries_for_client_only_removes_matching_client() {
    let db = Database::in_memory().unwrap();

    db.insert_audit_entry(&AuditLogEntry::new(
        "desktop-smoke",
        "find_local_files",
        serde_json::json!({"dry_run": true}),
        AuditStatus::Denied,
    ))
    .unwrap();
    db.insert_audit_entry(&AuditLogEntry::new(
        "user-client",
        "search_clipboard",
        serde_json::json!({"query": "invoice"}),
        AuditStatus::Allowed,
    ))
    .unwrap();

    assert_eq!(
        db.delete_audit_entries_for_client("desktop-smoke").unwrap(),
        1
    );

    let remaining = db.list_audit_entries(10).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].client_id, "user-client");
    assert_eq!(remaining[0].tool_name, "search_clipboard");
    assert_eq!(
        db.delete_audit_entries_for_client("missing-client")
            .unwrap(),
        0
    );
}

#[test]
fn test_prune_audit_entries_applies_age_and_count_retention() {
    let db = Database::in_memory().unwrap();

    let entries = [
        ("old", "2026-05-01T00:00:00Z"),
        ("middle", "2026-06-01T00:00:00Z"),
        ("newer", "2026-06-03T00:00:00Z"),
        ("newest", "2026-06-04T00:00:00Z"),
    ];
    for (id, timestamp) in entries {
        let mut entry = AuditLogEntry::new(
            "codex",
            "find_local_files",
            serde_json::json!({ "id": id }),
            AuditStatus::Allowed,
        );
        entry.id = format!("audit-{id}");
        entry.timestamp = timestamp.to_string();
        db.insert_audit_entry(&entry).unwrap();
    }

    let deleted = db
        .prune_audit_entries(Some("2026-06-01T00:00:00Z"), Some(2))
        .unwrap();
    assert_eq!(deleted, 2);

    let remaining = db.list_audit_entries(10).unwrap();
    assert_eq!(
        remaining
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["audit-newest", "audit-newer"]
    );

    assert_eq!(
        db.prune_audit_entries(Some("2026-06-01T00:00:00Z"), Some(2))
            .unwrap(),
        0
    );
}

#[test]
fn test_audit_log_filter_indexes_exist() {
    let db = Database::in_memory().unwrap();
    let conn = db.conn.lock();
    let mut stmt = conn
        .prepare("PRAGMA index_list(audit_log)")
        .expect("index list");
    let indexes = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query indexes")
        .collect::<std::result::Result<Vec<_>, _>>()
        .expect("indexes");

    assert!(indexes.contains(&"idx_audit_log_status_timestamp".to_string()));
    assert!(indexes.contains(&"idx_audit_log_tool_timestamp".to_string()));
    assert!(indexes.contains(&"idx_audit_log_client_timestamp".to_string()));
}
