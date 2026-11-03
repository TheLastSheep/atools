use super::{privacy, state::Harness};
use serde_json::{json, Value};
use sha2::Digest;
use std::os::unix::fs::MetadataExt;
use std::{fs, fs::OpenOptions, io::Write, path::Path};
use tauri::{AppHandle, Manager};

pub(super) const MAIN_READY_TIMEOUT: &str = "clipboard-context-main-ready-timeout";
pub(super) const PROBE_INJECTION_FAILED: &str = "clipboard-context-probe-injection-failed";
pub(super) const PROBE_READY_INVALID: &str = "clipboard-context-probe-ready-invalid";
pub(super) const PROBE_TIMEOUT: &str = "clipboard-context-probe-timeout";
pub(super) const PROBE_INVALID: &str = "clipboard-context-probe-invalid";
pub(super) const FIXTURE_INVALID: &str = "clipboard-context-fixture-invalid";
pub(super) const PERMISSION_BASELINE_INVALID: &str =
    "clipboard-context-permission-baseline-invalid";
pub(super) const STAGE_FAILED: &str = "clipboard-context-stage-failed";
pub(super) const PRIVACY_AUDIT_FAILED: &str = "clipboard-context-privacy-audit-failed";
pub(super) const CLEANUP_FAILED: &str = "clipboard-context-cleanup-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "clipboard-context-report-write-failed";
pub(super) const WATCHDOG_TIMEOUT: &str = "clipboard-context-watchdog-timeout";
const MAX_REPORT_BYTES: usize = 1024 * 1024;
const REPORT_NAME: &str = "native-clipboard-context-report.json";

pub(super) fn empty_stages() -> Value {
    let empty = json!(null);
    json!({
        "ready": {
            "probeReady": empty, "documentVisibility": empty,
            "documentHasFocus": empty, "searchInputCount": empty, "clipboardGetterAvailable": empty,
            "mainWindowVisible": empty, "mainWindowFocused": empty,
        },
        "textEmpty": {
            "pasteCanceled": empty, "clipboardCommandDelta": empty, "boardSnapshotDelta": empty,
            "inputEmpty": empty, "textChipMatches": empty, "launchContextObserved": empty,
        },
        "textSelection": {
            "pasteCanceled": empty, "clipboardCommandDelta": empty, "boardSnapshotDelta": empty,
            "inputValueMatches": empty, "selectionMatches": empty, "launchContextObserved": empty,
        },
        "image": {
            "pasteCanceled": empty, "clipboardCommandDelta": empty, "boardSnapshotDelta": empty,
            "imageChipMatches": empty, "naturalWidth": empty, "naturalHeight": empty,
            "launchContextObserved": empty,
        },
        "file": {
            "pasteCanceled": empty, "clipboardCommandDelta": empty, "boardSnapshotDelta": empty,
            "fileChipMatches": empty, "fileNameMatches": empty, "launchContextObserved": empty,
            "pasteboardChangeCountBefore": empty, "pasteboardChangeCountAfter": empty,
        },
        "expiredSameCount": {
            "getterReturnedNull": empty, "clipboardCommandDelta": empty, "boardSnapshotDelta": empty,
            "changeCountBefore": empty, "changeCountAfter": empty, "changeCountUnchanged": empty,
            "launchContextUnchanged": empty,
        },
        "empty": {
            "getterReturnedNull": empty, "clipboardCommandDelta": empty, "boardSnapshotDelta": empty,
            "uiUnchanged": empty, "launchContextUnchanged": empty,
        },
        "denied": {
            "getterRejected": empty, "clipboardCommandDelta": empty, "boardSnapshotDelta": empty,
            "uiUnchanged": empty, "launchContextUnchanged": empty,
            "deniedTaskRun": empty, "deniedAudit": empty,
        },
    })
}

pub(super) fn write(
    app: &AppHandle,
    harness: &Harness,
    cleanup: Value,
) -> Result<bool, &'static str> {
    let report = build(app, harness, cleanup);
    let passed = report["declaredPassed"].as_bool() == Some(true);
    let bytes = serde_json::to_vec(&report).map_err(|_| REPORT_WRITE_FAILED)?;
    if bytes.len() > MAX_REPORT_BYTES {
        return Err(REPORT_WRITE_FAILED);
    }
    let path = report_path(harness.profile())?;
    write_new_private_file(&path, &bytes)?;
    Ok(passed)
}

