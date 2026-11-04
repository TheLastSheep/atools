use super::*;

#[test]
fn test_plugin_data_crud() {
    let db = Database::in_memory().unwrap();
    let plugin_id = "data-plugin";

    let plugin = create_test_plugin(plugin_id, "Data Plugin");
    db.save_plugin(&plugin).unwrap();

    // Create
    let doc1 = Document {
        id: "doc1".to_string(),
        rev: None,
        data: serde_json::json!({"name": "Alice", "age": 30}),
    };
    let doc2 = Document {
        id: "doc2".to_string(),
        rev: None,
        data: serde_json::json!({"name": "Bob", "age": 25}),
    };

    db.plugin_data_put(plugin_id, &doc1).unwrap();
    db.plugin_data_put(plugin_id, &doc2).unwrap();

    // Read single
    let retrieved = db.plugin_data_get(plugin_id, "doc1").unwrap().unwrap();
    assert_eq!(retrieved.data["name"], "Alice");

    // Read all
    let all = db.plugin_data_all(plugin_id).unwrap();
    assert_eq!(all.len(), 2);

    // Update
    let updated = Document {
        id: "doc1".to_string(),
        rev: None,
        data: serde_json::json!({"name": "Alice", "age": 31}),
    };
    db.plugin_data_put(plugin_id, &updated).unwrap();
    let re_retrieved = db.plugin_data_get(plugin_id, "doc1").unwrap().unwrap();
    assert_eq!(re_retrieved.data["age"], 31);

    // Delete
    db.plugin_data_remove(plugin_id, "doc1").unwrap();
    assert!(db.plugin_data_get(plugin_id, "doc1").unwrap().is_none());
    let remaining = db.plugin_data_all(plugin_id).unwrap();
    assert_eq!(remaining.len(), 1);
}

#[test]
fn test_plugin_data_bulk_operations() {
    let db = Database::in_memory().unwrap();
    let plugin_id = "bulk-plugin";

    let plugin = create_test_plugin(plugin_id, "Bulk Plugin");
    db.save_plugin(&plugin).unwrap();

    let docs = vec![
        Document {
            id: "bulk1".to_string(),
            rev: None,
            data: serde_json::json!({"value": 1}),
        },
        Document {
            id: "bulk2".to_string(),
            rev: None,
            data: serde_json::json!({"value": 2}),
        },
        Document {
            id: "bulk3".to_string(),
            rev: None,
            data: serde_json::json!({"value": 3}),
        },
    ];

    db.plugin_data_bulk(plugin_id, &docs).unwrap();

    let all = db.plugin_data_all(plugin_id).unwrap();
    assert_eq!(all.len(), 3);

    for i in 1..=3 {
        let doc = db
            .plugin_data_get(plugin_id, &format!("bulk{}", i))
            .unwrap()
            .unwrap();
        assert_eq!(doc.data["value"], i);
    }
}

#[test]
fn plugin_data_put_update_preserves_attachments() {
    let db = Database::in_memory().unwrap();
    let plugin_id = "put-attachment-plugin";
    db.save_plugin(&create_test_plugin(plugin_id, "Put Attachment Plugin"))
        .unwrap();
    db.plugin_data_put(
        plugin_id,
        &Document {
            id: "doc".to_string(),
            rev: None,
            data: serde_json::json!({"version": 1}),
        },
    )
    .unwrap();
    db.put_attachment(
        plugin_id,
        "doc",
        "payload.bin",
        b"single-put-attachment",
        "application/octet-stream",
    )
    .unwrap();

    db.plugin_data_put(
        plugin_id,
        &Document {
            id: "doc".to_string(),
            rev: None,
            data: serde_json::json!({"version": 2}),
        },
    )
    .unwrap();

    assert_eq!(
        db.plugin_data_get(plugin_id, "doc").unwrap().unwrap().data["version"],
        2
    );
    assert_eq!(
        db.get_attachment(plugin_id, "doc", "payload.bin")
            .unwrap()
            .unwrap()
            .0,
        b"single-put-attachment"
    );
}

#[test]
fn plugin_data_bulk_update_preserves_attachments() {
    let db = Database::in_memory().unwrap();
    let plugin_id = "bulk-attachment-plugin";
    db.save_plugin(&create_test_plugin(plugin_id, "Bulk Attachment Plugin"))
        .unwrap();
    db.plugin_data_put(
        plugin_id,
        &Document {
            id: "doc".to_string(),
            rev: None,
            data: serde_json::json!({"version": 1}),
        },
    )
    .unwrap();
    db.put_attachment(
        plugin_id,
        "doc",
        "payload.bin",
        b"bulk-put-attachment",
        "application/octet-stream",
    )
    .unwrap();

    db.plugin_data_bulk(
        plugin_id,
        &[
            Document {
                id: "doc".to_string(),
                rev: None,
                data: serde_json::json!({"version": 2}),
            },
            Document {
                id: "new-doc".to_string(),
                rev: None,
                data: serde_json::json!({"created": true}),
            },
        ],
    )
    .unwrap();

    assert_eq!(
        db.plugin_data_get(plugin_id, "doc").unwrap().unwrap().data["version"],
        2
    );
    assert_eq!(
        db.get_attachment(plugin_id, "doc", "payload.bin")
            .unwrap()
            .unwrap()
            .0,
        b"bulk-put-attachment"
    );
}
