//! Retains only the validated, bounded runner log for the real-package smoke profile.
use atools_core::task_run::{ArtifactKind, TaskRun, TaskRunStatus};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::Path,
};

const PROFILE: &str = "application-uninstaller";
const TOOL: &str = "convert_ztools_plugin";
const LOG_FIELD: &str = "capturedRunnerLog";
const ISSUE_CODE: &str = "source_build_runner_failed";
const ARTIFACT_PREFIX: &str = "artifact-source-build-log-";
const RESOURCE_PREFIX: &str = "atools://task-runs/";
const EVIDENCE_FILE: &str = "source-build-runner.log";
const MAX_LOG_BYTES: usize = 64 * 1024;

/// Finds the single failed UI conversion for this fixture and writes only its
/// exact producer-validated log to a fixed, create-new sidecar.
pub(super) fn retain_failed_runner_log(
    runs: &[TaskRun],
    run_inventory_complete: bool,
    profile: &str,
    source_path: &Path,
    fixture_root: &Path,
    sidecar_path: &Path,
) -> Value {
    if profile != PROFILE {
        return json!({"status":"not_applicable"});
    }
    if !run_inventory_complete {
        return status("task_run_inventory_incomplete");
    }
    let Some(source) = source_path.to_str() else {
        return status("source_identity_unavailable");
    };
    let candidates = runs
        .iter()
        .filter(|run| {
            run.capability_id == TOOL
                && run.initiator.client_id.as_deref() == Some("atools-ui")
                && run.input.get("sourcePath").and_then(Value::as_str) == Some(source)
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return status("no_matching_task_run");
    }
    if candidates.len() != 1 {
        return with_count("ambiguous_task_runs", candidates.len());
    }
    let run = candidates[0];
    if run.status != TaskRunStatus::Failed {
        return status("task_run_not_failed");
    }
    let issues = run
        .errors
        .iter()
        .filter(|issue| issue.code == ISSUE_CODE)
        .collect::<Vec<_>>();
    if issues.len() != 1 {
        return with_count("runner_issue_unavailable", issues.len());
    }
    let issue = issues[0];
    let artifact_id = format!("{ARTIFACT_PREFIX}{}", run.id);
    let uri = format!("{RESOURCE_PREFIX}{}/output", run.id);
    let artifact = run
        .artifacts
        .iter()
        .filter(|artifact| artifact.id == artifact_id)
        .collect::<Vec<_>>();
    if artifact.len() != 1 {
        return with_count("log_artifact_invalid", artifact.len());
    }
    let Some(log) = run.output.get(LOG_FIELD).and_then(Value::as_str) else {
        return status("log_output_unavailable");
    };
    let bytes = log.as_bytes();
    let details = &issue.details;
    let metadata = &artifact[0].metadata;
    let exact_artifact = artifact[0].kind == ArtifactKind::Log
        && artifact[0].uri.as_deref() == Some(uri.as_str())
        && artifact[0].path.is_none()
        && artifact[0].size_bytes == Some(bytes.len() as u64)
        && metadata.get("outputField").and_then(Value::as_str) == Some(LOG_FIELD)
        && metadata.get("encoding").and_then(Value::as_str) == Some("utf-8-lossy")
        && metadata.get("source").and_then(Value::as_str) == Some("merged_stdout_stderr")
        && metadata.get("untrusted").and_then(Value::as_bool) == Some(true);
    let exact_issue = details.get("schemaVersion").and_then(Value::as_u64) == Some(1)
        && details.get("phase").and_then(Value::as_str) == Some("runner")
        && details.get("runId").and_then(Value::as_str) == Some(run.id.as_str())
        && details
            .get("capturedLogBytes")
            .and_then(Value::as_u64)
            .is_some_and(|value| value <= MAX_LOG_BYTES as u64)
        && details.get("storedLogBytes").and_then(Value::as_u64) == Some(bytes.len() as u64)
        && details
            .get("cleanupConfirmed")
            .and_then(Value::as_bool)
            .is_some()
        && details
            .get("artifact")
            .and_then(|value| value.get("id"))
            .and_then(Value::as_str)
            == Some(artifact_id.as_str())
        && details
            .get("artifact")
            .and_then(|value| value.get("uri"))
            .and_then(Value::as_str)
            == Some(uri.as_str())
        && details
            .get("artifact")
            .and_then(|value| value.get("outputField"))
            .and_then(Value::as_str)
            == Some(LOG_FIELD);
    if !exact_artifact || !exact_issue || bytes.len() > MAX_LOG_BYTES {
        return status("log_artifact_invalid");
    }
    if let Err(code) = validate_destinations(fixture_root, sidecar_path, bytes.len()) {
        return status(code);
    }
    let mut file = match create_private_file(sidecar_path) {
        Ok(file) => file,
        Err(_) => return status("log_evidence_create_failed"),
    };
    if file.write_all(bytes).is_err() || file.sync_all().is_err() {
        drop(file);
        return status(cleanup_created_sidecar(
            sidecar_path,
            "log_evidence_write_failed",
        ));
    }
    let metadata = match file.metadata() {
        Ok(metadata) if metadata.is_file() && metadata.len() == bytes.len() as u64 => metadata,
        _ => {
            drop(file);
            return status(cleanup_created_sidecar(
                sidecar_path,
                "log_evidence_verify_failed",
            ));
        }
    };
    drop(metadata);
    let mut result = Map::new();
    result.insert("status".into(), json!("retained"));
    result.insert("taskRunMatchCount".into(), json!(1));
    result.insert("taskRunStatus".into(), json!("failed"));
    result.insert("errorCount".into(), json!(run.errors.len()));
    result.insert("issueCode".into(), json!(ISSUE_CODE));
    result.insert("artifactValidated".into(), json!(true));
    result.insert("file".into(), json!(EVIDENCE_FILE));
    result.insert("bytes".into(), json!(bytes.len()));
    result.insert(
        "sha256".into(),
        json!(format!("{:x}", Sha256::digest(bytes))),
    );
    result.insert(
        "runnerExitCodeObserved".into(),
        json!(details
            .get("runnerExitCode")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .is_some()),
    );
    if let Some(exit_code) = details
        .get("runnerExitCode")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
    {
        result.insert("runnerExitCode".into(), json!(exit_code));
    }
    result.insert(
        "runnerFailureCode".into(),
        json!(fixed_runner_code(details.get("runnerFailureCode"))),
    );
    result.insert(
        "runnerClassification".into(),
        json!(fixed_classification(details.get("classification"))),
    );
    result.insert(
        "runnerSignalObserved".into(),
        json!(details
            .get("runnerSignal")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok())
            .is_some()),
    );
    if let Some(signal) = details
        .get("runnerSignal")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
    {
        result.insert("runnerSignal".into(), json!(signal));
    }
    result.insert(
        "capturedLogBytesObserved".into(),
        json!(details
            .get("capturedLogBytes")
            .and_then(Value::as_u64)
            .is_some()),
    );
    if let Some(captured_bytes) = details.get("capturedLogBytes").and_then(Value::as_u64) {
        result.insert("capturedLogBytes".into(), json!(captured_bytes));
    }
    result.insert(
        "runnerCleanupConfirmedObserved".into(),
        json!(details
            .get("cleanupConfirmed")
            .and_then(Value::as_bool)
            .is_some()),
    );
    if let Some(cleanup_confirmed) = details.get("cleanupConfirmed").and_then(Value::as_bool) {
        result.insert("runnerCleanupConfirmed".into(), json!(cleanup_confirmed));
    }
    Value::Object(result)
}

