use super::{
    probe, report,
    state::{Evidence, Harness},
};
use crate::pasteboard_native::clipboard_fixture::FixtureContent;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry};

const READY_TIMEOUT: Duration = Duration::from_secs(12);
const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
const TERMINAL_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) async fn run(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    if !harness.wait_ready(READY_TIMEOUT).await {
        return Err(report::MAIN_READY_TIMEOUT);
    }
    let ready = harness.ready().ok_or(report::PROBE_READY_INVALID)?;
    let (visible, focused) = harness.ready_window_facts();
    if !ready.document_root
        || ready.search_input_count != 1
        || !ready.clipboard_getter_available
        || visible != Some(false)
        || focused != Some(false)
    {
        return Err(report::PROBE_READY_INVALID);
    }

    paste_stage(app, harness, "textEmpty", FixtureContent::Text).await?;
    paste_stage(app, harness, "textSelection", FixtureContent::Text).await?;
    paste_stage(app, harness, "image", FixtureContent::Image).await?;
    paste_stage(app, harness, "file", FixtureContent::Files).await?;
    expired_stage(app, harness).await?;
    empty_stage(app, harness).await?;
    denied_stage(app, harness).await?;
    Ok(())
}

async fn paste_stage(
    app: &AppHandle<Wry>,
    harness: &Harness,
    operation: &'static str,
    content: FixtureContent,
) -> Result<(), &'static str> {
    harness
        .0
        .board
        .set_content(content)
        .map_err(|_| report::FIXTURE_INVALID)?;
    let metrics_before = harness.0.board.metrics();
    let calls_before = harness.reader_commands();
    let evidence = run_probe(app, harness, operation).await?;
    let metrics_after = harness.0.board.metrics();
    let calls_after = harness.reader_commands();
    let mut stage = common_deltas(
        &evidence,
        calls_before,
        calls_after,
        &metrics_before,
        &metrics_after,
    );
    stage["pasteCanceled"] = option_bool(evidence.paste_canceled);
    stage["launchContextObserved"] = option_bool(evidence.launch_context_observed);
    match operation {
        "textEmpty" => {
            stage["inputEmpty"] = option_bool(evidence.input_empty);
            stage["textChipMatches"] = option_bool(evidence.text_chip_matches);
        }
        "textSelection" => {
            stage["inputValueMatches"] = option_bool(evidence.input_value_matches);
            stage["selectionMatches"] = option_bool(evidence.selection_matches);
        }
        "image" => {
            stage["imageChipMatches"] = option_bool(evidence.image_chip_matches);
            stage["naturalWidth"] = option_u32(evidence.natural_width);
            stage["naturalHeight"] = option_u32(evidence.natural_height);
        }
        "file" => {
            stage["fileChipMatches"] = option_bool(evidence.file_chip_matches);
            stage["fileNameMatches"] = option_bool(evidence.file_name_matches);
            stage["pasteboardChangeCountBefore"] =
                metric_i64(&metrics_before, "pasteboardChangeCount");
            stage["pasteboardChangeCountAfter"] =
                metric_i64(&metrics_after, "pasteboardChangeCount");
        }
        _ => return Err(report::PROBE_INVALID),
    }
    harness.set_stage(operation, stage);
    if calls_after.checked_sub(calls_before) != Some(1)
        || metric_delta(&metrics_before, &metrics_after, "snapshots") != Some(1)
        || !paste_evidence_pass(operation, &evidence)
    {
        return Err(report::STAGE_FAILED);
    }
    Ok(())
}

async fn expired_stage(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    // The runtime retains the copied-at timestamp for a stable pasteboard change count.
    tokio::time::sleep(Duration::from_millis(5)).await;
    let metrics_before = harness.0.board.metrics();
    let calls_before = harness.reader_commands();
    let evidence = run_probe(app, harness, "expiredSameCount").await?;
    let metrics_after = harness.0.board.metrics();
    let calls_after = harness.reader_commands();
    let before_count = metric_i64(&metrics_before, "pasteboardChangeCount");
    let after_count = metric_i64(&metrics_after, "pasteboardChangeCount");
    let unchanged = before_count == after_count && before_count.is_i64();
    harness.set_stage(
        "expiredSameCount",
        json!({
            "getterReturnedNull": evidence.getter_returned_null,
            "clipboardCommandDelta": calls_after.checked_sub(calls_before),
            "boardSnapshotDelta": metric_delta(&metrics_before, &metrics_after, "snapshots"),
            "changeCountBefore": before_count,
            "changeCountAfter": after_count,
            "changeCountUnchanged": unchanged,
            "launchContextUnchanged": evidence.launch_context_unchanged,
        }),
    );
    if calls_after.checked_sub(calls_before) != Some(1)
        || metric_delta(&metrics_before, &metrics_after, "snapshots") != Some(1)
        || evidence.getter_returned_null != Some(true)
        || !unchanged
        || evidence.launch_context_unchanged != Some(true)
    {
        return Err(report::STAGE_FAILED);
    }
    Ok(())
}

