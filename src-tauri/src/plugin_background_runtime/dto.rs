//! Small durable identity only. Actions, paths, bearer data and preload bytes
//! remain native-memory state and never enter TaskRun input or output.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Operation {
    Start,
    Stop,
}

impl Operation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Request {
    pub request_id: String,
    pub session_id: String,
    pub plugin_id: String,
    pub code_revision: String,
    pub operation: Operation,
}

impl Request {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let object = value.as_object().ok_or("ERR_PLUGIN_BACKGROUND_INPUT")?;
        const KEYS: [&str; 5] = [
            "requestId",
            "sessionId",
            "pluginId",
            "codeRevision",
            "operation",
        ];
        if object.len() != KEYS.len() || object.keys().any(|key| !KEYS.contains(&key.as_str())) {
            return Err("ERR_PLUGIN_BACKGROUND_PRIVATE_METADATA_ONLY".into());
        }
        let request: Self =
            serde_json::from_value(value.clone()).map_err(|_| "ERR_PLUGIN_BACKGROUND_INPUT")?;
        request.validate()?;
        Ok(request)
    }

    pub fn validate(&self) -> Result<(), String> {
        for value in [&self.request_id, &self.session_id] {
            let id = uuid::Uuid::parse_str(value).map_err(|_| "ERR_PLUGIN_BACKGROUND_INPUT")?;
            if id.to_string() != *value {
                return Err("ERR_PLUGIN_BACKGROUND_INPUT".into());
            }
        }
        if self.plugin_id.trim().is_empty()
            || self.plugin_id.len() > 256
            || self.plugin_id.trim() != self.plugin_id
            || self.plugin_id.chars().any(char::is_control)
            || self.code_revision.len() != 64
            || !self
                .code_revision
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("ERR_PLUGIN_BACKGROUND_INPUT".into());
        }
        Ok(())
    }

    pub fn to_value(&self) -> Value {
        serde_json::to_value(self).expect("background request has a JSON representation")
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Outcome {
    Ready,
    Closed,
    Failed,
}

impl Outcome {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "ready" => Ok(Self::Ready),
            "closed" => Ok(Self::Closed),
            "failed" => Ok(Self::Failed),
            _ => Err("ERR_PLUGIN_BACKGROUND_RECEIPT".into()),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ready => "ready",
            Self::Closed => "closed",
            Self::Failed => "failed",
        }
    }

    pub fn valid_for(self, operation: Operation) -> bool {
        match operation {
            Operation::Start => matches!(self, Self::Ready | Self::Failed),
            Operation::Stop => matches!(self, Self::Closed | Self::Failed),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Receipt {
    pub request_id: String,
    pub ticket: String,
    pub session_id: String,
    pub outcome: Outcome,
}

impl Receipt {
    pub fn validate(&self, request: &Request, ticket: &str) -> Result<(), String> {
        if self.request_id != request.request_id
            || self.session_id != request.session_id
            || self.ticket != ticket
            || !self.outcome.valid_for(request.operation)
        {
            return Err("ERR_PLUGIN_BACKGROUND_RECEIPT_OWNER".into());
        }
        Ok(())
    }
}
