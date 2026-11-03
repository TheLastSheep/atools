//! Bounded, identifier-free evidence projections for the private native image fixture.
use crate::legacy_runtime::Sessions;
use atools_core::{
    agent::PermissionScope,
    task_run::{TaskRun, TaskRunStatus},
    Database,
};
use serde_json::{json, Value};

const TASK_RUN_LIMIT: usize = 1000;
const METHODS: &[&str] = &[
    "require",
    "call",
    "get",
    "set",
    "construct",
    "readPngPath",
    "nativeImageTransform",
];

pub(super) fn runtime_counts(runtime: &Sessions) -> Value {
    json!({
        "sessions": runtime.sessions.read().len(),
        "intents": runtime.intents.lock().len(),
        "openings": runtime.openings.lock().len(),
        "invocations": runtime.invocations.lock().len(),
    })
}

#[cfg(feature = "legacy-node-smoke")]
pub(super) fn image_snapshot<T: serde::Serialize>(snapshot: &T) -> Value {
    serde_json::to_value(snapshot).unwrap_or(Value::Null)
}

#[cfg(not(feature = "legacy-node-smoke"))]
pub(super) fn image_snapshot<T>(_: &T) -> Value {
    Value::Null
}

pub(super) fn task_run_counts(db: &Database, tool_name: &str, private_paths: &[String]) -> Value {
    let rows = db.list_task_runs(TASK_RUN_LIMIT).map_err(|_| ());
    task_run_projection(rows, tool_name, private_paths, TASK_RUN_LIMIT)
}

fn task_run_projection(
    rows: Result<Vec<TaskRun>, ()>,
    tool_name: &str,
    private_paths: &[String],
    limit: usize,
) -> Value {
    let Ok(runs) = rows else {
        return failed_task_run_projection(limit);
    };
    let fixture_rows: Vec<_> = runs
        .iter()
        .filter(|run| {
            run.capability_id == tool_name
                && run.initiator.client_id.as_deref() == Some("atools-ui")
        })
        .collect();
    let fixture_requests: Vec<_> = fixture_rows
        .iter()
        .copied()
        .filter(|run| run.input.get("operation").and_then(Value::as_str) == Some("request"))
        .collect();
    let fixture_non_requests = fixture_rows.len().saturating_sub(fixture_requests.len());
    let outside_fixture = runs.len().saturating_sub(fixture_rows.len());
    let mut method_counts = empty_histogram();
    for run in &fixture_requests {
        let bucket = match run.input.get("method") {
            None | Some(Value::Null) => "missing",
            Some(Value::String(method)) if METHODS.contains(&method.as_str()) => method.as_str(),
            Some(_) => "other",
        };
        let entry = &mut method_counts[bucket];
        entry["count"] = json!(entry["count"].as_u64().unwrap_or(0) + 1);
        let status = run.status.as_str();
        entry["statusCounts"][status] =
            json!(entry["statusCounts"][status].as_u64().unwrap_or(0) + 1);
    }
    let matching: Vec<_> = fixture_requests
        .iter()
        .copied()
        .filter(|run| {
            run.input.get("method").and_then(Value::as_str) == Some("nativeImageTransform")
        })
        .collect();
    let succeeded = matching
        .iter()
        .filter(|run| run.status == TaskRunStatus::Succeeded)
        .count();
    let failed = matching
        .iter()
        .filter(|run| run.status == TaskRunStatus::Failed)
        .count();
    let terminal = matching.iter().all(|run| run.status.is_terminal());
    let serialized_image_task_rows: Vec<String> = matching
        .iter()
        .filter_map(|run| serde_json::to_string(run).ok())
        .collect();
    let no_private_paths = serialized_image_task_rows.iter().all(|row| {
        private_paths
            .iter()
            .all(|path| path.is_empty() || !row.contains(path))
    });
    let no_image_payload = serialized_image_task_rows
        .iter()
        .all(|row| !row.contains("dataBase64") && !row.contains("data:image/"));
    let method_histogram_rows = method_counts
        .as_object()
        .into_iter()
        .flat_map(|counts| counts.values())
        .map(|entry| entry["count"].as_u64().unwrap_or(0) as usize)
        .sum::<usize>();
    let sample_complete = runs.len() < limit;
    json!({
        "taskRunQuerySucceeded": true,
        "taskRunQueryErrorCode": Value::Null,
        "allTaskRunCount": runs.len(),
        "taskRunSample": {
            "limit": limit,
            "sampleCount": runs.len(),
            "hitLimit": runs.len() >= limit,
            "complete": sample_complete,
        },
        "fixtureTaskRunPartition": {
            "allRows": runs.len(),
            "fixtureRequestRows": fixture_requests.len(),
            "fixtureNonRequestRows": fixture_non_requests,
            "outsideFixtureRows": outside_fixture,
            "partitionSumsMatch": runs.len() == fixture_requests.len() + fixture_non_requests + outside_fixture,
            "methodHistogramRows": method_histogram_rows,
            "methodHistogramMatchesRequestRows": method_histogram_rows == fixture_requests.len(),
            "methodHistogramComplete": sample_complete,
            "methods": method_counts,
        },
        "allTaskRunsTerminal": sample_complete && runs.iter().all(|run| run.status.is_terminal()),
        "sampledTaskRunsTerminal": runs.iter().all(|run| run.status.is_terminal()),
        "imageTaskRunCount": matching.len(),
        "imageTaskRunsTerminal": sample_complete && terminal,
        "sampledImageTaskRunsTerminal": terminal,
        "imageTaskRunSucceededCount": succeeded,
        "imageTaskRunFailedCount": failed,
        "serializedImageTaskRowsContainNoFixturePaths": no_private_paths,
        "serializedImageTaskRowsContainNoImagePayload": no_image_payload,
        "imageTaskRunsExpected": sample_complete
            && matching.len() == 129
            && terminal
            && succeeded == 128
            && failed == 1,
    })
}

