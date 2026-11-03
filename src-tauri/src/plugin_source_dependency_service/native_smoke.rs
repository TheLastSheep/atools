//! Opt-in, isolated native proof of inspect → fetch → prepare → convert.
#[path = "native_smoke_case.rs"]
mod case;
#[path = "native_smoke_fixture.rs"]
mod fixture;
#[path = "native_smoke_handoff.rs"]
mod handoff;
#[path = "native_smoke_manifest_selection.rs"]
mod manifest_selection;
#[path = "native_smoke_task.rs"]
mod task;
#[path = "native_smoke_tree.rs"]
mod tree;

use crate::{
    pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime},
    state::AppState,
};
use async_trait::async_trait;
use atools_core::{task_run::TaskRun, AppConfig, Database};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
use tauri::{Manager, RunEvent};

const INSPECT: &str = "inspect_ztools_source_dependencies";
const FETCH: &str = "fetch_ztools_source_dependencies";
const PREPARE: &str = "prepare_ztools_source_dependencies";
const CONVERT: &str = "convert_ztools_plugin";
const SOURCE_BUILD_INSPECT: &str = crate::plugin_source_build::registry::INSPECT_TOOL;
const MAX_TASK_RUN_ERROR_CODES: usize = 8;
const MAX_TASK_RUN_ERROR_CODE_BYTES: usize = 64;

struct DisabledPasteboard(Arc<AtomicUsize>);

#[async_trait]
impl PasteboardBackend for DisabledPasteboard {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Source-dependency fixture disables clipboard access".into())
    }
    async fn write_item(
        &self,
        _: &atools_core::PasteboardItem,
        _: &Path,
        _: bool,
    ) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Source-dependency fixture disables clipboard access".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Source-dependency fixture disables clipboard access".into())
    }
}

pub(crate) fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Source-dependency native fixture supports macOS only".into());
    }
    let args = std::env::args().collect::<Vec<_>>();
    let fixture = fixture::prepare(&args)?;
    let config = AppConfig::with_base_dir(fixture.app_data.clone());
    config
        .ensure_dirs()
        .map_err(|_| "Private app-data directories could not be created")?;
    let db = Arc::new(
        Database::open(&config.db_path())
            .map_err(|_| "Private fixture database could not be opened")?,
    );
    db.set_setting("agent.permission_mode", "conservative")
        .map_err(|_| "Fixture permission mode could not be set")?;
    crate::agent_tools::sync_builtin_tools(&db)
        .map_err(|_| "Fixture capabilities could not be registered")?;
    let clipboard_calls = Arc::new(AtomicUsize::new(0));
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(DisabledPasteboard(clipboard_calls.clone())),
        db.clone(),
        &config,
    )?);
    let app_state = AppState::new(config, db.clone(), None, pasteboard);
    let cache_override = super::service::IsolatedCacheRoot::new(fixture.cache.clone())?;
    let result = Arc::new(Mutex::new(None::<Value>));
    let result_for_setup = result.clone();
    let fixture_for_setup = fixture.clone_for_app();
    let db_for_setup = db.clone();

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.source-dependency-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    let app = tauri::Builder::default()
        .manage(app_state)
        .manage(cache_override)
        .setup(move |app| {
            let handle = app.handle().clone();
            let result = result_for_setup.clone();
            let fixture = fixture_for_setup.clone();
            let db = db_for_setup.clone();
            let clipboard_calls = clipboard_calls.clone();
            tauri::async_runtime::spawn(async move {
                let report = execute_scenario(&handle, &fixture, &db, clipboard_calls).await;
                let code = if report.get("passed").and_then(Value::as_bool) == Some(true) {
                    0
                } else {
                    1
                };
                *result.lock() = Some(report);
                handle.exit(code);
            });
            Ok(())
        })
        .build(context)
        .map_err(|_| "Isolated Tauri application could not be built")?;
    app.run_return(|_, event| {
        if matches!(event, RunEvent::Exit) {
            // The scenario task owns the report and performs all TaskRun waits before exit.
        }
    });
    drop(db);
    let mut report = result
        .lock()
        .take()
        .ok_or("Native scenario did not produce a report")?;
    handoff::finalize(&fixture, &mut report)?;
    fixture::write_report(&fixture.report, &report)?;
    if report.get("passed").and_then(Value::as_bool) == Some(true) {
        Ok(())
    } else {
        Err("Source-dependency scenario did not pass; inspect its bounded report".into())
    }
}

