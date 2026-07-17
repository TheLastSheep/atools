use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const ORDER_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_ORDER_KEY_LENGTH: usize = 128;

fn validate_order_key(key: Option<&str>) -> Result<(), String> {
    let Some(key) = key else {
        return Ok(());
    };
    if key.is_empty()
        || key.len() > MAX_ORDER_KEY_LENGTH
        || !key
            .as_bytes()
            .iter()
            .all(|byte| ORDER_ALPHABET.contains(byte))
    {
        return Err("Order keys must contain 1 to 128 base62 characters".to_string());
    }
    Ok(())
}

fn midpoint_order_key(before: Option<&str>, after: Option<&str>) -> Result<String, String> {
    if before.is_none() && after.is_none() {
        return Ok(char::from(ORDER_ALPHABET[ORDER_ALPHABET.len() / 2]).to_string());
    }
    let before = before.map(str::as_bytes);
    let after = after.map(str::as_bytes);
    let mut prefix = Vec::new();
    let mut index = 0;
    while before.is_some_and(|value| index < value.len())
        && after.is_some_and(|value| index < value.len())
        && before.unwrap()[index] == after.unwrap()[index]
    {
        prefix.push(before.unwrap()[index]);
        index += 1;
    }
    let lower_digit = before
        .filter(|value| index < value.len())
        .and_then(|value| ORDER_ALPHABET.iter().position(|byte| *byte == value[index]))
        .map(|value| value as i32)
        .unwrap_or(-1);
    let upper_digit = after
        .filter(|value| index < value.len())
        .and_then(|value| ORDER_ALPHABET.iter().position(|byte| *byte == value[index]))
        .map(|value| value as i32)
        .unwrap_or(ORDER_ALPHABET.len() as i32);

    let candidate = if upper_digit - lower_digit > 1 {
        let midpoint = ((lower_digit + upper_digit) / 2) as usize;
        prefix.push(ORDER_ALPHABET[midpoint]);
        String::from_utf8(prefix).expect("base62 order keys are UTF-8")
    } else if lower_digit >= 0 {
        let before = before.expect("lower digit requires a lower key");
        prefix.push(ORDER_ALPHABET[lower_digit as usize]);
        let suffix = if index + 1 < before.len() {
            Some(std::str::from_utf8(&before[index + 1..]).expect("validated base62 is UTF-8"))
        } else {
            None
        };
        prefix.extend_from_slice(midpoint_order_key(suffix, None)?.as_bytes());
        String::from_utf8(prefix).expect("base62 order keys are UTF-8")
    } else if let Some(after) = after.filter(|value| index + 1 < value.len()) {
        String::from_utf8(after[..=index].to_vec()).expect("validated base62 is UTF-8")
    } else {
        return Err("No base62 order key exists in this gap; rebalance is required".to_string());
    };
    if candidate.len() > MAX_ORDER_KEY_LENGTH {
        return Err("Generated order key requires rebalancing".to_string());
    }
    Ok(candidate)
}

pub fn pasteboard_order_key_between(
    before: Option<&str>,
    after: Option<&str>,
) -> Result<String, String> {
    validate_order_key(before)?;
    validate_order_key(after)?;
    if before
        .zip(after)
        .is_some_and(|(before, after)| before >= after)
    {
        return Err("The lower order key must sort before the upper key".to_string());
    }
    if before.is_none() && after.is_none() {
        return Ok("a0".to_string());
    }
    midpoint_order_key(before, after)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasteboardItemKind {
    Text,
    RichText,
    Html,
    Url,
    Image,
    Pdf,
    Color,
    Files,
}

impl PasteboardItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::RichText => "rich_text",
            Self::Html => "html",
            Self::Url => "url",
            Self::Image => "image",
            Self::Pdf => "pdf",
            Self::Color => "color",
            Self::Files => "files",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HybridLogicalClock {
    pub wall_ms: i64,
    pub counter: u64,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardSourceApp {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardPayload {
    pub revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_paths: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardItem {
    pub id: String,
    pub kind: PasteboardItemKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_app: Option<PasteboardSourceApp>,
    pub source_device_id: String,
    pub copied_at: String,
    pub updated_at: String,
    pub content_fingerprint: String,
    pub payload: PasteboardPayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinboard_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinboard_order_key: Option<String>,
    pub pinned: bool,
    pub field_clocks: BTreeMap<String, HybridLogicalClock>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Pinboard {
    pub id: String,
    pub name: String,
    pub color: String,
    pub order_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub field_clocks: BTreeMap<String, HybridLogicalClock>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PasteboardEntityType {
    PasteItem,
    Pinboard,
}

impl PasteboardEntityType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::PasteItem => "paste_item",
            Self::Pinboard => "pinboard",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardTombstone {
    pub id: String,
    pub entity_type: PasteboardEntityType,
    pub deleted: bool,
    pub deleted_at: String,
    pub source_device_id: String,
    pub clock: HybridLogicalClock,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardBlob {
    pub id: String,
    pub keyed_fingerprint: String,
    pub relative_path: String,
    pub media_type: String,
    pub byte_length: u64,
    pub created_at: String,
    pub last_accessed_at: String,
    pub remote_available: bool,
    pub sync_state: String,
    #[serde(default, skip_serializing_if = "Value::is_null")]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardPruneResult {
    pub deleted_items: usize,
    pub deleted_item_ids: Vec<String>,
    pub deleted_blob_bytes: u64,
    pub deleted_blob_ids: Vec<String>,
    pub retained_blob_bytes: u64,
    pub budget_satisfied: bool,
}
