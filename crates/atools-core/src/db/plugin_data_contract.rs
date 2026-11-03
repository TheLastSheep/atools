//! Types and fixed budgets for untrusted plugin document requests.

use serde::{Deserialize, Serialize};

use crate::error::{AToolsError, Result};
use crate::models::Document;

pub const PLUGIN_DATA_MAX_DOCUMENT_BYTES: usize = 256 * 1024;
pub const PLUGIN_DATA_MAX_RESPONSE_BYTES: usize = 512 * 1024;
pub const PLUGIN_DATA_MAX_DOCUMENTS: usize = 1000;
pub const PLUGIN_DATA_MAX_KEYS: usize = 128;

/// Reserve the transport's {ok:true,result:...} envelope before committing any
/// mutation, so a valid write can never become a post-commit budget failure.
pub(super) fn validate_mutation_result<T: Serialize + ?Sized>(result: &T) -> Result<()> {
    serialized_size(result, PLUGIN_DATA_MAX_RESPONSE_BYTES - 64).map(|_| ())
}

/// An allDocs selector. Keys retain input order and duplicates; missing keys are omitted.
#[derive(Debug, Clone)]
pub enum PluginDataQuery {
    All,
    Prefix(String),
    Keys(Vec<String>),
}

/// Removing by ID reports not_found for a missing document. A document target
/// checks its revision only when a revision was explicitly supplied, like ZTools.
#[derive(Debug, Clone)]
pub enum PluginDataRemove {
    Id(String),
    Document(Document),
}

/// ZTools-compatible mutation result. Conflicts are values, database/budget
/// failures are errors; callers must not turn errors into successful writes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginDataWriteResult {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rev: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ok: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PluginDataWriteResult {
    pub(super) fn success(id: &str, rev: Option<String>) -> Self {
        Self {
            id: id.into(),
            rev,
            ok: Some(true),
            error: None,
            name: None,
            message: None,
        }
    }

    pub(super) fn failure(id: &str, name: &str, message: &str) -> Self {
        Self {
            id: id.into(),
            rev: None,
            ok: None,
            error: Some(true),
            name: Some(name.into()),
            message: Some(message.into()),
        }
    }
}

pub(super) fn invalid(message: &str) -> AToolsError {
    AToolsError::Plugin(format!("Plugin data: {message}"))
}

pub(super) fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Err(invalid("non-empty document/plugin ID required"));
    }
    // A single key must fit the same bound as a document, even on missing reads.
    if id.len() > PLUGIN_DATA_MAX_DOCUMENT_BYTES {
        return Err(invalid("document/plugin ID exceeds byte budget"));
    }
    Ok(())
}

pub(super) fn validate_document(doc: &Document) -> Result<()> {
    validate_id(&doc.id)?;
    let Some(data) = doc.data.as_object() else {
        return Err(invalid("document fields must be a JSON object"));
    };
    if data.contains_key("_id") || data.contains_key("_rev") {
        return Err(invalid("document fields cannot shadow _id or _rev"));
    }
    serialized_size(doc, PLUGIN_DATA_MAX_DOCUMENT_BYTES)?;
    Ok(())
}

/// Count serialized bytes without allocating an unbounded temporary JSON string.
pub(super) fn serialized_size<T: Serialize + ?Sized>(value: &T, maximum: usize) -> Result<usize> {
    super::bounded_json::serialized_size(value, maximum)
        .ok_or_else(|| invalid("serialized data exceeds byte budget or is invalid"))
}

pub(super) fn validate_limit(limit: Option<usize>) -> Result<usize> {
    let limit = limit.unwrap_or(PLUGIN_DATA_MAX_DOCUMENTS);
    if limit == 0 || limit > PLUGIN_DATA_MAX_DOCUMENTS {
        return Err(invalid("document limit must be between 1 and 1000"));
    }
    Ok(limit)
}
