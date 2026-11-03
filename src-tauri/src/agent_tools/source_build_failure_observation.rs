//! Private TaskRun projection for bounded source-build runner diagnostics.
use atools_core::task_run::{Artifact, ArtifactKind, TaskIssue, TaskRun};
use serde_json::{json, Map, Value};

use crate::plugin_source_build::failure::{RunnerFailure, MAX_CAPTURED_RUNNER_LOG_BYTES};

const LOG_FIELD: &str = "capturedRunnerLog";
const ISSUE_CODE: &str = "source_build_runner_failed";
const MESSAGE: &str = "Source build runner failed; see the TaskRun log artifact.";

pub(in crate::agent_tools) fn attach_to_run(
    run: &mut TaskRun,
    failure: &RunnerFailure,
) -> TaskIssue {
    let artifact_id = artifact_id(&run.id);
    let artifact_uri = format!("atools://task-runs/{}/output", run.id);
    let (log_text, stored_bytes) = bounded_log_text(&failure.captured_log);

    let mut output = match std::mem::replace(&mut run.output, Value::Null) {
        Value::Object(fields) => fields,
        Value::Null => Map::new(),
        previous => Map::from_iter([("priorOutput".to_owned(), previous)]),
    };
    // This tool has no success-output field with this name. If a prior or
    // partial output nevertheless used it, preserve the complete object under
    // one bounded wrapper before installing the artifact's authoritative log.
    if output.contains_key(LOG_FIELD) {
        output = Map::from_iter([("priorOutput".to_owned(), Value::Object(output))]);
    }
    output.insert(LOG_FIELD.to_owned(), Value::String(log_text));
    run.output = Value::Object(output);

    // Logs are untrusted user-viewable output only; no executor decision reads
    // this field, and the immediate failure observation contains no log bytes.
    run.artifacts.push(Artifact {
        id: artifact_id.clone(),
        kind: ArtifactKind::Log,
        label: "Captured source-build runner log".to_owned(),
        media_type: Some("text/plain; charset=utf-8".to_owned()),
        uri: Some(artifact_uri.clone()),
        path: None,
        size_bytes: Some(stored_bytes as u64),
        metadata: json!({
            "outputField": LOG_FIELD,
            "encoding": "utf-8-lossy",
            "source": "merged_stdout_stderr",
            "untrusted": true
        }),
    });

    TaskIssue {
        code: ISSUE_CODE.to_owned(),
        message: MESSAGE.to_owned(),
        details: details(run, failure, &artifact_id, &artifact_uri, stored_bytes),
        retryable: false,
    }
}

pub(super) fn task_issue(run_id: &str, failure: &RunnerFailure) -> TaskIssue {
    let artifact_id = artifact_id(run_id);
    let artifact_uri = format!("atools://task-runs/{run_id}/output");
    let (_, stored_bytes) = bounded_log_text(&failure.captured_log);
    TaskIssue {
        code: ISSUE_CODE.to_owned(),
        message: MESSAGE.to_owned(),
        details: details_for_values(run_id, failure, &artifact_id, &artifact_uri, stored_bytes),
        retryable: false,
    }
}

pub(super) fn error_observation(run_id: &str, issue: &TaskIssue) -> Value {
    json!({
        "runId": run_id,
        "error": MESSAGE,
        "errorCode": "SOURCE_BUILD_RUNNER_FAILED",
        "errorObservation": {
            "schemaVersion": 1,
            "category": "runtime",
            "retryable": false,
            "message": MESSAGE,
            "diagnostics": issue.details
        }
    })
}

fn details(
    run: &TaskRun,
    failure: &RunnerFailure,
    artifact_id: &str,
    artifact_uri: &str,
    stored_bytes: usize,
) -> Value {
    details_for_values(&run.id, failure, artifact_id, artifact_uri, stored_bytes)
}

fn details_for_values(
    run_id: &str,
    failure: &RunnerFailure,
    artifact_id: &str,
    artifact_uri: &str,
    stored_bytes: usize,
) -> Value {
    json!({
        "schemaVersion": 1,
        "phase": "runner",
        "classification": failure.classification.as_str(),
        "runnerFailureCode": failure.failure_code.map(|code| code.as_str()),
        "runnerExitCode": failure.runner_exit_code,
        "runnerSignal": failure.runner_signal,
        "cleanupConfirmed": failure.cleanup_confirmed,
        "capturedLogBytes": failure.captured_log_bytes(),
        "storedLogBytes": stored_bytes,
        "artifact": {
            "id": artifact_id,
            "uri": artifact_uri,
            "outputField": LOG_FIELD
        },
        "runId": run_id
    })
}

