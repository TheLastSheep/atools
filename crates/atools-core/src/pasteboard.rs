//! Durable domain types for the native Paste clipboard runtime.

use serde::{Deserialize, Serialize};
use serde_json::Value;

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

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "text" => Some(Self::Text),
            "rich_text" => Some(Self::RichText),
            "html" => Some(Self::Html),
            "url" => Some(Self::Url),
            "image" => Some(Self::Image),
            "pdf" => Some(Self::Pdf),
            "color" => Some(Self::Color),
            "files" => Some(Self::Files),
            _ => None,
        }
    }

    pub fn search_aliases(self) -> &'static str {
        match self {
            Self::Text => "text 文本",
            Self::RichText => "rich text rich_text 富文本",
            Self::Html => "html 网页",
            Self::Url => "url link 链接 网址",
            Self::Image => "image picture 图片 图像",
            Self::Pdf => "pdf 文档",
            Self::Color => "color 颜色 色值",
            Self::Files => "files file 文件 文件夹",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardSourceApp {
    pub bundle_id: Option<String>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardItem {
    pub id: String,
    pub kind: PasteboardItemKind,
    pub title: Option<String>,
    pub source_app: Option<PasteboardSourceApp>,
    pub source_device_id: String,
    pub copied_at: String,
    pub updated_at: String,
    pub content_fingerprint: String,
    pub payload: Value,
    pub ocr_text: Option<String>,
    pub pinboard_id: Option<String>,
    pub pinboard_order_key: Option<String>,
    pub pinned: bool,
    #[serde(default = "empty_object")]
    pub field_clocks: Value,
}

impl PasteboardItem {
    pub fn searchable_text(&self) -> String {
        let mut values = vec![self.kind.search_aliases().to_string()];
        if let Some(title) = self.title.as_deref() {
            values.push(title.to_string());
        }
        if let Some(source) = self.source_app.as_ref() {
            if let Some(name) = source.name.as_deref() {
                values.push(name.to_string());
            }
            if let Some(bundle_id) = source.bundle_id.as_deref() {
                values.push(bundle_id.to_string());
            }
        }
        if let Some(ocr_text) = self.ocr_text.as_deref() {
            values.push(ocr_text.to_string());
        }
        collect_json_strings(&self.payload, &mut values);
        values.join("\n").to_lowercase()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardPinboard {
    pub id: String,
    pub name: String,
    pub color: String,
    pub order_key: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "empty_object")]
    pub field_clocks: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardBlob {
    pub id: String,
    pub content_hash: String,
    pub relative_path: String,
    pub media_type: String,
    pub byte_size: u64,
    pub created_at: String,
    pub last_accessed_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardTombstone {
    pub entity_id: String,
    pub entity_kind: String,
    pub deleted_at: String,
    pub deleted_clock: Value,
    pub source_device_id: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardPruneResult {
    pub deleted_items: usize,
    pub deleted_blobs: Vec<String>,
    pub reclaimed_bytes: u64,
    pub remaining_attachment_bytes: u64,
}

fn empty_object() -> Value {
    Value::Object(Default::default())
}

fn collect_json_strings(value: &Value, output: &mut Vec<String>) {
    match value {
        Value::String(value) => output.push(value.clone()),
        Value::Array(values) => {
            for value in values {
                collect_json_strings(value, output);
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                collect_json_strings(value, output);
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn searchable_text_includes_metadata_payload_and_ocr() {
        let item = PasteboardItem {
            id: "item-1".into(),
            kind: PasteboardItemKind::Image,
            title: Some("Reference".into()),
            source_app: Some(PasteboardSourceApp {
                bundle_id: Some("com.apple.Safari".into()),
                name: Some("Safari".into()),
            }),
            source_device_id: "device-1".into(),
            copied_at: "2026-07-21T00:00:00Z".into(),
            updated_at: "2026-07-21T00:00:00Z".into(),
            content_fingerprint: "hash".into(),
            payload: serde_json::json!({"fileName": "Hero.PNG"}),
            ocr_text: Some("Invoice 42".into()),
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks: empty_object(),
        };

        let text = item.searchable_text();
        assert!(text.contains("reference"));
        assert!(text.contains("image"));
        assert!(text.contains("图片"));
        assert!(text.contains("com.apple.safari"));
        assert!(text.contains("hero.png"));
        assert!(text.contains("invoice 42"));
    }
}
