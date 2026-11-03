use crate::plugin_display_runtime::{manager, runtime_state, stop};
use crate::state::AppState;
use atools_core::task_run::{TaskRun, TaskRunStatus};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub(super) struct FrameEvidence(Mutex<Option<Value>>);

impl FrameEvidence {
    pub(super) fn store(&self, frame: Value) {
        *self.0.lock() = Some(frame);
    }

    fn take(&self) -> Option<Value> {
        self.0.lock().take()
    }
}

const SNAPSHOT_OUTPUT_KEYS: &[&str] = &["count", "operation", "status", "transportOnly"];
const FRAME_KEYS: &[&str] = &[
    "calls",
    "passed",
    "ungrantedThrowsWithoutTransport",
    "closeThrowsWithoutTransport",
    "identityConversion",
    "unsupportedConversions",
    "errorCode",
];
const CALL_KEYS: &[&str] = &["elapsedMs", "operation", "valid"];
const OPERATIONS: &[&str] = &[
    "getPrimaryDisplay",
    "getAllDisplays",
    "getCursorScreenPoint",
    "getDisplayNearestPoint",
    "getDisplayMatching",
];

pub(super) fn snapshot_output_is_whitelisted(run: &TaskRun) -> bool {
    let Some(output) = run.output.as_object() else {
        return false;
    };
    let mut keys: Vec<_> = output.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut allowed = SNAPSHOT_OUTPUT_KEYS.to_vec();
    allowed.sort_unstable();
    keys == allowed
        && output.get("operation").and_then(serde_json::Value::as_str) == Some("snapshot")
        && output.get("status").and_then(serde_json::Value::as_str) == Some("completed")
        && output
            .get("transportOnly")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
        && output
            .get("count")
            .and_then(serde_json::Value::as_u64)
            .is_some_and(|n| n > 0 && n <= 32)
        && run.status == TaskRunStatus::Succeeded
}

pub(super) fn frame_report_is_safe(report: &serde_json::Value) -> bool {
    let Some(fields) = report.as_object() else {
        return false;
    };
    if fields.keys().any(|key| !FRAME_KEYS.contains(&key.as_str()))
        || ![
            "passed",
            "ungrantedThrowsWithoutTransport",
            "closeThrowsWithoutTransport",
            "identityConversion",
            "unsupportedConversions",
            "calls",
        ]
        .iter()
        .all(|key| fields.contains_key(*key))
    {
        return false;
    }
    if fields.get("errorCode").is_some_and(|value| {
        !value.as_str().is_some_and(|code| {
            code.starts_with("ERR_ATOOLS_DISPLAY_")
                && code.len() <= 64
                && code
                    .bytes()
                    .all(|b| b.is_ascii_uppercase() || b == b'_' || b.is_ascii_digit())
        })
    }) {
        return false;
    }
    let Some(calls) = fields.get("calls").and_then(serde_json::Value::as_array) else {
        return false;
    };
    calls.len() <= 20
        && calls.iter().all(|call| {
            let Some(item) = call.as_object() else {
                return false;
            };
            let mut keys: Vec<_> = item.keys().map(String::as_str).collect();
            keys.sort_unstable();
            let mut allowed = CALL_KEYS.to_vec();
            allowed.sort_unstable();
            keys == allowed
                && item
                    .get("operation")
                    .and_then(serde_json::Value::as_str)
                    .is_some_and(|op| OPERATIONS.contains(&op))
                && item
                    .get("elapsedMs")
                    .and_then(serde_json::Value::as_f64)
                    .is_some_and(|ms| ms.is_finite() && ms >= 0.0)
                && item
                    .get("valid")
                    .and_then(serde_json::Value::as_bool)
                    .is_some()
        })
}

pub(super) fn successful_snapshot_count(runs: &[TaskRun]) -> usize {
    runs.iter()
        .filter(|run| run.status == TaskRunStatus::Succeeded && snapshot_output_is_whitelisted(run))
        .count()
}