#[derive(Clone)]
struct FixtureRun {
    case: case::SourceCase,
    app_data: std::path::PathBuf,
    report: std::path::PathBuf,
    source: std::path::PathBuf,
    source_manifest_sha256: String,
    source_inventory_sha256: String,
    source_bytes: u64,
    source_files: usize,
    source_revision_before: String,
}

impl fixture::Fixture {
    fn clone_for_app(&self) -> FixtureRun {
        FixtureRun {
            case: self.case,
            app_data: self.app_data.clone(),
            report: self.report.clone(),
            source: self.source.clone(),
            source_manifest_sha256: self.source_manifest_sha256.clone(),
            source_inventory_sha256: self.source_inventory_sha256.clone(),
            source_bytes: self.source_bytes,
            source_files: self.source_files,
            source_revision_before: self.source_revision_before.clone(),
        }
    }
}

async fn execute_scenario(
    app: &tauri::AppHandle,
    fixture: &FixtureRun,
    db: &Database,
    clipboard_calls: Arc<AtomicUsize>,
) -> Value {
    let mut evidence = Vec::<Value>::new();
    let mut failed_stage = None;
    let mut failure_code = None;
    let outcome = run_stages(app, fixture, &mut evidence).await;
    if let Err((stage, code)) = outcome {
        failed_stage = Some(stage);
        failure_code = Some(code);
    }
    let source_after = fixture::verify_fixed_source(fixture.case, &fixture.source);
    let source_unchanged =
        source_after
            .as_ref()
            .is_ok_and(|(manifest, inventory, files, bytes)| {
                manifest == &fixture.source_manifest_sha256
                    && inventory == &fixture.source_inventory_sha256
                    && *files == fixture.source_files
                    && *bytes == fixture.source_bytes
            });
    let source_digest_cancel = std::sync::atomic::AtomicBool::new(false);
    let mut revision_after = None;
    if let Ok((revision, stats)) =
        super::super::staging::source_digest(&fixture.source, &source_digest_cancel)
    {
        revision_after =
            Some(json!({"sha256":revision,"entries":stats.entries,"bytes":stats.bytes}));
    }
    let runs = db.list_task_runs(1000).unwrap_or_default();
    let runs_complete = runs.len() < 1000;
    let all_terminal = runs_complete && runs.iter().all(|run| run.status.is_terminal());
    let pending_count = app.state::<AppState>().pending_agent_requests.lock().len();
    let active_run_count = app.state::<AppState>().active_task_runs.lock().len();
    let lease_states = runs
        .iter()
        .filter(|run| super::registry::is_tool(&run.capability_id) || run.capability_id == CONVERT)
        .map(|run| {
            let state = if super::registry::is_tool(&run.capability_id) {
                super::state(run)
            } else {
                Ok(super::super::manager::global().state(&run.id))
            };
            match state {
                Ok(state) => serde_json::to_value(state).unwrap_or(Value::Null),
                Err(_) => json!({"active":true,"stateUnavailable":true}),
            }
        })
        .collect::<Vec<_>>();
    let task_run_rows = runs
        .iter()
        .map(|run| {
            let mut row = json!({
                "id":run.id,"capabilityId":run.capability_id,"status":run.status.as_str(),
                "initiatorType":serde_json::to_value(run.initiator.kind).ok(),
                "clientId":run.initiator.client_id,"auditIdPresent":run.audit_id.is_some(),
                "errorCount":run.errors.len(),"errorCodes":bounded_error_codes(run),
                "warningCount":run.warnings.len()
            });
            if let Some(diagnostic) = super::diagnostics::project_cancelled_prepare(
                &run.capability_id,
                run.status,
                &run.metrics,
            ) {
                row["operationDiagnostic"] = diagnostic;
            }
            row
        })
        .collect::<Vec<_>>();
    let audit_rows = db
        .list_audit_entries(1000)
        .unwrap_or_default()
        .iter()
        .filter(|audit| audit.client_id == "b235-isolated-native-fixture")
        .map(|audit| {
            json!({"tool":audit.tool_name,
            "status":serde_json::to_value(&audit.status).unwrap_or(Value::Null),
            "durationMs":audit.duration_ms,"hasError":audit.error.is_some()})
        })
        .collect::<Vec<_>>();
    let leases_inactive = lease_states
        .iter()
        .all(|state| state.get("active").and_then(Value::as_bool) == Some(false));
    let clipboard_count = clipboard_calls.load(Ordering::Relaxed);
    let install = installed_summary(db, fixture);
    let revision_matches = revision_after
        .as_ref()
        .and_then(|value| value.get("sha256"))
        .and_then(Value::as_str)
        == Some(fixture.source_revision_before.as_str());
    let expected_sequence = [
        INSPECT,
        FETCH,
        PREPARE,
        INSPECT,
        SOURCE_BUILD_INSPECT,
        CONVERT,
    ];
    let task_sequence_matches = evidence.len() == expected_sequence.len()
        && evidence
            .iter()
            .zip(expected_sequence)
            .all(|(row, expected)| {
                row.get("tool").and_then(Value::as_str) == Some(expected)
                    && row.get("status").and_then(Value::as_str) == Some("succeeded")
            });
    let passed = failed_stage.is_none()
        && task_sequence_matches
        && source_unchanged
        && revision_matches
        && all_terminal
        && pending_count == 0
        && active_run_count == 0
        && leases_inactive
        && clipboard_count == 0
        && install
            .as_ref()
            .is_ok_and(|value| value.get("verified").and_then(Value::as_bool) == Some(true));
    json!({
        "schemaVersion":1,
        "passed":passed,
        "profile":fixture.case.report_profile,
        "sourceCaseId":fixture.case.case_id,
        "sourceProvenance":{"upstreamHead":fixture.case.upstream_head,"origin":"fixed local Git-HEAD blob snapshot; not a tracked checkout status claim",
            "manifestSha256":fixture.source_manifest_sha256,"inventorySha256":fixture.source_inventory_sha256,
            "fileCount":fixture.source_files,"bytes":fixture.source_bytes,
            "sourceRevisionBefore":fixture.source_revision_before,
            "sourceRevisionAfter":revision_after,"sourceFilesUnchanged":source_unchanged},
        "taskRuns":evidence,
        "businessUsabilityVerified":false,
        "scenario":{"expectedSequence":[INSPECT,FETCH,PREPARE,INSPECT,SOURCE_BUILD_INSPECT,CONVERT],"completedStages":evidence.len(),
            "failedStage":failed_stage,"failureCode":failure_code,"businessUsabilityVerified":false,
            "fixturePermissionSemantics":"first use receives an explicit fixed-scope permission-queue grant in a fresh isolated database; later calls for that client/tool reuse the persisted grant through shared Allow; not physical UI approval",
            "physicalUserApprovalObserved":false,
            "cancellationRequestedRunCount":0,
            "cancellationBehaviorExercised":false,
            "workerReapedByProductionPrepareSuccessGate": evidence.iter().any(|row| row.get("tool").and_then(Value::as_str)==Some(PREPARE) && row["status"]=="succeeded"),
            "taskSequenceMatchesExpected":task_sequence_matches,"sourceRevisionMatchesAfter":revision_matches},
        "installedPlugin":install.unwrap_or_else(|_| json!({"verified":false})),
        "server":{"taskRunCount":runs.len(),"taskRunInventoryComplete":runs_complete,
            "taskRunRows":task_run_rows,"auditRows":audit_rows,
            "allTaskRunsTerminal":all_terminal,"pendingPermissionRequestCount":pending_count,
            "activeTaskRunCount":active_run_count,"leaseStates":lease_states,"allLeasesInactive":leases_inactive,
            "clipboardBackendCalls":clipboard_count,"cleanupSafe":all_terminal && pending_count==0 && active_run_count==0 && leases_inactive && source_unchanged}
    })
}

