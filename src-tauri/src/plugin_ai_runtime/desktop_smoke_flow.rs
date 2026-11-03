//! Bounded acceptance of the real native AI commands, permission gate and Channel.
use super::{desktop_smoke_fixture::PROMPTS, EventReader};
use atools_core::{
    agent::PermissionScope,
    task_run::{TaskRunInitiatorType, TaskRunStatus},
    Database, Plugin,
};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{Manager, WebviewWindow};

const CASES: [(&str, &str); 5] = [
    ("pending_cancel", "stream"),
    ("stream", "stream"),
    ("collect", "collect"),
    ("ack_wait", "stream"),
    ("no_delta", "stream"),
];

pub(super) async fn run(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    plugin: &Plugin,
    db: &Database,
    events: &mut EventReader,
    ready: tokio::sync::oneshot::Receiver<()>,
    provider_url: &str,
    settings_for_flow: &str,
) -> Result<Value, String> {
    tokio::time::timeout(Duration::from_secs(10), ready)
        .await
        .map_err(|_| "fixture_ready_timeout")?
        .map_err(|_| "fixture_ready_closed")?;

    let disabled = events.wait("initial-models", None, 10).await?;
    if disabled["configured"] != false || disabled["count"] != 0 || disabled["error"] == true {
        return Err("disabled_provider_models_not_empty".into());
    }
    set_settings(window, events, settings_for_flow, "disabled-model-probe").await?;
    let mut without_model: Value =
        serde_json::from_str(settings_for_flow).map_err(|_| "fixture_settings_parse_failed")?;
    without_model
        .as_object_mut()
        .ok_or("fixture_settings_not_object")?
        .remove("aiDefaultModel");
    let missing_model =
        serde_json::to_string(&without_model).map_err(|_| "fixture_settings_encode_failed")?;
    set_settings(window, events, &missing_model, "missing-model-probe").await?;
    evaluate(
        window,
        "fixtureProbeModels",
        &json!({"caseName":"missing-model-probe"}),
    )?;
    let missing = events
        .wait("model-probe", Some("missing-model-probe"), 10)
        .await?;
    if missing["configured"] != false || missing["count"] != 0 || missing["error"] == true {
        return Err("missing_default_model_not_empty".into());
    }
    set_settings(window, events, settings_for_flow, "restore-model-probe").await?;

    let before_oversize = super::runtime_snapshot(app);
    let state = app.state::<crate::state::AppState>();
    let pending_before = state.pending_agent_requests.lock().len();
    let tasks_before = state.active_task_runs.lock().len();
    let run_rows_before = db
        .list_task_runs(32)
        .map_err(|_| "oversize_task_scan_failed")?
        .len();
    evaluate(window, "fixtureOversize", &json!({}))?;
    let oversize = events.wait("oversize-result", None, 10).await?;
    let after_oversize = super::runtime_snapshot(app);
    if oversize["rejected"] != true
        || oversize["budgetRejected"] != true
        || oversize["requestBytes"].as_u64().unwrap_or(0) <= 3 * 1024 * 1024
        || before_oversize != after_oversize
        || state.pending_agent_requests.lock().len() != pending_before
        || state.active_task_runs.lock().len() != tasks_before
        || db
            .list_task_runs(32)
            .map_err(|_| "oversize_task_scan_failed")?
            .len()
            != run_rows_before
    {
        return Err("oversized_request_occupied_runtime_slot".into());
    }

    let tool = crate::plugin_ai_runtime::registry::tool_name(&plugin.id);
    let mut cases = Vec::new();
    let mut provider_index = 0usize;
    for (case, mode) in CASES {
        let request_id = uuid::Uuid::new_v4().to_string();
        let spec = json!({"caseName":case,"mode":mode,"clientRequestId":request_id,
            "prompt":if case=="pending_cancel" {"pending approval cancellation"} else {PROMPTS[provider_index]}});
        evaluate(window, "fixtureStart", &spec)?;
        let pending = events.wait("pending", Some(case), 10).await?;
        let request = request_id_value(&pending, &request_id)?;
        let run_id = pending["runId"].as_str().ok_or("pending_run_id_missing")?;
        if pending["permissionRequired"] != true
            || pending["foreignExecuteRejected"] != true
            || pending["foreignAckRejected"] != true
            || pending["foreignCancelRejected"] != true
            || pending["staleRejected"] != true
            || pending["model"] != "fixture-model"
        {
            return Err("pending_contract_mismatch".into());
        }
        validate_pending(app, db, plugin, &tool, run_id, request)?;

        if case == "pending_cancel" {
            if crate::permission_requests::find_for_run(app, run_id).is_none() {
                return Err("pending_cancel_permission_not_present".into());
            }
            evaluate(
                window,
                "fixtureCancel",
                &json!({"caseName":case,"requestId":request}),
            )?;
            let cancel = events.wait("cancel-result", Some(case), 5).await?;
            if cancel["accepted"] != true || cancel["taskStatus"] != "cancelled" {
                return Err("pending_approval_cancel_not_terminal".into());
            }
            let run = db
                .get_task_run(run_id)
                .map_err(|_| "pending_cancel_task_read_failed")?
                .ok_or("pending_cancel_task_missing")?;
            let state = app.state::<crate::state::AppState>();
            if run.status != TaskRunStatus::Cancelled
                || crate::permission_requests::find_for_run(app, run_id).is_some()
                || !super::counts_are_zero(&super::runtime_snapshot(app))
                || !state.pending_agent_requests.lock().is_empty()
                || !state.active_task_runs.lock().is_empty()
            {
                return Err("pending_approval_cancel_cleanup_failed".into());
            }
            if db
                .is_agent_tool_granted("atools-ui", &tool)
                .map_err(|_| "grant_read_failed")?
            {
                return Err("pending_cancel_created_saved_grant".into());
            }
            cases.push(json!({"case":case,"taskStatus":run.status.as_str(),"permission":"network_once",
                "providerRequest":false,"requestCleaned":true,"runtimeCounts":super::runtime_snapshot(app),
                "maxEnvelopeBytes":0}));
            continue;
        }

        evaluate(
            window,
            "fixtureResume",
            &json!({"caseName":case,"requestId":request,
            "runId":run_id,"tool":tool} ),
        )?;

        let provider = events.wait("provider_request", None, 10).await?;
        if provider["index"] != provider_index
            || provider["requestValid"] != true
            || provider["fixtureAuthorization"] != true
        {
            return Err("provider_request_mismatch".into());
        }
        provider_index += 1;

        let mut cancel_accepted = false;
        let mut settings_changed = false;
        if case == "ack_wait" {
            let held = events.wait("ack-held", Some(case), 10).await?;
            if held["seq"] != 1 {
                return Err("ack_sequence_mismatch".into());
            }
            evaluate(
                window,
                "fixtureCancel",
                &json!({"caseName":case,"requestId":request}),
            )?;
            let cancel = events.wait("cancel-result", Some(case), 5).await?;
            cancel_accepted = cancel["accepted"] == true;
            if !cancel_accepted {
                return Err("ack_cancel_rejected".into());
            }
        } else if case == "no_delta" {
            let changed = settings_value(db, provider_url)?;
            evaluate(window, "fixtureChangeSettings", &json!({"value":changed}))?;
            let result = events.wait("settings-result", Some(case), 5).await?;
            settings_changed = result["changed"] == true;
            if !settings_changed {
                return Err("settings_change_rejected".into());
            }
        }

        let completed = events.wait("completed", Some(case), 20).await?;
        let status = completed["taskStatus"]
            .as_str()
            .ok_or("terminal_status_missing")?;
        let channel_events = events.take_case("channel", case);
        match case {
            "stream" => {
                if completed["callSucceeded"] != true
                    || status != "succeeded"
                    || completed["sequenceCorrect"] != true
                    || completed["contentExact"] != true
                    || completed["reasoningExact"] != true
                    || completed["finalContentExact"] != true
                    || completed["maxEnvelopeBytes"].as_u64().unwrap_or(u64::MAX) > 16_384
                    || completed["channelCount"].as_u64().unwrap_or(0) < 3
                    || !channel_events
                        .iter()
                        .any(|event| event["hasContent"] == true)
                    || !channel_events
                        .iter()
                        .any(|event| event["hasReasoning"] == true)
                    || !labels(
                        &channel_events[channel_events.len().saturating_sub(2)..],
                        &["content_final", "terminal_succeeded"],
                    )
                    || !channel_events.iter().all(|event| event["acked"] == true)
                {
                    return Err("stream_contract_mismatch".into());
                }
            }
            "collect" => {
                if completed["callSucceeded"] != true
                    || status != "succeeded"
                    || completed["sequenceCorrect"] != true
                    || completed["channelCount"] != 1
                    || completed["outputTaken"] != true
                    || completed["outputExact"] != true
                    || completed["maxEnvelopeBytes"].as_u64().unwrap_or(u64::MAX) > 16_384
                    || !labels(&channel_events, &["terminal_succeeded"])
                {
                    return Err("collect_contract_mismatch".into());
                }
            }
            "ack_wait" => {
                if !cancel_accepted
                    || status != "cancelled"
                    || completed["channelCount"] != 1
                    || channel_events.len() != 1
                    || channel_events[0]["hasContent"] != true
                        && channel_events[0]["hasReasoning"] != true
                    || channel_events[0]["envelopeBytes"]
                        .as_u64()
                        .unwrap_or(u64::MAX)
                        > 16_384
                    || channel_events[0]["acked"] != false
                {
                    return Err("ack_cancel_contract_mismatch".into());
                }
            }
            "no_delta" => {
                if !settings_changed
                    || status != "cancelled"
                    || completed["channelCount"] != 0
                    || !channel_events.is_empty()
                {
                    return Err("configuration_cancel_contract_mismatch".into());
                }
            }
            _ => return Err("unknown_fixture_case".into()),
        }
        let run = db
            .get_task_run(run_id)
            .map_err(|_| "final_task_read_failed")?
            .ok_or("final_task_missing")?;
        if (case == "stream" || case == "collect") && run.status != TaskRunStatus::Succeeded
            || case == "no_delta" && run.status != TaskRunStatus::Cancelled
            || case == "ack_wait" && run.status != TaskRunStatus::Cancelled
        {
            return Err("final_task_status_mismatch".into());
        }
        if db
            .is_agent_tool_granted("atools-ui", &tool)
            .map_err(|_| "grant_read_failed")?
        {
            return Err("once_approval_persisted_as_grant".into());
        }
        let runtime_counts = super::runtime_snapshot(app);
        let request_cleaned = super::counts_are_zero(&runtime_counts);
        if !request_cleaned {
            return Err("request_not_cleaned".into());
        }
        cases.push(json!({"case":case,"taskStatus":run.status.as_str(),"permission":"network_once",
            "streamSequence":if case=="stream" {"content,reasoning,final,terminal"} else {"not_applicable"},
            "collectResultExact":case=="collect" && completed["outputExact"]==true,
            "contentExact":completed["contentExact"],"reasoningExact":completed["reasoningExact"],
            "maxEnvelopeBytes":completed["maxEnvelopeBytes"],
            "cancelAccepted":cancel_accepted,"settingsInvalidated":settings_changed,
            "requestCleaned":request_cleaned,"runtimeCounts":runtime_counts}));
    }
    let audit = db.list_audit_entries(32).map_err(|_| "audit_read_failed")?;
    let tasks = db.list_task_runs(32).map_err(|_| "task_read_failed")?;
    let private_payloads = serde_json::to_string(&json!({"audit":audit,"tasks":tasks}))
        .map_err(|_| "privacy_scan_failed")?;
    let long_content = "c".repeat(super::desktop_smoke_fixture::FIRST_PART_CHARS);
    let long_reasoning = "r".repeat(super::desktop_smoke_fixture::FIRST_PART_CHARS);
    for secret in PROMPTS.iter().chain(
        [
            "pending approval cancellation",
            "fixture-content-one",
            "fixture-content-final",
            "fixture-reasoning",
            "fixture-only-not-a-real-key",
        ]
        .iter(),
    ) {
        if private_payloads.contains(secret) {
            return Err("private_payload_persisted".into());
        }
    }
    if private_payloads.contains(&long_content) || private_payloads.contains(&long_reasoning) {
        return Err("long_provider_payload_persisted".into());
    }
    let runtime_counts = super::runtime_snapshot(app);
    let runtime_empty = super::counts_are_zero(&runtime_counts);
    let task_maps_empty = app
        .state::<crate::state::AppState>()
        .pending_agent_requests
        .lock()
        .is_empty()
        && app
            .state::<crate::state::AppState>()
            .active_task_runs
            .lock()
            .is_empty();
    if !runtime_empty || !task_maps_empty {
        return Err("runtime_not_drained".into());
    }
    let observed_max_envelope = cases
        .iter()
        .filter_map(|case| case["maxEnvelopeBytes"].as_u64())
        .max()
        .unwrap_or(0);
    Ok(
        json!({"passed":true,"cases":cases,"requests":4,"runtimeDrained":runtime_empty,
        "runtimeCounts":runtime_counts,
        "permissionQueueDrained":task_maps_empty,"taskRunPrivacyChecked":true,
        "disabledProviderModelsEmpty":true,"missingModelModelsEmpty":true,
        "oversizeRejectedWithoutSlot":true,"observedMaxEnvelopeBytes":observed_max_envelope,
        "maximumChannelEnvelopeBytes":16_384,
        "approvalPath":"existing confirmed exact-run API; no saved grant"}),
    )
}

