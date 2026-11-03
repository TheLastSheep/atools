//! Isolated native acceptance for source inspection, permission, build, and install.
//! The cohort is synthetic and the harness owns only its fresh private app-data root.
use super::Cleanup;
use crate::{
    pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime},
    state::AppState,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem};
use parking_lot::Mutex;
use serde_json::{json, Value};
#[path = "desktop_smoke_source_build_identity.rs"]
mod identity;
#[path = "desktop_smoke_source_build_profile.rs"]
mod profile;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

#[path = "desktop_smoke_source_build_diagnostics.rs"]
mod diagnostics;
use diagnostics::{FrontendDiagnosticMessage, FrontendReportMessage, Ledger, ProtocolRequest};
#[path = "desktop_smoke_source_build_failure_evidence.rs"]
mod failure_evidence;
#[path = "desktop_smoke_source_build_inspection_observation.rs"]
mod inspection_observation;
#[path = "desktop_smoke_source_build_scenario_diagnostics.rs"]
mod scenario_diagnostics;
#[path = "desktop_smoke_source_build_scenario_host.rs"]
mod scenario_host;
use scenario_diagnostics::ScenarioLedger;

const REPORT_LIMIT: usize = 2 * 1024 * 1024;
const ASSET_LIMIT: u64 = 2 * 1024 * 1024;

struct Fixture {
    root: PathBuf,
    plugin_root: PathBuf,
    success: PathBuf,
    cancel: PathBuf,
    invalid: PathBuf,
    evidence_dir: PathBuf,
    run_token: String,
    diagnostics: Arc<Mutex<Ledger>>,
    scenario_diagnostics: Arc<Mutex<ScenarioLedger>>,
    document_html: Vec<u8>,
    document_html_bytes: usize,
    document_html_sha256: String,
    profile: profile::Profile,
}
struct Report(Arc<Mutex<Option<oneshot::Sender<Value>>>>);

struct CountedNoClipboard(Arc<AtomicUsize>);
#[async_trait]
impl PasteboardBackend for CountedNoClipboard {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard is disabled in source-build smoke".into())
    }
    async fn write_item(&self, _: &PasteboardItem, _: &Path, _: bool) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard is disabled in source-build smoke".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard is disabled in source-build smoke".into())
    }
}

fn absolute_arg(args: &[String], key: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {key}"))
}

fn bounded_regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err(format!(
            "Invalid or oversized smoke asset: {}",
            path.display()
        ));
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("Smoke asset changed during read".into());
    }
    Ok(bytes)
}

fn safe_output_path(root: &Path, output: &Path) -> Result<(), String> {
    if output.parent().is_none() || fs::symlink_metadata(output).is_ok() {
        return Err("Output must be a new path outside the fixture root".into());
    }
    let parent = fs::canonicalize(output.parent().unwrap()).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if parent.starts_with(&root) {
        return Err("Report path must be outside private fixture data".into());
    }
    Ok(())
}

fn safe_evidence_dir(root: &Path, path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Diagnostic evidence must be a fresh regular directory".into());
    }
    let evidence = fs::canonicalize(path).map_err(|error| error.to_string())?;
    let root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    if evidence.starts_with(root) {
        return Err("Diagnostic evidence must be outside fixture data".into());
    }
    let mut names = fs::read_dir(path)
        .map_err(|_| "Diagnostic evidence directory could not be read")?
        .map(|entry| entry.map(|entry| entry.file_name().to_string_lossy().into_owned()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| "Diagnostic evidence directory could not be read")?;
    names.sort();
    if names.len() != 2 || names[0] != "panel.css" || names[1] != "panel.js" {
        return Err(
            "Diagnostic evidence directory must contain only the two fixed panel assets".into(),
        );
    }
    Ok(())
}

pub(super) fn source_build_fixture_payload(app: &tauri::AppHandle) -> Value {
    let fixture = app.state::<Fixture>();
    json!({"sourceRoot":fixture.plugin_root,"successPath":fixture.success,"cancelPath":fixture.cancel,
        "invalidPath":fixture.invalid,"pluginId":fixture.profile.plugin_id(),
        "profile":fixture.profile.label(),"typescriptBuild":fixture.profile.typescript_build(),
        "expectedVersion":fixture.profile.expected_version(),"runToken":fixture.run_token})
}

#[tauri::command]
fn native_source_build_diagnostic(
    app: tauri::AppHandle,
    message: FrontendDiagnosticMessage,
) -> Result<(), String> {
    app.state::<Fixture>()
        .diagnostics
        .lock()
        .record_frontend(message)
        .map_err(str::to_owned)
}

