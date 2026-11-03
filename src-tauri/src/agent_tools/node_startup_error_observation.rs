//! Redacted TaskRun/errorObservation projection for typed Node startup failures.
use atools_core::task_run::TaskIssue;
use serde_json::{json, Value};

#[path = "source_build_failure_observation.rs"]
pub(super) mod source_build_failure_observation;

#[derive(Debug)]
pub(crate) enum AgentExecutionFailure {
    Message(String),
    SourceBuild(crate::plugin_source_build::SourceBuildFailure),
    #[cfg(feature = "legacy-node-smoke")]
    NodeStartup(crate::legacy_runtime::node_startup_diagnostic::NodeStartupFailure),
}

impl AgentExecutionFailure {
    pub(crate) fn safe_message(&self) -> &str {
        match self {
            Self::Message(message) => message,
            Self::SourceBuild(failure) => failure.safe_message(),
            #[cfg(feature = "legacy-node-smoke")]
            Self::NodeStartup(_) => "Node sidecar startup failed",
        }
    }

    pub(crate) fn task_issue(&self, _current_run_id: &str) -> TaskIssue {
        if let Self::SourceBuild(crate::plugin_source_build::SourceBuildFailure::Runner(failure)) =
            self
        {
            return source_build_failure_observation::task_issue(_current_run_id, failure);
        }
        #[cfg(feature = "legacy-node-smoke")]
        if let Self::NodeStartup(failure) = self {
            if crate::legacy_runtime::native_node_startup_fixture::is_task_run_id(_current_run_id)
                && failure.task_run_id == _current_run_id
                && valid_owner(&failure.owner)
                && failure.owner == failure.attempt.owner()
                && failure.plugin_id == failure.attempt.plugin_id()
                && failure.diagnostic.failure == failure.failure
            {
                let retryable = is_timeout(failure.failure)
                    && failure.diagnostic.snapshot.cleanup_required
                    && failure.diagnostic.snapshot.cleanup_completed == Some(true);
                return TaskIssue {
                    code: if is_timeout(failure.failure) {
                        "node_sidecar_startup_timeout"
                    } else {
                        "node_sidecar_startup_failed"
                    }
                    .into(),
                    message: "Node sidecar startup failed".into(),
                    details: json!({
                        "schemaVersion": 1,
                        "runId": _current_run_id,
                        "owner": failure.owner,
                        "pluginId": failure.plugin_id,
                        "failure": failure.failure,
                        "diagnostic": failure.diagnostic,
                    }),
                    retryable,
                };
            }
            failure.attempt.mark_incomplete();
        }
        TaskIssue::error("execution_failed", self.safe_message())
    }

    pub(crate) fn error_observation(&self, _current_run_id: &str) -> Value {
        if let Self::SourceBuild(crate::plugin_source_build::SourceBuildFailure::Runner(failure)) =
            self
        {
            let issue = source_build_failure_observation::task_issue(_current_run_id, failure);
            return source_build_failure_observation::error_observation(_current_run_id, &issue);
        }
        #[cfg(feature = "legacy-node-smoke")]
        if let Self::NodeStartup(failure) = self {
            let issue = self.task_issue(_current_run_id);
            if issue.code != "execution_failed" {
                let timeout = is_timeout(failure.failure);
                let stage = startup_stage(failure.failure);
                let observation = json!({
                    "runId": _current_run_id,
                    "error": issue.message,
                    "errorCode": if timeout { "NODE_SIDECAR_STARTUP_TIMEOUT" } else { "NODE_SIDECAR_STARTUP_FAILED" },
                    "errorObservation": {
                        "schemaVersion": 1,
                        "category": "runtime",
                        "retryable": issue.retryable,
                        "message": issue.message,
                        "whyFailed": stage,
                        "diagnostics": issue.details,
                    }
                });
                let _ = failure
                    .attempt
                    .record_failure(_current_run_id, &issue, &observation);
                return observation;
            }
        }
        json!({ "error": self.safe_message() })
    }
}

impl From<String> for AgentExecutionFailure {
    fn from(message: String) -> Self {
        Self::Message(message)
    }
}

impl From<crate::plugin_source_build::SourceBuildFailure> for AgentExecutionFailure {
    fn from(failure: crate::plugin_source_build::SourceBuildFailure) -> Self {
        Self::SourceBuild(failure)
    }
}

impl From<&'static str> for AgentExecutionFailure {
    fn from(message: &'static str) -> Self {
        Self::Message(message.to_owned())
    }
}

