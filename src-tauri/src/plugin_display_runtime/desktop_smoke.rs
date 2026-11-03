//! Opt-in isolated Wry fixture for the production display metadata adapter.
//! Running it performs real main-thread metadata reads; source and compile checks do not.
#[path = "desktop_smoke_evidence.rs"]
mod evidence;
#[path = "desktop_smoke_flow.rs"]
mod flow;

use crate::{
    pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime},
    state::AppState,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

struct NoClipboard;
#[async_trait]
impl PasteboardBackend for NoClipboard {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        Err("Clipboard disabled in display fixture".into())
    }
    async fn write_item(&self, _: &PasteboardItem, _: &Path, _: bool) -> Result<(), String> {
        Err("Clipboard disabled in display fixture".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        Err("Clipboard disabled in display fixture".into())
    }
}

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn argument(args: &[String], key: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|pair| pair[0] == key)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {key}"))
}

fn fixture(root: &Path) -> Result<Plugin, String> {
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    std::fs::create_dir(root.join("plugin")).map_err(|e| e.to_string())?;
    // The scanner observes a getter reference; this inert page never runs plugin code.
    std::fs::write(root.join("plugin/index.html"), "<!doctype html><title>Display fixture</title><script>void window.ztools.getPrimaryDisplay;</script>")
        .map_err(|e| e.to_string())?;
    let manifest: PluginManifest = serde_json::from_value(
        json!({"name":"Isolated Display Fixture","version":"0.0.0","main":"index.html"}),
    )
    .map_err(|e| e.to_string())?;
    let plugin = Plugin {
        id: "isolated-native-display".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: root.join("plugin").to_string_lossy().into(),
        enabled: true,
        manifest,
        created_at: atools_core::utils::now_iso(),
        updated_at: atools_core::utils::now_iso(),
    };
    Ok(plugin)
}

pub fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    let root = argument(&args, "--fixture-root")?;
    let output = argument(&args, "--output")?;
    let probe = std::fs::read(argument(&args, "--probe-script")?).map_err(|e| e.to_string())?;
    let plugin = fixture(&root)?;
    let cleanup = Cleanup(root.clone());
    let config = AppConfig::with_base_dir(root.join("app-data"));
    config.ensure_dirs().map_err(|e| e.to_string())?;
    let db = Arc::new(Database::open(&root.join("fixture.sqlite")).map_err(|e| e.to_string())?);
    db.save_plugin_with_features(&plugin, &[])
        .map_err(|e| e.to_string())?;
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db, None, pasteboard);
    let (ready_tx, ready_rx) = oneshot::channel();
    let (result_tx, result_rx) = oneshot::channel();
    let ready = Arc::new(Mutex::new(Some(ready_tx)));
    let result = Arc::new(Mutex::new(Some(result_tx)));
    let destination = output.clone();
    let profile = root.clone();
    let page_script = String::from_utf8(probe).map_err(|_| "Invalid display probe bundle")?;
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.fixture.display.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let app = tauri::Builder::default()
        .manage(state)
        .register_uri_scheme_protocol("atools-display-smoke", move |_, request| {
            if request.uri().path() == "/ready" {
                if let Some(sender) = ready.lock().take() {
                    let _ = sender.send(());
                }
            }
            if request.uri().path() == "/report" && request.body().len() < 65536 {
                if let Ok(value) = serde_json::from_slice::<Value>(request.body()) {
                    if let Some(sender) = result.lock().take() {
                        let _ = sender.send(value);
                    }
                }
            }
            let (content_type, body) = if request.uri().path() == "/probe.js" {
                ("text/javascript", page_script.as_bytes().to_vec())
            } else {
                ("text/html", flow::HOST.as_bytes().to_vec())
            };
            tauri::http::Response::builder()
                .header("content-type", content_type)
                .body(body)
                .unwrap()
        })
        .setup(move |app| {
            crate::plugin_display_runtime::install_manager(app.handle());
            app.manage(evidence::FrameEvidence::default());
            let window = WebviewWindowBuilder::new(
                app,
                "display-smoke",
                WebviewUrl::CustomProtocol(
                    "atools-display-smoke://localhost/index.html"
                        .parse()
                        .unwrap(),
                ),
            )
            .title("ATools isolated display metadata fixture")
            .inner_size(420.0, 180.0)
            .incognito(true)
            .data_directory(profile.join("webview"))
            .build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let outcome = tokio::time::timeout(
                    std::time::Duration::from_secs(70),
                    flow::run(&app, &window, &plugin, ready_rx, result_rx),
                )
                .await;
                let outcome = match outcome {
                    Ok(value) => value,
                    Err(_) => Err("Display fixture deadline exceeded".into()),
                };
                let report = evidence::finalize(&app, outcome).await;
                if let Some(parent) = destination.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&destination, serde_json::to_vec_pretty(&report).unwrap());
                app.exit(if report["passed"] == true { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .map_err(|e| e.to_string())?;
    app.run_return(|_, _| {});
    drop(cleanup);
    let mut report: Value =
        serde_json::from_slice(&std::fs::read(&output).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    report["temporaryDataRemoved"] = json!(!root.exists());
    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap())
        .map_err(|e| e.to_string())?;
    if report["passed"] == true && !root.exists() {
        Ok(())
    } else {
        Err("Display fixture failed".into())
    }
}
