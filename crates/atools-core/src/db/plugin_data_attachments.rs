//! Bounded, transactional attachment storage sharing the plugin document owner.

use md5::{Digest, Md5};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::plugin_data_contract::{
    invalid, serialized_size, validate_id, validate_mutation_result,
    PLUGIN_DATA_MAX_DOCUMENT_BYTES, PLUGIN_DATA_MAX_RESPONSE_BYTES,
};
use super::plugin_data_read::read_one;
use super::plugin_data_write::{next_generation, write_document};
use super::{Database, PluginDataWriteResult};
use crate::error::Result;
use crate::models::Document;

const MAX_MIME_BYTES: usize = 1024;

/// Real metadata for the stored bytes. MD5 supplies ZTools digest compatibility,
/// not authentication. revpos is absent for legacy rows without upload metadata.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PluginDataAttachmentMetadata {
    #[serde(rename = "type")]
    pub kind: String,
    pub length: usize,
    pub md5: String,
    pub digest: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revpos: Option<u64>,
}

impl Database {
    /// Official callers use name="default". The existing named extension stays
    /// isolated by (plugin_id,doc_id,name); posting an existing name conflicts.
    pub fn plugin_data_post_attachment_bounded(
        &self,
        plugin_id: &str,
        id: &str,
        name: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<PluginDataWriteResult> {
        validate_attachment_target(plugin_id, id, name)?;
        if bytes.len() > PLUGIN_DATA_MAX_DOCUMENT_BYTES {
            return Err(invalid("attachment exceeds 256KiB budget"));
        }
        if content_type.len() > MAX_MIME_BYTES {
            return Err(invalid("attachment MIME type exceeds byte budget"));
        }
        let mut conn = self.conn.lock();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let exists: bool = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM plugin_data_attachments WHERE plugin_id=?1 AND doc_id=?2 AND name=?3)",
            params![plugin_id, id, name], |row| row.get(0),
        )?;
        if exists {
            return Ok(PluginDataWriteResult::failure(
                id,
                "conflict",
                "Attachment already exists",
            ));
        }
        let mut document = read_one(&transaction, plugin_id, id)?.unwrap_or(Document {
            id: id.into(),
            rev: None,
            data: json!({}),
        });
        let generation = next_generation(document.rev.as_deref())?;
        let metadata = metadata(bytes, content_type, name, Some(generation));
        let mut stubs = document
            .data
            .get("_attachments")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        stubs.insert(
            name.into(),
            json!({
                "stub":true, "digest":metadata.digest, "content_type":content_type,
                "length":bytes.len(), "revpos":generation,
            }),
        );
        document.data["_attachments"] = Value::Object(stubs);
        let receipt = write_document(&transaction, plugin_id, &document, document.rev.as_deref())?;
        transaction.execute(
            "INSERT INTO plugin_data_attachments(plugin_id,doc_id,name,data,content_type,metadata) VALUES(?1,?2,?3,?4,?5,?6)",
            params![plugin_id, id, name, bytes, content_type, serde_json::to_string(&metadata)?],
        )?;
        validate_mutation_result(&receipt)?;
        transaction.commit()?;
        Ok(receipt)
    }

    /// The host must encode bytes as base64, not JSON integer arrays. 256KiB of
    /// binary plus the bounded metadata fits a 512KiB JSON response.
    pub fn plugin_data_get_attachment_bounded(
        &self,
        plugin_id: &str,
        id: &str,
        name: &str,
    ) -> Result<Option<(Vec<u8>, PluginDataAttachmentMetadata)>> {
        validate_attachment_target(plugin_id, id, name)?;
        let mut conn = self.conn.lock();
        let transaction = conn.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let mut statement = transaction.prepare_cached(
            "SELECT octet_length(data),octet_length(content_type),coalesce(octet_length(metadata),0) FROM plugin_data_attachments WHERE plugin_id=?1 AND doc_id=?2 AND name=?3",
        )?;
        let sizes = statement
            .query_row(params![plugin_id, id, name], |row| {
                Ok((
                    row.get::<_, usize>(0)?,
                    row.get::<_, usize>(1)?,
                    row.get::<_, usize>(2)?,
                ))
            })
            .optional()?;
        let Some((size, mime_size, metadata_size)) = sizes else {
            return Ok(None);
        };
        if size > PLUGIN_DATA_MAX_DOCUMENT_BYTES
            || mime_size > MAX_MIME_BYTES
            || metadata_size > PLUGIN_DATA_MAX_DOCUMENT_BYTES
        {
            return Err(invalid("stored attachment exceeds byte budget"));
        }
        drop(statement);
        let (bytes, kind, saved): (Vec<u8>, String, Option<String>) = transaction.query_row(
            "SELECT data,content_type,metadata FROM plugin_data_attachments WHERE plugin_id=?1 AND doc_id=?2 AND name=?3",
            params![plugin_id, id, name], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;
        let metadata = match saved {
            Some(saved) => {
                let saved: PluginDataAttachmentMetadata = serde_json::from_str(&saved)?;
                if saved != metadata(&bytes, &kind, name, saved.revpos) {
                    return Err(invalid(
                        "stored attachment metadata does not match its bytes",
                    ));
                }
                saved
            }
            // Old rows predate upload metadata. Recover only facts proven by
            // the stored bytes/type/name; an unknown upload revision stays null.
            None => metadata(&bytes, &kind, name, None),
        };
        let metadata_bytes = serialized_size(&metadata, PLUGIN_DATA_MAX_RESPONSE_BYTES)?;
        let base64_bytes = bytes.len().div_ceil(3) * 4;
        if base64_bytes + metadata_bytes + 64 > PLUGIN_DATA_MAX_RESPONSE_BYTES {
            return Err(invalid("attachment response exceeds 512KiB budget"));
        }
        transaction.commit()?;
        Ok(Some((bytes, metadata)))
    }

    pub fn plugin_data_get_attachment_type_bounded(
        &self,
        plugin_id: &str,
        id: &str,
        name: &str,
    ) -> Result<Option<PluginDataAttachmentMetadata>> {
        Ok(self
            .plugin_data_get_attachment_bounded(plugin_id, id, name)?
            .map(|(_, metadata)| metadata))
    }
}

fn metadata(
    bytes: &[u8],
    kind: &str,
    name: &str,
    revpos: Option<u64>,
) -> PluginDataAttachmentMetadata {
    let md5 = format!("{:x}", Md5::digest(bytes));
    PluginDataAttachmentMetadata {
        kind: kind.into(),
        length: bytes.len(),
        digest: format!("md5-{md5}"),
        md5,
        name: name.into(),
        revpos,
    }
}

/// Additive and serialized across independent database handles. Checking the
/// column inside IMMEDIATE prevents two simultaneous opens from racing ALTER.
pub(super) fn migrate_attachment_metadata(conn: &Connection) -> Result<()> {
    let transaction = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('plugin_data_attachments') WHERE name='metadata')",
        [], |row| row.get(0),
    )?;
    if !exists {
        transaction.execute(
            "ALTER TABLE plugin_data_attachments ADD COLUMN metadata TEXT",
            [],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn validate_attachment_target(plugin: &str, id: &str, name: &str) -> Result<()> {
    validate_id(plugin)?;
    validate_id(id)?;
    validate_id(name)?;
    // The name occurs in metadata as well as the document's attachment stub.
    serialized_size(name, MAX_MIME_BYTES)?;
    Ok(())
}