fn failed_task_run_projection(limit: usize) -> Value {
    json!({
        "taskRunQuerySucceeded": false,
        "taskRunQueryErrorCode": "task_run_query_failed",
        "allTaskRunCount": 0,
        "taskRunSample": {
            "limit": limit,
            "sampleCount": 0,
            "hitLimit": false,
            "complete": false,
        },
        "fixtureTaskRunPartition": {
            "allRows": 0,
            "fixtureRequestRows": 0,
            "fixtureNonRequestRows": 0,
            "outsideFixtureRows": 0,
            "partitionSumsMatch": false,
            "methodHistogramRows": 0,
            "methodHistogramMatchesRequestRows": false,
            "methodHistogramComplete": false,
            "methods": empty_histogram(),
        },
        "allTaskRunsTerminal": false,
        "sampledTaskRunsTerminal": false,
        "imageTaskRunCount": 0,
        "imageTaskRunsTerminal": false,
        "sampledImageTaskRunsTerminal": false,
        "imageTaskRunSucceededCount": 0,
        "imageTaskRunFailedCount": 0,
        "serializedImageTaskRowsContainNoFixturePaths": false,
        "serializedImageTaskRowsContainNoImagePayload": false,
        "imageTaskRunsExpected": false,
    })
}

fn empty_histogram() -> Value {
    let mut counts = json!({});
    for method in METHODS.iter().copied().chain(["other", "missing"]) {
        counts[method] = empty_method_counts();
    }
    counts
}

fn empty_method_counts() -> Value {
    json!({
        "count": 0,
        "statusCounts": {
            "created": 0,
            "awaiting_permission": 0,
            "running": 0,
            "partial": 0,
            "succeeded": 0,
            "failed": 0,
            "cancelled": 0,
        }
    })
}

#[cfg(test)]
mod tests {
    use super::task_run_projection;
    use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
    use serde_json::{json, Value};

    const TOOL: &str = "fixture-native-image-tool";
    const LIMIT: usize = 1000;

    fn run(index: usize, method: Option<Value>, status: TaskRunStatus) -> TaskRun {
        let mut input = json!({"operation": "request"});
        if let Some(method) = method {
            input["method"] = method;
        }
        let mut row = TaskRun::new(TOOL, TaskRunInitiator::agent("atools-ui"), input);
        row.id = format!("fixture-{index}");
        row.status = status;
        row
    }

    fn image_rows(total: usize) -> Vec<TaskRun> {
        (0..total)
            .map(|index| {
                let (method, status) = match index {
                    0..=127 => ("nativeImageTransform", TaskRunStatus::Succeeded),
                    128 => ("nativeImageTransform", TaskRunStatus::Failed),
                    _ => ("call", TaskRunStatus::Succeeded),
                };
                run(index, Some(json!(method)), status)
            })
            .collect()
    }

    #[test]
    fn complete_sample_reports_partition_and_image_status_counts() {
        let report = task_run_projection(Ok(image_rows(457)), TOOL, &[], LIMIT);
        assert_eq!(report["fixtureTaskRunPartition"]["allRows"], 457);
        assert_eq!(report["fixtureTaskRunPartition"]["fixtureRequestRows"], 457);
        assert_eq!(
            report["fixtureTaskRunPartition"]["partitionSumsMatch"],
            true
        );
        assert_eq!(
            report["fixtureTaskRunPartition"]["methodHistogramRows"],
            457
        );
        assert_eq!(report["imageTaskRunCount"], 129);
        assert_eq!(report["imageTaskRunSucceededCount"], 128);
        assert_eq!(report["imageTaskRunFailedCount"], 1);
        assert_eq!(report["imageTaskRunsExpected"], true);
    }