fn build(app: &AppHandle, harness: &Harness, cleanup: Value) -> Value {
    let profile = harness.profile();
    let stages = harness.stages();
    let run_state = app.try_state::<crate::state::AppState>();
    let facts = privacy::database_facts(&harness.0.db, profile).ok();
    let metrics_after = harness.0.board.metrics();
    let ready = harness.ready();
    let asset_metrics = app
        .try_state::<super::super::FixtureMetadata>()
        .and_then(|metadata| metadata.0.get("assets").cloned());
    let fallback_summary = app
        .try_state::<super::super::FixtureMetadata>()
        .and_then(|metadata| metadata.0.get("fallbackSettingsAssets").cloned())
        .unwrap_or(Value::Null);
    let source = json!({
        "journey": "clipboard-context",
        "renderer": "unchanged-original-vue",
        "genericReportAbsent": !profile.output.exists(),
        "documentRoot": ready.as_ref().is_some_and(|value| value.document_root),
        "searchInputCount": ready.as_ref().map(|value| value.search_input_count),
        "clipboardGetterAvailable": ready.as_ref().map(|value| value.clipboard_getter_available),
        "readerCommandObserved": harness.reader_commands() == 7,
        "assets": {
            "runtimeAssetCount": asset_metrics.as_ref().and_then(|value| value.get("runtimeAssetCount")).cloned().unwrap_or(Value::Null),
            "runtimeAssetBytes": asset_metrics.as_ref().and_then(|value| value.get("runtimeAssetBytes")).cloned().unwrap_or(Value::Null),
            "javascriptAssetCount": asset_metrics.as_ref().and_then(|value| value.get("javascriptAssetCount")).cloned().unwrap_or(Value::Null),
            "fallbackSettingsAssets": fallback_summary,
        },
    });
    let task_runs = facts
        .as_ref()
        .map(|value| value.task_runs.as_slice())
        .unwrap_or(&[]);
    let audits = facts
        .as_ref()
        .map(|value| value.audits.as_slice())
        .unwrap_or(&[]);
    let (succeeded, cancelled, other_runs, all_terminal) = privacy::task_status_counts(task_runs);
    let (confirmed, denied, other_audits, finalized) = privacy::audit_status_counts(audits);
    let task_report = json!({
        "before": 0,
        "after": task_runs.len(),
        "succeeded": succeeded,
        "cancelled": cancelled,
        "other": other_runs,
        "allTerminal": facts.is_some() && all_terminal,
        "summaryOnly": !task_runs.is_empty() && task_runs.iter().all(privacy::task_summary_only),
        "rawPayloadAbsent": facts.is_some() && task_runs.iter().all(|run| privacy::task_payload_absent(run, profile)),
    });
    let audit_report = json!({
        "before": 0,
        "after": audits.len(),
        "confirmed": confirmed,
        "denied": denied,
        "other": other_audits,
        "finalized": facts.is_some() && finalized,
        "metadataOnly": !audits.is_empty() && audits.iter().all(|entry| privacy::audit_metadata_only(entry, profile)),
        "rawPayloadAbsent": facts.is_some() && audits.iter().all(|entry| privacy::audit_metadata_only(entry, profile)),
    });
    let history_after = facts.as_ref();
    let before_metrics = &harness.0.metrics_before;
    let counters = json!({
        "clipboardCommandCalls": harness.reader_commands(),
        "boardSnapshots": metric_u64(&metrics_after, "snapshots"),
        "boardChangeCountReads": metric_u64(&metrics_after, "changeCounts"),
        "pasteboardChangeCountBefore": before_metrics.get("pasteboardChangeCount").cloned().unwrap_or(Value::Null),
        "pasteboardChangeCountAfter": metrics_after.get("pasteboardChangeCount").cloned().unwrap_or(Value::Null),
        "backgroundCaptures": metric_u64(&metrics_after, "backgroundCaptures"),
        "writesRejected": metric_u64(&metrics_after, "writesRejected"),
        "pastesRejected": metric_u64(&metrics_after, "pastesRejected"),
    });
    let runtime = runtime(app);
    let errors = harness.errors();
    let elapsed = harness.elapsed_ms();
    let history = json!({
        "beforeCount": 0,
        "afterCount": history_after.map(|facts| facts.history_count),
        "beforeSha256": empty_history_hash(),
        "afterSha256": history_after.map(|facts| facts.history_hash.as_str()),
        "unchanged": history_after.is_some_and(|facts| facts.history_count == 0 && facts.history_hash == empty_history_hash()),
        "fixtureContentAbsent": history_after.is_some_and(|facts| facts.history_payload_absent),
        "nativeBeforeEmpty": harness.0.before.native_items_empty,
        "nativeAfterEmpty": history_after.map(|facts| facts.native_items_empty),
    });
    let mut report = json!({
        "schemaVersion": 1,
        "journey": "clipboard-context",
        "scope": "isolated-original-main-clipboard-context",
        "identifier": profile.identifier,
        "root": profile.root,
        "pid": std::process::id(),
        "runId": profile.run_id,
        "elapsedMs": elapsed,
        "source": source,
        "stages": stages,
        "counters": counters,
        "taskRuns": task_report,
        "audits": audit_report,
        "history": history,
        "runtime": runtime,
        "cleanup": cleanup,
        "errors": errors,
        "declaredPassed": false,
        "fullProductAcceptance": false,
    });
    let passed = errors.is_empty()
        && source_pass(&report["source"])
        && stage_pass(&report["stages"], &report["counters"])
        && counter_pass(&report["counters"])
        && task_pass(&report["taskRuns"])
        && audit_pass(&report["audits"])
        && runtime_pass(&report["runtime"])
        && history_pass(&report["history"])
        && cleanup_pass(&report["cleanup"])
        && run_state.is_some();
    report["declaredPassed"] = Value::Bool(passed);
    report
}