#[tauri::command]
fn native_source_build_report(
    app: tauri::AppHandle,
    message: FrontendReportMessage,
) -> Result<(), String> {
    let report = serde_json::to_value(message.report).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec(&report).map_err(|error| error.to_string())?;
    if bytes.len() > REPORT_LIMIT {
        return Err("Native report exceeds 2 MiB".into());
    }
    app.state::<Fixture>()
        .diagnostics
        .lock()
        .record_report_received(&message.run_token)
        .map_err(str::to_owned)?;
    if let Some(sender) = app.state::<Report>().0.lock().take() {
        sender
            .send(report)
            .map_err(|_| "Native report receiver closed".to_string())
    } else {
        Err("Native report already received".into())
    }
}

pub(super) fn source_build_snapshot_payload(app: &tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let runs = state
        .db
        .list_task_runs(1000)
        .map_err(|error| error.to_string())?;
    let fixture = app.state::<Fixture>();
    let plugin = state.db.get_plugin(fixture.profile.plugin_id()).ok();
    let installed_hash = plugin
        .as_ref()
        .map(|plugin| identity::installed_identity(&state.db, plugin))
        .transpose()?;
    Ok(
        json!({"pluginVersion":plugin.as_ref().map(|plugin|plugin.version.clone()),
        "installedHash":installed_hash,"identityScope":"Full DB plugin record, durable code revision, and bounded complete installed tree",
        "allTaskRunsTerminal":runs.iter().all(|run|run.status.is_terminal()),
        "taskRunCount":runs.len(),"pendingRequestCount":state.pending_agent_requests.lock().len()}),
    )
}

pub(super) fn scan_default_ztools_plugins_impl(
    app: &tauri::AppHandle,
) -> Result<Vec<crate::ztools_import::ZToolsImportCandidate>, String> {
    crate::ztools_import::scan_ztools_plugin_candidates(&app.state::<Fixture>().plugin_root)
}

fn prepare(args: &[String]) -> Result<(Fixture, PathBuf, Vec<u8>, Vec<u8>, Cleanup), String> {
    let root = absolute_arg(args, "--fixture-root")?;
    fs::create_dir(&root).map_err(|error| format!("fixture root must be fresh: {error}"))?;
    let cleanup = Cleanup(root.clone());
    let plugin_root = fs::canonicalize(absolute_arg(args, "--plugin-root")?)
        .map_err(|error| error.to_string())?;
    let output = absolute_arg(args, "--output")?;
    safe_output_path(&root, &output)?;
    let evidence_dir = absolute_arg(args, "--diagnostic-evidence-dir")?;
    safe_evidence_dir(&root, &evidence_dir)?;
    for name in ["baseline-publish", "success", "cancel", "invalid"] {
        let candidate = plugin_root.join(name);
        if fs::symlink_metadata(&candidate).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err(format!("Fixture cohort cannot be a symlink: {name}"));
        }
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| format!("Missing fixture cohort {name}: {error}"))?;
        if !canonical.starts_with(&plugin_root) || !canonical.is_dir() {
            return Err(format!("Fixture cohort escapes plugin root: {name}"));
        }
    }
    let script = bounded_regular(&absolute_arg(args, "--source-build-ui")?, ASSET_LIMIT)?;
    let css = bounded_regular(&absolute_arg(args, "--source-build-css")?, ASSET_LIMIT)?;
    let profile = profile::Profile::parse(args, &plugin_root.join("success"))?;
    let run_token = uuid::Uuid::new_v4().to_string();
    let document_html = diagnostics::document_html(&run_token);
    let (document_html_bytes, document_html_sha256) =
        diagnostics::write_entry_html(&evidence_dir, &document_html)?;
    let fixture = Fixture {
        root,
        plugin_root: plugin_root.clone(),
        success: plugin_root.join("success"),
        cancel: plugin_root.join("cancel"),
        invalid: plugin_root.join("invalid"),
        evidence_dir,
        run_token: run_token.clone(),
        diagnostics: Arc::new(Mutex::new(Ledger::new(run_token.clone()))),
        scenario_diagnostics: Arc::new(Mutex::new(ScenarioLedger::new(run_token))),
        document_html,
        document_html_bytes,
        document_html_sha256,
        profile,
    };
    Ok((fixture, output, script, css, cleanup))
}

