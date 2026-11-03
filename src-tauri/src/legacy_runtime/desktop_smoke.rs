//! Opt-in native acceptance harness. Never uses AppConfig::new or production data.
#[path = "desktop_smoke_catalog_fixture.rs"]
mod catalog_fixture;
#[path = "desktop_smoke_flow.rs"]
mod flow;
#[path = "desktop_smoke_inventory_logo.rs"]
mod inventory_logo;
#[path = "desktop_smoke_main_push.rs"]
mod main_push;
#[path = "desktop_smoke_native_image_consumer.rs"]
mod native_image_consumer;
#[path = "desktop_smoke_native_image_consumer_audit.rs"]
mod native_image_consumer_audit;
#[path = "desktop_smoke_native_image_toolbox.rs"]
mod native_image_toolbox;
#[path = "desktop_smoke_native_image_toolbox_artifact.rs"]
mod native_image_toolbox_artifact;
#[path = "desktop_smoke_native_image_toolbox_entry.rs"]
mod native_image_toolbox_entry;
#[path = "desktop_smoke_native_image_toolbox_grants.rs"]
mod native_image_toolbox_grants;
#[path = "desktop_smoke_native_image_toolbox_stage.rs"]
mod native_image_toolbox_stage;
#[path = "desktop_smoke_native_image_toolbox_startup_receipts.rs"]
mod native_image_toolbox_startup_receipts;
#[path = "desktop_smoke_native_image_toolbox_window.rs"]
mod native_image_toolbox_window;
#[path = "desktop_smoke_native_image_toolbox_window_contract.rs"]
mod native_image_toolbox_window_contract;
#[path = "desktop_smoke_page.rs"]
mod page;
#[path = "desktop_smoke_panel.rs"]
mod panel;
#[path = "desktop_smoke_panel_dialog.rs"]
pub(crate) mod panel_dialog;
#[path = "desktop_smoke_panel_foreground.rs"]
mod panel_foreground;
#[path = "desktop_smoke_panel_node_page.rs"]
pub(super) mod panel_node_page;
#[path = "desktop_smoke_panel_perf.rs"]
mod panel_perf;
#[path = "desktop_smoke_permission.rs"]
mod permission;
#[path = "desktop_smoke_plugin_mutation.rs"]
mod plugin_mutation;
#[path = "desktop_smoke_plugin_navigation.rs"]
mod plugin_navigation;
#[path = "desktop_smoke_published_plugin.rs"]
mod published_plugin;
#[path = "desktop_smoke_source_build.rs"]
mod source_build;

use crate::pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime};
use crate::state::AppState;
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

pub(super) struct Fixture {
    root: PathBuf,
    bridge: String,
    plugin: Plugin,
    secret: String,
    private_error: String,
    output: PathBuf,
    permission_ui: Option<Vec<u8>>,
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct NoClipboard;
#[async_trait]
impl PasteboardBackend for NoClipboard {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        Err("Clipboard is disabled in smoke".into())
    }
    async fn write_item(&self, _: &PasteboardItem, _: &Path, _: bool) -> Result<(), String> {
        Err("Clipboard is disabled in smoke".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        Err("Clipboard is disabled in smoke".into())
    }
}

fn arguments() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let args: Vec<_> = std::env::args().collect();
    let value = |key: &str| {
        args.windows(2)
            .find(|pair| pair[0] == key)
            .map(|pair| PathBuf::from(&pair[1]))
            .filter(|p| p.is_absolute())
            .ok_or_else(|| format!("Missing absolute {key}"))
    };
    Ok((
        value("--bridge-script")?,
        value("--output")?,
        value("--fixture-root")?,
    ))
}

