use super::pasteboard_support::json_column;
use super::Database;
use crate::error::{AToolsError, Result};
use crate::pasteboard::{PasteboardItem, PasteboardItemKind};
use rusqlite::params;

impl Database {
    // ---- Native Paste clipboard runtime ----

    pub fn upsert_pasteboard_item(&self, item: &PasteboardItem) -> Result<()> {
        validate_pasteboard_item(item)?;
        let source_app = serde_json::to_string(&item.source_app)?;
        let payload = serde_json::to_string(&item.payload)?;
        let field_clocks = serde_json::to_string(&item.field_clocks)?;
        let search_text = item.searchable_text();
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT INTO pasteboard_items
            (id, kind, title, source_app, source_device_id, copied_at, updated_at,
             content_fingerprint, payload, ocr_text, pinboard_id, pinboard_order_key,
             pinned, field_clocks, search_text)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            ON CONFLICT(id) DO UPDATE SET
                kind = excluded.kind,
                title = excluded.title,
                source_app = excluded.source_app,
                source_device_id = excluded.source_device_id,
                copied_at = excluded.copied_at,
                updated_at = excluded.updated_at,
                content_fingerprint = excluded.content_fingerprint,
                payload = excluded.payload,
                ocr_text = excluded.ocr_text,
                pinboard_id = excluded.pinboard_id,
                pinboard_order_key = excluded.pinboard_order_key,
                pinned = excluded.pinned,
                field_clocks = excluded.field_clocks,
                search_text = excluded.search_text
            "#,
            params![
                item.id,
                item.kind.as_str(),
                item.title,
                source_app,
                item.source_device_id,
                item.copied_at,
                item.updated_at,
                item.content_fingerprint,
                payload,
                item.ocr_text,
                item.pinboard_id,
                item.pinboard_order_key,
                item.pinned,
                field_clocks,
                search_text,
            ],
        )?;
        Ok(())
    }

    pub fn get_pasteboard_item(&self, id: &str) -> Result<Option<PasteboardItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&pasteboard_item_select("WHERE id = ?1"))?;
        match stmt.query_row(params![id], pasteboard_item_from_row) {
            Ok(item) => Ok(Some(item)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn find_pasteboard_item_by_fingerprint(
        &self,
        fingerprint: &str,
    ) -> Result<Option<PasteboardItem>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(&pasteboard_item_select(
            "WHERE content_fingerprint = ?1 ORDER BY copied_at DESC LIMIT 1",
        ))?;
        match stmt.query_row(params![fingerprint], pasteboard_item_from_row) {
            Ok(item) => Ok(Some(item)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    pub fn search_pasteboard_items(
        &self,
        query: &str,
        pinboard_id: Option<&str>,
        kinds: &[PasteboardItemKind],
        limit: usize,
        offset: usize,
    ) -> Result<Vec<PasteboardItem>> {
        let conn = self.conn.lock();
        let limit = limit.clamp(1, 500) as i64;
        let offset = offset.min(i64::MAX as usize) as i64;
        let query = format!("%{}%", query.trim().to_lowercase());
        let pinboard_id = pinboard_id.unwrap_or_default();
        let kinds = kinds
            .iter()
            .map(|kind| kind.as_str())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "{} WHERE (?1 = '%%' OR search_text LIKE ?1 OR \
             CASE kind \
               WHEN 'text' THEN 'text 文本' \
               WHEN 'rich_text' THEN 'rich text rich_text 富文本' \
               WHEN 'html' THEN 'html 网页' \
               WHEN 'url' THEN 'url link 链接 网址' \
               WHEN 'image' THEN 'image picture 图片 图像' \
               WHEN 'pdf' THEN 'pdf 文档' \
               WHEN 'color' THEN 'color 颜色 色值' \
               WHEN 'files' THEN 'files file 文件 文件夹' \
               ELSE kind END LIKE ?1) \
             AND (?2 = '' OR pinboard_id = ?2) \
             AND (?3 = '' OR instr(',' || ?3 || ',', ',' || kind || ',') > 0) \
             ORDER BY copied_at DESC LIMIT ?4 OFFSET ?5",
            pasteboard_item_select("")
        );
        let mut stmt = conn.prepare(&sql)?;
        let items = stmt
            .query_map(
                params![query, pinboard_id, kinds, limit, offset],
                pasteboard_item_from_row,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(items)
    }

    pub fn delete_pasteboard_item(&self, id: &str) -> Result<bool> {
        let conn = self.conn.lock();
        Ok(conn.execute("DELETE FROM pasteboard_items WHERE id = ?1", params![id])? > 0)
    }
}
fn validate_pasteboard_item(item: &PasteboardItem) -> Result<()> {
    if item.id.trim().is_empty()
        || item.source_device_id.trim().is_empty()
        || item.content_fingerprint.trim().is_empty()
        || item.copied_at.trim().is_empty()
        || item.updated_at.trim().is_empty()
    {
        return Err(AToolsError::Config(
            "Pasteboard item identity, device, fingerprint, and timestamps are required"
                .to_string(),
        ));
    }
    if item.pinboard_id.is_none() && item.pinboard_order_key.is_some() {
        return Err(AToolsError::Config(
            "Pasteboard item order requires a pinboard".to_string(),
        ));
    }
    Ok(())
}

fn pasteboard_item_select(suffix: &str) -> String {
    format!(
        r#"
        SELECT id, kind, title, source_app, source_device_id, copied_at, updated_at,
               content_fingerprint, payload, ocr_text, pinboard_id, pinboard_order_key,
               pinned, field_clocks
        FROM pasteboard_items
        {suffix}
        "#
    )
}

fn pasteboard_item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PasteboardItem> {
    let kind = row.get::<_, String>(1)?;
    let kind = PasteboardItemKind::parse(&kind).ok_or_else(|| {
        rusqlite::Error::FromSqlConversionFailure(
            1,
            rusqlite::types::Type::Text,
            format!("Unknown pasteboard item kind: {kind}").into(),
        )
    })?;
    let source_app = json_column(row, 3)?;
    let payload = json_column(row, 8)?;
    let field_clocks = json_column(row, 13)?;
    Ok(PasteboardItem {
        id: row.get(0)?,
        kind,
        title: row.get(2)?,
        source_app,
        source_device_id: row.get(4)?,
        copied_at: row.get(5)?,
        updated_at: row.get(6)?,
        content_fingerprint: row.get(7)?,
        payload,
        ocr_text: row.get(9)?,
        pinboard_id: row.get(10)?,
        pinboard_order_key: row.get(11)?,
        pinned: row.get(12)?,
        field_clocks,
    })
}
