use super::Database;
use crate::error::Result;
use rusqlite::params;

impl Database {
    // ---- Attachment storage ----

    /// Stores a binary attachment associated with a plugin document.
    pub fn put_attachment(
        &self,
        plugin_id: &str,
        doc_id: &str,
        name: &str,
        data: &[u8],
        content_type: &str,
    ) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            r#"
            INSERT OR REPLACE INTO plugin_data_attachments
            (plugin_id, doc_id, name, data, content_type)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![plugin_id, doc_id, name, data, content_type],
        )?;
        Ok(())
    }

    /// Retrieves a binary attachment.
    pub fn get_attachment(
        &self,
        plugin_id: &str,
        doc_id: &str,
        name: &str,
    ) -> Result<Option<(Vec<u8>, String)>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT data, content_type FROM plugin_data_attachments WHERE plugin_id = ?1 AND doc_id = ?2 AND name = ?3"
        )?;

        let result = stmt.query_row(params![plugin_id, doc_id, name], |row| {
            let data: Vec<u8> = row.get(0)?;
            let content_type: String = row.get(1)?;
            Ok((data, content_type))
        });

        match result {
            Ok(attachment) => Ok(Some(attachment)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Deletes an attachment.
    pub fn delete_attachment(&self, plugin_id: &str, doc_id: &str, name: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let rows = conn.execute(
            "DELETE FROM plugin_data_attachments WHERE plugin_id = ?1 AND doc_id = ?2 AND name = ?3",
            params![plugin_id, doc_id, name],
        )?;
        Ok(rows > 0)
    }
}