async fn empty_stage(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    harness
        .0
        .board
        .set_content(FixtureContent::Empty)
        .map_err(|_| report::FIXTURE_INVALID)?;
    let metrics_before = harness.0.board.metrics();
    let calls_before = harness.reader_commands();
    let evidence = run_probe(app, harness, "empty").await?;
    let metrics_after = harness.0.board.metrics();
    let calls_after = harness.reader_commands();
    harness.set_stage(
        "empty",
        json!({
            "getterReturnedNull": evidence.getter_returned_null,
            "clipboardCommandDelta": calls_after.checked_sub(calls_before),
            "boardSnapshotDelta": metric_delta(&metrics_before, &metrics_after, "snapshots"),
            "uiUnchanged": evidence.ui_unchanged,
            "launchContextUnchanged": evidence.launch_context_unchanged,
        }),
    );
    if calls_after.checked_sub(calls_before) != Some(1)
        || metric_delta(&metrics_before, &metrics_after, "snapshots") != Some(1)
        || evidence.getter_returned_null != Some(true)
        || evidence.ui_unchanged != Some(true)
        || evidence.launch_context_unchanged != Some(true)
    {
        return Err(report::STAGE_FAILED);
    }
    Ok(())
}

async fn denied_stage(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    harness
        .0
        .board
        .set_content(FixtureContent::Text)
        .map_err(|_| report::FIXTURE_INVALID)?;
    harness.set_denied()?;
    let metrics_before = harness.0.board.metrics();
    let calls_before = harness.reader_commands();
    let evidence = run_probe(app, harness, "denied").await?;
    let metrics_after = harness.0.board.metrics();
    let calls_after = harness.reader_commands();
    let facts = super::privacy::database_facts(&harness.0.db, harness.profile())?;
    let denied_task = facts
        .task_runs
        .iter()
        .filter(|run| {
            run.status == atools_core::task_run::TaskRunStatus::Cancelled
                && run
                    .errors
                    .iter()
                    .any(|issue| issue.code == "permission_denied")
        })
        .count()
        == 1;
    let denied_audit = facts
        .audits
        .iter()
        .filter(|entry| {
            entry.status == atools_core::agent::AuditStatus::Denied
                && entry.tool_name == crate::launcher_clipboard_context::TOOL
        })
        .count()
        == 1;
    harness.set_stage(
        "denied",
        json!({
            "getterRejected": evidence.getter_rejected,
            "clipboardCommandDelta": calls_after.checked_sub(calls_before),
            "boardSnapshotDelta": metric_delta(&metrics_before, &metrics_after, "snapshots"),
            "uiUnchanged": evidence.ui_unchanged,
            "launchContextUnchanged": evidence.launch_context_unchanged,
            "deniedTaskRun": denied_task,
            "deniedAudit": denied_audit,
        }),
    );
    if calls_after.checked_sub(calls_before) != Some(1)
        || metric_delta(&metrics_before, &metrics_after, "snapshots") != Some(0)
        || evidence.getter_rejected != Some(true)
        || evidence.ui_unchanged != Some(true)
        || evidence.launch_context_unchanged != Some(true)
        || !denied_task
        || !denied_audit
    {
        return Err(report::STAGE_FAILED);
    }
    Ok(())
}

async fn run_probe(
    app: &AppHandle<Wry>,
    harness: &Harness,
    operation: &str,
) -> Result<Evidence, &'static str> {
    let webview = crate::window::main_webview(app).map_err(|_| report::PROBE_INVALID)?;
    probe::validate_main_source(app, &webview).map_err(|_| report::PROBE_INVALID)?;
    let (probe_id, receiver) = harness.begin(operation)?;
    let operation_arg = serde_json::to_string(operation).map_err(|_| report::PROBE_INVALID)?;
    if webview
        .eval(format!(
            "window.__ATOOLS_CLIPBOARD_CONTEXT_PROBE__?.run({operation_arg},{probe_id});"
        ))
        .is_err()
    {
        harness.finish_pending();
        return Err(report::PROBE_INJECTION_FAILED);
    }
    match tokio::time::timeout(PROBE_TIMEOUT, receiver).await {
        Ok(Ok(Ok(evidence))) => Ok(evidence),
        Ok(Ok(Err(error))) => Err(error),
        Ok(Err(_)) => Err(report::PROBE_INVALID),
        Err(_) => {
            harness.finish_pending();
            Err(report::PROBE_TIMEOUT)
        }
    }
}

fn common_deltas(
    evidence: &Evidence,
    calls_before: u32,
    calls_after: u32,
    metrics_before: &Value,
    metrics_after: &Value,
) -> Value {
    json!({
        "pasteCanceled": evidence.paste_canceled,
        "clipboardCommandDelta": calls_after.checked_sub(calls_before),
        "boardSnapshotDelta": metric_delta(metrics_before, metrics_after, "snapshots"),
        "launchContextObserved": evidence.launch_context_observed,
    })
}