fn source_pass(source: &Value) -> bool {
    source["journey"] == "clipboard-context"
        && source["renderer"] == "unchanged-original-vue"
        && source["genericReportAbsent"] == true
        && source["documentRoot"] == true
        && source["searchInputCount"] == 1
        && source["clipboardGetterAvailable"] == true
        && source["readerCommandObserved"] == true
        && source["assets"]["runtimeAssetCount"].as_u64().is_some()
        && source["assets"]["runtimeAssetBytes"].as_u64().is_some()
        && source["assets"]["javascriptAssetCount"]
            .as_u64()
            .is_some_and(|count| count > 0)
        && source["assets"]["fallbackSettingsAssets"].is_null()
}

fn stage_pass(stages: &Value, counters: &Value) -> bool {
    let ready = &stages["ready"];
    let paste = ["textEmpty", "textSelection", "image", "file"]
        .iter()
        .all(|name| {
            let stage = &stages[*name];
            stage["pasteCanceled"] == true
                && stage["clipboardCommandDelta"] == 1
                && stage["boardSnapshotDelta"] == 1
                && stage["launchContextObserved"] == true
        });
    ready["probeReady"] == true
        && matches!(
            ready["documentVisibility"].as_str(),
            Some("visible" | "hidden")
        )
        && ready["documentHasFocus"].as_bool().is_some()
        && ready["mainWindowVisible"] == false
        && ready["mainWindowFocused"] == false
        && ready["searchInputCount"] == 1
        && ready["clipboardGetterAvailable"] == true
        && stages["textEmpty"]["inputEmpty"] == true
        && stages["textEmpty"]["textChipMatches"] == true
        && stages["textSelection"]["inputValueMatches"] == true
        && stages["textSelection"]["selectionMatches"] == true
        && stages["image"]["imageChipMatches"] == true
        && stages["image"]["naturalWidth"] == 1
        && stages["image"]["naturalHeight"] == 1
        && stages["file"]["fileChipMatches"] == true
        && stages["file"]["fileNameMatches"] == true
        && paste
        && stages["file"]["pasteboardChangeCountBefore"]
            .as_i64()
            .is_some()
        && stages["file"]["pasteboardChangeCountBefore"]
            == stages["file"]["pasteboardChangeCountAfter"]
        && stages["expiredSameCount"]["clipboardCommandDelta"] == 1
        && stages["expiredSameCount"]["boardSnapshotDelta"] == 1
        && stages["expiredSameCount"]["getterReturnedNull"] == true
        && stages["expiredSameCount"]["changeCountUnchanged"] == true
        && stages["expiredSameCount"]["changeCountBefore"]
            == stages["file"]["pasteboardChangeCountAfter"]
        && stages["expiredSameCount"]["changeCountBefore"]
            == stages["expiredSameCount"]["changeCountAfter"]
        && stages["expiredSameCount"]["launchContextUnchanged"] == true
        && stages["empty"]["clipboardCommandDelta"] == 1
        && stages["empty"]["boardSnapshotDelta"] == 1
        && stages["empty"]["getterReturnedNull"] == true
        && stages["empty"]["uiUnchanged"] == true
        && stages["empty"]["launchContextUnchanged"] == true
        && stages["denied"]["clipboardCommandDelta"] == 1
        && stages["denied"]["boardSnapshotDelta"] == 0
        && stages["denied"]["getterRejected"] == true
        && stages["denied"]["uiUnchanged"] == true
        && stages["denied"]["launchContextUnchanged"] == true
        && stages["denied"]["deniedTaskRun"] == true
        && stages["denied"]["deniedAudit"] == true
        && counters["clipboardCommandCalls"] == 7
        && counters["boardSnapshots"] == 6
}

