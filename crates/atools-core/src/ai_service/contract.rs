use serde::{Deserialize, Serialize};
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiRole {
    System,
    User,
    Assistant,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AiContent {
    Text(String),
    Parts(Vec<AiPart>),
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum AiPart {
    Text { text: String },
    ImageUrl { image_url: AiImageUrl },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AiImageDetail {
    Auto,
    Low,
    High,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiImageUrl {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<AiImageDetail>,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiMessage {
    pub role: AiRole,
    pub content: AiContent,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiRequest {
    pub messages: Vec<AiMessage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiModel {
    pub id: String,
    pub value: String,
    pub label: String,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiDelta {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

#[derive(PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiAssistantMessage {
    pub role: AiRole,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AiOutputMode {
    Stream,
    Collect,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiErrorCode {
    InvalidRequest,
    UnsupportedContent,
    UnsupportedToolCall,
    PayloadTooLarge,
    UnknownModel,
    NotConfigured,
    Transport,
    HttpStatus,
    ProviderError,
    TruncatedStream,
    MalformedResponse,
    Timeout,
    Aborted,
    Busy,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AiServiceError {
    pub code: AiErrorCode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

impl AiServiceError {
    pub const fn new(code: AiErrorCode) -> Self {
        Self { code, http_status: None }
    }

    pub const fn http_status(status: u16) -> Self {
        Self { code: AiErrorCode::HttpStatus, http_status: Some(status) }
    }
}

impl fmt::Display for AiServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.http_status {
            Some(status) => write!(formatter, "AI service error: {:?} ({status})", self.code),
            None => write!(formatter, "AI service error: {:?}", self.code),
        }
    }
}

impl std::error::Error for AiServiceError {}