async fn run_stages(
    app: &tauri::AppHandle,
    fixture: &FixtureRun,
    evidence: &mut Vec<Value>,
) -> Result<(), (&'static str, &'static str)> {
    let inspect_input = json!({"sourcePath":fixture.source});
    let initial = invoke(app, INSPECT, inspect_input.clone())
        .await
        .map_err(|_| ("inspect", "INSPECT_TASK_FAILED"))?;
    let revision = string_field(&initial.output, "sourceRevision")
        .map_err(|_| ("inspect", "INSPECT_REVISION_MISSING"))?
        .to_owned();
    if initial.output["status"] != "eligible"
        || initial.output["businessUsabilityVerified"] != false
    {
        return Err(("inspect", "INSPECT_RESULT_NOT_ELIGIBLE"));
    }
    evidence.push(initial.evidence);

    let operation = || json!({"sourcePath":fixture.source,"expectedRevision":revision});
    let fetch = invoke(app, FETCH, operation())
        .await
        .map_err(|_| ("fetch", "FETCH_TASK_FAILED"))?;
    if fetch.output["status"] != "cached"
        || fetch.output["sourceRevision"] != revision
        || fetch.output["dependencySetIdSha256"] != initial.output["dependencySetIdSha256"]
    {
        return Err(("fetch", "FETCH_IDENTITY_MISMATCH"));
    }
    evidence.push(fetch.evidence);

    let prepared = invoke(app, PREPARE, operation())
        .await
        .map_err(|_| ("prepare", "PREPARE_TASK_FAILED"))?;
    if prepared.output["status"] != "prepared"
        || prepared.output["sourceRevision"] != revision
        || prepared.output["dependencySetIdSha256"] != initial.output["dependencySetIdSha256"]
        || prepared.output["treeSha256"].as_str().is_none()
        || prepared.output["treeBytes"].as_u64().is_none()
        || prepared.output["dependencyClosureVerified"] != false
        || prepared.output["businessUsabilityVerified"] != false
    {
        return Err(("prepare", "PREPARE_RECEIPT_MISMATCH"));
    }
    evidence.push(prepared.evidence);

    let verified = invoke(app, INSPECT, inspect_input.clone())
        .await
        .map_err(|_| ("prepared_inspect", "PREPARED_INSPECT_TASK_FAILED"))?;
    if verified.output["dependencySetPrepared"] != true
        || verified.output["sourceRevision"] != revision
        || verified.output["dependencySetIdSha256"] != prepared.output["dependencySetIdSha256"]
        || verified.output["dependencyTreeSha256"] != prepared.output["treeSha256"]
        || verified.output["dependencyTreeBytes"] != prepared.output["treeBytes"]
    {
        return Err(("prepared_inspect", "PREPARED_TREE_IDENTITY_MISMATCH"));
    }
    evidence.push(verified.evidence);

    let mut source_build_input = inspect_input.clone();
    manifest_selection::add_inspection_selection(fixture.case, &mut source_build_input);
    let source_build = invoke(app, SOURCE_BUILD_INSPECT, source_build_input)
        .await
        .map_err(|_| {
            (
                "source_build_inspect",
                "SOURCE_BUILD_INSPECTION_TASK_FAILED",
            )
        })?;
    evidence.push(source_build.evidence);
    let blockers_empty = source_build
        .output
        .get("blockers")
        .and_then(Value::as_array)
        .is_some_and(|blockers| blockers.is_empty());
    if source_build.output["status"] != "eligible"
        || source_build.output["pluginId"] != fixture.case.plugin_id
        || source_build.output["sourceRevision"] != revision
        || !blockers_empty
        || !valid_build_steps(&source_build.output["buildSteps"])
        || !manifest_selection::selected_identity_matches(fixture.case, &source_build.output)
    {
        return Err((
            "source_build_inspect",
            "SOURCE_BUILD_INSPECTION_NOT_ELIGIBLE",
        ));
    }

    let mut conversion_input = operation();
    manifest_selection::add_conversion_selection(fixture.case, &mut conversion_input);
    let converted = invoke(app, CONVERT, conversion_input)
        .await
        .map_err(|_| ("convert", "CONVERSION_TASK_FAILED"))?;
    if converted.output["installed"] != true
        || converted.output["pluginId"] != fixture.case.plugin_id
        || converted.output["sourceRevision"] != revision
        || converted.output["businessOperationVerified"] != false
        || converted.output["dependencyClosureVerified"] != false
        || !manifest_selection::conversion_input_identity_matches(fixture.case, &converted.evidence)
    {
        return Err(("convert", "CONVERSION_OUTPUT_MISMATCH"));
    }
    evidence.push(converted.evidence);
    Ok(())
}

