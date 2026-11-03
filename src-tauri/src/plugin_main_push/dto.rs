//! Closed metadata contracts: original input, options and rows stay in the frame.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CommandType {
    Text,
    Regex,
    Over,
}
impl CommandType {
    pub(super) fn from_match(kind: &str) -> Option<Self> {
        match kind {
            "exact" | "prefix" | "contains" | "pinyin" => Some(Self::Text),
            "regex" => Some(Self::Regex),
            "over" => Some(Self::Over),
            _ => None,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Operation {
    Prepare,
    Query,
    Select,
}
impl Operation {
    pub(super) fn deadline(self) -> std::time::Duration {
        std::time::Duration::from_millis(match self {
            Self::Prepare => 5000,
            Self::Query => 1200,
            Self::Select => 3000,
        })
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Identity {
    pub plugin_id: String,
    pub feature_code: String,
    pub command_type: CommandType,
    pub code_revision: String,
}
impl Identity {
    pub(super) fn same_code(&self, other: &Self) -> bool {
        self.plugin_id == other.plugin_id
            && self.feature_code == other.feature_code
            && self.code_revision == other.code_revision
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Request {
    pub request_id: String,
    pub runner_id: String,
    #[serde(flatten)]
    pub identity: Identity,
    pub operation: Operation,
    pub input_bytes: u32,
    pub query_generation: u32,
}
impl Request {
    pub(super) fn validate(&self) -> Result<(), String> {
        for id in [&self.request_id, &self.runner_id] {
            uuid::Uuid::parse_str(id).map_err(|_| "ERR_MAIN_PUSH_ID_INVALID")?;
        }
        for value in [&self.identity.plugin_id, &self.identity.feature_code] {
            if value.is_empty()
                || value.len() > 512
                || value != value.trim()
                || value.chars().any(char::is_control)
            {
                return Err("ERR_MAIN_PUSH_IDENTITY_INVALID".into());
            }
        }
        if self.identity.code_revision.len() != 64
            || !self
                .identity
                .code_revision
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err("ERR_MAIN_PUSH_REVISION_INVALID".into());
        }
        if self.input_bytes > 1024 * 1024
            || (self.operation == Operation::Prepare && self.input_bytes != 0)
        {
            return Err("ERR_MAIN_PUSH_INPUT_BUDGET".into());
        }
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Outcome {
    Ready,
    Handled,
    Enter,
    Empty,
    Failed,
    Superseded,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Receipt {
    pub ticket: String,
    pub request_id: String,
    pub outcome: Outcome,
    pub row_count: u8,
    pub duration_ms: u32,
}
impl Receipt {
    pub(super) fn validate(&self, operation: Operation) -> Result<(), String> {
        if self.row_count > 20
            || self.duration_ms > 86_400_000
            || (self.row_count != 0 && operation != Operation::Query)
            || !matches!(
                (operation, self.outcome),
                (_, Outcome::Failed | Outcome::Superseded)
                    | (Operation::Prepare, Outcome::Ready)
                    | (Operation::Query, Outcome::Handled | Outcome::Empty)
                    | (Operation::Select, Outcome::Handled | Outcome::Enter)
            )
        {
            return Err("ERR_MAIN_PUSH_RECEIPT_INVALID".into());
        }
        Ok(())
    }
}
