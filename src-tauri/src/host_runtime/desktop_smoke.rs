//! Opt-in Wry + actual native named pasteboard + production permission pipeline.
//! Never opens the general clipboard or the production AppConfig/database.
#[path = "desktop_smoke_flow.rs"]
mod flow;
use super::{
    clipboard::{ClipboardAccess, NamedClipboard},
    Sessions,
};
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
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

struct NoHistory;
#[async_trait]
impl PasteboardBackend for NoHistory {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        Err("History capture disabled".into())
    }
    async fn write_item(&self, _: &PasteboardItem, _: &Path, _: bool) -> Result<(), String> {
        Err("History writes disabled".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        Err("Paste disabled".into())
    }
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct ClearNamed(Arc<NamedClipboard>);
impl Drop for ClearNamed {
    fn drop(&mut self) {
        let _ = self.0.write("");
    }
}
const HOST: &str = r#"<!doctype html><meta charset="utf-8"><title>Isolated host clipboard gate</title>
<iframe sandbox="allow-scripts" style="width:100%;height:200px"></iframe><script>
const frame=document.querySelector('iframe');
window.startHostFixture=html=>frame.srcdoc=html;
addEventListener('message',event=>{if(event.source!==frame.contentWindow||!event.data?.hostClipboardReport)return;
fetch('atools-host-smoke://localhost/result',{method:'POST',body:JSON.stringify(event.data)});});
fetch('atools-host-smoke://localhost/ready',{method:'POST',body:'{}'});
</script>"#;

pub fn run() -> Result<(), String> {
    let args: Vec<_> = std::env::args().collect();
    let argument = |key| {
        args.windows(2)
            .find(|a| a[0] == key)
            .map(|a| PathBuf::from(&a[1]))
            .filter(|p| p.is_absolute())
            .ok_or_else(|| format!("Missing absolute {key}"))
    };
    let root = argument("--fixture-root")?;
    let output = argument("--output")?;
    let bridge =
        std::fs::read_to_string(argument("--bridge-script")?).map_err(|e| e.to_string())?;
    // create_dir refuses any pre-existing profile, including a symlink.
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    let cleanup = Cleanup(root.clone());
    let config = AppConfig::with_base_dir(root.join("app-data"));
    config.ensure_dirs().map_err(|e| e.to_string())?;
    let db = Arc::new(Database::open(&root.join("fixture.sqlite")).map_err(|e| e.to_string())?);
    let manifest: PluginManifest = serde_json::from_value(
        json!({"name":"Isolated Clipboard Fixture","version":"0.0.0","main":"index.html"}),
    )
    .unwrap();
    let plugin = Plugin {
        id: "isolated-host-clipboard".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: root.join("plugin").to_string_lossy().into(),
        enabled: true,
        manifest,
        created_at: atools_core::utils::now_iso(),
        updated_at: atools_core::utils::now_iso(),
    };
    db.save_plugin_with_features(&plugin, &[])
        .map_err(|e| e.to_string())?;
    let history = Arc::new(PasteboardRuntime::new(
        Arc::new(NoHistory),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db, None, history);
    let native = Arc::new(NamedClipboard(format!(
        "dev.atools.host-smoke.{}",
        uuid::Uuid::new_v4()
    )));
    let _clear = ClearNamed(native.clone());
    let sessions = Arc::new(Sessions::new(native.clone()));
    let (ready_tx, ready_rx) = oneshot::channel();
    let (result_tx, result_rx) = oneshot::channel();
    let ready = Mutex::new(Some(ready_tx));
    let result = Mutex::new(Some(result_tx));
    let mut context = tauri::generate_context!();
    context.config_mut().identifier =
        format!("dev.atools.host-smoke.{}", uuid::Uuid::new_v4().simple());
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let destination = output.clone();
    let profile = root.clone();
    let app = tauri::Builder::default()
        .manage(state)
        .manage(sessions)
        .register_uri_scheme_protocol("atools-host-smoke", move |_, request| {
            if request.uri().path() == "/ready" {
                if let Some(tx) = ready.lock().take() {
                    let _ = tx.send(());
                }
            }
            if request.uri().path() == "/result" && request.body().len() < 65536 {
                if let Ok(value) = serde_json::from_slice::<Value>(request.body()) {
                    if let Some(tx) = result.lock().take() {
                        let _ = tx.send(value);
                    }
                }
            }
            tauri::http::Response::builder()
                .header("content-type", "text/html")
                .body(HOST.as_bytes().to_vec())
                .unwrap()
        })
        .setup(move |app| {
            let window = WebviewWindowBuilder::new(
                app,
                "host-clipboard-smoke",
                WebviewUrl::CustomProtocol(
                    "atools-host-smoke://localhost/index.html".parse().unwrap(),
                ),
            )
            .title("ATools isolated clipboard fixture")
            .inner_size(620.0, 280.0)
            .incognito(true)
            .data_directory(profile.join("webview"))
            .build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result = tokio::time::timeout(
                    std::time::Duration::from_secs(25),
                    flow::run(
                        &app, &window, &plugin, &bridge, &native, ready_rx, result_rx,
                    ),
                )
                .await;
                let report = match result {
                    Ok(Ok(report)) => report,
                    Ok(Err(error)) => json!({"passed":false,"error":error}),
                    Err(_) => json!({"passed":false,"error":"Host clipboard fixture timed out"}),
                };
                if let Ok(runtime) = super::manager(&app) {
                    runtime.close(None, None, true).await;
                }
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
        Err("Host clipboard fixture failed".into())
    }
}