fn cleanup_created_sidecar(path: &Path, failure_status: &'static str) -> &'static str {
    if fs::remove_file(path).is_ok() {
        failure_status
    } else {
        "log_evidence_cleanup_failed"
    }
}

fn create_private_file(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

fn validate_destinations(
    fixture_root: &Path,
    sidecar_path: &Path,
    log_bytes: usize,
) -> Result<(), &'static str> {
    if log_bytes > MAX_LOG_BYTES
        || !sidecar_path.is_absolute()
        || sidecar_path.file_name().and_then(|name| name.to_str()) != Some(EVIDENCE_FILE)
    {
        return Err("log_destination_invalid");
    }
    if fs::symlink_metadata(sidecar_path).is_ok() {
        return Err("log_destination_exists");
    }
    let parent = sidecar_path.parent().ok_or("log_destination_invalid")?;
    let parent_metadata = fs::symlink_metadata(parent).map_err(|_| "log_destination_invalid")?;
    if !parent_metadata.is_dir() || parent_metadata.file_type().is_symlink() {
        return Err("log_destination_invalid");
    }
    let canonical_parent = fs::canonicalize(parent).map_err(|_| "log_destination_invalid")?;
    let canonical_root = fs::canonicalize(fixture_root).map_err(|_| "fixture_root_invalid")?;
    if canonical_parent.starts_with(canonical_root) {
        return Err("log_destination_inside_fixture");
    }
    Ok(())
}

fn fixed_runner_code(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("SourceBuildProcessFailed") => "SourceBuildProcessFailed",
        Some("SourceBuildTimeout") => "SourceBuildTimeout",
        Some("SOURCE_BUILD_CANCELLED") => "SOURCE_BUILD_CANCELLED",
        Some("SOURCE_BUILD_CLEANUP_UNCONFIRMED") => "SOURCE_BUILD_CLEANUP_UNCONFIRMED",
        Some("SourceBuildSpawnFailed") => "SourceBuildSpawnFailed",
        Some("SourceBuildPipeConfigurationFailed") => "SourceBuildPipeConfigurationFailed",
        Some("SourceBuildWaitFailed") => "SourceBuildWaitFailed",
        Some("SourceBuildLogLimitExceeded") => "SourceBuildLogLimitExceeded",
        Some("SourceBuildLogReadFailed") => "SourceBuildLogReadFailed",
        Some("SourceBuildPrivateEnvironmentFailed") => "SourceBuildPrivateEnvironmentFailed",
        Some("SourceBuildProfileWriteFailed") => "SourceBuildProfileWriteFailed",
        _ => "unknown",
    }
}