fn fixture(bridge_path: &Path, output: PathBuf, root: PathBuf) -> Result<Fixture, String> {
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(root.join("plugin")).map_err(|e| e.to_string())?;
    let secret = format!("NATIVE_PRIVATE_VALUE_{}", uuid::Uuid::new_v4());
    let private_error = format!("NATIVE_PRIVATE_ERROR_{}", uuid::Uuid::new_v4());
    std::fs::write(root.join("plugin/data.txt"), &secret).map_err(|e| e.to_string())?;
    let ui_path = std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == "--permission-ui")
        .map(|pair| PathBuf::from(&pair[1]));
    let permission_ui = ui_path
        .map(std::fs::read)
        .transpose()
        .map_err(|e| e.to_string())?;
    std::fs::write(
        root.join("plugin/preload.cjs"),
        if permission_ui.is_some() { r#"module.exports={
          hash(text){return require('node:crypto').createHash('sha256').update(text).digest('hex')},
          async collect(){const core=await import('./local.mjs');const seen=[];core.collect(value=>seen.push(value));return seen},
          async dynamic(){const url=require('node:url').pathToFileURL(require('node:path').join(__dirname,'dynamic.mjs')).href;return(await import(url)).value}
        };"# }
        else { "throw new Error('preload must remain in WebView');" },
    )
    .map_err(|e| e.to_string())?;
    if permission_ui.is_some() {
        std::fs::write(
            root.join("plugin/local.mjs"),
            "export function collect(emit){emit(7);emit(11)};",
        )
        .map_err(|e| e.to_string())?;
        std::fs::write(
            root.join("plugin/dynamic.mjs"),
            "export const value='native-file-module';",
        )
        .map_err(|e| e.to_string())?;
    }
    std::fs::write(
        root.join("plugin/private.cjs"),
        format!(
            "module.exports = {{ fail() {{ throw new Error({}); }} }};",
            serde_json::to_string(&private_error).unwrap()
        ),
    )
    .map_err(|e| e.to_string())?;
    let manifest:PluginManifest=serde_json::from_value(json!({"name":"isolated-native-node-smoke","version":"0.0.0","main":"index.html","preload":"preload.cjs"})).map_err(|e|e.to_string())?;
    let plugin = Plugin {
        id: "isolated-native-node-smoke".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: root.join("plugin").to_string_lossy().into(),
        enabled: true,
        manifest,
        created_at: atools_core::utils::now_iso(),
        updated_at: atools_core::utils::now_iso(),
    };
    Ok(Fixture {
        root,
        bridge: std::fs::read_to_string(bridge_path).map_err(|e| e.to_string())?,
        plugin,
        secret,
        private_error,
        output,
        permission_ui,
    })
}