fn artifact_id(run_id: &str) -> String {
    format!("artifact-source-build-log-{run_id}")
}

fn bounded_log_text(bytes: &[u8]) -> (String, usize) {
    let mut text = String::from_utf8_lossy(bytes).into_owned();
    if text.len() > MAX_CAPTURED_RUNNER_LOG_BYTES {
        // `String::truncate` panics when its byte index splits a UTF-8 code
        // point, including the replacement character emitted by lossy decode.
        // Find the safe byte boundary first, then truncate once.
        let mut boundary = MAX_CAPTURED_RUNNER_LOG_BYTES;
        while !text.is_char_boundary(boundary) {
            boundary -= 1;
        }
        text.truncate(boundary);
    }
    let stored_bytes = text.len();
    (text, stored_bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_tools::{
        node_startup_error_observation::AgentExecutionFailure, task_run_pipeline,
    };
    use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
    use serde_json::json;

    fn run() -> TaskRun {
        TaskRun::new(
            crate::plugin_source_build::registry::TOOL,
            TaskRunInitiator::agent("fixture-client"),
            json!({"fixture":true}),
        )
    }

    fn failure(bytes: Vec<u8>) -> RunnerFailure {
        RunnerFailure::observed("SourceBuildProcessFailed", true, Some(7), None, bytes)
    }

    #[test]
    fn failure_persists_log_artifact_without_copying_untrusted_log_into_issue_or_message() {
        let db = atools_core::Database::in_memory().unwrap();
        let mut run = run();
        let id = run.id.clone();
        run.output = json!({"existingOutput":"keep"});
        run.artifacts.push(Artifact {
            id: "prior-artifact".into(),
            kind: ArtifactKind::Json,
            label: "Prior".into(),
            media_type: None,
            uri: None,
            path: None,
            size_bytes: None,
            metadata: json!({}),
        });
        run.transition(TaskRunStatus::Running).unwrap();
        db.upsert_task_run(&run).unwrap();
        let sensitive_fixture = b"/private/user/project SECRET_TOKEN=do-not-project".to_vec();
        let error = AgentExecutionFailure::SourceBuild(
            crate::plugin_source_build::failure::SourceBuildFailure::Runner(failure(
                sensitive_fixture.clone(),
            )),
        );
        task_run_pipeline::finish_execution_failure(&db, &mut run, &error, 17, None).unwrap();
        let observation = error.error_observation(&id);
        let encoded_issue = serde_json::to_string(&run.errors[0]).unwrap();
        let encoded_observation = serde_json::to_string(&observation).unwrap();
        assert!(!encoded_issue.contains("/private/user/project"));
        assert!(!encoded_issue.contains("SECRET_TOKEN"));
        assert!(!encoded_observation.contains("/private/user/project"));
        assert!(!encoded_observation.contains("SECRET_TOKEN"));
        assert_eq!(run.errors[0].message, MESSAGE);
        assert_eq!(run.errors[0].details["phase"], "runner");
        assert_eq!(run.errors[0].details["classification"], "nonzero_exit");
        assert_eq!(
            run.errors[0].details["runnerFailureCode"],
            "SourceBuildProcessFailed"
        );
        assert_eq!(run.errors[0].details["runnerExitCode"], 7);
        assert_eq!(
            run.errors[0].details["capturedLogBytes"],
            sensitive_fixture.len()
        );
        assert_eq!(run.errors[0].details["artifact"]["outputField"], LOG_FIELD);
        let detail_keys = run.errors[0]
            .details
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            detail_keys,
            [
                "artifact",
                "capturedLogBytes",
                "cleanupConfirmed",
                "classification",
                "phase",
                "runId",
                "runnerExitCode",
                "runnerFailureCode",
                "runnerSignal",
                "schemaVersion",
                "storedLogBytes",
            ]
            .into_iter()
            .collect()
        );
        assert_eq!(
            run.errors[0].details["artifact"]
                .as_object()
                .unwrap()
                .keys()
                .map(String::as_str)
                .collect::<std::collections::BTreeSet<_>>(),
            ["id", "outputField", "uri"].into_iter().collect()
        );
        assert_eq!(run.artifacts.len(), 2);
        assert_eq!(run.artifacts[0].id, "prior-artifact");
        assert_eq!(run.artifacts[1].kind, ArtifactKind::Log);
        assert_eq!(run.artifacts[1].metadata["outputField"], LOG_FIELD);

        let persisted = db.get_task_run(&id).unwrap().unwrap();
        assert_eq!(
            persisted.output[LOG_FIELD],
            String::from_utf8_lossy(&sensitive_fixture).as_ref()
        );
        assert_eq!(persisted.output["existingOutput"], "keep");
        assert_eq!(persisted.artifacts.len(), 2);
        assert_eq!(persisted.artifacts[0].id, "prior-artifact");
        assert_eq!(persisted.artifacts[1].id, run.artifacts[1].id);
        assert_eq!(persisted.errors[0].details, run.errors[0].details);
    }

    #[test]
    fn rendered_log_never_exceeds_64k_even_when_lossy_utf8_expands() {
        let bytes = vec![0xff; MAX_CAPTURED_RUNNER_LOG_BYTES];
        let (rendered, stored_bytes) = bounded_log_text(&bytes);
        assert!(stored_bytes <= MAX_CAPTURED_RUNNER_LOG_BYTES);
        assert_eq!(stored_bytes, rendered.len());
        assert!(rendered.is_char_boundary(rendered.len()));
        assert_eq!(stored_bytes, MAX_CAPTURED_RUNNER_LOG_BYTES - 1);
    }

    #[test]
    fn multibyte_character_straddling_the_limit_is_removed_before_truncate() {
        let mut bytes = vec![b'x'; MAX_CAPTURED_RUNNER_LOG_BYTES - 1];
        bytes.extend_from_slice("é".as_bytes());

        let (rendered, stored_bytes) = bounded_log_text(&bytes);
        assert_eq!(stored_bytes, MAX_CAPTURED_RUNNER_LOG_BYTES - 1);
        assert_eq!(rendered.len(), stored_bytes);
        assert!(rendered.is_char_boundary(rendered.len()));
    }

    #[test]
    fn valid_utf8_log_keeps_the_exact_64k_boundary_and_truncates_only_overflow() {
        let exact = vec![b'x'; MAX_CAPTURED_RUNNER_LOG_BYTES];
        let (exact_text, exact_size) = bounded_log_text(&exact);
        assert_eq!(exact_size, MAX_CAPTURED_RUNNER_LOG_BYTES);
        assert_eq!(exact_text.len(), MAX_CAPTURED_RUNNER_LOG_BYTES);

        let over = vec![b'x'; MAX_CAPTURED_RUNNER_LOG_BYTES + 1];
        let (over_text, over_size) = bounded_log_text(&over);
        assert_eq!(over_size, MAX_CAPTURED_RUNNER_LOG_BYTES);
        assert_eq!(over_text.len(), MAX_CAPTURED_RUNNER_LOG_BYTES);
    }

    #[test]
    fn unicode_codepoint_ending_exactly_at_limit_is_kept_intact() {
        let mut bytes = vec![b'x'; MAX_CAPTURED_RUNNER_LOG_BYTES - 2];
        bytes.extend_from_slice("é".as_bytes());

        let (rendered, stored_bytes) = bounded_log_text(&bytes);
        assert_eq!(stored_bytes, MAX_CAPTURED_RUNNER_LOG_BYTES);
        assert_eq!(rendered.len(), stored_bytes);
        assert!(rendered.ends_with('é'));
        assert!(rendered.is_char_boundary(rendered.len()));
    }

    #[test]
    fn projection_appends_without_replacing_existing_run_output_or_artifacts() {
        let mut run = run();
        run.output = json!({"existing":"keep"});
        run.artifacts.push(Artifact {
            id: "prior-artifact".into(),
            kind: ArtifactKind::Json,
            label: "Prior".into(),
            media_type: None,
            uri: None,
            path: None,
            size_bytes: None,
            metadata: json!({}),
        });
        let issue = attach_to_run(&mut run, &failure(b"short log".to_vec()));
        assert_eq!(run.output["existing"], "keep");
        assert_eq!(run.output[LOG_FIELD], "short log");
        assert_eq!(run.artifacts.len(), 2);
        assert_eq!(run.artifacts[0].id, "prior-artifact");
        assert_eq!(issue.details["artifact"]["id"], run.artifacts[1].id);
    }

    #[test]
    fn reserved_log_field_collision_preserves_prior_value_and_points_to_new_log() {
        let mut run = run();
        run.output = json!({"capturedRunnerLog":"prior partial output", "keep":true});
        let issue = attach_to_run(&mut run, &failure(b"current runner log".to_vec()));

        assert_eq!(run.output["priorOutput"][LOG_FIELD], "prior partial output");
        assert_eq!(run.output["priorOutput"]["keep"], true);
        assert_eq!(run.output[LOG_FIELD], "current runner log");
        assert_eq!(issue.details["artifact"]["outputField"], LOG_FIELD);
        assert_eq!(run.artifacts[0].metadata["outputField"], LOG_FIELD);
    }
}
