//! Actual manager shutdown and the existing identity/TaskRun/drain acceptance gate.
use super::{lifecycle::Lifecycle, profile_digest, PublishedFixture};
use atools_core::Database;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{AppHandle, Manager};

pub(super) async fn run(
    app: AppHandle,
    db: Arc<Database>,
    receiver: tokio::sync::oneshot::Receiver<Value>,
    package_verification: Value,
    passed: Arc<AtomicBool>,
) {
    let fixture = app.state::<PublishedFixture>();
    let report_profile = fixture.profile.clone();
    let report_run_id = fixture.run_id.clone();
    let native_ui_input = fixture.native_ui_input;
    let worker_contract_only = fixture.worker_contract_only;
    let reviewed_deepread_handoff = fixture.converted_handoff.as_ref().is_some_and(|handoff| {
        handoff.case_id == "converted-deepread-source"
            && handoff.plugin_id == "deepread"
            && handoff.plugin_version == "1.1.2"
    });
    let lifecycle = app.state::<Arc<Lifecycle>>().inner().clone();
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(if native_ui_input { 300 } else { 90 }),
        receiver,
    )
    .await;
    let (phase, mut report) = match result {
        Ok(Ok(value)) => ("frontend-report-received", value),
        Ok(Err(_)) => (
            "report-channel-closed",
            json!({"passed":false,"error":"Published plugin report channel closed"}),
        ),
        Err(_) => (
            "report-timeout",
            json!({"passed":false,"error":"Published plugin report timed out"}),
        ),
    };
    lifecycle.received(phase, &report);
    if !report.is_object() {
        report = json!({"passed":false,"error":"Published plugin report must be an object"});
    }
    report["preExecutionSourceVerification"] = package_verification;
    let _ = lifecycle.phase("cleanup-resources-start");
    crate::plugin_asset_protocol::invalidate_plugin(
        &app,
        report_profile["id"].as_str().unwrap_or(""),
    );
    crate::plugin_asset_protocol::close_window(&app, "main");
    let _ = lifecycle.phase("cleanup-resources-complete");
    let _ = lifecycle.phase("cleanup-display-start");
    crate::plugin_display_runtime::stop(&app).await;
    let _ = lifecycle.phase("cleanup-display-complete");
    let _ = lifecycle.phase("cleanup-dialogs-start");
    crate::plugin_dialog_runtime::stop(&app).await;
    let _ = lifecycle.phase("cleanup-dialogs-complete");
    let _ = lifecycle.phase("cleanup-paths-start");
    crate::plugin_system_paths::stop(&app);
    let _ = lifecycle.phase("cleanup-paths-complete");
    let _ = lifecycle.phase("cleanup-data-start");
    crate::plugin_data_runtime::stop(&app).await;
    let _ = lifecycle.phase("cleanup-data-complete");
    let _ = lifecycle.phase("cleanup-legacy-start");
    // This isolated WebView is labeled `main`. Reuse the production window-close
    // path so pending Node TaskRuns are cancelled and their paired requests removed
    // before the fixture's final TaskRun/permission snapshot.
    crate::legacy_runtime::close_window(&app, "main").await;
    let runtime = app.state::<Arc<crate::legacy_runtime::Sessions>>();
    runtime.stop_all().await;
    let _ = lifecycle.phase("cleanup-legacy-complete");
    let _ = lifecycle.phase("cleanup-host-start");
    if let Ok(host) = crate::host_runtime::manager(&app) {
        host.close(None, None, true).await;
    }
    let _ = lifecycle.phase("cleanup-host-complete");
    let _ = lifecycle.phase("task-runs-start");
    let runs_result = db.list_task_runs(1000);
    let task_run_query_ok = runs_result.is_ok();
    if let Err(error) = &runs_result {
        report["taskRunQueryError"] = json!(error.to_string());
    }
    let runs = runs_result.unwrap_or_default();
    report["taskRunCount"] = json!(runs.len());
    report["taskRunsSummary"] = json!(runs
        .iter()
        .map(|run| {
            let mut summary = json!({
                "capabilityId":run.capability_id,
                "status":run.status.as_str(),
                "summary":run.summary,
            });
            if let (Some(target), Value::Object(fields)) = (
                summary.as_object_mut(),
                crate::plugin_data_runtime::task_run_audit_fields(
                    &run.capability_id,
                    run.status.as_str(),
                    &run.input,
                    run.summary.as_deref(),
                ),
            ) {
                target.extend(fields);
            }
            summary
        })
        .collect::<Vec<_>>());
    report["taskRunsTerminal"] =
        json!(task_run_query_ok && runs.iter().all(|run| run.status.is_terminal()));
    let _ = lifecycle.phase("task-runs-complete");
    let _ = lifecycle.phase("final-runtime-start");
    report["finalRuntimeState"] = super::native_published_state(&app).await;
    let _ = lifecycle.phase("final-runtime-complete");
    let final_state = report["finalRuntimeState"].clone();
    let runtime_drained = final_runtime_drained(&final_state);
    report["finalRuntimeDrained"] = json!(runtime_drained);
    let diagnostics_required = startup_diagnostics_required(
        native_ui_input,
        worker_contract_only,
        &report_profile,
        reviewed_deepread_handoff,
    );
    let node_startup_diagnostics_verified =
        startup_diagnostics_verified(&final_state, diagnostics_required);
    report["nodeStartupDiagnosticsVerified"] =
        node_startup_diagnostics_verified.map_or(Value::Null, |verified| json!(verified));
    report["nodeStartupDiagnosticsStatus"] = json!(startup_diagnostics_status(
        &final_state,
        node_startup_diagnostics_verified,
    ));
    let execution_mode = if worker_contract_only {
        "original_worker_contract"
    } else {
        "original_ui"
    };
    let identity_valid = report["runId"] == report_run_id
        && report["profile"] == report_profile
        && report["executionMode"] == execution_mode
        && report["packageSha256"] == *profile_digest(&report_profile);
    report["identityValid"] = json!(identity_valid);
    report["scope"] = json!({"package":format!("{}@{}",report_profile["id"].as_str().unwrap_or(""),report_profile["version"].as_str().unwrap_or("")),
                    "profile":report_profile,"entry":if report_profile["sourceKind"]=="local_original_archive" { "real original ZPX import; explicitly disable, then enable; market installation excluded" } else { "real directory import; explicitly disable, then enable; market installation excluded" },
                    "businessAssertions":"See observations.business.tested; original pinned UI and explicitly scoped preload contract operations",
                    "executionMode":execution_mode,
                    "inputMethod":if native_ui_input { "external OS UI control with trusted event assertions; no human hardware claim" } else { "fixture operations" },
                    "notTested":["market installation","physical keyboard","physical pointer","foreground paint/visual comparison","unregistered community plugins"],
                    "aiScope":"No AI operation is selected; optional offline API guard and runtime diagnostics are checked, not an AI request counter",
                    "networkBoundary":"WebView CSP blocks external origins and permits only app/asset/IPC schemes plus 127.0.0.1 loopback; Node is not OS-network-sandboxed",
                    "runtime":"real production App/PluginPanel and Rust importer/search/activation/permission pipeline; temporary DB; backgroundServices=false"});
    report["sourceKind"] = report_profile["sourceKind"]
        .as_str()
        .map_or(json!("official_published_archive"), |kind| json!(kind));
    let success = report["passed"] == true
        && report["taskRunsTerminal"] == true
        && identity_valid
        && runtime_drained
        && node_startup_diagnostics_verified != Some(false);
    report["passed"] = json!(success);
    report["cleanupComplete"] = json!(runtime_drained && report["taskRunsTerminal"] == true);
    report["cleanupStatus"] = json!(if report["cleanupComplete"] == true {
        "complete"
    } else {
        "incomplete"
    });
    let success = lifecycle.finalize(report).unwrap_or(false);
    passed.store(success, Ordering::Release);
    app.exit(if success { 0 } else { 1 });
}