/// Drain the isolated runtime regardless of success, assertion failure, or timeout.
pub(super) async fn finalize(app: &AppHandle, outcome: Result<Value, String>) -> Value {
    let frame = app
        .try_state::<FrameEvidence>()
        .and_then(|evidence| evidence.take());
    let before = runtime_state(app);
    let state = app.state::<AppState>();
    let pending_before = state.db.list_task_runs(1000).ok().map(|runs| {
        runs.iter()
            .filter(|run| run.status == TaskRunStatus::AwaitingPermission)
            .count()
    });
    stop(app).await;
    let after = runtime_state(app);
    let transport_stopped = match manager(app) {
        Ok(runtime) => runtime.server.lock().await.is_none(),
        Err(_) => false,
    };
    let runs_result = state.db.list_task_runs(1000);
    let task_run_query_ok = runs_result.is_ok();
    let runs = runs_result.unwrap_or_default();
    let pending_after = runs
        .iter()
        .filter(|run| run.status == TaskRunStatus::AwaitingPermission)
        .count();
    let all_terminal = task_run_query_ok && runs.iter().all(|run| run.status.is_terminal());
    let snapshot_task_runs = runs
        .iter()
        .filter(|run| {
            run.capability_id.starts_with("atools.host.display.")
                && run.input["operation"] == "request"
        })
        .count();
    let native_snapshots_succeeded = successful_snapshot_count(&runs);
    let mut report = match outcome {
        Ok(value) => value,
        Err(error) => {
            let safe = [
                "Wry display host did not become ready",
                "Display listener started before approval",
                "Unused plugin opened display authority",
                "Foreign Origin was accepted",
                "Invalid display token was accepted",
                "Display payload fields outside the fixed operation were accepted",
                "Rejected request entered TaskRun history",
                "Could not start isolated display iframe",
                "Display iframe deadline exceeded",
                "Display iframe report channel closed",
                "Serialized display bridge assertions failed",
                "Missing display call timings",
                "Display bridge did not complete exactly twenty calls",
                "Native getter calls did not produce twenty terminal TaskRuns",
                "TaskRun output included non-contract display data",
                "Display endpoint credential entered durable history",
                "Raw display metadata entered durable history",
                "Rotated display endpoint remained live",
                "Previous session identifier published credentials after rotation",
                "Successor did not receive a fresh endpoint",
                "Closing old owner did not close the rotated successor",
                "Disabled display capability opened native access",
                "Display runtime did not drain",
                "Fixture left a non-terminal TaskRun",
                "Synthetic grant failed to open display session",
                "Display frame report contained an unexpected field",
                "Rejected request entered audit history",
                "Disabled display endpoint was accepted",
                "Disabled display endpoint created a successful snapshot",
                "Display credentials or metadata entered durable history",
            ]
            .contains(&error.as_str())
            .then_some(error)
            .unwrap_or_else(|| "display_operation_failed".into());
            json!({"passed":false,"failure":safe})
        }
    };
    if let Some(frame) = frame {
        report["frame"] = frame;
    }
    let drained = after["displaySessions"] == 0
        && after["displayIntents"] == 0
        && after["displayInvocations"] == 0
        && task_run_query_ok
        && pending_after == 0
        && all_terminal
        && transport_stopped;
    report["passed"] = json!(report["passed"] == true && drained);
    report["nativeReadPerformed"] = if task_run_query_ok {
        json!(native_snapshots_succeeded > 0)
    } else {
        Value::Null
    };
    report["snapshotTaskRuns"] = json!(snapshot_task_runs);
    report["successfulSnapshots"] = json!(native_snapshots_succeeded);
    report["runtimeCleanup"] = json!({
        "beforeStop":{"sessions":before["displaySessions"],"intents":before["displayIntents"],"invocations":before["displayInvocations"],"pendingPermissionRuns":pending_before},
        "afterStop":{"sessions":after["displaySessions"],"intents":after["displayIntents"],"invocations":after["displayInvocations"],"pendingPermissionRuns":pending_after},
        "transportStopped":transport_stopped,"taskRunQueryOk":task_run_query_ok,"allTaskRunsTerminal":all_terminal,"drained":drained
    });
    report
}
