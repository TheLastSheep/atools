//! Typed handoff for a failed legacy Node startup without parsing display text.
use std::fmt;

#[derive(Debug)]
pub(crate) enum LegacyRuntimeError {
    Message(String),
    #[cfg(feature = "legacy-node-smoke")]
    Startup(NodeStartupFailure),
}

#[cfg(feature = "legacy-node-smoke")]
pub(crate) struct NodeStartupFailure {
    pub failure: atools_plugin::sidecar::StartupFailureKind,
    pub diagnostic: atools_plugin::sidecar::StartupFailureDiagnostic,
    pub task_run_id: String,
    pub owner: String,
    pub plugin_id: String,
    pub attempt: super::native_node_startup_fixture::StartupAttemptGuard,
}

#[cfg(feature = "legacy-node-smoke")]
impl fmt::Debug for NodeStartupFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NodeStartupFailure")
            .field("failure", &self.failure)
            .field("task_run_id", &self.task_run_id)
            .field("plugin_id", &self.plugin_id)
            .finish_non_exhaustive()
    }
}

impl LegacyRuntimeError {
    pub(crate) fn safe_message(&self) -> &str {
        match self {
            Self::Message(message) => message,
            #[cfg(feature = "legacy-node-smoke")]
            Self::Startup(_) => "Node sidecar startup failed",
        }
    }

    #[cfg(test)]
    pub(crate) fn contains(&self, needle: &str) -> bool {
        self.safe_message().contains(needle)
    }
}

impl fmt::Display for LegacyRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.safe_message())
    }
}

impl From<String> for LegacyRuntimeError {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<&'static str> for LegacyRuntimeError {
    fn from(message: &'static str) -> Self {
        Self::Message(message.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(feature = "legacy-node-smoke")]
    use atools_plugin::sidecar::{
        StartupDiagnosticSnapshot, StartupFailureDiagnostic, StartupFailureKind,
        StartupProcessStatus, StartupTryWait, StartupVersionSource,
    };

    #[test]
    fn regular_errors_preserve_existing_message() {
        let error = LegacyRuntimeError::from("ordinary failure".to_owned());
        assert_eq!(error.safe_message(), "ordinary failure");
    }

    #[cfg(feature = "legacy-node-smoke")]
    #[test]
    fn diagnostic_error_display_never_exposes_serialized_private_details() {
        let owner = format!("window:main:{}", uuid::Uuid::new_v4());
        let fixture = std::sync::Arc::new(
            super::super::native_node_startup_fixture::NativeNodeStartupFixture::new(
                &serde_json::json!({"caseId":"local-plain-text","id":"plain-text","runtime":"node"}),
                &uuid::Uuid::new_v4().to_string(),
                true,
                false,
            ),
        );
        let attempt = fixture
            .permit("plain-text", &owner)
            .unwrap()
            .begin_attempt();
        let error = LegacyRuntimeError::Startup(NodeStartupFailure {
            failure: StartupFailureKind::InitializeResponse,
            diagnostic: StartupFailureDiagnostic {
                schema_version: 1,
                failure: StartupFailureKind::InitializeResponse,
                snapshot: StartupDiagnosticSnapshot {
                    schema_version: 1,
                    elapsed_ms: 1500,
                    events: Vec::new(),
                    resolution_source: None,
                    selected_executable_path_sha256: None,
                    node_version: None,
                    node_version_source: StartupVersionSource::Unavailable,
                    owned_pid: Some(123),
                    sidecar_status: StartupProcessStatus::Running,
                    last_try_wait: StartupTryWait::Running,
                    last_try_wait_elapsed_ms: Some(1500),
                    stderr_bytes: 0,
                    stderr_hashed_bytes: 0,
                    stderr_sha256: None,
                    stderr_truncated: false,
                    stdout_read: Default::default(),
                    cleanup_required: true,
                    cleanup_completed: Some(true),
                },
            },
            task_run_id: uuid::Uuid::new_v4().to_string(),
            owner,
            plugin_id: "plain-text".into(),
            attempt,
        });
        assert_eq!(error.to_string(), "Node sidecar startup failed");
        assert!(!error.to_string().contains("plain-text"));
        assert!(!error.to_string().contains("123"));
    }
}