async fn invoke(
    app: &tauri::AppHandle,
    tool: &str,
    input: Value,
) -> Result<task::CompletedTool, String> {
    task::execute(app, tool, input).await
}

fn string_field<'a>(value: &'a Value, field: &str) -> Result<&'a str, ()> {
    value.get(field).and_then(Value::as_str).ok_or(())
}

fn valid_build_steps(value: &Value) -> bool {
    let Some(steps) = value.as_array() else {
        return false;
    };
    if !(1..=12).contains(&steps.len()) {
        return false;
    }
    steps.iter().all(|step| {
        let Some(object) = step.as_object() else {
            return false;
        };
        match object.get("kind").and_then(Value::as_str) {
            Some("typecheck" | "viteBuild" | "packageScript") => {
                object.len() == 1 && object.contains_key("kind")
            }
            Some("nodeTests") => {
                object.len() == 2
                    && object.contains_key("files")
                    && object
                        .get("files")
                        .and_then(Value::as_u64)
                        .is_some_and(|files| (1..=128).contains(&files))
            }
            _ => false,
        }
    })
}

fn bounded_error_codes(run: &TaskRun) -> Vec<String> {
    fn push_code(codes: &mut Vec<String>, code: Option<&str>, uppercase_only: bool) {
        let Some(code) = code else { return };
        let valid_ascii_code = !code.is_empty()
            && code.len() <= MAX_TASK_RUN_ERROR_CODE_BYTES
            && code
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
        let valid_uppercase_message = !uppercase_only
            || code
                .bytes()
                .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_');
        if !valid_ascii_code
            || !valid_uppercase_message
            || codes.iter().any(|existing| existing.as_str() == code)
            || codes.len() >= MAX_TASK_RUN_ERROR_CODES
        {
            return;
        }
        codes.push(code.to_owned());
    }

    let mut codes = Vec::new();
    for issue in &run.errors {
        push_code(&mut codes, Some(&issue.code), false);
        push_code(
            &mut codes,
            issue
                .details
                .pointer("/errorObservation/errorCode")
                .and_then(Value::as_str),
            false,
        );
        push_code(
            &mut codes,
            issue
                .details
                .pointer("/errorObservation/code")
                .and_then(Value::as_str),
            false,
        );
        // Some executor errors persist a fixed machine code as the whole safe message.
        // Never extract a token from free-form prose or arbitrary structured details.
        push_code(&mut codes, Some(&issue.message), true);
        if codes.len() >= MAX_TASK_RUN_ERROR_CODES {
            break;
        }
    }
    codes
}

