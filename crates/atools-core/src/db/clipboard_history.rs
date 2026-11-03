use super::Database;
use crate::error::{AToolsError, Result};
use crate::models::ClipboardHistoryEntry;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

pub const CLIPBOARD_HISTORY_PAGE_SIZE_MAX: usize = 1000;
pub const CLIPBOARD_HISTORY_QUERY_BYTES_MAX: usize = 256;
pub const CLIPBOARD_HISTORY_TEXT_BYTES_MAX: usize = 256 * 1024;
pub const CLIPBOARD_HISTORY_PAGE_CONTENT_BYTES_MAX: usize = 512 * 1024;
pub const CLIPBOARD_HISTORY_OFFSET_MAX: usize = 10_000_000;
pub const CLIPBOARD_HISTORY_PREVIEW_CHARS: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipboardHistoryPage {
    pub items: Vec<ClipboardHistoryPageItem>,
    pub total: usize,
    pub page: usize,
    pub page_size: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipboardHistoryPageItem {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub timestamp: String,
    pub preview: String,
    pub content: String,
}

impl Database {
    pub fn clipboard_history_page(
        &self,
        query: &str,
        page: usize,
        page_size: usize,
    ) -> Result<ClipboardHistoryPage> {
        if query.len() > CLIPBOARD_HISTORY_QUERY_BYTES_MAX {
            return Err(AToolsError::Config("Clipboard history query exceeds 256 bytes".into()));
        }
        if page == 0 || page_size == 0 || page_size > CLIPBOARD_HISTORY_PAGE_SIZE_MAX {
            return Err(AToolsError::Config("Invalid clipboard history page bounds".into()));
        }
        let offset = page
            .checked_sub(1)
            .and_then(|page_index| page_index.checked_mul(page_size))
            .filter(|offset| *offset <= CLIPBOARD_HISTORY_OFFSET_MAX)
            .ok_or_else(|| AToolsError::Config("Clipboard history offset exceeds limit".into()))?;
        let query = query.trim();
        let pattern = format!("%{}%", escape_like_pattern(&query.to_lowercase()));
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let total: i64 = tx.query_row(
            r#"SELECT COUNT(*) FROM clipboard_history
               WHERE (?1 = '' OR LOWER(text) LIKE ?2 ESCAPE '\')"#,
            params![query, pattern],
            |row| row.get(0),
        )?;
        let mut stmt = tx.prepare_cached(
            r#"SELECT id, last_copied_at, length(CAST(text AS BLOB))
               FROM clipboard_history
               WHERE (?1 = '' OR LOWER(text) LIKE ?2 ESCAPE '\')
               ORDER BY last_copied_at DESC, id DESC
               LIMIT ?3 OFFSET ?4"#,
        )?;
        let mut bounded_items = stmt
            .query_map(params![query, pattern, page_size as i64, offset as i64], |row| {
                Ok((
                    ClipboardHistoryPageItem {
                        id: row.get(0)?,
                        r#type: "text".to_string(),
                        timestamp: row.get(1)?,
                        preview: String::new(),
                        content: String::new(),
                    },
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(stmt);

        let mut aggregate_content_bytes = 0usize;
        for (_, row_bytes) in &bounded_items {
            let row_bytes = usize::try_from(*row_bytes)
                .map_err(|_| AToolsError::Config("Invalid clipboard history content size".into()))?;
            if row_bytes > CLIPBOARD_HISTORY_TEXT_BYTES_MAX {
                return Err(AToolsError::Config(
                    "Clipboard history content exceeds 256 KiB".into(),
                ));
            }
            aggregate_content_bytes = aggregate_content_bytes
                .checked_add(row_bytes)
                .filter(|size| *size <= CLIPBOARD_HISTORY_PAGE_CONTENT_BYTES_MAX)
                .ok_or_else(|| {
                    AToolsError::Config("Clipboard history page content exceeds 512 KiB".into())
                })?;
        }

        let mut content_stmt = tx.prepare_cached(
            "SELECT text FROM clipboard_history WHERE id = ?1",
        )?;
        for (item, expected_bytes) in &mut bounded_items {
            item.content = content_stmt.query_row(params![&item.id], |row| row.get(0))?;
            if item.content.len() != usize::try_from(*expected_bytes).map_err(|_| {
                AToolsError::Config("Invalid clipboard history content size".into())
            })? {
                return Err(AToolsError::Config(
                    "Clipboard history content changed during page read".into(),
                ));
            }
            item.preview = item
                .content
                .chars()
                .take(CLIPBOARD_HISTORY_PREVIEW_CHARS)
                .collect();
        }
        drop(content_stmt);
        let items = bounded_items.into_iter().map(|(item, _)| item).collect();
        tx.commit()?;
        let total = usize::try_from(total)
            .map_err(|_| AToolsError::Config("Invalid clipboard history count".into()))?;
        Ok(ClipboardHistoryPage { items, total, page, page_size })
    }

    pub fn clipboard_history_text(&self, id: &str) -> Result<Option<ClipboardHistoryEntry>> {
        validate_clipboard_history_id(id)?;
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let bytes = tx
            .query_row(
                "SELECT length(CAST(text AS BLOB)) FROM clipboard_history WHERE id = ?1",
                params![id],
                |row| row.get::<_, i64>(0),
            )
            .optional()?;
        let Some(bytes) = bytes else {
            tx.commit()?;
            return Ok(None);
        };
        if bytes < 0 || bytes as usize > CLIPBOARD_HISTORY_TEXT_BYTES_MAX {
            return Err(AToolsError::Config("Clipboard history content exceeds 256 KiB".into()));
        }
        let mut stmt = tx.prepare_cached(
            "SELECT id, text, first_copied_at, last_copied_at, used_count FROM clipboard_history WHERE id = ?1",
        )?;
        let entry = stmt.query_row(params![id], clipboard_history_from_row)?;
        drop(stmt);
        tx.commit()?;
        Ok(Some(entry))
    }

    // This removes only the legacy plugin-history projection, not Pasteboard Shelf items.
    pub fn delete_clipboard_history_item(&self, id: &str) -> Result<bool> {
        validate_clipboard_history_id(id)?;
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM clipboard_history WHERE id = ?1", params![id])? > 0)
    }

    pub fn record_clipboard_text(
        &self,
        text: &str,
        copied_at: &str,
    ) -> Result<ClipboardHistoryEntry> {
        if text.trim().is_empty() {
            return Err(AToolsError::Config(
                "Clipboard text history cannot store empty text".to_string(),
            ));
        }
        let text_hash = stable_text_hash(text);
        let id = format!("clip-{}", text_hash);
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO clipboard_history
            (id, text_hash, text, first_copied_at, last_copied_at, used_count)
            VALUES (?1, ?2, ?3, ?4, ?4, 1)
            ON CONFLICT(text_hash) DO UPDATE SET
                text = excluded.text,
                last_copied_at = excluded.last_copied_at,
                used_count = clipboard_history.used_count + 1
            "#,
            params![id, text_hash, text, copied_at],
        )?;
        clipboard_history_by_hash(&conn, &text_hash)
    }

    /// Mirrors one accepted native text capture into the legacy plugin history.
    /// The per-device marker makes retries idempotent without storing clipboard text.
    pub fn record_clipboard_capture_projection(
        &self,
        text: &str,
        copied_at: &str,
        device_id: &str,
        capture_epoch_id: &str,
        change_count: i64,
        snapshot_fingerprint: &str,
        retention_cutoff: &str,
    ) -> Result<bool> {
        if text.trim().is_empty() || text.len() > CLIPBOARD_HISTORY_TEXT_BYTES_MAX {
            return Err(AToolsError::Config(
                "Clipboard projection text is empty or exceeds the history limit".into(),
            ));
        }
        if device_id.is_empty() || capture_epoch_id.is_empty() || change_count < 0 || snapshot_fingerprint.len() != 64 {
            return Err(AToolsError::Config("Invalid clipboard capture identity".into()));
        }
        let marker_key = format!("pasteboard.clipboard_projection.{device_id}");
        let marker_value = format!("{capture_epoch_id}:{change_count}:{snapshot_fingerprint}");
        let text_hash = stable_text_hash(text);
        let id = format!("clip-{text_hash}");
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key = ?1",
                params![marker_key],
                |row| row.get(0),
            )
            .optional()?;
        if previous.as_deref() == Some(marker_value.as_str()) {
            tx.execute(
                "DELETE FROM clipboard_history WHERE last_copied_at < ?1",
                params![retention_cutoff],
            )?;
            tx.commit()?;
            return Ok(false);
        }
        tx.execute(
            r#"INSERT INTO clipboard_history
               (id, text_hash, text, first_copied_at, last_copied_at, used_count)
               VALUES (?1, ?2, ?3, ?4, ?4, 1)
               ON CONFLICT(text_hash) DO UPDATE SET
                 text = excluded.text,
                 last_copied_at = excluded.last_copied_at,
                 used_count = clipboard_history.used_count + 1"#,
            params![id, text_hash, text, copied_at],
        )?;
        tx.execute(
            "DELETE FROM clipboard_history WHERE last_copied_at < ?1",
            params![retention_cutoff],
        )?;
        tx.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![marker_key, marker_value],
        )?;
        tx.commit()?;
        Ok(true)
    }

    pub fn search_clipboard_history(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ClipboardHistoryEntry>> {
        let conn = self.conn.lock();
        let limit = limit.clamp(1, 500) as i64;
        let query = query.trim();
        if query.is_empty() {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, text, first_copied_at, last_copied_at, used_count
                FROM clipboard_history
                ORDER BY last_copied_at DESC
                LIMIT ?1
                "#,
            )?;
            return stmt
                .query_map(params![limit], clipboard_history_from_row)?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(Into::into);
        }

        let like = format!("%{}%", query.to_lowercase());
        let mut stmt = conn.prepare(
            r#"
            SELECT id, text, first_copied_at, last_copied_at, used_count
            FROM clipboard_history
            WHERE LOWER(text) LIKE ?1
            ORDER BY last_copied_at DESC
            LIMIT ?2
            "#,
        )?;
        let entries = stmt
            .query_map(params![like, limit], clipboard_history_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(AToolsError::from)?;
        Ok(entries)
    }

    pub fn prune_clipboard_history(&self, older_than: &str) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "DELETE FROM clipboard_history WHERE last_copied_at < ?1",
            params![older_than],
        )?)
    }

    // This clears only the legacy plugin-history projection, not Pasteboard Shelf items.
    pub fn clear_clipboard_history(&self) -> Result<usize> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM clipboard_history", [])?)
    }

    pub fn export_clipboard_history_json(&self, limit: usize) -> Result<String> {
        let entries = self.search_clipboard_history("", limit)?;
        Ok(serde_json::to_string_pretty(&serde_json::json!({
            "version": 1,
            "exportedAt": crate::utils::now_iso(),
            "count": entries.len(),
            "entries": entries,
        }))?)
    }

}

fn validate_clipboard_history_id(id: &str) -> Result<()> {
    let valid = id.strip_prefix("clip-").is_some_and(|hash| {
        hash.len() == 16 && hash.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    });
    if valid { Ok(()) } else { Err(AToolsError::Config("Invalid clipboard history id".into())) }
}

fn escape_like_pattern(value: &str) -> String {
    value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn clipboard_history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ClipboardHistoryEntry> {
    let used_count: i64 = row.get(4)?;
    Ok(ClipboardHistoryEntry {
        id: row.get(0)?,
        text: row.get(1)?,
        first_copied_at: row.get(2)?,
        last_copied_at: row.get(3)?,
        used_count: used_count.max(0) as u32,
    })
}

fn clipboard_history_by_hash(conn: &Connection, text_hash: &str) -> Result<ClipboardHistoryEntry> {
    let mut stmt = conn.prepare(
        "SELECT id, text, first_copied_at, last_copied_at, used_count FROM clipboard_history WHERE text_hash = ?1",
    )?;
    Ok(stmt.query_row(params![text_hash], clipboard_history_from_row)?)
}

fn stable_text_hash(value: &str) -> String {
    // FNV-1a is sufficient here: the hash is only for local de-duplication, not security.
    let mut hash = 0xcbf29ce484222325u64;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}