impl From<crate::legacy_runtime::node_startup_diagnostic::LegacyRuntimeError>
    for AgentExecutionFailure
{
    fn from(error: crate::legacy_runtime::node_startup_diagnostic::LegacyRuntimeError) -> Self {
        match error {
            crate::legacy_runtime::node_startup_diagnostic::LegacyRuntimeError::Message(
                message,
            ) => Self::Message(message),
            #[cfg(feature = "legacy-node-smoke")]
            crate::legacy_runtime::node_startup_diagnostic::LegacyRuntimeError::Startup(
                failure,
            ) => Self::NodeStartup(failure),
        }
    }
}

#[cfg(feature = "legacy-node-smoke")]
fn is_timeout(failure: atools_plugin::sidecar::StartupFailureKind) -> bool {
    matches!(
        failure,
        atools_plugin::sidecar::StartupFailureKind::WaitUntilRunning
            | atools_plugin::sidecar::StartupFailureKind::InitializeResponse
    )
}

#[cfg(feature = "legacy-node-smoke")]
fn startup_stage(failure: atools_plugin::sidecar::StartupFailureKind) -> &'static str {
    use atools_plugin::sidecar::StartupFailureKind::*;
    match failure {
        NodeResolve => "The Node runtime could not be resolved.",
        NodeSpawn => "The Node sidecar did not spawn.",
        WaitUntilRunning => "The sidecar did not reach running before the startup deadline.",
        InitializeWrite => "The initialize request write failed.",
        InitializeResponse => {
            "No matching initialize response was observed before the startup deadline."
        }
        StartupProtocol => "The sidecar startup protocol failed.",
        StartupCrashed => "The sidecar exited during startup.",
    }
}

