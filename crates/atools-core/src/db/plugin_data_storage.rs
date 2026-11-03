//! dbStorage shares plugin_data, with atomic current-revision upserts.

use rusqlite::TransactionBehavior;
use serde_json::{json, Value};

use super::plugin_data_contract::{
    serialized_size, validate_document, validate_id, validate_mutation_result,
    PLUGIN_DATA_MAX_DOCUMENT_BYTES, PLUGIN_DATA_MAX_RESPONSE_BYTES,
};
use super::plugin_data_read::current_revision;
use super::plugin_data_write::write_document;
use super::{Database, PluginDataRemove, PluginDataWriteResult};
use crate::error::Result;
use crate::models::Document;

impl Database {
    /// Match ZTools' `doc.value ?? doc.data` fallback, including missing/null.
    pub fn plugin_storage_get(&self, plugin_id: &str, key: &str) -> Result<Value> {
        let doc = self.plugin_data_get_bounded(plugin_id, key)?;
        let value = doc
            .and_then(|doc| {
                doc.data
                    .get("value")
                    .filter(|value| !value.is_null())
                    .or_else(|| doc.data.get("data"))
                    .cloned()
            })
            .unwrap_or(Value::Null);
        serialized_size(&value, PLUGIN_DATA_MAX_RESPONSE_BYTES)?;
        Ok(value)
    }

    pub fn plugin_storage_set(
        &self,
        plugin_id: &str,
        key: &str,
        value: &Value,
    ) -> Result<PluginDataWriteResult> {
        validate_id(plugin_id)?;
        serialized_size(value, PLUGIN_DATA_MAX_DOCUMENT_BYTES)?;
        let doc = Document {
            id: key.into(),
            rev: None,
            data: json!({ "value": value }),
        };
        validate_document(&doc)?;
        let mut conn = self.conn.lock();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = current_revision(&transaction, plugin_id, key)?;
        let result = write_document(&transaction, plugin_id, &doc, existing.as_deref())?;
        validate_mutation_result(&result)?;
        transaction.commit()?;
        Ok(result)
    }

    pub fn plugin_storage_remove(
        &self,
        plugin_id: &str,
        key: &str,
    ) -> Result<PluginDataWriteResult> {
        self.plugin_data_remove_strict(plugin_id, &PluginDataRemove::Id(key.into()))
    }
}
