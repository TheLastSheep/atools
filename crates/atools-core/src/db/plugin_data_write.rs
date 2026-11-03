//! Atomic revision checks and writes for plugin document requests.

use rusqlite::{params, Connection, TransactionBehavior};

use super::plugin_data_contract::{
    invalid, serialized_size, validate_document, validate_id, validate_mutation_result,
    PLUGIN_DATA_MAX_DOCUMENTS, PLUGIN_DATA_MAX_RESPONSE_BYTES,
};
use super::plugin_data_read::current_revision;
use super::{Database, PluginDataRemove, PluginDataWriteResult};
use crate::error::Result;
use crate::models::Document;

impl Database {
    /// Returns the actual new revision from the transaction which wrote it.
    /// Existing documents require the current revision; new documents do not.
    pub fn plugin_data_put_strict(
        &self,
        plugin_id: &str,
        doc: &Document,
    ) -> Result<PluginDataWriteResult> {
        validate_id(plugin_id)?;
        validate_document(doc)?;
        let mut conn = self.conn.lock();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = put_checked(&transaction, plugin_id, doc)?;
        validate_mutation_result(&result)?;
        transaction.commit()?;
        Ok(result)
    }

    /// Per-document conflicts preserve their position and do not block other
    /// valid documents. Duplicate IDs are rejected before any write; budget or
    /// SQLite errors roll back the complete transaction.
    pub fn plugin_data_bulk_strict(
        &self,
        plugin_id: &str,
        docs: &[Document],
    ) -> Result<Vec<PluginDataWriteResult>> {
        validate_id(plugin_id)?;
        if docs.len() > PLUGIN_DATA_MAX_DOCUMENTS {
            return Err(invalid("at most 1000 bulk documents allowed"));
        }
        serialized_size(docs, PLUGIN_DATA_MAX_RESPONSE_BYTES)?;
        let mut ids = std::collections::HashSet::with_capacity(docs.len());
        for doc in docs {
            validate_document(doc)?;
            if !ids.insert(doc.id.as_str()) {
                return Err(invalid("Duplicate document IDs in bulk request"));
            }
        }
        let mut conn = self.conn.lock();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut results = Vec::with_capacity(docs.len());
        for doc in docs {
            results.push(put_checked(&transaction, plugin_id, doc)?);
        }
        validate_mutation_result(&results)?;
        transaction.commit()?;
        Ok(results)
    }

    pub fn plugin_data_remove_strict(
        &self,
        plugin_id: &str,
        target: &PluginDataRemove,
    ) -> Result<PluginDataWriteResult> {
        validate_id(plugin_id)?;
        let (id, expected, require_existing) = match target {
            PluginDataRemove::Id(id) => (id.as_str(), None, true),
            PluginDataRemove::Document(doc) => {
                validate_document(doc)?;
                (doc.id.as_str(), doc.rev.as_deref(), false)
            }
        };
        validate_id(id)?;
        let mut conn = self.conn.lock();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = current_revision(&transaction, plugin_id, id)?;
        let result = if require_existing && current.is_none() {
            PluginDataWriteResult::failure(id, "not_found", "Document not found")
        } else if current
            .as_deref()
            .zip(expected)
            .is_some_and(|(actual, expected)| actual != expected)
        {
            PluginDataWriteResult::failure(id, "conflict", "Document update conflict")
        } else {
            transaction.execute(
                "DELETE FROM plugin_data WHERE plugin_id=?1 AND _id=?2",
                params![plugin_id, id],
            )?;
            PluginDataWriteResult::success(id, None)
        };
        validate_mutation_result(&result)?;
        transaction.commit()?;
        Ok(result)
    }
}

fn put_checked(conn: &Connection, plugin: &str, doc: &Document) -> Result<PluginDataWriteResult> {
    let existing = current_revision(conn, plugin, &doc.id)?;
    if existing.is_some() && existing.as_deref() != doc.rev.as_deref() {
        return Ok(PluginDataWriteResult::failure(
            &doc.id,
            "conflict",
            "Document update conflict",
        ));
    }
    write_document(conn, plugin, doc, existing.as_deref())
}

pub(super) fn write_document(
    conn: &Connection,
    plugin: &str,
    doc: &Document,
    existing: Option<&str>,
) -> Result<PluginDataWriteResult> {
    let generation = next_generation(existing)?;
    let revision = format!("{generation}-{}", uuid::Uuid::new_v4().simple());
    // The generated revision may be longer than the caller's old one.
    let mut stored = doc.clone();
    stored.rev = Some(revision.clone());
    validate_document(&stored)?;
    let json = serde_json::to_string(&doc.data)?;
    conn.execute(
        "INSERT INTO plugin_data(plugin_id,_id,data,rev) VALUES(?1,?2,?3,?4) ON CONFLICT(plugin_id,_id) DO UPDATE SET data=excluded.data,rev=excluded.rev",
        params![plugin, doc.id, json, revision],
    )?;
    Ok(PluginDataWriteResult::success(&doc.id, Some(revision)))
}

pub(super) fn next_generation(existing: Option<&str>) -> Result<u64> {
    existing
        .and_then(|rev| rev.split_once('-'))
        .and_then(|(generation, _)| generation.parse::<u64>().ok())
        .unwrap_or(0)
        .checked_add(1)
        .ok_or_else(|| invalid("revision generation exhausted"))
}
