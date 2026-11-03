use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FullChangeEntry {
    #[serde(default)]
    pub seq: i64,
    pub doc_id: String,
    #[serde(default)]
    pub rev: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_rev: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision_history: Option<Vec<String>>,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub timestamp: i64,
    #[serde(default)]
    pub doc: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<i32>,
    #[serde(flatten, default, skip_serializing_if = "BTreeMap::is_empty")]
    pub extra_fields: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CheckpointPayload {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default)]
    pub last_seq: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_pull_seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_push_seq: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_epoch: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl CheckpointPayload {
    pub fn missing(id: String) -> Self {
        Self {
            id,
            source_id: None,
            target_id: None,
            last_seq: 0,
            remote_pull_seq: None,
            local_push_seq: None,
            sync_epoch: None,
            protocol_version: None,
            updated_at: None,
            data: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClientMessage {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub device_id: String,
    #[serde(default)]
    pub device_name: String,
    #[serde(default)]
    pub since: i64,
    #[serde(default)]
    pub snapshot: bool,
    #[serde(default)]
    pub checkpoint: Option<CheckpointPayload>,
    #[serde(default)]
    pub checkpoint_id: String,
    #[serde(default)]
    pub changes: Vec<FullChangeEntry>,
    #[serde(default)]
    pub protocol_version: i32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerMessage {
    #[serde(rename = "type")]
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_instance_id: Option<String>,
    pub server_seq: i64,
    pub protocol_version: i32,
    pub sync_epoch: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<std::collections::BTreeMap<&'static str, bool>>,
    pub changes: Option<Vec<FullChangeEntry>>,
    pub seq: i64,
    #[serde(skip_serializing_if = "is_false")]
    pub snapshot: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub reset: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint: Option<CheckpointPayload>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl ServerMessage {
    pub fn new(kind: &'static str) -> Self {
        Self {
            kind,
            server_instance_id: None,
            server_seq: 0,
            protocol_version: 2,
            sync_epoch: 0,
            features: None,
            changes: None,
            seq: 0,
            snapshot: false,
            reset: false,
            checkpoint: None,
            message: None,
        }
    }

    pub fn error(message: impl Into<String>) -> Self {
        let mut response = Self::new("error");
        response.message = Some(message.into());
        response
    }
}
