use super::*;
pub fn search_clipboard_history(
    db: &Database,
    current_text: Option<&str>,
    arguments: Value,
) -> Result<Value, String> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .min(500) as usize;

    if let Some(text) = current_text.filter(|text| !text.trim().is_empty()) {
        db.record_clipboard_text(text, &atools_core::utils::now_iso())
            .map_err(|e| e.to_string())?;
    }

    let items = db
        .search_clipboard_history(query, limit)
        .map_err(|e| e.to_string())?;
    let json_items: Vec<Value> = items
        .into_iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "type": "text",
                "source": "clipboard_history",
                "text": entry.text,
                "first_copied_at": entry.first_copied_at,
                "last_copied_at": entry.last_copied_at,
                "used_count": entry.used_count,
            })
        })
        .collect();
    let total = json_items.len();

    Ok(json!({
        "items": json_items,
        "total": total
    }))
}

pub(super) fn clipboard_retention_days(db: &Database) -> u64 {
    db.get_setting("settings-general")
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .and_then(|settings| {
            settings
                .get("clipboardRetentionDays")
                .and_then(Value::as_u64)
        })
        .unwrap_or(180)
        .clamp(1, 3650)
}