fn paste_evidence_pass(operation: &str, evidence: &Evidence) -> bool {
    evidence.paste_canceled == Some(true)
        && evidence.launch_context_observed == Some(true)
        && match operation {
            "textEmpty" => {
                evidence.input_empty == Some(true) && evidence.text_chip_matches == Some(true)
            }
            "textSelection" => {
                evidence.input_value_matches == Some(true)
                    && evidence.selection_matches == Some(true)
            }
            "image" => {
                evidence.image_chip_matches == Some(true)
                    && evidence.natural_width == Some(1)
                    && evidence.natural_height == Some(1)
            }
            "file" => {
                evidence.file_chip_matches == Some(true) && evidence.file_name_matches == Some(true)
            }
            _ => false,
        }
}

fn metric_delta(before: &Value, after: &Value, key: &str) -> Option<u64> {
    after
        .get(key)?
        .as_u64()?
        .checked_sub(before.get(key)?.as_u64()?)
}

fn metric_i64(metrics: &Value, key: &str) -> Value {
    metrics
        .get(key)
        .and_then(Value::as_i64)
        .map_or(Value::Null, Value::from)
}

fn option_bool(value: Option<bool>) -> Value {
    value.map_or(Value::Null, Value::Bool)
}

fn option_u32(value: Option<u32>) -> Value {
    value.map_or(Value::Null, Value::from)
}

pub(super) async fn finish(app: &AppHandle<Wry>, harness: &Harness) {
    harness.finish_pending();
    if harness.ready().is_some() {
        if run_probe(app, harness, "dispose").await.is_err() {
            harness.note_error(report::CLEANUP_FAILED);
        }
    }
    if !harness.probe_disposed() {
        harness.note_error(report::CLEANUP_FAILED);
    }
    if !wait_native_terminal(app, TERMINAL_TIMEOUT).await {
        harness.note_error(report::CLEANUP_FAILED);
    }

    let board_clear = harness.0.board.clear().unwrap_or(false);
    let metrics = harness.0.board.metrics();
    let permission_restored = harness.restore_permission().unwrap_or(false);
    let app_state = app.try_state::<crate::state::AppState>();
    let task_terminal = app_state.as_ref().is_some_and(|state| {
        state.active_task_runs.lock().is_empty() && state.pending_agent_requests.lock().is_empty()
    });
    let pending_commands = app_state.as_ref().map_or(0, |state| {
        (state.active_task_runs.lock().len() + state.pending_agent_requests.lock().len()) as u32
    });
    let facts = super::privacy::database_facts(&harness.0.db, harness.profile()).ok();
    let audits_terminal = facts.as_ref().is_some_and(|facts| {
        facts.audits.iter().all(|entry| {
            matches!(
                entry.status,
                atools_core::agent::AuditStatus::Confirmed
                    | atools_core::agent::AuditStatus::Denied
            )
        })
    });
    let main_window_present = crate::window::main_window(app).is_ok();
    let webviews = app.webview_windows();
    let settings_window_count = webviews
        .keys()
        .filter(|label| label.as_str() == "settings" || label.starts_with("ztools-settings-"))
        .count();
    let plugin_window_count = webviews
        .keys()
        .filter(|label| label.starts_with("plugin-"))
        .count();
    let last_outstanding = harness
        .last_evidence()
        .and_then(|evidence| evidence.adapter_outstanding_native_calls);
    let cleanup = json!({
        "boardCleared": board_clear,
        "boardClearVerified": metrics.get("clearVerified").and_then(Value::as_bool).unwrap_or(false),
        "permissionRestored": permission_restored,
        "mainWindowPresent": main_window_present,
        "settingsWindowCount": settings_window_count,
        "pluginWindowCount": plugin_window_count,
        "pendingProbeCount": harness.pending_probe_count(),
        "pendingCommandCount": pending_commands,
        "adapterOutstandingNativeCalls": last_outstanding,
        "taskRunsTerminal": task_terminal,
        "auditsTerminal": audits_terminal,
        "mediaPermitsBefore": harness.media_permits_before(),
        "mediaPermitsAfter": available_media_permits(),
        "probeDisposed": harness.probe_disposed(),
    });
    let code = match report::write(app, harness, cleanup) {
        Ok(true) => 0,
        Ok(false) => 1,
        Err(_) => {
            harness.note_error(report::REPORT_WRITE_FAILED);
            1
        }
    };
    if let Some(status) = app.try_state::<std::sync::Arc<super::super::FixtureExitStatus>>() {
        status
            .code
            .store(code, std::sync::atomic::Ordering::Release);
    }
    app.exit(code);
}

async fn wait_native_terminal(app: &AppHandle<Wry>, timeout: Duration) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let no_active = app
            .try_state::<crate::state::AppState>()
            .is_some_and(|state| {
                state.active_task_runs.lock().is_empty()
                    && state.pending_agent_requests.lock().is_empty()
            });
        if no_active && available_media_permits() == Some(2) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn available_media_permits() -> Option<usize> {
    #[cfg(feature = "legacy-node-smoke")]
    {
        Some(crate::launcher_media_work::available_permits_for_smoke())
    }
    #[cfg(not(feature = "legacy-node-smoke"))]
    {
        None
    }
}