fn server_evidence(
    app: &tauri::AppHandle,
    frontend: Value,
    cleanup_ok: bool,
    clipboard_calls: usize,
    log_evidence_path: &Path,
) -> Value {
    let state = app.state::<AppState>();
    let mut evidence_errors = Vec::new();
    let runs = state.db.list_task_runs(1000).unwrap_or_else(|_| {
        evidence_errors.push("TaskRun inventory could not be read");
        Vec::new()
    });
    let audits = state.db.list_audit_entries(1000).unwrap_or_else(|_| {
        evidence_errors.push("Audit inventory could not be read");
        Vec::new()
    });
    if runs.len() >= 1000 || audits.len() >= 1000 {
        evidence_errors.push("Bounded inventory is not proven complete");
    }
    let pending = state.pending_agent_requests.lock().len();
    let task_rows = runs.iter().map(|run| json!({"id":run.id,"capabilityId":run.capability_id,
        "status":run.status.as_str(),"summary":run.summary,"errorCount":run.errors.len(),"warningCount":run.warnings.len()})).collect::<Vec<_>>();
    let source_audits = audits.iter().filter(|entry| matches!(entry.tool_name.as_str(), "convert_ztools_plugin" | "inspect_ztools_source_build"))
        .map(|entry|json!({"toolName":entry.tool_name,"status":entry.status,"durationMs":entry.duration_ms,"hasError":entry.error.is_some()})).collect::<Vec<_>>();
    let all_terminal = runs.iter().all(|run| run.status.is_terminal());
    let runtime_states = runs.iter().filter(|run| run.capability_id == crate::plugin_source_build::registry::TOOL)
        .map(|run| {
            let state = crate::plugin_source_build::api::get_plugin_source_build_state(app.state::<AppState>(), run.id.clone());
            match state {
                Ok(state) => json!({"taskRunId":run.id,"active":state.active,"cancellable":state.cancellable,
                    "cancelRequested":state.cancel_requested,"recoveryRequired":state.recovery_required}),
                Err(error) => json!({"taskRunId":run.id,"stateReadError":error}),
            }
        }).collect::<Vec<_>>();
    let active = state.active_task_runs.lock().len();
    let clipboard_capture_task_started = state.pasteboard_capture_task.lock().is_some();
    let fixture = app.state::<Fixture>();
    let runner_log_evidence = failure_evidence::retain_failed_runner_log(
        &runs,
        runs.len() < 1000,
        fixture.profile.label(),
        &fixture.success,
        &fixture.root,
        log_evidence_path,
    );
    let boot = fixture.diagnostics.lock().snapshot();
    let scenario = fixture
        .scenario_diagnostics
        .lock()
        .snapshot(fixture.profile.label() == "application-uninstaller");
    let entry_metadata = fs::symlink_metadata(fixture.evidence_dir.join("entry.html")).ok();
    let entry_html_evidence = json!({
        "stored": entry_metadata.as_ref().is_some_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink()),
        "byteLength": fixture.document_html_bytes,
        "sha256": fixture.document_html_sha256,
        "servedFromSameBytes": true
    });
    let window = app.get_webview_window("source-build-smoke");
    let window_visible = window.as_ref().and_then(|window| window.is_visible().ok());
    let window_focused = window.as_ref().and_then(|window| window.is_focused().ok());
    let manager_safe = runtime_states.iter().all(|row| {
        row.get("active").and_then(Value::as_bool) == Some(false)
            && row.get("recoveryRequired").and_then(Value::as_bool) == Some(false)
    });
    let cleanup_safe =
        evidence_errors.is_empty() && manager_safe && all_terminal && pending == 0 && active == 0;
    let window_isolated = window_visible == Some(false) && window_focused == Some(false);
    let side_effects_isolated =
        clipboard_calls == 0 && !clipboard_capture_task_started && window_isolated;
    let passed = frontend.get("passed").and_then(Value::as_bool) == Some(true)
        && boot["passed"] == true
        && entry_html_evidence["stored"] == true
        && (fixture.profile.label() != "application-uninstaller" || scenario["passed"] == true)
        && side_effects_isolated
        && cleanup_safe
        && cleanup_ok;
    json!({"passed":passed,"frontend":frontend,"server":{"taskRuns":task_rows,"sourceBuildAudit":source_audits,
        "taskRunCount":runs.len(),"auditCount":audits.len(),"pendingPermissionRequests":pending,"allTaskRunsTerminal":all_terminal,
        "activeTaskRunCount":active,"sourceBuildRuntimeStates":runtime_states,"evidenceErrors":evidence_errors,
        "bootDiagnostics":boot,"scenarioDiagnostics":scenario,"entryHtmlEvidence":entry_html_evidence,
        "windowVisibleObserved":window_visible,"windowFocusedObserved":window_focused,
        "windowIsolationPassed":window_isolated,"clipboardBackendCalls":clipboard_calls,"clipboardIsolationPassed":clipboard_calls==0,
        "clipboardCaptureTaskStarted":clipboard_capture_task_started,
        "sourceBuildFailureEvidence":runner_log_evidence,
        "sideEffectsIsolated":side_effects_isolated,"cleanupSafe":cleanup_safe,"cleanupSucceeded":cleanup_ok}})
}

