//! Opt-in Wry acceptance of the real native file-drop command/TaskRun path.
#[path = "desktop_smoke_flow.rs"]
mod flow;
#[path = "desktop_smoke_page.rs"]
mod page;
use super::commands;
use crate::{
    pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime},
    state::AppState,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

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
struct Endpoints {
    ready: Mutex<Option<oneshot::Sender<()>>>,
    prepared: Mutex<Option<oneshot::Sender<Value>>>,
    delivered: Mutex<Option<oneshot::Sender<Value>>>,
    cancelled: Mutex<Option<oneshot::Sender<Value>>>,
    cancel_prepared: Mutex<Option<oneshot::Sender<Value>>>,
    max_prepared: Mutex<Option<oneshot::Sender<Value>>>,
    max_delivered: Mutex<Option<oneshot::Sender<Value>>>,
}
fn send(slot: &Mutex<Option<oneshot::Sender<Value>>>, value: Value) {
    if let Some(sender) = slot.lock().take() {
        let _ = sender.send(value);
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
    std::fs::write(path.join("index.html"), "isolated file-drop host fixture")
        .map_err(|_| "Fixture plugin file failed")?;
    let manifest: PluginManifest = serde_json::from_value(
        json!({"name":"Isolated File Drop Fixture","version":"0.0.0","main":"index.html"}),
    )
    .map_err(|_| "Fixture manifest failed")?;
    Ok(Plugin {
        id: "isolated-native-file-drop".into(),
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
    let max_payload_case = args.iter().any(|arg| arg == "--max-payload-case");
    let root = absolute(&args, "--fixture-root")?;
    let output = absolute(&args, "--output")?;
    let output_parent = output.parent().ok_or("Fixture output has no parent")?;
    if root.exists()
        || std::fs::symlink_metadata(&root).is_ok()
        || output.starts_with(&root)
        || std::fs::symlink_metadata(&output).is_ok()
        || !output_parent.is_dir()
        || std::fs::canonicalize(output_parent)
            .map_err(|_| "Fixture output parent is unavailable")?
            .as_path()
            != output_parent
    {
        return Err(
            "Fixture paths must be new, non-symlink paths with an existing output parent".into(),
        );
    }
    std::fs::create_dir(&root).map_err(|_| "Fixture root must not exist")?;
    let cleanup = Cleanup(root.clone());
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
    let plugin = make_plugin(&root)?;
    db.save_plugin_with_features(&plugin, &[])
        .map_err(|_| "Fixture plugin registration failed")?;
    let history = Arc::new(PasteboardRuntime::new(
        Arc::new(NoHistory),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db, None, history);
    let (ready_tx, ready_rx) = oneshot::channel();
    let (prepared_tx, prepared_rx) = oneshot::channel();
    let (delivered_tx, delivered_rx) = oneshot::channel();
    let (cancel_prepared_tx, cancel_prepared_rx) = oneshot::channel();
    let (cancelled_tx, cancelled_rx) = oneshot::channel();
    let (max_prepared_tx, max_prepared_rx) = oneshot::channel();
    let (max_delivered_tx, max_delivered_rx) = oneshot::channel();
    let endpoints = Arc::new(Endpoints {
        ready: Mutex::new(Some(ready_tx)),
        prepared: Mutex::new(Some(prepared_tx)),
        delivered: Mutex::new(Some(delivered_tx)),
        cancelled: Mutex::new(Some(cancelled_tx)),
        cancel_prepared: Mutex::new(Some(cancel_prepared_tx)),
        max_prepared: Mutex::new(Some(max_prepared_tx)),
        max_delivered: Mutex::new(Some(max_delivered_tx)),
    });
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.file-drop-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let endpoint_state = endpoints.clone();
    let profile = root.clone();
    let flow_root = root.clone();
    let flow_report = Arc::new(Mutex::new(None::<Value>));
    let report_slot = flow_report.clone();
    let fixture_plugin = plugin.clone();
    let app = tauri::Builder::default()
        .manage(state)
        .register_uri_scheme_protocol("atools-file-drop-smoke", move |_, request| {
            let path = request.uri().path();
            let body = request.body();
            let oversized = body.len() > 64 * 1024;
            if !oversized {
                match path {
                    "/ready" => {
                        if let Some(tx) = endpoint_state.ready.lock().take() {
                            let _ = tx.send(());
                        }
                    }
                    "/prepared" => {
                        if let Ok(value) = serde_json::from_slice(body) {
                            send(&endpoint_state.prepared, value);
                        }
                    }
                    "/delivered" => {
                        if let Ok(value) = serde_json::from_slice(body) {
                            send(&endpoint_state.delivered, value);
                        }
                    }
                    "/cancel-prepared" => {
                        if let Ok(value) = serde_json::from_slice(body) {
                            send(&endpoint_state.cancel_prepared, value);
                        }
                    }
                    "/cancelled" => {
                        if let Ok(value) = serde_json::from_slice(body) {
                            send(&endpoint_state.cancelled, value);
                        }
                    }
                    "/max-prepared" => {
                        if let Ok(value) = serde_json::from_slice(body) {
                            send(&endpoint_state.max_prepared, value);
                        }
                    }
                    "/max-delivered" => {
                        if let Ok(value) = serde_json::from_slice(body) {
                            send(&endpoint_state.max_delivered, value);
                        }
                    }
                    _ => {}
                }
            }
            let (status, content_type, data) = if oversized {
                (
                    tauri::http::StatusCode::PAYLOAD_TOO_LARGE,
                    "text/plain",
                    Vec::new(),
                )
            } else if path == "/index.html" {
                (
                    tauri::http::StatusCode::OK,
                    "text/html",
                    page::PAGE.as_bytes().to_vec(),
                )
            } else {
                (
                    tauri::http::StatusCode::NO_CONTENT,
                    "text/plain",
                    Vec::new(),
                )
            };
            tauri::http::Response::builder()
                .status(status)
                .header("content-type", content_type)
                .body(data)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            commands::prepare_plugin_file_drop,
            commands::get_plugin_file_drop_delivery,
            commands::close_plugin_file_drop,
            commands::discard_plugin_file_drop_intent
        ])
        .setup(move |app| {
            super::install_manager(app.handle());
            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::CustomProtocol(
                    "atools-file-drop-smoke://localhost/index.html"
                        .parse()
                        .unwrap(),
                ),
            )
            .title("Isolated native file-drop acceptance")
            .inner_size(640.0, 360.0)
            .incognito(true)
            .data_directory(profile.join("webview"))
            .build()?;
            let handle = app.handle().clone();
            let flow_root = flow_root.clone();
            let report_slot = report_slot.clone();
            let plugin = fixture_plugin.clone();
            let max_payload_case = max_payload_case;
            tauri::async_runtime::spawn(async move {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(50),
                    flow::run(
                        &handle,
                        &window,
                        &plugin,
                        &flow_root,
                        ready_rx,
                        prepared_rx,
                        delivered_rx,
                        cancel_prepared_rx,
                        cancelled_rx,
                        max_payload_case,
                        max_prepared_rx,
                        max_delivered_rx,
                    ),
                )
                .await;
                let mut report = match result {
                    Ok(Ok(report)) => report,
                    Ok(Err(stage)) => json!({"passed":false,"error":sanitize_stage(&stage)}),
                    Err(_) => json!({"passed":false,"error":"fixture_timeout"}),
                };
                super::stop(&handle).await;
                let drained = super::manager(&handle).ok().is_some_and(|runtime| {
                    let store = runtime.store.lock();
                    store.selections.is_empty()
                        && store.requests.is_empty()
                        && store.selection_timers.is_empty()
                        && store.request_timers.is_empty()
                }) && handle
                    .state::<AppState>()
                    .pending_agent_requests
                    .lock()
                    .is_empty();
                report["closeDrained"] = json!(drained);
                report["passed"] = json!(report["passed"] == true && drained);
                *report_slot.lock() = Some(report.clone());
                handle.exit(if report["passed"] == true { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .map_err(|_| "Isolated Wry host could not start")?;
    app.run_return(|_, _| {});
    drop(cleanup);
    let mut report = flow_report
        .lock()
        .take()
        .ok_or("Fixture flow produced no report")?;
    report["temporaryDataRemoved"] = json!(!root.exists());
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
        Err("Native file-drop fixture failed".into())
    }
}

fn sanitize_stage(stage: &str) -> String {
    let mut result = String::with_capacity(stage.len().min(64));
    let mut separator = false;
    for ch in stage.chars() {
        if result.len() >= 64 {
            break;
        }
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            result.push(ch);
            separator = false;
        } else if !separator && !result.is_empty() {
            result.push('_');
            separator = true;
        }
    }
    result.trim_end_matches('_').to_owned()
}
