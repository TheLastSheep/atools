use super::Database;
use crate::error::{AToolsError, Result};
use crate::pasteboard::{
    PasteboardBlob, PasteboardPinboard, PasteboardPruneResult, PasteboardTombstone,
};
use rusqlite::{params, Connection};

impl Database {
    pub fn upsert_pasteboard_pinboard(&self, pinboard: &PasteboardPinboard) -> Result<()> {
        if pinboard.id.trim().is_empty() || pinboard.name.trim().is_empty() {
            return Err(AToolsError::Config(
                "Pasteboard pinboard ID and name are required".to_string(),
            ));
        }
        let field_clocks = serde_json::to_string(&pinboard.field_clocks)?;
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO pasteboard_pinboards
            (id, name, color, order_key, created_at, updated_at, field_clocks)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                color = excluded.color,
                order_key = excluded.order_key,
                updated_at = excluded.updated_at,
                field_clocks = excluded.field_clocks
            "#,
            params![
                pinboard.id,
                pinboard.name,
                pinboard.color,
                pinboard.order_key,
                pinboard.created_at,
                pinboard.updated_at,
                field_clocks,
            ],
        )?;
        Ok(())
    }

    pub fn list_pasteboard_pinboards(&self) -> Result<Vec<PasteboardPinboard>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, name, color, order_key, created_at, updated_at, field_clocks
            FROM pasteboard_pinboards
            ORDER BY order_key, created_at, id
            "#,
        )?;
        let pinboards = stmt
            .query_map([], pasteboard_pinboard_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(pinboards)
    }

    pub fn assign_pasteboard_item(
        &self,
        item_id: &str,
        pinboard_id: Option<&str>,
        order_key: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            r#"
            UPDATE pasteboard_items
            SET pinboard_id = ?2, pinboard_order_key = ?3, updated_at = ?4
            WHERE id = ?1
            "#,
            params![item_id, pinboard_id, order_key, crate::utils::now_iso()],
        )?;
        Ok(rows > 0)
    }

    pub fn delete_pasteboard_pinboard(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE pasteboard_items SET pinboard_id = NULL, pinboard_order_key = NULL WHERE pinboard_id = ?1",
            params![id],
        )?;
        let deleted = tx.execute(
            "DELETE FROM pasteboard_pinboards WHERE id = ?1",
            params![id],
        )?;
        tx.commit()?;
        Ok(deleted > 0)
    }

    pub fn upsert_pasteboard_blob(&self, blob: &PasteboardBlob) -> Result<()> {
        if blob.id.trim().is_empty() || blob.relative_path.trim().is_empty() {
            return Err(AToolsError::Config(
                "Pasteboard blob ID and path are required".to_string(),
            ));
        }
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO pasteboard_blobs
            (id, content_hash, relative_path, media_type, byte_size, created_at, last_accessed_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET
                content_hash = excluded.content_hash,
                relative_path = excluded.relative_path,
                media_type = excluded.media_type,
                byte_size = excluded.byte_size,
                last_accessed_at = excluded.last_accessed_at
            "#,
            params![
                blob.id,
                blob.content_hash,
                blob.relative_path,
                blob.media_type,
                blob.byte_size.min(i64::MAX as u64) as i64,
                blob.created_at,
                blob.last_accessed_at,
            ],
        )?;
        Ok(())
    }

    pub fn get_pasteboard_blob(&self, id: &str) -> Result<Option<PasteboardBlob>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT id, content_hash, relative_path, media_type, byte_size, created_at, last_accessed_at
            FROM pasteboard_blobs WHERE id = ?1
            "#,
        )?;
        match stmt.query_row(params![id], pasteboard_blob_from_row) {
            Ok(blob) => Ok(Some(blob)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn link_pasteboard_blob(&self, item_id: &str, blob_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR IGNORE INTO pasteboard_item_blobs (item_id, blob_id) VALUES (?1, ?2)",
            params![item_id, blob_id],
        )?;
        Ok(())
    }

    pub fn replace_pasteboard_item_blobs(&self, item_id: &str, blob_ids: &[String]) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        tx.execute(
            "DELETE FROM pasteboard_item_blobs WHERE item_id = ?1",
            params![item_id],
        )?;
        for blob_id in blob_ids {
            tx.execute(
                "INSERT OR IGNORE INTO pasteboard_item_blobs (item_id, blob_id) VALUES (?1, ?2)",
                params![item_id, blob_id],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn pasteboard_attachment_bytes(&self) -> Result<u64> {
        let conn = self.conn.lock();
        let bytes = conn.query_row(
            r#"
            SELECT COALESCE(SUM(byte_size), 0)
            FROM pasteboard_blobs
            WHERE EXISTS (
                SELECT 1 FROM pasteboard_item_blobs
                WHERE pasteboard_item_blobs.blob_id = pasteboard_blobs.id
            )
            "#,
            [],
            |row| row.get::<_, i64>(0),
        )?;
        Ok(bytes.max(0) as u64)
    }

    pub fn upsert_pasteboard_tombstone(&self, tombstone: &PasteboardTombstone) -> Result<()> {
        let deleted_clock = serde_json::to_string(&tombstone.deleted_clock)?;
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO pasteboard_tombstones
            (entity_id, entity_kind, deleted_at, deleted_clock, source_device_id)
            VALUES (?1, ?2, ?3, ?4, ?5)
            ON CONFLICT(entity_id) DO UPDATE SET
                entity_kind = excluded.entity_kind,
                deleted_at = excluded.deleted_at,
                deleted_clock = excluded.deleted_clock,
                source_device_id = excluded.source_device_id
            "#,
            params![
                tombstone.entity_id,
                tombstone.entity_kind,
                tombstone.deleted_at,
                deleted_clock,
                tombstone.source_device_id,
            ],
        )?;
        Ok(())
    }

    pub fn list_pasteboard_tombstones(&self) -> Result<Vec<PasteboardTombstone>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            r#"
            SELECT entity_id, entity_kind, deleted_at, deleted_clock, source_device_id
            FROM pasteboard_tombstones
            ORDER BY deleted_at DESC, entity_kind, entity_id
            "#,
        )?;
        let tombstones = stmt
            .query_map([], pasteboard_tombstone_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(tombstones)
    }

    pub fn delete_pasteboard_tombstone(&self, entity_id: &str, entity_kind: &str) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute(
            "DELETE FROM pasteboard_tombstones WHERE entity_id = ?1 AND entity_kind = ?2",
            params![entity_id, entity_kind],
        )? > 0)
    }

    pub fn prune_pasteboard_history(
        &self,
        older_than: &str,
        attachment_budget_bytes: u64,
    ) -> Result<PasteboardPruneResult> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;
        let mut deleted_items = tx.execute(
            r#"
            DELETE FROM pasteboard_items
            WHERE copied_at < ?1 AND pinned = 0 AND pinboard_id IS NULL
            "#,
            params![older_than],
        )?;

        let mut total_bytes = pasteboard_attachment_bytes_with_connection(&tx)?;
        if total_bytes > attachment_budget_bytes {
            let candidates = {
                let mut stmt = tx.prepare(
                    r#"
                    SELECT DISTINCT item.id, item.copied_at
                    FROM pasteboard_items item
                    JOIN pasteboard_item_blobs link ON link.item_id = item.id
                    WHERE item.pinned = 0 AND item.pinboard_id IS NULL
                    ORDER BY item.copied_at ASC, item.id ASC
                    "#,
                )?;
                let items = stmt
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<std::result::Result<Vec<_>, _>>()?;
                items
            };
            for item_id in candidates {
                if total_bytes <= attachment_budget_bytes {
                    break;
                }
                let item_bytes = tx.query_row(
                    r#"
                    SELECT COALESCE(SUM(blob.byte_size), 0)
                    FROM pasteboard_item_blobs link
                    JOIN pasteboard_blobs blob ON blob.id = link.blob_id
                    WHERE link.item_id = ?1
                    "#,
                    params![item_id],
                    |row| row.get::<_, i64>(0),
                )?;
                deleted_items += tx.execute(
                    "DELETE FROM pasteboard_items WHERE id = ?1",
                    params![item_id],
                )?;
                total_bytes = total_bytes.saturating_sub(item_bytes.max(0) as u64);
            }
        }

        let deleted_blobs = {
            let mut stmt = tx.prepare(
                r#"
                SELECT relative_path, byte_size
                FROM pasteboard_blobs blob
                WHERE NOT EXISTS (
                    SELECT 1 FROM pasteboard_item_blobs link WHERE link.blob_id = blob.id
                )
                "#,
            )?;
            let blobs = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?.max(0) as u64,
                    ))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            blobs
        };
        tx.execute(
            r#"
            DELETE FROM pasteboard_blobs
            WHERE NOT EXISTS (
                SELECT 1 FROM pasteboard_item_blobs link WHERE link.blob_id = pasteboard_blobs.id
            )
            "#,
            [],
        )?;
        let remaining_attachment_bytes = pasteboard_attachment_bytes_with_connection(&tx)?;
        tx.commit()?;

        Ok(PasteboardPruneResult {
            deleted_items,
            reclaimed_bytes: deleted_blobs.iter().map(|(_, bytes)| *bytes).sum(),
            deleted_blobs: deleted_blobs.into_iter().map(|(path, _)| path).collect(),
            remaining_attachment_bytes,
        })
    }
}
fn pasteboard_pinboard_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PasteboardPinboard> {
    Ok(PasteboardPinboard {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        order_key: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        field_clocks: json_column(row, 6)?,
    })
}

