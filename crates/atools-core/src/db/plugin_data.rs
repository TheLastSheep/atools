//! Existing unbounded document APIs retained for trusted callers.
//!
//! New plugin bridges must use the bounded APIs exported beside this module.

use rusqlite::params;

use super::Database;
use crate::error::Result;
use crate::models::Document;
use crate::utils::generate_rev;

impl Database {
    // ---- Plugin data (PouchDB-compatible document store) ----

    /// Inserts or updates a document in a plugin's data store.
    ///
    /// If the document already exists, its revision is updated.
    pub fn plugin_data_put(&self, plugin_id: &str, doc: &Document) -> Result<()> {
        let conn = self.conn.lock();
        let rev = generate_rev();
        let data_json = serde_json::to_string(&doc.data)?;

        let mut stmt = conn.prepare_cached(
            r#"
            INSERT INTO plugin_data (plugin_id, _id, data, rev)
            VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(plugin_id, _id) DO UPDATE SET
                data = excluded.data,
                rev = excluded.rev
            "#,
        )?;
        stmt.execute(params![plugin_id, doc.id, data_json, rev])?;

        Ok(())
    }

    /// Retrieves a single document by ID from a plugin's data store.
    pub fn plugin_data_get(&self, plugin_id: &str, doc_id: &str) -> Result<Option<Document>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare_cached(
            "SELECT _id, data, rev FROM plugin_data WHERE plugin_id = ?1 AND _id = ?2",
        )?;

        let result = stmt.query_row(params![plugin_id, doc_id], |row| {
            let id: String = row.get(0)?;
            let data_str: String = row.get(1)?;
            let rev: String = row.get(2)?;
            let data: serde_json::Value =
                serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
            Ok(Document {
                id,
                rev: Some(rev),
                data,
            })
        });

        match result {
            Ok(doc) => Ok(Some(doc)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Removes a document by ID from a plugin's data store.
    pub fn plugin_data_remove(&self, plugin_id: &str, doc_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare_cached("DELETE FROM plugin_data WHERE plugin_id = ?1 AND _id = ?2")?;
        stmt.execute(params![plugin_id, doc_id])?;
        Ok(())
    }

    /// Returns all documents in a plugin's data store.
    pub fn plugin_data_all(&self, plugin_id: &str) -> Result<Vec<Document>> {
        let conn = self.conn.lock();
        let mut stmt =
            conn.prepare_cached("SELECT _id, data, rev FROM plugin_data WHERE plugin_id = ?1")?;

        let docs = stmt
            .query_map(params![plugin_id], |row| {
                let id: String = row.get(0)?;
                let data_str: String = row.get(1)?;
                let rev: String = row.get(2)?;
                let data: serde_json::Value =
                    serde_json::from_str(&data_str).unwrap_or(serde_json::json!({}));
                Ok(Document {
                    id,
                    rev: Some(rev),
                    data,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(docs)
    }

    /// Bulk-inserts or updates multiple documents.
    pub fn plugin_data_bulk(&self, plugin_id: &str, docs: &[Document]) -> Result<()> {
        let conn = self.conn.lock();
        let tx = conn.unchecked_transaction()?;

        {
            let mut stmt = tx.prepare_cached(
                r#"
                INSERT INTO plugin_data (plugin_id, _id, data, rev)
                VALUES (?1, ?2, ?3, ?4)
                ON CONFLICT(plugin_id, _id) DO UPDATE SET
                    data = excluded.data,
                    rev = excluded.rev
                "#,
            )?;

            for doc in docs {
                let rev = generate_rev();
                let data_json = serde_json::to_string(&doc.data)?;
                stmt.execute(params![plugin_id, doc.id, data_json, rev])?;
            }
        }

        tx.commit()?;
        Ok(())
    }
}