async fn set_settings(
    window: &WebviewWindow,
    events: &mut EventReader,
    value: &str,
    case: &str,
) -> Result<(), String> {
    evaluate(
        window,
        "fixtureSetSettings",
        &json!({"value":value,"caseName":case}),
    )?;
    let result = events.wait("settings-result", Some(case), 5).await?;
    if result["changed"] != true {
        return Err("fixture_settings_write_failed".into());
    }
    Ok(())
}

fn validate_pending(
    app: &tauri::AppHandle,
    db: &Database,
    plugin: &Plugin,
    tool: &str,
    run_id: &str,
    request_id: &str,
) -> Result<(), String> {
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "pending_task_read_failed")?
        .ok_or("pending_task_missing")?;
    let expected_input = json!({"operation":"execute","requestId":request_id});
    let pending = crate::permission_requests::find_for_run(app, run_id)
        .ok_or("pending_permission_missing")?;
    if run.status != TaskRunStatus::AwaitingPermission
        || run.capability_id != tool
        || run.initiator.kind != TaskRunInitiatorType::Human
        || run.initiator.client_id.as_deref() != Some("atools-ui")
        || run.input != expected_input
        || run.output["permission_required"] != true
        || run.output["request_id"] != pending.id
        || pending.client_id != "atools-ui"
        || pending.tool_name != tool
        || pending.arguments != expected_input
        || pending.run_id.as_deref() != Some(run_id)
        || pending.scopes.as_slice() != [PermissionScope::Network]
        || run.output["scopes"] != json!(["network"])
        || plugin.id != "isolated-native-ai-fixture"
    {
        return Err("pending_task_permission_identity_mismatch".into());
    }
    Ok(())
}

