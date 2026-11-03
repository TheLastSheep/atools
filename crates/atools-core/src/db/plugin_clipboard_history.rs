use super::plugin_clipboard_history_validation::{
    escape_like_pattern, parse_plugin_clipboard_history_id, validate_media_projection,
    PluginClipboardHistoryIdKind, PLUGIN_CLIPBOARD_HISTORY_MEDIA_BYTES_MAX,
};
use super::{clipboard_history, Database};
use crate::error::{AToolsError, Result};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::{json, Value};

const PAGE_SIZE_MAX: usize = 1000;
const QUERY_BYTES_MAX: usize = 256;
const TEXT_BYTES_MAX: usize = clipboard_history::CLIPBOARD_HISTORY_TEXT_BYTES_MAX;
const PAGE_CONTENT_BYTES_MAX: usize = clipboard_history::CLIPBOARD_HISTORY_PAGE_CONTENT_BYTES_MAX;
const PAGE_OFFSET_MAX: usize = 10_000_000;
const PREVIEW_CHARS: usize = clipboard_history::CLIPBOARD_HISTORY_PREVIEW_CHARS;
const RESPONSE_BYTES_MAX: usize = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginClipboardHistoryPage {
    pub items: Vec<PluginClipboardHistoryPageItem>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginClipboardHistoryPageItem {
    pub id: String,
    pub kind: String,
    pub timestamp: String,
    pub preview: String,
    pub payload: Value,
}

struct PendingHistoryItem {
    id: String,
    kind: String,
    timestamp: String,
    preview: String,
    payload_bytes: i64,
}

impl Database {
    pub fn record_clipboard_media_projection(
        &self,
        item_id: &str,
        kind: &str,
        payload: &Value,
        copied_at: &str,
        retention_cutoff: &str,
    ) -> Result<()> {
        if copied_at.is_empty() || retention_cutoff.is_empty() {
            return Err(AToolsError::Config(
                "Clipboard media timestamps are required".into(),
            ));
        }
        let projection = validate_media_projection(item_id, kind, payload)?;
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM plugin_clipboard_history_media WHERE copied_at < ?1",
            params![retention_cutoff],
        )?;
        if copied_at < retention_cutoff {
            // An old capture can arrive for an item retained on the Shelf (for
            // example, because it was pinned). Do not leave a newer projection
            // associated with that item visible after its stale recapture.
            tx.execute(
                "DELETE FROM plugin_clipboard_history_media WHERE item_id = ?1",
                params![item_id],
            )?;
            tx.commit()?;
            return Ok(());
        }
        tx.execute(
            r#"INSERT INTO plugin_clipboard_history_media
               (id, item_id, kind, copied_at, preview, payload, search_text)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
               ON CONFLICT(item_id) DO UPDATE SET
                 id = excluded.id,
                 kind = excluded.kind,
                 copied_at = excluded.copied_at,
                 preview = excluded.preview,
                 payload = excluded.payload,
                 search_text = excluded.search_text"#,
            params![
                projection.id,
                item_id,
                projection.kind,
                copied_at,
                projection.preview,
                projection.payload_json,
                projection.search_text,
            ],
        )?;
        tx.execute(
            "DELETE FROM plugin_clipboard_history_media WHERE copied_at < ?1",
            params![retention_cutoff],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn plugin_clipboard_history_page(
        &self,
        query: &str,
        page: usize,
        page_size: usize,
    ) -> Result<PluginClipboardHistoryPage> {
        if query.len() > QUERY_BYTES_MAX {
            return Err(AToolsError::Config(
                "Clipboard history query exceeds 256 bytes".into(),
            ));
        }
        if page == 0 || page_size == 0 || page_size > PAGE_SIZE_MAX {
            return Err(AToolsError::Config(
                "Invalid clipboard history page bounds".into(),
            ));
        }
        let offset = page
            .checked_sub(1)
            .and_then(|page_index| page_index.checked_mul(page_size))
            .filter(|offset| *offset <= PAGE_OFFSET_MAX)
            .ok_or_else(|| AToolsError::Config("Clipboard history offset exceeds limit".into()))?;
        let query = query.trim();
        let pattern = format!("%{}%", escape_like_pattern(&query.to_lowercase()));
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let total: i64 = tx.query_row(
            r#"SELECT COUNT(*) FROM (
                 SELECT id FROM clipboard_history
                   WHERE (?1 = '' OR LOWER(text) LIKE ?2 ESCAPE '\')
                 UNION ALL
                 SELECT id FROM plugin_clipboard_history_media
                   WHERE (?1 = '' OR LOWER(search_text) LIKE ?2 ESCAPE '\')
               )"#,
            params![query, pattern],
            |row| row.get(0),
        )?;
        let mut stmt = tx.prepare_cached(
            r#"SELECT id, kind, timestamp, preview, payload_bytes FROM (
                 SELECT id, 'text' AS kind, last_copied_at AS timestamp,
                        substr(text, 1, 256) AS preview,
                        length(CAST(text AS BLOB)) AS payload_bytes
                   FROM clipboard_history
                   WHERE (?1 = '' OR LOWER(text) LIKE ?2 ESCAPE '\')
                 UNION ALL
                 SELECT id, kind, copied_at AS timestamp, preview,
                        length(CAST(payload AS BLOB)) AS payload_bytes
                   FROM plugin_clipboard_history_media
                   WHERE (?1 = '' OR LOWER(search_text) LIKE ?2 ESCAPE '\')
               )
               ORDER BY timestamp DESC, id DESC
               LIMIT ?3 OFFSET ?4"#,
        )?;
        let pending = stmt
            .query_map(
                params![query, pattern, page_size as i64, offset as i64],
                |row| {
                    Ok(PendingHistoryItem {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        timestamp: row.get(2)?,
                        preview: row.get(3)?,
                        payload_bytes: row.get(4)?,
                    })
                },
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut aggregate_payload_bytes = 0usize;
        for item in &pending {
            let payload_bytes = checked_payload_bytes(item.payload_bytes)?;
            let item_limit = if item.kind == "text" {
                TEXT_BYTES_MAX
            } else {
                PLUGIN_CLIPBOARD_HISTORY_MEDIA_BYTES_MAX
            };
            if payload_bytes > item_limit {
                return Err(AToolsError::Config(format!(
                    "Clipboard history item exceeds the {} KiB limit",
                    item_limit / 1024
                )));
            }
            aggregate_payload_bytes = aggregate_payload_bytes
                .checked_add(payload_bytes)
                .filter(|size| *size <= PAGE_CONTENT_BYTES_MAX)
                .ok_or_else(|| {
                    AToolsError::Config("Clipboard history page content exceeds 512 KiB".into())
                })?;
        }

        let mut items = Vec::with_capacity(pending.len());
        let mut text_stmt =
            tx.prepare_cached("SELECT text FROM clipboard_history WHERE id = ?1")?;
        let mut media_stmt = tx.prepare_cached(
            "SELECT kind, copied_at, preview, payload FROM plugin_clipboard_history_media WHERE id = ?1",
        )?;
        for item in pending {
            let expected_bytes = checked_payload_bytes(item.payload_bytes)?;
            let payload = match item.kind.as_str() {
                "text" => {
                    let content: String =
                        text_stmt.query_row(params![&item.id], |row| row.get(0))?;
                    if content.len() != expected_bytes {
                        return Err(AToolsError::Config(
                            "Clipboard history content changed during page read".into(),
                        ));
                    }
                    json!({ "content": content })
                }
                "image" | "file" => {
                    let (kind, timestamp, preview, payload_json): (String, String, String, String) =
                        media_stmt.query_row(params![&item.id], |row| {
                            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                        })?;
                    if kind != item.kind
                        || timestamp != item.timestamp
                        || preview != item.preview
                        || payload_json.len() != expected_bytes
                    {
                        return Err(AToolsError::Config(
                            "Clipboard history content changed during page read".into(),
                        ));
                    }
                    serde_json::from_str(&payload_json)?
                }
                _ => {
                    return Err(AToolsError::Config(
                        "Invalid clipboard history item kind".into(),
                    ))
                }
            };
            let preview = if item.kind == "text" {
                payload["content"]
                    .as_str()
                    .unwrap_or_default()
                    .chars()
                    .take(PREVIEW_CHARS)
                    .collect()
            } else {
                item.preview
            };
            items.push(PluginClipboardHistoryPageItem {
                id: item.id,
                kind: item.kind,
                timestamp: item.timestamp,
                preview,
                payload,
            });
        }
        drop(text_stmt);
        drop(media_stmt);
        let total = usize::try_from(total)
            .map_err(|_| AToolsError::Config("Invalid clipboard history count".into()))?;
        let result = PluginClipboardHistoryPage {
            items,
            total,
            page,
            page_size,
        };
        let serialized = serde_json::to_vec(&result)?;
        if serialized.len() > RESPONSE_BYTES_MAX {
            return Err(AToolsError::Config(
                "Clipboard history response exceeds 512 KiB".into(),
            ));
        }
        tx.commit()?;
        Ok(result)
    }

    pub fn plugin_clipboard_history_content(
        &self,
        id: &str,
    ) -> Result<Option<PluginClipboardHistoryPageItem>> {
        let id_kind = parse_plugin_clipboard_history_id(id)?;
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let item = match id_kind {
            PluginClipboardHistoryIdKind::Text => {
                let row = tx
                    .query_row(
                        "SELECT last_copied_at, length(CAST(text AS BLOB)) FROM clipboard_history WHERE id = ?1",
                        params![id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                    )
                    .optional()?;
                let Some((timestamp, content_bytes)) = row else {
                    tx.commit()?;
                    return Ok(None);
                };
                let content_bytes = checked_payload_bytes(content_bytes)?;
                if content_bytes > TEXT_BYTES_MAX {
                    return Err(AToolsError::Config(
                        "Clipboard history content exceeds 256 KiB".into(),
                    ));
                }
                let content: String = tx.query_row(
                    "SELECT text FROM clipboard_history WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                if content.len() != content_bytes {
                    return Err(AToolsError::Config(
                        "Clipboard history content changed during read".into(),
                    ));
                }
                let preview = content.chars().take(PREVIEW_CHARS).collect();
                PluginClipboardHistoryPageItem {
                    id: id.to_string(),
                    kind: "text".to_string(),
                    timestamp,
                    preview,
                    payload: json!({ "content": content }),
                }
            }
            PluginClipboardHistoryIdKind::Image | PluginClipboardHistoryIdKind::File => {
                let row = tx
                    .query_row(
                        "SELECT kind, copied_at, preview, length(CAST(payload AS BLOB)) FROM plugin_clipboard_history_media WHERE id = ?1",
                        params![id],
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, i64>(3)?,
                            ))
                        },
                    )
                    .optional()?;
                let Some((kind, timestamp, preview, payload_bytes)) = row else {
                    tx.commit()?;
                    return Ok(None);
                };
                let payload_bytes = checked_payload_bytes(payload_bytes)?;
                if payload_bytes > PLUGIN_CLIPBOARD_HISTORY_MEDIA_BYTES_MAX {
                    return Err(AToolsError::Config(
                        "Clipboard media payload exceeds 256 KiB".into(),
                    ));
                }
                let payload_json: String = tx.query_row(
                    "SELECT payload FROM plugin_clipboard_history_media WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )?;
                if payload_json.len() != payload_bytes {
                    return Err(AToolsError::Config(
                        "Clipboard media content changed during read".into(),
                    ));
                }
                let payload: Value = serde_json::from_str(&payload_json)?;
                PluginClipboardHistoryPageItem {
                    id: id.to_string(),
                    kind,
                    timestamp,
                    preview,
                    payload,
                }
            }
        };
        let serialized = serde_json::to_vec(&item)?;
        if serialized.len() > RESPONSE_BYTES_MAX {
            return Err(AToolsError::Config(
                "Clipboard history response exceeds 512 KiB".into(),
            ));
        }
        tx.commit()?;
        Ok(Some(item))
    }

    pub fn delete_plugin_clipboard_history_item(&self, id: &str) -> Result<bool> {
        let kind = parse_plugin_clipboard_history_id(id)?;
        let conn = self.conn.lock();
        let deleted = match kind {
            PluginClipboardHistoryIdKind::Text => {
                conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])?
            }
            PluginClipboardHistoryIdKind::Image | PluginClipboardHistoryIdKind::File => conn
                .execute(
                    "DELETE FROM plugin_clipboard_history_media WHERE id = ?1",
                    params![id],
                )?,
        };
        Ok(deleted > 0)
    }

    pub fn clear_plugin_clipboard_history(&self, kind: Option<&str>) -> Result<usize> {
        if !matches!(kind, None | Some("all" | "text" | "image" | "file")) {
            return Err(AToolsError::Config(
                "Invalid clipboard history clear kind".into(),
            ));
        }
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let deleted = match kind {
            Some("text") => tx.execute("DELETE FROM clipboard_history", [])?,
            Some("image" | "file") => tx.execute(
                "DELETE FROM plugin_clipboard_history_media WHERE kind = ?1",
                params![kind],
            )?,
            None | Some("all") => {
                let text = tx.execute("DELETE FROM clipboard_history", [])?;
                let media = tx.execute("DELETE FROM plugin_clipboard_history_media", [])?;
                text.checked_add(media).ok_or_else(|| {
                    AToolsError::Config("Clipboard history delete count overflow".into())
                })?
            }
            _ => unreachable!("clear kind validated above"),
        };
        tx.commit()?;
        Ok(deleted)
    }

    pub fn plugin_clipboard_history_projection_exists(
        &self,
        item_id: &str,
        kind: &str,
    ) -> Result<bool> {
        if item_id.is_empty() || item_id.len() > 8192 || item_id.contains('\0') {
            return Err(AToolsError::Config(
                "Invalid clipboard media item id".into(),
            ));
        }
        if kind != "image" && kind != "file" {
            return Err(AToolsError::Config("Invalid clipboard media kind".into()));
        }
        let conn = self.conn.lock();
        Ok(conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_clipboard_history_media WHERE item_id = ?1 AND kind = ?2)",
            params![item_id, kind],
            |row| row.get(0),
        )?)
    }
}

fn checked_payload_bytes(bytes: i64) -> Result<usize> {
    usize::try_from(bytes)
        .map_err(|_| AToolsError::Config("Invalid clipboard history payload size".into()))
}