pub(super) fn json_column<T: serde::de::DeserializeOwned>(
    row: &rusqlite::Row<'_>,
    index: usize,
) -> rusqlite::Result<T> {
    let value = row.get::<_, String>(index)?;
    serde_json::from_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn pasteboard_blob_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PasteboardBlob> {
    Ok(PasteboardBlob {
        id: row.get(0)?,
        content_hash: row.get(1)?,
        relative_path: row.get(2)?,
        media_type: row.get(3)?,
        byte_size: row.get::<_, i64>(4)?.max(0) as u64,
        created_at: row.get(5)?,
        last_accessed_at: row.get(6)?,
    })
}

fn pasteboard_tombstone_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PasteboardTombstone> {
    let deleted_clock: String = row.get(3)?;
    Ok(PasteboardTombstone {
        entity_id: row.get(0)?,
        entity_kind: row.get(1)?,
        deleted_at: row.get(2)?,
        deleted_clock: serde_json::from_str(&deleted_clock).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?,
        source_device_id: row.get(4)?,
    })
}

fn pasteboard_attachment_bytes_with_connection(conn: &Connection) -> rusqlite::Result<u64> {
    let bytes = conn.query_row(
        r#"
        SELECT COALESCE(SUM(byte_size), 0)
        FROM pasteboard_blobs
        WHERE EXISTS (
            SELECT 1 FROM pasteboard_item_blobs
            WHERE pasteboard_item_blobs.blob_id = pasteboard_blobs.id
        )
        "#,
        [],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(bytes.max(0) as u64)
}