#[cfg(feature = "legacy-node-smoke")]
fn valid_owner(owner: &str) -> bool {
    let mut parts = owner.split(':');
    matches!(
        (parts.next(), parts.next(), parts.next(), parts.next()),
        (Some("window"), Some("main"), Some(instance), None)
            if uuid::Uuid::parse_str(instance).is_ok()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_failures_keep_the_existing_error_contract() {
        let error = AgentExecutionFailure::from("ordinary error".to_owned());
        assert_eq!(error.safe_message(), "ordinary error");
        assert_eq!(
            error.error_observation("run"),
            json!({"error":"ordinary error"})
        );
    }

    #[cfg(feature = "legacy-node-smoke")]
    #[test]
    fn startup_observation_requires_exact_run_and_redacts_typed_diagnostic() {
        use atools_plugin::sidecar::{
            StartupDiagnosticSnapshot, StartupFailureDiagnostic, StartupFailureKind,
            StartupProcessStatus, StartupResolutionSource, StartupTryWait, StartupVersionSource,
        };
        let mut run = crate::agent_tools::new_task_run(
            "atools-ui",
            "plugin.plain-text.legacy_node",
            json!({"operation":"open"}),
        );
        let run_id = run.id.clone();
        assert!(run_id.starts_with("run-"));
        let owner = format!("window:main:{}", uuid::Uuid::new_v4());
        let fixture = std::sync::Arc::new(
            crate::legacy_runtime::native_node_startup_fixture::NativeNodeStartupFixture::new(
                &json!({"caseId":"local-plain-text","id":"plain-text","runtime":"node"}),
                &uuid::Uuid::new_v4().to_string(),
                true,
                false,
            ),
        );
        let attempt = fixture
            .permit("plain-text", &owner)
            .unwrap()
            .begin_attempt();
        let failure = AgentExecutionFailure::NodeStartup(
            crate::legacy_runtime::node_startup_diagnostic::NodeStartupFailure {
                failure: StartupFailureKind::InitializeResponse,
                diagnostic: StartupFailureDiagnostic {
                    schema_version: 1,
                    failure: StartupFailureKind::InitializeResponse,
                    snapshot: StartupDiagnosticSnapshot {
                        schema_version: 1,
                        elapsed_ms: 1500,
                        events: Vec::new(),
                        resolution_source: Some(StartupResolutionSource::SharedProductionResolver),
                        selected_executable_path_sha256: None,
                        node_version: None,
                        node_version_source: StartupVersionSource::Unavailable,
                        owned_pid: Some(1234),
                        sidecar_status: StartupProcessStatus::Running,
                        last_try_wait: StartupTryWait::Running,
                        last_try_wait_elapsed_ms: Some(1490),
                        stderr_bytes: 16,
                        stderr_hashed_bytes: 16,
                        stderr_sha256: Some("a".repeat(64)),
                        stderr_truncated: false,
                        stdout_read: Default::default(),
                        cleanup_required: true,
                        cleanup_completed: Some(true),
                    },
                },
                task_run_id: run_id.clone(),
                owner,
                plugin_id: "plain-text".into(),
                attempt,
            },
        );
        let issue = failure.task_issue(&run_id);
        assert_eq!(issue.code, "node_sidecar_startup_timeout");
        assert!(issue.retryable);
        assert_eq!(issue.details["runId"], run_id);
        let observation = failure.error_observation(&run_id);
        let encoded = serde_json::to_string(&observation).unwrap();
        assert!(encoded.contains("NODE_SIDECAR_STARTUP_TIMEOUT"));
        assert!(!encoded.contains("raw stderr"));
        let db = atools_core::Database::in_memory().unwrap();
        run.transition(atools_core::task_run::TaskRunStatus::Running)
            .unwrap();
        db.upsert_task_run(&run).unwrap();
        super::super::task_run_pipeline::finish_execution_failure(
            &db, &mut run, &failure, 1500, None,
        )
        .unwrap();
        let response = super::super::task_run_error(&run, observation);
        let persisted = db.get_task_run(&run.id).unwrap().unwrap();
        assert_eq!(persisted.id, run_id);
        assert_eq!(persisted.errors[0].details, issue.details);
        assert_eq!(persisted.errors[0].details["runId"], run_id);
        assert_eq!(
            response.structured_content["errorObservation"]["diagnostics"],
            persisted.errors[0].details
        );
        assert_eq!(response.structured_content["runId"], run_id);
        let report = fixture.report(&db).unwrap();
        assert_eq!(report["associationVerified"], true);
    }

    #[cfg(feature = "legacy-node-smoke")]
    #[test]
    fn rejected_mismatched_startup_failure_invalidates_prior_success_capture() {
        use atools_core::task_run::{TaskRunStatus, TaskValidationStatus};
        use atools_plugin::sidecar::{
            StartupDiagnosticSnapshot, StartupFailureDiagnostic, StartupFailureKind,
            StartupProcessStatus, StartupTryWait, StartupVersionSource,
        };
        let mut run = crate::agent_tools::new_task_run(
            "atools-ui",
            "plugin.plain-text.legacy_node",
            json!({"operation":"open"}),
        );
        let run_id = run.id.clone();
        assert!(run_id.starts_with("run-"));
        let owner = format!("window:main:{}", uuid::Uuid::new_v4());
        let fixture = std::sync::Arc::new(
            crate::legacy_runtime::native_node_startup_fixture::NativeNodeStartupFixture::new(
                &json!({"caseId":"local-plain-text","id":"plain-text","runtime":"node"}),
                &uuid::Uuid::new_v4().to_string(),
                true,
                false,
            ),
        );
        let attempt = fixture
            .permit("plain-text", &owner)
            .unwrap()
            .begin_attempt();
        let snapshot = StartupDiagnosticSnapshot {
            schema_version: 1,
            elapsed_ms: 10,
            events: Vec::new(),
            resolution_source: None,
            selected_executable_path_sha256: None,
            node_version: Some("22.0.0".into()),
            node_version_source: StartupVersionSource::InitializeResponse,
            owned_pid: Some(2345),
            sidecar_status: StartupProcessStatus::Running,
            last_try_wait: StartupTryWait::Running,
            last_try_wait_elapsed_ms: Some(9),
            stderr_bytes: 0,
            stderr_hashed_bytes: 0,
            stderr_sha256: None,
            stderr_truncated: false,
            stdout_read: Default::default(),
            cleanup_required: false,
            cleanup_completed: None,
        };
        assert!(attempt.record_success(&run_id, &snapshot));

        let db = atools_core::Database::in_memory().unwrap();
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(TaskRunStatus::Succeeded).unwrap();
        run.validation.status = TaskValidationStatus::Passed;
        db.upsert_task_run(&run).unwrap();
        assert_eq!(fixture.report(&db).unwrap()["associationVerified"], true);

        let mismatch = AgentExecutionFailure::NodeStartup(
            crate::legacy_runtime::node_startup_diagnostic::NodeStartupFailure {
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
                        owned_pid: Some(2346),
                        sidecar_status: StartupProcessStatus::Running,
                        last_try_wait: StartupTryWait::Running,
                        last_try_wait_elapsed_ms: Some(1499),
                        stderr_bytes: 0,
                        stderr_hashed_bytes: 0,
                        stderr_sha256: None,
                        stderr_truncated: false,
                        stdout_read: Default::default(),
                        cleanup_required: true,
                        cleanup_completed: Some(true),
                    },
                },
                task_run_id: run_id.clone(),
                owner: format!("window:main:{}", uuid::Uuid::new_v4()),
                plugin_id: "plain-text".into(),
                attempt,
            },
        );
        assert_eq!(
            mismatch.task_issue("different-run").code,
            "execution_failed"
        );
        assert_eq!(mismatch.task_issue(&run_id).code, "execution_failed");
        let report = fixture.report(&db).unwrap();
        assert_eq!(report["captureComplete"], false);
        assert_eq!(report["associationVerified"], false);
    }
}
