use atools_core::memory::{
    apply_memory_defaults, validate_memory_content, MemoryApproval, MemoryItem, MemoryScope,
    MemoryType,
};
use atools_core::Database;
use serde_json::json;

fn memory(tool: Option<&str>, content: serde_json::Value) -> MemoryItem {
    MemoryItem::new(
        MemoryType::Preference,
        MemoryScope {
            tool: tool.map(str::to_string),
            ..MemoryScope::default()
        },
        content,
        None,
        1.0,
        MemoryApproval::Explicit,
        None,
    )
    .expect("memory")
}

#[test]
fn memory_round_trips_and_matches_structured_scope() {
    let db = Database::in_memory().expect("database");
    let item = memory(
        Some("compress_images"),
        json!({ "arguments": { "quality": 82 } }),
    );
    db.upsert_memory_item(&item).expect("insert memory");

    let matches = db
        .find_memory_items(
            &MemoryScope {
                tool: Some("compress_images".to_string()),
                ..MemoryScope::default()
            },
            20,
        )
        .expect("find memory");
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].id, item.id);

    let unrelated = db
        .find_memory_items(
            &MemoryScope {
                tool: Some("ocr_image".to_string()),
                ..MemoryScope::default()
            },
            20,
        )
        .expect("find unrelated memory");
    assert!(unrelated.is_empty());
}

#[test]
fn memory_defaults_never_override_explicit_arguments() {
    let memories = vec![memory(
        Some("compress_images"),
        json!({ "arguments": { "quality": 82, "format": "webp" } }),
    )];
    let mut arguments = json!({ "quality": 95 });
    apply_memory_defaults(&mut arguments, &memories);
    assert_eq!(arguments["quality"], 95);
    assert_eq!(arguments["format"], "webp");
}

#[test]
fn secret_like_memory_is_rejected() {
    assert!(validate_memory_content(&json!({ "apiKey": "value" })).is_err());
    assert!(validate_memory_content(&json!({ "note": "sk-sensitive" })).is_err());
}

#[test]
fn temporary_memory_requires_expiry() {
    let result = MemoryItem::new(
        MemoryType::Correction,
        MemoryScope::default(),
        json!({ "note": "only for this task" }),
        None,
        0.8,
        MemoryApproval::Temporary,
        None,
    );
    assert!(result.is_err());
}