fn final_runtime_drained(final_state: &Value) -> bool {
    [
        "resourceLeases",
        "legacySessions",
        "legacyOpenings",
        "pendingRequests",
        "hostSessions",
        "hostIntents",
        "hostInvocations",
        "displaySessions",
        "displayIntents",
        "displayInvocations",
        "dataSessions",
        "dataIntents",
        "dataInvocations",
        "dataPreparations",
        "activePathSnapshots",
        "activePathIntents",
        "activePathPreparations",
        "pathSnapshotBytes",
        "dialogSessions",
        "dialogIntents",
        "dialogInvocations",
        "dialogPreparations",
        "nativeDialogs",
    ]
    .iter()
    .all(|key| final_state[key].as_u64() == Some(0))
        && final_state["pathRuntimeAvailable"] == true
        && [
            "legacyTransport",
            "hostTransport",
            "dataTransport",
            "dialogTransport",
        ]
        .iter()
        .all(|key| final_state[key] == false)
}

fn startup_diagnostics_verified(final_state: &Value, required: bool) -> Option<bool> {
    if !required {
        return None;
    }
    let Some(diagnostics) = final_state.get("nodeStartupDiagnostics") else {
        return Some(false);
    };
    Some(diagnostics["associationVerified"] == true && diagnostics["captureStatus"] == "verified")
}

fn startup_diagnostics_status(final_state: &Value, verified: Option<bool>) -> &'static str {
    match verified {
        None => "not_applicable",
        Some(true) => "verified",
        Some(false) => {
            let Some(diagnostics) = final_state.get("nodeStartupDiagnostics") else {
                return "not_configured";
            };
            match diagnostics["captureStatus"].as_str() {
                Some("not_exercised") => "not_exercised",
                _ => "incomplete",
            }
        }
    }
}

fn startup_diagnostics_required(
    native_ui_input: bool,
    worker_contract_only: bool,
    profile: &Value,
    reviewed_deepread_handoff: bool,
) -> bool {
    let editor_fixture = native_ui_input
        && !worker_contract_only
        && profile["runtime"] == "node"
        && matches!(
            (profile["caseId"].as_str(), profile["id"].as_str()),
            (Some("local-json-editor"), Some("json-editor"))
                | (Some("local-plain-text"), Some("plain-text"))
        );
    editor_fixture
        || (!worker_contract_only
            && reviewed_deepread_handoff
            && profile["caseId"] == "converted-deepread-source"
            && profile["id"] == "deepread"
            && profile["version"] == "1.1.2"
            && profile["runtime"] == "web")
}

#[cfg(test)]
#[path = "desktop_smoke_published_shutdown_tests.rs"]
mod tests;
