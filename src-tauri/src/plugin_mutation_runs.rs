//! Durable audit records for mutations initiated by the local plugin UI.
//!
//! These runs describe package metadata and filesystem persistence only. They
//! do not claim that plugin business behavior was exercised or accepted.
use atools_core::{
    db::Database,
    task_run::{
        Artifact, ArtifactKind, TaskIssue, TaskRun, TaskRunInitiator, TaskRunStatus,
        TaskValidationStatus,
    },
};
use serde_json::json;
use std::sync::Arc;

const INITIATOR: &str = "atools-ui";

#[derive(Debug, Clone, Copy)]
pub(crate) enum Outcome {
    Success { changed: bool },
    Failure,
}

pub(crate) struct MutationRun {
    db: Arc<Database>,
    run: Option<TaskRun>,
}

impl MutationRun {
    /// Persist a human-initiated plugin mutation before it starts.
    /// Only the stable plugin ID and a short operation label enter TaskRun.
    pub(crate) fn start(
        db: Arc<Database>,
        plugin_id: &str,
        operation: &str,
    ) -> Result<Self, String> {
        validate_metadata(plugin_id, operation)?;

        let mut run = TaskRun::new(
            format!("atools-ui.plugin.{operation}"),
            TaskRunInitiator::human(Some(INITIATOR.to_owned())),
            json!({ "pluginId": plugin_id, "operation": operation }),
        );
        run.transition(TaskRunStatus::Running)
            .map_err(|error| error.to_string())?;
        db.upsert_task_run(&run)
            .map_err(|error| format!("Could not persist plugin mutation run: {error}"))?;

        Ok(Self { db, run: Some(run) })
    }

    pub(crate) fn id(&self) -> &str {
        self.run
            .as_ref()
            .expect("active mutation run has a TaskRun")
            .id
            .as_str()
    }

    /// Persist the first terminal result. Database CAS prevents an earlier
    /// cancellation or other terminal state from being overwritten.
    pub(crate) fn finish(mut self, outcome: Outcome) -> Result<(), String> {
        let mut run = self.run.take().expect("mutation run finishes once");
        match outcome {
            Outcome::Success { changed: true } => {
                let evidence = json!({
                    "changed": true,
                    "verification": "plugin metadata and files persisted",
                    "businessRuntimeVerified": false
                });
                run.output = evidence.clone();
                run.artifacts.push(Artifact {
                    id: format!("artifact-{}", run.id),
                    kind: ArtifactKind::Json,
                    label: "Plugin mutation persistence result".into(),
                    media_type: Some("application/json".into()),
                    uri: None,
                    path: None,
                    size_bytes: None,
                    metadata: evidence,
                });
                run.summary = Some(
                    "Plugin metadata and files persisted; business runtime not verified".into(),
                );
                run.validation.status = TaskValidationStatus::Passed;
                run.validation.summary = Some("Metadata and files persisted".into());
                run.transition(TaskRunStatus::Succeeded)
                    .map_err(|error| error.to_string())?;
            }
            Outcome::Success { changed: false } => {
                run.output = json!({ "changed": false });
                run.summary = Some("Plugin mutation made no changes".into());
                run.transition(TaskRunStatus::Cancelled)
                    .map_err(|error| error.to_string())?;
            }
            Outcome::Failure => {
                run.summary = Some("Plugin mutation failed".into());
                run.errors.push(TaskIssue::error(
                    "plugin_mutation_failed",
                    "Plugin mutation failed",
                ));
                run.validation.status = TaskValidationStatus::Failed;
                run.validation.summary = Some("Plugin metadata or files were not confirmed".into());
                run.transition(TaskRunStatus::Failed)
                    .map_err(|error| error.to_string())?;
            }
        }

        self.db
            .finish_running_task_run(&run)
            .map(|_| ())
            .map_err(|error| format!("Could not persist plugin mutation result: {error}"))
    }
}

impl Drop for MutationRun {
    fn drop(&mut self) {
        let Some(mut run) = self.run.take() else {
            return;
        };
        run.summary = Some("Plugin mutation was interrupted".into());
        run.errors.push(TaskIssue::error(
            "plugin_mutation_interrupted",
            "Plugin mutation was interrupted",
        ));
        let transitioned = run.transition(TaskRunStatus::Failed).is_ok();
        if transitioned {
            if let Err(error) = self.db.finish_running_task_run(&run) {
                tracing::warn!("Could not persist interrupted plugin mutation run: {error}");
            }
        }
    }
}

fn validate_metadata(plugin_id: &str, operation: &str) -> Result<(), String> {
    let valid_plugin_id = !plugin_id.is_empty()
        && plugin_id.len() <= 256
        && plugin_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte));
    let valid_operation = matches!(
        operation,
        "install"
            | "update"
            | "uninstall"
            | "import"
            | "enable"
            | "disable"
            | "market_install"
            | "market_update"
    );
    if !valid_plugin_id || !valid_operation {
        return Err("Invalid plugin mutation metadata".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "plugin_mutation_runs_tests.rs"]
mod tests;