pub fn run() -> Result<(), String> {
    if std::env::args().any(|arg| arg == "--image-toolbox-original-ui") {
        return native_image_toolbox::run();
    }
    if std::env::args().any(|arg| arg == "--pasteboard-pro-native-image-ui") {
        return native_image_consumer::run();
    }
    if std::env::args().any(|arg| arg == "--inventory-logo-ui") {
        return inventory_logo::run();
    }
    if std::env::args().any(|arg| arg == "--display-metadata-ui") {
        return crate::plugin_display_runtime::desktop_smoke::run();
    }
    if std::env::args().any(|arg| arg == "--source-build-ui") {
        return source_build::run();
    }
    if std::env::args().any(|arg| arg == "--main-push-ui") {
        return main_push::run();
    }
    if std::env::args().any(|arg| arg == "--plugin-mutation-panel-ui") {
        return plugin_mutation::run();
    }
    if std::env::args().any(|arg| arg == "--plugin-navigation-panel-ui") {
        return plugin_navigation::run();
    }
    if std::env::args().any(|arg| arg == "--published-plugin-panel-ui") {
        return published_plugin::run();
    }
    if std::env::args().any(|arg| arg == "--file-tree-head-ui") {
        return panel::run();
    }
    if std::env::args().any(|arg| arg == "--developer-codec-tools-head-ui") {
        return panel::run();
    }
    if std::env::args().any(|arg| arg == "--panel-ui") {
        return panel::run();
    }
    let (bridge, output, root) = arguments()?;
    let fixture = Arc::new(fixture(&bridge, output, root)?);
    let _cleanup = Cleanup(fixture.root.clone());
    let cleanup_path = fixture.root.clone();
    let report_path = fixture.output.clone();
    let config = AppConfig::with_base_dir(fixture.root.join("app-data"));
    config.ensure_dirs().map_err(|e| e.to_string())?;
    let db =
        Arc::new(Database::open(&fixture.root.join("smoke.sqlite")).map_err(|e| e.to_string())?);
    db.save_plugin_with_features(&fixture.plugin, &[])
        .map_err(|e| e.to_string())?;
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db, None, pasteboard);
    let (ready_tx, ready_rx) = oneshot::channel::<Value>();
    let (result_tx, result_rx) = oneshot::channel::<Value>();
    let ready = Arc::new(Mutex::new(Some(ready_tx)));
    let result = Arc::new(Mutex::new(Some(result_tx)));
    let passed = Arc::new(AtomicBool::new(false));
    let passed_after = passed.clone();
    let root = fixture.root.clone();
    let ui_source = fixture.permission_ui.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.isolated-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let app = tauri::Builder::default()
        .manage(state)
        .manage(fixture.clone())
        .invoke_handler(tauri::generate_handler![
            permission::native_permission_fixture,
            permission::native_permission_runtime_state,
            crate::legacy_runtime::commands::prepare_legacy_node,
            crate::legacy_runtime::commands::get_legacy_node_session,
            crate::legacy_runtime::commands::close_legacy_node,
            crate::legacy_runtime::permission_context::get_permission_request_context,
            crate::plugin_resources::read_plugin_preload_module,
            crate::commands::list_pending_agent_requests,
            crate::commands::get_task_run,
            crate::commands::dismiss_pending_agent_request,
            crate::commands::call_agent_tool,
            crate::commands::grant_agent_tool,
            crate::commands::list_agent_tool_grants,
            crate::commands::revoke_agent_tool,
        ])
        .register_uri_scheme_protocol("atools-smoke", move |_, request| {
            if request.uri().path() == "/permission-ui.js" {
                return tauri::http::Response::builder()
                    .header("content-type", "text/javascript")
                    .body(ui_source.clone().unwrap_or_default())
                    .unwrap();
            }
            if request.uri().path() == "/report" {
                if request.body().len() < 65536 {
                    if let Ok(value) = serde_json::from_slice::<Value>(request.body()) {
                        let destination =
                            if value.get("stage").and_then(Value::as_str) == Some("ready") {
                                &ready
                            } else {
                                &result
                            };
                        if let Some(sender) = destination.lock().take() {
                            let _ = sender.send(value);
                        }
                    }
                }
                return tauri::http::Response::builder()
                    .header("content-type", "text/plain")
                    .body(b"ok".to_vec())
                    .unwrap();
            }
            tauri::http::Response::builder()
                .header("content-type", "text/html")
                .body(
                    if ui_source.is_some() {
                        page::PERMISSION_HOST
                    } else {
                        page::HOST
                    }
                    .as_bytes()
                    .to_vec(),
                )
                .unwrap()
        })
        .setup(move |app| {
            crate::legacy_runtime::install_manager(app.handle());
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("isolated-native-permission")
                    .window("legacy-smoke")
                    .remote("atools-smoke://localhost/*".into())
                    .permission("core:event:allow-listen")
                    .permission("core:event:allow-unlisten"),
            )?;
            let window = WebviewWindowBuilder::new(
                app,
                "legacy-smoke",
                WebviewUrl::CustomProtocol("atools-smoke://localhost/index.html".parse().unwrap()),
            )
            .title("ATools isolated Node gate smoke")
            .inner_size(620.0, 360.0)
            .incognito(true)
            .data_directory(root.join("webview"))
            .build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let outcome = tokio::time::timeout(std::time::Duration::from_secs(35), async {
                    if fixture.permission_ui.is_some() {
                        let result = result_rx.await.map_err(|_| {
                            "Native permission UI report channel closed".to_string()
                        })?;
                        permission::report(&app, result)
                    } else {
                        flow::run(&app, &window, &fixture, ready_rx, result_rx).await
                    }
                })
                .await;
                let report = match outcome {
                    Ok(Ok(report)) => {
                        passed.store(true, Ordering::Release);
                        report
                    }
                    Ok(Err(error)) => json!({"passed":false,"error":error}),
                    Err(_) => json!({"passed":false,"error":"native gate smoke timed out"}),
                };
                app.state::<Arc<crate::legacy_runtime::Sessions>>()
                    .stop_all()
                    .await;
                if let Some(parent) = fixture.output.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ =
                    std::fs::write(&fixture.output, serde_json::to_vec_pretty(&report).unwrap());
                app.exit(if passed.load(Ordering::Acquire) { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context)
        .map_err(|e| e.to_string())?;
    app.run_return(|_, _| {});
    drop(_cleanup);
    let removed = !cleanup_path.exists();
    if let Ok(bytes) = std::fs::read(&report_path) {
        if let Ok(mut report) = serde_json::from_slice::<Value>(&bytes) {
            report["temporaryDataRemoved"] = json!(removed);
            if !removed {
                report["passed"] = json!(false);
            }
            let _ = std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap());
        }
    }
    if passed_after.load(Ordering::Acquire) && removed {
        Ok(())
    } else {
        Err("Native smoke did not pass; see output report".into())
    }
}