fn counter_pass(counters: &Value) -> bool {
    counters["boardChangeCountReads"]
        .as_u64()
        .is_some_and(|reads| (6..=4096).contains(&reads))
        && counters["pasteboardChangeCountBefore"].as_i64().is_some()
        && counters["pasteboardChangeCountAfter"].as_i64().is_some()
        && counters["backgroundCaptures"] == 0
        && counters["writesRejected"] == 0
        && counters["pastesRejected"] == 0
}

fn task_pass(value: &Value) -> bool {
    value["before"] == 0
        && value["after"] == 7
        && value["succeeded"] == 6
        && value["cancelled"] == 1
        && value["other"] == 0
        && value["allTerminal"] == true
        && value["summaryOnly"] == true
        && value["rawPayloadAbsent"] == true
}

fn audit_pass(value: &Value) -> bool {
    value["before"] == 0
        && value["after"] == 7
        && value["confirmed"] == 6
        && value["denied"] == 1
        && value["other"] == 0
        && value["finalized"] == true
        && value["metadataOnly"] == true
        && value["rawPayloadAbsent"] == true
}

fn cleanup_pass(value: &Value) -> bool {
    value["boardCleared"] == true
        && value["boardClearVerified"] == true
        && value["permissionRestored"] == true
        && value["mainWindowPresent"] == true
        && value["settingsWindowCount"] == 0
        && value["pluginWindowCount"] == 0
        && value["pendingProbeCount"] == 0
        && value["pendingCommandCount"] == 0
        && value["adapterOutstandingNativeCalls"] == 0
        && value["taskRunsTerminal"] == true
        && value["auditsTerminal"] == true
        && value["mediaPermitsBefore"] == 2
        && value["mediaPermitsAfter"] == value["mediaPermitsBefore"]
        && value["probeDisposed"] == true
}

fn runtime_pass(value: &Value) -> bool {
    value["activePluginAbsent"] == true
        && value["activeTaskRuns"] == 0
        && value["mcpStatusAbsent"] == true
        && value["pasteboardCaptureTaskAbsent"] == true
        && value["nodeSidecarStarted"].is_null()
        && value["pluginRuntimeStarted"].is_null()
}

fn history_pass(value: &Value) -> bool {
    value["unchanged"] == true
        && value["fixtureContentAbsent"] == true
        && value["nativeBeforeEmpty"] == true
        && value["nativeAfterEmpty"] == true
}

fn runtime(app: &AppHandle) -> Value {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return json!({
            "activePluginAbsent": null,
            "activeTaskRuns": null,
            "mcpStatusAbsent": null,
            "pasteboardCaptureTaskAbsent": null,
            "nodeSidecarStarted": null,
            "pluginRuntimeStarted": null,
        });
    };
    json!({
        "activePluginAbsent": state.active_plugin.lock().is_none(),
        "activeTaskRuns": state.active_task_runs.lock().len(),
        "mcpStatusAbsent": state.mcp_status.lock().is_none(),
        "pasteboardCaptureTaskAbsent": state.pasteboard_capture_task.lock().is_none(),
        "nodeSidecarStarted": null,
        "pluginRuntimeStarted": null,
    })
}

fn metric_u64(metrics: &Value, key: &str) -> Value {
    metrics.get(key).cloned().unwrap_or(Value::Null)
}

fn empty_history_hash() -> String {
    sha2::Sha256::digest(b"[]")
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn report_path(
    profile: &super::super::profile::Profile,
) -> Result<std::path::PathBuf, &'static str> {
    if !profile.clipboard_context_journey
        || profile.output.file_name().and_then(|name| name.to_str()) != Some("native-report.json")
        || profile.identifier != format!("dev.atools.renderer-clipboard.{}", profile.run_id)
    {
        return Err(REPORT_WRITE_FAILED);
    }
    let parent = profile.output.parent().ok_or(REPORT_WRITE_FAILED)?;
    let metadata = fs::symlink_metadata(parent).map_err(|_| REPORT_WRITE_FAILED)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || fs::canonicalize(parent).map_err(|_| REPORT_WRITE_FAILED)? != parent
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o7777 != 0o700
    {
        return Err(REPORT_WRITE_FAILED);
    }
    Ok(parent.join(REPORT_NAME))
}

fn write_new_private_file(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC);
    let mut file = options.open(path).map_err(|_| REPORT_WRITE_FAILED)?;
    file.write_all(bytes).map_err(|_| REPORT_WRITE_FAILED)?;
    file.sync_all().map_err(|_| REPORT_WRITE_FAILED)?;
    let parent = path.parent().ok_or(REPORT_WRITE_FAILED)?;
    fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| REPORT_WRITE_FAILED)
}
