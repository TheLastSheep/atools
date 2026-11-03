//! One permission-queue-backed TaskRun approval and execution for the isolated fixture.
use atools_core::{
    agent::PendingAgentToolRequest,
    db::Database,
    task_run::{TaskRun, TaskRunStatus},
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const CLIENT_ID: &str = "b235-isolated-native-fixture";
const PERMISSION_WAIT: Duration = Duration::from_secs(15);

pub(super) struct CompletedTool {
    pub evidence: Value,
    pub output: Value,
}

pub(super) async fn execute(
    app: &AppHandle,
    tool_name: &str,
    arguments: Value,
) -> Result<CompletedTool, String> {
    let state = app.state::<crate::state::AppState>();
    let db = state.db.clone();
    let definition = crate::agent_tools::builtin_tool_registry()
        .get(tool_name)
        .cloned()
        .ok_or("Fixture tool is not registered")?;
    let grant_existed_before_start = db
        .is_agent_tool_granted(CLIENT_ID, tool_name)
        .map_err(|_| "Fixture grant state could not be read")?;
    let started = crate::commands::start_agent_tool_background(
        app,
        tool_name.to_owned(),
        arguments.clone(),
        CLIENT_ID.to_owned(),
        false,
        None,
    )?;
    if started.status != TaskRunStatus::Created
        || started.capability_id != tool_name
        || started.input != arguments
        || started.initiator.kind != atools_core::task_run::TaskRunInitiatorType::Agent
        || started.initiator.client_id.as_deref() != Some(CLIENT_ID)
    {
        return Err("Fixture TaskRun did not preserve capability/input identity".into());
    }
    let (approval_path, pending) = if grant_existed_before_start {
        // The shared permission gate sees the persisted fixture grant and
        // executes this confirmed:false run through its normal Allow path.
        // Do not manufacture a second pending request or call the resume path.
        ("existing_fixture_grant_shared_allow", None)
    } else {
        let pending = await_permission(app, &db, &started.id).await?;
        if pending.client_id != CLIENT_ID
            || pending.tool_name != tool_name
            || pending.run_id.as_deref() != Some(started.id.as_str())
            || pending.arguments != arguments
            || pending.scopes != definition.scopes
        {
            return Err("Fixture permission request identity/scope mismatch".into());
        }

        // This fixture-scoped approval is saved only in the fresh isolated
        // database through the shared identity-checked permission queue.
        crate::agent_tools::grant_tool(app, &db, CLIENT_ID, tool_name, Some(&pending.id)).await?;
        let resumed = crate::agent_tools::resume_tool_with_audit(
            app,
            &db,
            CLIENT_ID,
            tool_name,
            arguments.clone(),
            true,
            Some(&started.id),
        )
        .await;
        if resumed.is_error {
            return Err("FIXTURE_TOOL_EXECUTION_FAILED".into());
        }
        ("first_permission_queue_grant", Some(pending))
    };
    let run = await_terminal(&db, &started.id).await?;
    await_background_detached(app, &started.id).await?;
    let pending_left = state
        .pending_agent_requests
        .lock()
        .values()
        .any(|request| request.run_id.as_deref() == Some(started.id.as_str()));
    if pending_left {
        return Err("Fixture permission request did not drain".into());
    }
    if run.capability_id != tool_name || run.input != arguments || !run.status.is_terminal() {
        return Err("Fixture TaskRun identity or terminal state mismatch".into());
    }
    if run.status != TaskRunStatus::Succeeded {
        return Err("FIXTURE_TASK_RUN_NOT_SUCCEEDED".into());
    }
    let granted = db
        .is_agent_tool_granted(CLIENT_ID, tool_name)
        .map_err(|_| "Fixture grant state could not be read")?;
    if !granted {
        return Err("Fixture confirmation was not recorded".into());
    }
    let audits = db
        .list_audit_entries(1000)
        .map_err(|_| "Fixture audit inventory could not be read")?;
    let audit_count = audits
        .iter()
        .filter(|audit| audit.tool_name == tool_name && audit.client_id == CLIENT_ID)
        .count();
    let output = run.output.clone();
    let mut evidence = json!({
        "tool": tool_name,
        "taskRunId": started.id,
        "status": run.status.as_str(),
        "initiatorType": "agent",
        "clientId": CLIENT_ID,
        "inputIdentityMatched": true,
        "approvalPath": approval_path,
        "fixtureGrantExistedBeforeStart": grant_existed_before_start,
        "permissionRequestId": pending.as_ref().map(|request| request.id.as_str()),
        "capabilityScopes": serde_json::to_value(&definition.scopes).unwrap_or(Value::Null),
        "requestedScopes": pending.as_ref()
            .and_then(|request| serde_json::to_value(&request.scopes).ok()),
        "firstPermissionQueueApprovalObserved": pending.is_some(),
        "existingGrantSharedAllowReused": grant_existed_before_start,
        "fixtureScopedApprovalRecorded": granted,
        "physicalUserApprovalObserved": false,
        "auditEntriesForClientAndTool": audit_count,
        "taskAuditIdPresent": run.audit_id.is_some(),
        "errorCount": run.errors.len(),
        "warningCount": run.warnings.len(),
        "output": summarize_output(&output)
    });
    // This is projected from the persisted TaskRun input after exact equality with
    // the requested arguments was checked above; never synthesize it from a case.
    if let Some(identity) = summarize_manifest_input_identity(tool_name, &run.input) {
        evidence["manifestInputIdentity"] = identity;
    }
    Ok(CompletedTool { evidence, output })
}

async fn await_permission(
    app: &AppHandle,
    db: &Database,
    run_id: &str,
) -> Result<PendingAgentToolRequest, String> {
    let deadline = Instant::now() + PERMISSION_WAIT;
    loop {
        let run = db
            .get_task_run(run_id)
            .map_err(|_| "Fixture TaskRun could not be read")?
            .ok_or("Fixture TaskRun disappeared")?;
        if run.status == TaskRunStatus::AwaitingPermission {
            let state = app.state::<crate::state::AppState>();
            return state
                .pending_agent_requests
                .lock()
                .values()
                .find(|request| request.run_id.as_deref() == Some(run_id))
                .cloned()
                .ok_or_else(|| "FIXTURE_PERMISSION_REQUEST_MISSING".into());
        }
        if run.status.is_terminal() || Instant::now() >= deadline {
            return Err("FIXTURE_PERMISSION_WAIT_FAILED".into());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn await_terminal(db: &Database, run_id: &str) -> Result<TaskRun, String> {
    let deadline = Instant::now() + Duration::from_secs(125);
    loop {
        let run = db
            .get_task_run(run_id)
            .map_err(|_| "Fixture TaskRun could not be read")?
            .ok_or("Fixture TaskRun disappeared")?;
        if run.status.is_terminal() {
            return Ok(run);
        }
        if Instant::now() >= deadline {
            return Err("FIXTURE_TASK_RUN_WAIT_TIMEOUT".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn await_background_detached(app: &AppHandle, run_id: &str) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let active = app
            .state::<crate::state::AppState>()
            .active_task_runs
            .lock()
            .contains_key(run_id);
        if !active {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("FIXTURE_BACKGROUND_TASK_DID_NOT_DRAIN".into());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn summarize_output(output: &Value) -> Value {
    const ALLOWED: &[&str] = &[
        "manifestSelection",
        "manifestSha256",
        "status",
        "sourceRevision",
        "planSha256",
        "dependencySetIdSha256",
        "target",
        "packageCount",
        "skippedOptionalCount",
        "cachedBytes",
        "missingCount",
        "archiveBytes",
        "dependencySetPrepared",
        "dependencyTreeSha256",
        "dependencyTreeBytes",
        "cachedArchiveCount",
        "fetchedArchiveCount",
        "verifiedArchiveBytes",
        "elapsedMs",
        "lifecyclesSkipped",
        "unpackedBytes",
        "fileCount",
        "treeSha256",
        "treeEntries",
        "treeFiles",
        "treeBytes",
        "nodeBinaryBytes",
        "nodeBinarySha256",
        "toolchainFingerprintSha256",
        "toolchainHashElapsedMs",
        "workerElapsedMs",
        "dependencyClosureVerified",
        "businessUsabilityVerified",
        "businessOperationVerified",
        "installed",
        "pluginId",
        "buildSteps",
    ];
    let Some(object) = output.as_object() else {
        return Value::Null;
    };
    Value::Object(
        object
            .iter()
            .filter(|(key, _)| ALLOWED.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    )
}

fn summarize_manifest_input_identity(tool_name: &str, input: &Value) -> Option<Value> {
    let inspect = tool_name == super::SOURCE_BUILD_INSPECT;
    let convert = tool_name == super::CONVERT;
    if !inspect && !convert {
        return None;
    }
    let Some(input) = input.as_object() else {
        return Some(json!({"invalidPair":true}));
    };
    let selection = input.get("manifestSelection");
    let expected_hash = input.get("expectedManifestSha256");
    let valid_selection = |value: &Value| {
        value
            .as_str()
            .is_some_and(|value| matches!(value, "root" | "public"))
    };
    let valid_hash = |value: &Value| {
        value.as_str().is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    };
    match (inspect, selection, expected_hash) {
        (_, None, None) => None,
        (true, Some(selection), None) if valid_selection(selection) => {
            Some(json!({"manifestSelection":selection}))
        }
        (false, Some(selection), Some(hash)) if valid_selection(selection) && valid_hash(hash) => {
            Some(json!({"manifestSelection":selection,"expectedManifestSha256":hash}))
        }
        _ => Some(json!({"invalidPair":true})),
    }
}

#[cfg(test)]
mod manifest_selection_tests {
    use super::*;

    #[test]
    fn manifest_output_and_taskrun_input_summary_are_bounded_and_opt_in() {
        let hash = "1ad7c1b5ddd7ce687878d8aca0da319d9f75ef6d77e101ed8a706d6a1d268192";
        let inspect = super::super::SOURCE_BUILD_INSPECT;
        let convert = super::super::CONVERT;
        assert_eq!(
            summarize_output(&json!({"manifestSelection":"public","manifestSha256":hash,
            "manifestCandidates":["not projected"],"private":"not projected"})),
            json!({"manifestSelection":"public","manifestSha256":hash})
        );
        assert_eq!(summarize_manifest_input_identity(inspect, &json!({})), None);
        assert_eq!(summarize_manifest_input_identity(convert, &json!({})), None);
        assert_eq!(
            summarize_manifest_input_identity(inspect, &json!({"manifestSelection":"public"})),
            Some(json!({"manifestSelection":"public"}))
        );
        assert_eq!(
            summarize_manifest_input_identity(inspect, &json!({"manifestSelection":"root"})),
            Some(json!({"manifestSelection":"root"}))
        );
        let pair = json!({"manifestSelection":"public","expectedManifestSha256":hash});
        assert_eq!(
            summarize_manifest_input_identity(convert, &pair),
            Some(pair)
        );
    }

    #[test]
    fn malformed_manifest_input_is_bounded_and_other_tools_are_omitted() {
        let inspect = super::super::SOURCE_BUILD_INSPECT;
        let convert = super::super::CONVERT;
        let invalid = Some(json!({"invalidPair":true}));
        for input in [
            Value::Null,
            json!({"manifestSelection":null}),
            json!({"manifestSelection":7}),
            json!({"manifestSelection":"unknown"}),
            json!({"expectedManifestSha256":"a".repeat(64)}),
            json!({"manifestSelection":"public","expectedManifestSha256":"a".repeat(64)}),
        ] {
            assert_eq!(summarize_manifest_input_identity(inspect, &input), invalid);
        }
        for input in [
            Value::Null,
            json!({"manifestSelection":"public"}),
            json!({"expectedManifestSha256":"a".repeat(64)}),
            json!({"manifestSelection":"public","expectedManifestSha256":null}),
            json!({"manifestSelection":null,"expectedManifestSha256":"a".repeat(64)}),
            json!({"manifestSelection":"root","expectedManifestSha256":7}),
            json!({"manifestSelection":"other","expectedManifestSha256":"a".repeat(64)}),
            json!({"manifestSelection":"public","expectedManifestSha256":"A".repeat(64)}),
            json!({"manifestSelection":"public","expectedManifestSha256":"g".repeat(64)}),
            json!({"manifestSelection":"public","expectedManifestSha256":"short"}),
        ] {
            assert_eq!(summarize_manifest_input_identity(convert, &input), invalid);
        }
        assert_eq!(
            summarize_manifest_input_identity(
                "unrelated_tool",
                &json!({"manifestSelection":"public","expectedManifestSha256":"a".repeat(64)})
            ),
            None
        );
    }
}