fn installed_summary(db: &Database, fixture: &FixtureRun) -> Result<Value, String> {
    let case = fixture.case;
    let plugin = db
        .get_plugin(case.plugin_id)
        .map_err(|_| "Installed plugin row unavailable")?;
    let expected_path = fixture.app_data.join("plugins").join(case.plugin_id);
    if !case::installed_identity_matches(
        case,
        &plugin.id,
        &plugin.version,
        &plugin.manifest.name,
        &plugin.manifest.version,
        &plugin.path,
        &expected_path.to_string_lossy(),
    ) {
        return Err("Installed plugin identity or path differs from the fixed source case".into());
    }
    let entry = atools_plugin::package_resolution::resolve_plugin_package(Path::new(&plugin.path))
        .map_err(|_| "Installed package readiness could not be resolved")?;
    let installed_manifest = serde_json::to_value(&entry.manifest)
        .map_err(|_| "Installed plugin manifest identity could not be read")?;
    case::validate_plugin_manifest_value(case, &installed_manifest).map_err(str::to_owned)?;
    let tree = tree::digest(Path::new(&plugin.path))?;
    let ready =
        entry.readiness.as_str() == "ready" && entry.package_root == Path::new(&plugin.path);
    Ok(
        json!({"verified":ready,"pluginId":plugin.id,"version":plugin.version,
        "expectedVersionFromPinnedSource": case.plugin_version,
        "readiness":entry.readiness.as_str(),"manifestMainPresent":entry.manifest.main.is_some(),
        "manifestAtPackageRoot":entry.manifest_path == Path::new(&plugin.path).join("plugin.json"),
        "completeInstalledTreeSha256":tree.sha256,"treeEntries":tree.entries,
        "treeFiles":tree.files,"treeBytes":tree.bytes}),
    )
}