    #[test]
    fn partition_separates_fixture_requests_nonrequests_and_outside_rows() {
        let mut rows = image_rows(5);
        rows[1].input["method"] = json!("call");
        rows[2].input = json!({"operation": "initialize", "method": "nativeImageTransform"});
        rows[3].initiator = TaskRunInitiator::agent("other-client");
        rows[4].capability_id = "other-tool".to_owned();
        let report = task_run_projection(Ok(rows), TOOL, &[], LIMIT);
        let partition = &report["fixtureTaskRunPartition"];
        assert_eq!(partition["allRows"], 5);
        assert_eq!(partition["fixtureRequestRows"], 2);
        assert_eq!(partition["fixtureNonRequestRows"], 1);
        assert_eq!(partition["outsideFixtureRows"], 2);
        assert_eq!(partition["partitionSumsMatch"], true);
        assert_eq!(partition["methodHistogramRows"], 2);
        assert_eq!(partition["methodHistogramMatchesRequestRows"], true);
        assert_eq!(partition["methods"]["nativeImageTransform"]["count"], 1);
        assert_eq!(partition["methods"]["call"]["count"], 1);
        assert_eq!(report["imageTaskRunCount"], 1);
    }

    #[test]
    fn sample_at_cap_cannot_claim_complete_image_gate() {
        let report = task_run_projection(Ok(image_rows(LIMIT)), TOOL, &[], LIMIT);
        assert_eq!(report["taskRunSample"]["sampleCount"], LIMIT);
        assert_eq!(report["taskRunSample"]["complete"], false);
        assert_eq!(report["sampledTaskRunsTerminal"], true);
        assert_eq!(report["allTaskRunsTerminal"], false);
        assert_eq!(report["imageTaskRunCount"], 129);
        assert_eq!(report["sampledImageTaskRunsTerminal"], true);
        assert_eq!(report["imageTaskRunsTerminal"], false);
        assert_eq!(report["imageTaskRunsExpected"], false);
    }

    #[test]
    fn query_failure_is_fixed_and_incomplete() {
        let report = task_run_projection(Err(()), TOOL, &[], LIMIT);
        assert_eq!(report["taskRunQuerySucceeded"], false);
        assert_eq!(report["taskRunQueryErrorCode"], "task_run_query_failed");
        assert_eq!(report["taskRunSample"]["complete"], false);
        assert_eq!(report["imageTaskRunsExpected"], false);
        assert!(report.to_string().find("database secret").is_none());
    }

    #[test]
    fn unknown_and_malformed_methods_are_bucketed_without_echo() {
        let secret = "private-method-should-not-appear";
        let rows = vec![
            run(1, Some(json!(secret)), TaskRunStatus::Succeeded),
            run(2, Some(json!(17)), TaskRunStatus::Failed),
            run(3, None, TaskRunStatus::Succeeded),
            run(4, Some(Value::Null), TaskRunStatus::Succeeded),
        ];
        let report = task_run_projection(Ok(rows), TOOL, &[], LIMIT);
        assert_eq!(
            report["fixtureTaskRunPartition"]["methods"]["other"]["count"],
            2
        );
        assert_eq!(
            report["fixtureTaskRunPartition"]["methods"]["missing"]["count"],
            2
        );
        assert!(!report.to_string().contains(secret));
    }
}

pub(super) fn grant_evidence(db: &Database, tool_name: &str) -> Value {
    let definition = db.get_agent_tool(tool_name).ok().flatten();
    let grants = db.list_agent_tool_grants().unwrap_or_default();
    let host_clipboard_grants = grants
        .iter()
        .filter(|grant| {
            db.get_agent_tool(&grant.tool_name)
                .ok()
                .flatten()
                .is_some_and(|tool| tool.source == "host_clipboard")
        })
        .count();
    let fixture_grants = grants
        .iter()
        .filter(|grant| grant.client_id == "atools-ui" && grant.tool_name == tool_name)
        .count();
    let only_fixture_grant = grants.len() == 1 && fixture_grants == 1;
    let scopes = definition.as_ref().map(|tool| &tool.scopes);
    let legacy_node_source = definition
        .as_ref()
        .is_some_and(|tool| tool.source == crate::legacy_runtime::registry::SOURCE);
    let scope_count = scopes.map_or(0, Vec::len);
    let has = |scope| scopes.is_some_and(|scopes| scopes.contains(&scope));
    json!({
        "fixtureLegacyNodeGrantCount": fixture_grants,
        "allDatabaseGrantCount": grants.len(),
        "onlyFixtureLegacyNodeGrant": only_fixture_grant,
        "fixtureToolIsRegisteredLegacyNode": legacy_node_source,
        "hostClipboardGrantCount": host_clipboard_grants,
        "legacyNodeScopeCount": scope_count,
        "legacyNodeHasFileRead": has(PermissionScope::FileRead),
        "legacyNodeHasFileWrite": has(PermissionScope::FileWrite),
        "legacyNodeHasNetwork": has(PermissionScope::Network),
        "legacyNodeHasShell": has(PermissionScope::Shell),
        "legacyNodeHasClipboardRead": has(PermissionScope::ClipboardRead),
        "legacyNodeHasClipboardWrite": has(PermissionScope::ClipboardWrite),
        "legacyNodeHasScreenshot": has(PermissionScope::Screenshot),
        "legacyNodeHasBrowserContext": has(PermissionScope::BrowserContext),
        "legacyNodeHasPluginData": has(PermissionScope::PluginData),
        "legacyNodeHasSystemSettings": has(PermissionScope::SystemSettings),
    })
}
