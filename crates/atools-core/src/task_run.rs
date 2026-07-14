use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

use crate::utils::{generate_rev, now_iso};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunInitiatorType {
    Human,
    Agent,
    Automation,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunInitiator {
    #[serde(rename = "type")]
    pub kind: TaskRunInitiatorType,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

impl TaskRunInitiator {
    pub fn agent(client_id: impl Into<String>) -> Self {
        Self {
            kind: TaskRunInitiatorType::Agent,
            client_id: Some(client_id.into()),
        }
    }

    pub fn human(client_id: Option<String>) -> Self {
        Self {
            kind: TaskRunInitiatorType::Human,
            client_id,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskRunStatus {
    Created,
    AwaitingPermission,
    Running,
    Partial,
    Succeeded,
    Failed,
    Cancelled,
}

impl TaskRunStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::AwaitingPermission => "awaiting_permission",
            Self::Running => "running",
            Self::Partial => "partial",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_storage(value: &str) -> Self {
        match value {
            "awaiting_permission" => Self::AwaitingPermission,
            "running" => Self::Running,
            "partial" => Self::Partial,
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Created,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Partial | Self::Succeeded | Self::Failed | Self::Cancelled
        )
    }

    pub fn can_transition_to(self, next: Self) -> bool {
        if self == next {
            return true;
        }
        match self {
            Self::Created => matches!(
                next,
                Self::AwaitingPermission | Self::Running | Self::Failed | Self::Cancelled
            ),
            Self::AwaitingPermission => matches!(next, Self::Running | Self::Cancelled),
            Self::Running => matches!(
                next,
                Self::Partial | Self::Succeeded | Self::Failed | Self::Cancelled
            ),
            Self::Partial | Self::Failed => next == Self::Running,
            Self::Succeeded | Self::Cancelled => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidTaskRunTransition {
    pub from: TaskRunStatus,
    pub to: TaskRunStatus,
}

impl fmt::Display for InvalidTaskRunTransition {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "invalid TaskRun transition from {} to {}",
            self.from.as_str(),
            self.to.as_str()
        )
    }
}

impl std::error::Error for InvalidTaskRunTransition {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactKind {
    File,
    Directory,
    Image,
    Screenshot,
    Markdown,
    RichText,
    Table,
    Csv,
    Json,
    Diff,
    Url,
    Report,
    Log,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub kind: ArtifactKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uri: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskIssue {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Value,
    #[serde(default)]
    pub retryable: bool,
}

impl TaskIssue {
    pub fn error(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: Value::Null,
            retryable: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultAction {
    pub id: String,
    pub label: String,
    pub capability_id: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub requires_confirmation: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskValidationStatus {
    NotRun,
    Passed,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskValidation {
    pub status: TaskValidationStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl Default for TaskValidation {
    fn default() -> Self {
        Self {
            status: TaskValidationStatus::NotRun,
            summary: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub id: String,
    pub capability_id: String,
    pub initiator: TaskRunInitiator,
    pub status: TaskRunStatus,
    pub input: Value,
    #[serde(default)]
    pub output: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(default)]
    pub artifacts: Vec<Artifact>,
    #[serde(default)]
    pub warnings: Vec<TaskIssue>,
    #[serde(default)]
    pub errors: Vec<TaskIssue>,
    #[serde(default)]
    pub actions: Vec<ResultAction>,
    #[serde(default)]
    pub memory_ids: Vec<String>,
    #[serde(default)]
    pub metrics: Value,
    #[serde(default)]
    pub validation: TaskValidation,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audit_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_of: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
}

impl TaskRun {
    pub fn new(
        capability_id: impl Into<String>,
        initiator: TaskRunInitiator,
        input: Value,
    ) -> Self {
        let now = now_iso();
        Self {
            id: format!("run-{}", generate_rev()),
            capability_id: capability_id.into(),
            initiator,
            status: TaskRunStatus::Created,
            input,
            output: Value::Null,
            summary: None,
            progress: Some(0),
            artifacts: Vec::new(),
            warnings: Vec::new(),
            errors: Vec::new(),
            actions: Vec::new(),
            memory_ids: Vec::new(),
            metrics: Value::Null,
            validation: TaskValidation::default(),
            audit_id: None,
            retry_of: None,
            created_at: now.clone(),
            updated_at: now,
            started_at: None,
            finished_at: None,
        }
    }

    pub fn transition(&mut self, status: TaskRunStatus) -> Result<(), InvalidTaskRunTransition> {
        if !self.status.can_transition_to(status) {
            return Err(InvalidTaskRunTransition {
                from: self.status,
                to: status,
            });
        }
        if self.status == status {
            return Ok(());
        }
        let now = now_iso();
        self.status = status;
        self.updated_at = now.clone();
        if status == TaskRunStatus::Running && self.started_at.is_none() {
            self.started_at = Some(now.clone());
        }
        if status == TaskRunStatus::Running {
            self.finished_at = None;
            self.progress = Some(0);
        }
        if status.is_terminal() {
            self.finished_at = Some(now);
            self.progress = Some(100);
        }
        Ok(())
    }
}
