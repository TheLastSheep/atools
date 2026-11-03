//! Opt-in, isolated Wry acceptance of native plugin AI commands and TaskRuns.
#[path = "desktop_smoke_fixture.rs"]
mod desktop_smoke_fixture;
#[path = "desktop_smoke_flow.rs"]
mod desktop_smoke_flow;
#[path = "desktop_smoke_page.rs"]
mod desktop_smoke_page;

use crate::{
    pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime},
    state::AppState,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::mpsc;

struct NoHistory;
#[async_trait]
impl PasteboardBackend for NoHistory {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        Err("History disabled".into())
    }
    async fn write_item(&self, _: &PasteboardItem, _: &Path, _: bool) -> Result<(), String> {
        Err("History disabled".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        Err("History disabled".into())
    }
}

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn absolute(args: &[String], flag: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {flag}"))
}

fn make_plugin(root: &Path) -> Result<Plugin, String> {
    let path = root.join("plugin");
    std::fs::create_dir(&path).map_err(|_| "Fixture plugin directory failed")?;
    std::fs::write(path.join("index.html"), "isolated native AI fixture")
        .map_err(|_| "Fixture plugin file failed")?;
    let manifest: PluginManifest = serde_json::from_value(
        json!({"name":"Isolated Plugin AI Fixture","version":"0.0.0","main":"index.html"}),
    )
    .map_err(|_| "Fixture manifest failed")?;
    Ok(Plugin {
        id: "isolated-native-ai-fixture".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: path.to_string_lossy().into(),
        enabled: true,
        manifest,
        created_at: atools_core::utils::now_iso(),
        updated_at: atools_core::utils::now_iso(),
    })
}