fn request_id_value<'a>(event: &'a Value, expected_client_id: &'a str) -> Result<&'a str, String> {
    let actual = event["requestId"]
        .as_str()
        .ok_or("pending_request_id_missing")?;
    let parsed = uuid::Uuid::parse_str(actual).map_err(|_| "pending_request_id_invalid")?;
    if parsed.to_string() != actual || event["clientRequestId"] != expected_client_id {
        return Err("pending_request_identity_mismatch".into());
    }
    Ok(actual)
}

fn evaluate(window: &WebviewWindow, function: &str, args: &Value) -> Result<(), String> {
    let payload = serde_json::to_string(args).map_err(|_| "fixture_args_encode_failed")?;
    window
        .eval(&format!("void window.{function}({payload});"))
        .map_err(|_| "fixture_page_call_failed".into())
}

fn labels(events: &[Value], expected: &[&str]) -> bool {
    events.len() == expected.len()
        && events
            .iter()
            .zip(expected)
            .all(|(event, label)| event["label"] == *label)
}

fn settings_value(db: &Database, provider_url: &str) -> Result<String, String> {
    let raw = db
        .get_setting("settings-general")
        .map_err(|_| "settings_read_failed")?
        .ok_or("settings_missing")?;
    let mut value: Value = serde_json::from_str(&raw).map_err(|_| "settings_parse_failed")?;
    value["aiTemperature"] = json!(0.7);
    value["aiBaseUrl"] = json!(provider_url);
    serde_json::to_string(&value).map_err(|_| "settings_encode_failed".into())
}