fn fixed_classification(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("nonzero_exit") => "nonzero_exit",
        Some("signal_exit") => "signal_exit",
        Some("timeout") => "timeout",
        Some("cancelled") => "cancelled",
        Some("cleanup_unconfirmed") => "cleanup_unconfirmed",
        Some("supervisor_failure") => "supervisor_failure",
        _ => "unknown",
    }
}

fn status(value: &'static str) -> Value {
    json!({"status":value})
}
fn with_count(value: &'static str, count: usize) -> Value {
    json!({"status":value,"count":count})
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::task_run::{Artifact, TaskIssue, TaskRunInitiator};

    fn run(source: &str, log: &str, exit: Option<i32>) -> TaskRun {
        let mut run = TaskRun::new(
            TOOL,
            TaskRunInitiator::human(Some("atools-ui".into())),
            json!({"sourcePath":source}),
        );
        run.transition(TaskRunStatus::Running).unwrap();
        run.transition(TaskRunStatus::Failed).unwrap();
        run.output = Value::Object(Map::from_iter([(
            LOG_FIELD.to_owned(),
            Value::String(log.to_owned()),
        )]));
        let id = format!("{ARTIFACT_PREFIX}{}", run.id);
        let uri = format!("{RESOURCE_PREFIX}{}/output", run.id);
        let bytes = log.as_bytes().len() as u64;
        run.artifacts.push(Artifact { id:id.clone(), kind:ArtifactKind::Log, label:"bounded test log".into(),
            media_type:Some("text/plain; charset=utf-8".into()), uri:Some(uri.clone()), path:None, size_bytes:Some(bytes),
            metadata:json!({"outputField":LOG_FIELD,"encoding":"utf-8-lossy","source":"merged_stdout_stderr","untrusted":true}) });
        run.errors.push(TaskIssue { code:ISSUE_CODE.into(), message:"fixed producer message".into(), retryable:false,
            details:json!({"schemaVersion":1,"phase":"runner","runId":run.id,"runnerExitCode":exit,
                "runnerFailureCode":"SourceBuildProcessFailed","classification":"nonzero_exit","cleanupConfirmed":true,
                "capturedLogBytes":bytes,"storedLogBytes":bytes,"artifact":{"id":id,"uri":uri,"outputField":LOG_FIELD}}) });
        run
    }

    fn dirs() -> (
        tempfile::TempDir,
        std::path::PathBuf,
        std::path::PathBuf,
        std::path::PathBuf,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("fixture");
        fs::create_dir(&root).unwrap();
        let evidence = temp.path().join("evidence");
        fs::create_dir(&evidence).unwrap();
        for (name, bytes) in [
            ("panel.js", b"js".as_slice()),
            ("panel.css", b"css".as_slice()),
            ("entry.html", b"html".as_slice()),
        ] {
            fs::write(evidence.join(name), bytes).unwrap();
        }
        let scratch = temp.path().join("scratch");
        fs::create_dir(&scratch).unwrap();
        let sidecar = scratch.join(EVIDENCE_FILE);
        (temp, root, evidence, sidecar)
    }

    #[test]
    fn exact_failed_taskrun_artifact_is_retained_separately_from_safe_metadata() {
        let (_temp, root, evidence, sidecar) = dirs();
        let log = "stderr: fixture-only bounded runner text";
        let task = run("/fixture/success", log, Some(7));
        let result = retain_failed_runner_log(
            &[task],
            true,
            PROFILE,
            Path::new("/fixture/success"),
            &root,
            &sidecar,
        );
        assert_eq!(fs::read(&sidecar).unwrap(), log.as_bytes());
        assert_eq!(result["status"], "retained");
        assert_eq!(result["runnerExitCode"], 7);
        assert_eq!(result["bytes"], log.len());
        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains(log));
        assert!(!serialized.contains("/fixture/success"));
        assert_eq!(fs::read_dir(evidence).unwrap().count(), 3);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&sidecar).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn invalid_artifact_or_oversize_log_never_creates_sidecar() {
        let (_temp, root, _evidence, sidecar) = dirs();
        let mut task = run("/fixture/success", "raw-log", None);
        task.artifacts[0].metadata["untrusted"] = json!(false);
        let result = retain_failed_runner_log(
            &[task],
            true,
            PROFILE,
            Path::new("/fixture/success"),
            &root,
            &sidecar,
        );
        assert_eq!(result["status"], "log_artifact_invalid");
        assert!(!sidecar.exists());

        let oversized = "x".repeat(MAX_LOG_BYTES + 1);
        let task = run("/fixture/success", &oversized, None);
        let result = retain_failed_runner_log(
            &[task],
            true,
            PROFILE,
            Path::new("/fixture/success"),
            &root,
            &sidecar,
        );
        assert_eq!(result["status"], "log_artifact_invalid");
        assert!(!sidecar.exists());
    }

    #[test]
    fn created_partial_sidecar_is_removed_and_preexisting_sidecar_is_never_overwritten() {
        let (_temp, root, _evidence, sidecar) = dirs();
        fs::write(&sidecar, b"partial").unwrap();
        assert_eq!(
            cleanup_created_sidecar(&sidecar, "log_evidence_write_failed"),
            "log_evidence_write_failed"
        );
        assert!(!sidecar.exists());

        fs::write(&sidecar, b"preexisting").unwrap();
        let task = run("/fixture/success", "new log", Some(2));
        let result = retain_failed_runner_log(
            &[task],
            true,
            PROFILE,
            Path::new("/fixture/success"),
            &root,
            &sidecar,
        );
        assert_eq!(result["status"], "log_destination_exists");
        assert_eq!(fs::read(&sidecar).unwrap(), b"preexisting");
    }

    #[test]
    fn absent_runner_exit_remains_unobserved_and_native_status_is_not_substituted() {
        let (_temp, root, _evidence, sidecar) = dirs();
        let task = run("/fixture/success", "runner text", None);
        let result = retain_failed_runner_log(
            &[task],
            true,
            PROFILE,
            Path::new("/fixture/success"),
            &root,
            &sidecar,
        );
        assert_eq!(result["runnerExitCodeObserved"], false);
        assert!(result.get("runnerExitCode").is_none());
    }

    #[test]
    fn unrelated_or_ambiguous_taskruns_do_not_select_or_overwrite_evidence() {
        let (_temp, root, _evidence, sidecar) = dirs();
        let task = run("/fixture/other", "x", Some(1));
        let result = retain_failed_runner_log(
            &[task],
            true,
            PROFILE,
            Path::new("/fixture/success"),
            &root,
            &sidecar,
        );
        assert_eq!(result["status"], "no_matching_task_run");
        let one = run("/fixture/success", "x", Some(1));
        let two = run("/fixture/success", "y", Some(2));
        let result = retain_failed_runner_log(
            &[one, two],
            true,
            PROFILE,
            Path::new("/fixture/success"),
            &root,
            &sidecar,
        );
        assert_eq!(result["status"], "ambiguous_task_runs");
        assert!(!sidecar.exists());
    }
}