async fn cancel_owned_runs(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    for run in state
        .db
        .list_task_runs(1000)
        .map_err(|error| error.to_string())?
    {
        if run.capability_id != crate::plugin_source_build::registry::TOOL
            || run.status.is_terminal()
        {
            continue;
        }
        let _ = crate::commands::cancel_task_run_by_id(app, &run.id);
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let runs = state
            .db
            .list_task_runs(1000)
            .map_err(|error| error.to_string())?;
        if runs
            .iter()
            .filter(|run| run.capability_id == crate::plugin_source_build::registry::TOOL)
            .all(|run| run.status.is_terminal())
        {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(
                "Owned conversion tasks did not reach terminal state within 10 seconds".into(),
            );
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Native source-build fixture targets macOS only".into());
    }
    let args = std::env::args().collect::<Vec<_>>();
    let (fixture, output, script, css, cleanup) = prepare(&args)?;
    let baseline = fixture.plugin_root.join("baseline-publish");
    let config = AppConfig::with_base_dir(fixture.root.join("app-data"));
    config.ensure_dirs().map_err(|error| error.to_string())?;
    let db = Arc::new(
        Database::open(&fixture.root.join("source-build.sqlite"))
            .map_err(|error| error.to_string())?,
    );
    crate::agent_tools::sync_builtin_tools(&db)?;
    if fixture.profile.seeds_baseline() {
        let source = baseline
            .to_str()
            .ok_or("Baseline path is not valid UTF-8")?
            .to_owned();
        let seed = crate::ztools_import::import_ztools_plugins(
            &db,
            &config.plugins_dir(),
            &[source],
            true,
        )?;
        if seed.imported.len() != 1
            || seed.imported[0] != fixture.profile.plugin_id()
            || !seed.failed.is_empty()
        {
            return Err("Could not seed baseline published fixture".into());
        }
    } else if db
        .list_plugins()
        .map_err(|error| error.to_string())?
        .iter()
        .any(|plugin| plugin.id == fixture.profile.plugin_id())
    {
        return Err(
            "Real source-build profile requires a fresh, uninstalled plugin identity".into(),
        );
    }
    let clipboard_calls = Arc::new(AtomicUsize::new(0));
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(CountedNoClipboard(clipboard_calls.clone())),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db, None, pasteboard);
    let (tx, rx) = oneshot::channel::<Value>();
    let sender = Arc::new(Mutex::new(Some(tx)));
    let passed = Arc::new(AtomicBool::new(false));
    let passed_after = passed.clone();
    let root = fixture.root.clone();
    let cleanup_root = fixture.root.clone();
    let report_path = output.clone();
    let log_evidence_path = report_path.with_file_name("source-build-runner.log");
    let diagnostics = fixture.diagnostics.clone();
    let document_html = fixture.document_html.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.source-build-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy("default-src 'self' ipc://localhost atools-source-build://localhost; script-src 'self' 'unsafe-inline' 'unsafe-eval' atools-source-build://localhost; style-src 'self' 'unsafe-inline' atools-source-build://localhost; connect-src 'self' ipc://localhost atools-source-build://localhost".into()));
    let app = tauri::Builder::default()
        .manage(state)
        .manage(fixture)
        .manage(Report(sender))
        .invoke_handler(tauri::generate_handler![
            scenario_host::native_source_build_fixture,
            native_source_build_report,
            native_source_build_diagnostic,
            scenario_host::native_source_build_scenario_diagnostic,
            scenario_host::native_source_build_snapshot,
            scenario_host::scenario_scan_default_ztools_plugins,
            scenario_host::scenario_inspect_ztools_source_build,
            crate::commands::scan_ztools_plugins,
            crate::commands::import_ztools_plugins,
            crate::commands::list_plugins,
            crate::commands::toggle_plugin,
            crate::commands::get_setting,
            crate::plugin_source_build::api::get_plugin_source_build_state,
            crate::commands::start_agent_tool,
            crate::commands::get_task_run,
            crate::commands::list_task_runs,
            crate::commands::cancel_task_run,
            crate::commands::list_pending_agent_requests,
            crate::commands::dismiss_pending_agent_request,
            crate::commands::call_agent_tool,
            crate::commands::grant_agent_tool,
            crate::commands::revoke_agent_tool,
            crate::legacy_runtime::permission_context::get_permission_request_context
        ])
        .register_uri_scheme_protocol("atools-source-build", move |_, request| {
            let path = request.uri().path();
            let (status, mime, body) = match path {
                "/panel.js" => {
                    diagnostics.lock().record_protocol(ProtocolRequest::Script);
                    (200, "text/javascript", script.clone())
                }
                "/panel.css" => {
                    diagnostics.lock().record_protocol(ProtocolRequest::Css);
                    (200, "text/css", css.clone())
                }
                "/" => {
                    diagnostics
                        .lock()
                        .record_protocol(ProtocolRequest::Document);
                    (200, "text/html", document_html.clone())
                }
                _ => (404, "text/plain", Vec::new()),
            };
            tauri::http::Response::builder()
                .status(status)
                .header("content-type", mime)
                .header("cache-control", "no-store")
                .body(body)
                .unwrap()
        })
        .setup(move |app| {
            crate::legacy_runtime::install_manager(app.handle());
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("isolated-source-build")
                    .window("source-build-smoke")
                    .remote("atools-source-build://localhost/*".into())
                    .permission("core:event:allow-listen")
                    .permission("core:event:allow-unlisten"),
            )?;
            WebviewWindowBuilder::new(
                app,
                "source-build-smoke",
                WebviewUrl::CustomProtocol("atools-source-build://localhost/".parse().unwrap()),
            )
            .title("ATools isolated source-build native smoke")
            .inner_size(1000.0, 760.0)
            .visible(false)
            .focused(false)
            .incognito(true)
            .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
            .data_directory(root.join("webview"))
            .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let frontend = tokio::time::timeout(Duration::from_secs(100), rx).await;
                let frontend = match frontend {
                    Ok(Ok(report)) => report,
                    Ok(Err(_)) => json!({"passed":false,"error":"Frontend report channel closed"}),
                    Err(_) => {
                        json!({"passed":false,"error":"Native source-build scenario timed out"})
                    }
                };
                let cancellation = cancel_owned_runs(&handle).await;
                let clipboard_count = clipboard_calls.load(Ordering::Relaxed);
                let mut report = server_evidence(
                    &handle,
                    frontend,
                    cancellation.is_ok(),
                    clipboard_count,
                    &log_evidence_path,
                );
                if let Err(error) = cancellation {
                    report["server"]["cancellationError"] = json!(error);
                    report["passed"] = json!(false);
                }
                if let Some(parent) = output.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let bytes = serde_json::to_vec_pretty(&report)
                    .unwrap_or_else(|_| b"{\"passed\":false}".to_vec());
                let wrote = if bytes.len() <= REPORT_LIMIT {
                    fs::OpenOptions::new()
                        .write(true)
                        .create_new(true)
                        .open(&output)
                        .and_then(|mut file| file.write_all(&bytes))
                        .is_ok()
                } else {
                    false
                };
                if !wrote {
                    report["passed"] = json!(false);
                    report["server"]["reportWriteFailed"] = json!(true);
                }
                passed.store(
                    report["passed"].as_bool() == Some(true) && wrote,
                    Ordering::Release,
                );
                handle
                    .state::<Arc<crate::legacy_runtime::Sessions>>()
                    .stop_all()
                    .await;
                handle.exit(if passed.load(Ordering::Acquire) { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .map_err(|error| error.to_string())?;
    app.run_return(|_, _| {});
    let safe_to_remove = fs::read(&report_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .is_some_and(|report| report["server"]["cleanupSafe"] == true);
    if safe_to_remove {
        drop(cleanup);
    } else {
        // An unknown writer may still rely on this data. Keep the private root
        // for recovery; the outer runner preserves its environment as well.
        std::mem::forget(cleanup);
    }
    let cleanup_ok = safe_to_remove && !cleanup_root.exists();
    if let Ok(bytes) = fs::read(&report_path) {
        if let Ok(mut report) = serde_json::from_slice::<Value>(&bytes) {
            report["server"]["privateDataRemoved"] = json!(cleanup_ok);
            if !cleanup_ok {
                report["server"]["privateDataPreserved"] = json!(cleanup_root);
            }
            report["server"]["cleanupSafe"] =
                json!(report["server"]["cleanupSafe"].as_bool() == Some(true) && cleanup_ok);
            if !cleanup_ok {
                report["passed"] = json!(false);
            }
            let _ = fs::write(
                &report_path,
                serde_json::to_vec_pretty(&report).unwrap_or_default(),
            );
        }
    }
    if passed_after.load(Ordering::Acquire) && cleanup_ok {
        Ok(())
    } else {
        Err("Native source-build smoke did not pass; inspect the external report".into())
    }
}