pub fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    let root = absolute(&args, "--fixture-root")?;
    let output = absolute(&args, "--output")?;
    let output_parent = output.parent().ok_or("Fixture output has no parent")?;
    if root.exists()
        || std::fs::symlink_metadata(&root).is_ok()
        || output.starts_with(&root)
        || std::fs::symlink_metadata(&output).is_ok()
        || !output_parent.is_dir()
        || std::fs::canonicalize(output_parent)
            .map_err(|_| "Fixture output parent unavailable")?
            .as_path()
            != output_parent
    {
        return Err(
            "Fixture paths must be new, non-symlink paths with an existing output parent".into(),
        );
    }
    std::fs::create_dir(&root).map_err(|_| "Fixture root must not exist")?;
    let cleanup = Cleanup(root.clone());
    let (events_tx, event_rx) = mpsc::channel(32);
    let fixture = desktop_smoke_fixture::LoopbackFixture::start(events_tx.clone())?;
    let config = AppConfig::with_base_dir(root.join("app-data"));
    config
        .ensure_dirs()
        .map_err(|_| "Private app data setup failed")?;
    let db = Arc::new(
        Database::open(&root.join("fixture.sqlite"))
            .map_err(|_| "Private fixture database failed")?,
    );
    db.set_setting("agent.permission_mode", "conservative")
        .map_err(|_| "Permission fixture setup failed")?;
    let general = json!({"aiProvider":"compatible","aiBaseUrl":fixture.base_url(),
        "aiDefaultModel":"fixture-model","aiApiKey":"fixture-only-not-a-real-key",
        "aiTemperature":0.2,"proxyEnabled":false});
    let general_value = general.to_string();
    let mut disabled = general.clone();
    disabled["aiProvider"] = json!("disabled");
    db.set_setting("settings-general", &disabled.to_string())
        .map_err(|_| "AI fixture settings failed")?;
    let plugin = make_plugin(&root)?;
    db.save_plugin_with_features(&plugin, &[])
        .map_err(|_| "Fixture plugin registration failed")?;
    let history = Arc::new(PasteboardRuntime::new(
        Arc::new(NoHistory),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db.clone(), None, history);
    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
    let ready_sender = Arc::new(Mutex::new(Some(ready_tx)));
    let flow_report = Arc::new(Mutex::new(None::<Value>));
    let report_slot = flow_report.clone();
    let setup_events = events_tx.clone();
    let protocol_ready = ready_sender.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.plugin-ai-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy(
        "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost; style-src 'none'; img-src 'none'".into()));
    let profile = root.clone();
    let fixture_url = fixture.base_url();
    let settings_for_flow = general_value.clone();
    let plugin_for_flow = plugin.clone();
    let db_for_flow = db.clone();
    let app = tauri::Builder::default()
        .manage(state)
        .register_uri_scheme_protocol("atools-plugin-ai-smoke", move |_, request| {
            let path = request.uri().path();
            let method = request.method().as_str();
            let body = request.body();
            let mut status = tauri::http::StatusCode::NOT_FOUND;
            let mut content_type = "text/plain";
            let mut data = Vec::new();
            if method == "GET" && path == "/index.html" && body.is_empty() {
                status = tauri::http::StatusCode::OK;
                content_type = "text/html; charset=utf-8";
                data = desktop_smoke_page::PAGE
                    .replace(
                        "__FIXTURE_FINAL_CONTENT__",
                        desktop_smoke_fixture::FINAL_CONTENT,
                    )
                    .into_bytes();
            } else if method == "POST" && path == "/event" && !body.is_empty() && body.len() <= 4096
            {
                if let Ok(value) = serde_json::from_slice::<Value>(body) {
                    let allowed = [
                        "ready",
                        "initial-models",
                        "model-probe",
                        "oversize-result",
                        "pending",
                        "channel",
                        "ack-held",
                        "cancel-result",
                        "completed",
                        "settings-result",
                        "page-error",
                    ];
                    if value
                        .get("stage")
                        .and_then(Value::as_str)
                        .is_some_and(|stage| allowed.contains(&stage))
                        && setup_events.try_send(value).is_ok()
                    {
                        status = tauri::http::StatusCode::NO_CONTENT;
                    } else {
                        status = tauri::http::StatusCode::BAD_REQUEST;
                    }
                } else {
                    status = tauri::http::StatusCode::BAD_REQUEST;
                }
            } else if method == "POST" && path == "/ready" && body.len() <= 1024 {
                if let Some(sender) = protocol_ready.lock().take() {
                    let _ = sender.send(());
                }
                status = tauri::http::StatusCode::NO_CONTENT;
            }
            tauri::http::Response::builder()
                .status(status)
                .header("content-type", content_type)
                .header("cache-control", "no-store")
                .body(data)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            crate::commands::get_setting,
            crate::general_settings_runtime::commands::save_general_settings,
            crate::plugin_ai_runtime::commands::list_plugin_ai_models,
            crate::plugin_ai_runtime::commands::prepare_plugin_ai_request,
            crate::plugin_ai_runtime::commands::execute_plugin_ai_request,
            crate::plugin_ai_runtime::commands::ack_plugin_ai_delta,
            crate::plugin_ai_runtime::commands::take_plugin_ai_result,
            crate::plugin_ai_runtime::commands::cancel_plugin_ai_request,
            crate::commands::call_agent_tool,
            crate::commands::get_task_run,
            crate::settings_write::set_setting_ai
        ])
        .setup(move |app| {
            app.manage(crate::general_settings_runtime::GeneralSettingsCoordinator::default());
            crate::plugin_ai_runtime::install_manager(app.handle());
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol(
                    "atools-plugin-ai-smoke://localhost/index.html"
                        .parse()
                        .unwrap(),
                ),
            )
            .title("Isolated native plugin AI acceptance")
            .inner_size(640.0, 360.0)
            .incognito(true)
            .data_directory(profile.join("webview"))
            .build()?;
            let handle = app.handle().clone();
            let report_slot = report_slot.clone();
            let plugin = plugin_for_flow.clone();
            let db = db_for_flow.clone();
            let fixture_url = fixture_url.clone();
            let settings_for_flow = settings_for_flow.clone();
            tauri::async_runtime::spawn(async move {
                let mut events = EventReader::new(event_rx);
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(100),
                    desktop_smoke_flow::run(
                        &handle,
                        &window,
                        &plugin,
                        &db,
                        &mut events,
                        ready_rx,
                        &fixture_url,
                        &settings_for_flow,
                    ),
                )
                .await;
                let mut report = match result {
                    Ok(Ok(report)) => report,
                    Ok(Err(stage)) => json!({"passed":false,"error":safe_stage(&stage)}),
                    Err(_) => json!({"passed":false,"error":"fixture_timeout"}),
                };
                if report["passed"] != true {
                    report["eventTrace"] = events.trace();
                }
                crate::plugin_ai_runtime::stop(&handle).await;
                let state = handle.state::<AppState>();
                let runtime_counts = runtime_snapshot(&handle);
                let runtime_empty = counts_are_zero(&runtime_counts);
                let task_empty = state.pending_agent_requests.lock().is_empty()
                    && state.active_task_runs.lock().is_empty();
                report["requestsDrained"] = json!(runtime_empty && task_empty);
                report["runtimeCounts"] = runtime_counts;
                report["passed"] = json!(report["passed"] == true && runtime_empty && task_empty);
                *report_slot.lock() = Some(report.clone());
                handle.exit(if report["passed"] == true { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .map_err(|_| "Isolated Wry host could not start")?;
    app.run_return(|_, _| {});
    drop(db);
    let provider = fixture
        .stop()
        .map_err(|_| "Provider fixture did not drain")?;
    drop(cleanup);
    let mut report = flow_report
        .lock()
        .take()
        .ok_or("Fixture flow produced no report")?;
    let provider_ok = provider["requests"] == 4
        && provider["validRequests"] == 4
        && provider["noDeltaConnectionClosed"] == true
        && provider["extraRequests"] == 0;
    report["provider"] = provider;
    report["providerDrained"] = json!(provider_ok);
    report["passed"] = json!(report["passed"] == true && provider_ok);
    report["temporaryDataRemoved"] = json!(!root.exists());
    report["scope"] = json!({"nativeWryCommandTaskRunChannel":true,"actualAppApprovalUi":false,
        "originalPluginPanel":false,"originalAIHelper":false,"externalProvider":false});
    let bytes =
        serde_json::to_vec_pretty(&report).map_err(|_| "Fixture report serialization failed")?;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&output)
        .map_err(|_| "Fixture output already exists or cannot be created exclusively")?;
    file.write_all(&bytes)
        .map_err(|_| "Fixture report write failed")?;
    if report["passed"] == true && report["temporaryDataRemoved"] == true {
        Ok(())
    } else {
        Err("Native plugin AI fixture failed".into())
    }
}

fn runtime_snapshot(app: &tauri::AppHandle) -> Value {
    crate::plugin_ai_runtime::runtime_state(app)
}

fn counts_are_zero(counts: &Value) -> bool {
    [
        "requests",
        "byClient",
        "timers",
        "pendingAcks",
        "tombstones",
    ]
    .iter()
    .all(|key| counts[*key].as_u64() == Some(0))
}

const EVENT_TRACE_LIMIT: usize = 32;
const TRACE_STRING_LIMIT: usize = 64;
const TRACE_FIELDS: &[&str] = &[
    "stage",
    "case",
    "code",
    "requestId",
    "clientRequestId",
    "runId",
    "model",
    "taskStatus",
    "label",
    "index",
    "count",
    "seq",
    "envelopeBytes",
    "maxEnvelopeBytes",
    "channelCount",
    "requestBytes",
    "configured",
    "error",
    "changed",
    "rejected",
    "budgetRejected",
    "permissionRequired",
    "foreignExecuteRejected",
    "foreignAckRejected",
    "foreignCancelRejected",
    "staleRejected",
    "acked",
    "hasContent",
    "hasReasoning",
    "callSucceeded",
    "sequenceCorrect",
    "outputTaken",
    "outputExact",
    "contentExact",
    "reasoningExact",
    "finalContentExact",
    "accepted",
    "requestValid",
    "fixtureAuthorization",
];

struct EventReader {
    rx: mpsc::Receiver<Value>,
    stash: Vec<Value>,
    trace: VecDeque<Value>,
}
impl EventReader {
    fn new(rx: mpsc::Receiver<Value>) -> Self {
        Self {
            rx,
            stash: Vec::new(),
            trace: VecDeque::new(),
        }
    }

    fn trace(&self) -> Value {
        Value::Array(self.trace.iter().cloned().collect())
    }

    fn record(&mut self, value: &Value) {
        self.trace.push_back(trace_event(value));
        if self.trace.len() > EVENT_TRACE_LIMIT {
            self.trace.pop_front();
        }
    }

    async fn wait(
        &mut self,
        stage: &str,
        case_name: Option<&str>,
        seconds: u64,
    ) -> Result<Value, String> {
        let matches = |value: &Value| {
            value["stage"] == stage && case_name.is_none_or(|case| value["case"] == case)
        };
        if let Some(index) = self.stash.iter().position(matches) {
            return Ok(self.stash.remove(index));
        }
        tokio::time::timeout(std::time::Duration::from_secs(seconds), async {
            loop {
                let value = self.rx.recv().await.ok_or("Fixture event channel closed")?;
                self.record(&value);
                if value["stage"] == "page-error" {
                    return Err("fixture_page_error".into());
                }
                if matches(&value) {
                    return Ok(value);
                }
                if self.stash.len() >= 32 {
                    return Err("Fixture event budget exceeded".into());
                }
                self.stash.push(value);
            }
        })
        .await
        .map_err(|_| format!("fixture_wait_{stage}"))?
    }

    fn take_case(&mut self, stage: &str, case_name: &str) -> Vec<Value> {
        let mut found = Vec::new();
        self.stash.retain(|value| {
            if value["stage"] == stage && value["case"] == case_name {
                found.push(value.clone());
                false
            } else {
                true
            }
        });
        found
    }
}

fn trace_event(event: &Value) -> Value {
    let mut trace = serde_json::Map::new();
    for field in TRACE_FIELDS {
        let Some(value) = event.get(*field) else {
            continue;
        };
        let safe = match value {
            Value::Bool(_) | Value::Number(_) => value.clone(),
            Value::String(text) => Value::String(text.chars().take(TRACE_STRING_LIMIT).collect()),
            _ => continue,
        };
        trace.insert((*field).to_owned(), safe);
    }
    Value::Object(trace)
}

fn safe_stage(value: &str) -> String {
    let mut out = String::with_capacity(value.len().min(48));
    for ch in value.chars().take(48) {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            out.push(ch);
        }
    }
    if out.is_empty() {
        "fixture_failed".into()
    } else {
        out
    }
}
