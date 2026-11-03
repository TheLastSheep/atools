//! Hidden real-Tauri/WKWebView smoke for the installed-plugin inventory PNG path.
//! It uses a private database/profile and never shows or focuses a window.
use super::Cleanup;
use crate::{
    pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime},
    state::AppState,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tokio::sync::oneshot;

const FIXTURE_ID: &str = "batch58-calculation-paper-logo";
const SOURCE_BYTES: usize = 5031;
const SOURCE_SHA256: &str = "390aaa92636d3b3811341f418ca05497bc8751f6df760fa64c3aa5de6c5f3353";
const FIXTURE_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: asset: http://asset.localhost https://asset.localhost; connect-src ipc: http://ipc.localhost; base-uri 'none'; form-action 'none'; object-src 'none'";

struct InventoryLogoFixture {
    token: String,
    id: String,
    list_plugins_calls: Arc<AtomicUsize>,
    clipboard_calls: Arc<AtomicUsize>,
    report: Mutex<Option<oneshot::Sender<Value>>>,
}

struct NoClipboard(Arc<AtomicUsize>);

#[async_trait]
impl PasteboardBackend for NoClipboard {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in inventory fixture".into())
    }
    async fn write_item(
        &self,
        _: &atools_core::PasteboardItem,
        _: &Path,
        _: bool,
    ) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in inventory fixture".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in inventory fixture".into())
    }
}

#[tauri::command]
fn native_inventory_logo_fixture(fixture: tauri::State<'_, InventoryLogoFixture>) -> Value {
    json!({"token": fixture.token, "pluginId": fixture.id})
}

#[tauri::command]
fn native_inventory_logo_report(
    fixture: tauri::State<'_, InventoryLogoFixture>,
    token: String,
    report: Value,
) -> Result<(), String> {
    if token != fixture.token {
        return Err("Inventory logo report token mismatch".into());
    }
    fixture
        .report
        .lock()
        .take()
        .ok_or("Inventory logo report already received")?
        .send(report)
        .map_err(|_| "Inventory logo report receiver closed".into())
}

fn arg_path(args: &[String], name: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {name}"))
}

fn prepare_private_plugin(
    root: &Path,
    source: &Path,
) -> Result<(AppConfig, Arc<Database>, PathBuf, String), String> {
    let metadata =
        std::fs::metadata(source).map_err(|_| "Pinned logo fixture source unavailable")?;
    if !metadata.is_file() || metadata.len() != SOURCE_BYTES as u64 {
        return Err("Pinned logo fixture source size mismatch".into());
    }
    let bytes = std::fs::read(source).map_err(|_| "Pinned logo fixture source unreadable")?;
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != SOURCE_SHA256 {
        return Err("Pinned logo fixture source hash mismatch".into());
    }

    let config = AppConfig::with_base_dir(root.join("app-data"));
    config
        .ensure_dirs()
        .map_err(|_| "Private app-data setup failed")?;
    let plugin_root = config.plugins_dir().join(FIXTURE_ID);
    std::fs::create_dir_all(&plugin_root).map_err(|_| "Private plugin directory setup failed")?;
    let logo_path = plugin_root.join("logo.png");
    std::fs::write(&logo_path, &bytes).map_err(|_| "Private logo copy failed")?;
    let manifest: PluginManifest = serde_json::from_value(json!({
        "name":"B58 inventory logo fixture", "version":"1.0.0", "main":"index.html", "logo":"logo.png"
    })).map_err(|_| "Private plugin manifest setup failed")?;
    let plugin = Plugin {
        id: FIXTURE_ID.into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: plugin_root.to_string_lossy().into_owned(),
        enabled: false,
        manifest,
        created_at: atools_core::utils::now_iso(),
        updated_at: atools_core::utils::now_iso(),
    };
    let db = Arc::new(
        Database::open(&root.join("inventory.sqlite"))
            .map_err(|_| "Private inventory database setup failed")?,
    );
    db.save_plugin_with_features(&plugin, &[])
        .map_err(|_| "Private inventory record setup failed")?;
    let copied = std::fs::read(&logo_path).map_err(|_| "Private logo copy verification failed")?;
    if copied.len() != SOURCE_BYTES || format!("{:x}", Sha256::digest(&copied)) != SOURCE_SHA256 {
        return Err("Private logo copy differs from pinned source".into());
    }
    Ok((config, db, logo_path, digest))
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Inventory logo WebView fixture targets macOS only".into());
    }
    let args: Vec<String> = std::env::args().collect();
    let root = arg_path(&args, "--fixture-root")?;
    let output = arg_path(&args, "--output")?;
    let panel_js = std::fs::read(arg_path(&args, "--panel-ui")?)
        .map_err(|_| "Inventory smoke bundle unavailable")?;
    let panel_css = std::fs::read(arg_path(&args, "--panel-css")?)
        .map_err(|_| "Inventory smoke stylesheet unavailable")?;
    let source = arg_path(&args, "--inventory-logo-source")?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Output directory setup failed")?;
    }
    std::fs::create_dir(&root).map_err(|_| "Private fixture root must be new")?;
    let cleanup = Cleanup(root.clone());
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "Private fixture root canonicalization failed")?;
    let output_parent = output
        .parent()
        .ok_or("Output path has no parent")?
        .canonicalize()
        .map_err(|_| "Output parent canonicalization failed")?;
    let output_name = output.file_name().ok_or("Output path has no filename")?;
    if output_parent.join(output_name).starts_with(&canonical_root) {
        return Err("Output must be outside the private fixture root".into());
    }
    match std::fs::symlink_metadata(&output) {
        Ok(_) => return Err("Output must be a fresh path".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Output path could not be safely inspected".into()),
    }
    let (config, db, logo_path, source_sha) = prepare_private_plugin(&root, &source)?;
    let expected_path = logo_path
        .canonicalize()
        .map_err(|_| "Private logo path canonicalization failed")?;
    let clipboard_calls = Arc::new(AtomicUsize::new(0));
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard(clipboard_calls.clone())),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db.clone(), None, pasteboard);
    let token = uuid::Uuid::new_v4().to_string();
    let (report_tx, report_rx) = oneshot::channel();
    let list_plugins_calls = Arc::new(AtomicUsize::new(0));
    let fixture = InventoryLogoFixture {
        token: token.clone(),
        id: FIXTURE_ID.into(),
        list_plugins_calls: list_plugins_calls.clone(),
        clipboard_calls: clipboard_calls.clone(),
        report: Mutex::new(Some(report_tx)),
    };
    let passed = Arc::new(AtomicBool::new(false));
    let passed_after = passed.clone();
    let output_for_report = output.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.inventory-logo.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp =
        Some(tauri::utils::config::Csp::Policy(FIXTURE_CSP.into()));
    let root_for_setup = root.clone();
    let command_handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            crate::commands::list_plugins,
            native_inventory_logo_fixture,
            native_inventory_logo_report,
        ]);
    let calls_for_handler = list_plugins_calls.clone();
    let app = tauri::Builder::default()
        .manage(state).manage(fixture)
        .invoke_handler(move |invoke| {
            if invoke.message.command() == "list_plugins" {
                calls_for_handler.fetch_add(1, Ordering::Relaxed);
            }
            command_handler(invoke)
        })
        .register_uri_scheme_protocol("atools-inventory", move |_, request| {
            let (mime, body) = match request.uri().path() {
                "/panel.js" => ("text/javascript", panel_js.clone()),
                "/panel.css" => ("text/css", panel_css.clone()),
                "/" => ("text/html", format!("<!doctype html><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"{}\"><div id=\"app\"></div><script src=\"atools-inventory://localhost/panel.js\"></script>", FIXTURE_CSP).into_bytes()),
                _ => ("text/plain", Vec::new()),
            };
            let status = if matches!(request.uri().path(), "/" | "/panel.js" | "/panel.css") { 200 } else { 404 };
            let mut response = tauri::http::Response::builder().status(status).header("content-type", mime);
            if request.uri().path() == "/" { response = response.header("content-security-policy", FIXTURE_CSP); }
            response.body(body).unwrap()
        })
        .setup(move |app| {
            app.asset_protocol_scope().allow_directory(&root_for_setup, true)?;
            app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-inventory-logo")
                .window("main").remote("atools-inventory://localhost/*".into()))?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol("atools-inventory://localhost/".parse().unwrap()))
                .title("ATools hidden inventory logo smoke").visible(false).focused(false).incognito(true)
                .data_directory(root_for_setup.join("webview")).build()?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut report = match tokio::time::timeout(Duration::from_secs(30), report_rx).await {
                    Ok(Ok(value)) => value,
                    _ => json!({"passed":false,"error":"Hidden inventory WebView report timed out"}),
                };
                let fixture_state = app.state::<InventoryLogoFixture>();
                let list_count = fixture_state.list_plugins_calls.load(Ordering::Relaxed);
                let clipboard_calls = fixture_state.clipboard_calls.load(Ordering::Relaxed);
                let capture_task_started = app.state::<AppState>().pasteboard_capture_task.lock().is_some();
                let window_state = app.get_webview_window("main").map(|window| {
                    (window.is_visible().ok(), window.is_focused().ok())
                });
                let window_visible = window_state.as_ref().and_then(|state| state.0);
                let window_focused = window_state.as_ref().and_then(|state| state.1);
                let projection_ok = report["pluginId"] == FIXTURE_ID
                    && report["sourceKind"] == "imported"
                    && report["inventoryLogoPath"] == expected_path.to_string_lossy().as_ref()
                    && list_count == 1;
                let side_effects_ok = clipboard_calls == 0 && !capture_task_started
                    && window_visible == Some(false) && window_focused == Some(false);
                let decode_ok = report["decodeResolved"] == true && report["complete"] == true
                    && report["naturalWidth"] == 200 && report["naturalHeight"] == 200
                    && report["fallbackVisible"] == false
                    && report["assetUrlAllowed"] == true;
                report["sourceBytes"] = json!(SOURCE_BYTES);
                report["sourceSha256"] = json!(source_sha);
                report["projectionPassed"] = json!(projection_ok);
                report["webviewDecodePassed"] = json!(decode_ok);
                report["expectedCsp"] = json!(FIXTURE_CSP);
                let csp_violations = report["cspViolationCount"].as_u64().unwrap_or(u64::MAX);
                report["cspViolationCount"] = json!(csp_violations);
                report["listPluginsIpcCount"] = json!(list_count);
                report["pasteboardCaptureTaskStarted"] = json!(capture_task_started);
                report["pasteboardBackendCalls"] = json!(clipboard_calls);
                report["windowVisibleObserved"] = json!(window_visible);
                report["windowFocusedObserved"] = json!(window_focused);
                report["sideEffectsPassed"] = json!(side_effects_ok);
                report["scope"] = json!("One pinned 5031-byte imported plugin PNG through production list_plugins projection, PluginInventoryPanel/PluginInventoryIcon, convertFileSrc, and macOS Tauri asset protocol/WKWebView; no original plugin runtime or user profile");
                report["limitations"] = json!(["Hidden WebView image loading is the subject under test; timeout is a failure, not a browser fallback", "Single macOS fixture and one PNG; no broad plugin/business or performance claim"]);
                let csp_ok = report["cspMeta"] == FIXTURE_CSP && csp_violations == 0;
                report["cspPassed"] = json!(csp_ok);
                let accepted = projection_ok && decode_ok && side_effects_ok && csp_ok;
                report["passed"] = json!(accepted);
                let write_ok = std::fs::write(&output_for_report, serde_json::to_vec_pretty(&report).unwrap()).is_ok();
                passed.store(accepted && write_ok, Ordering::Release);
                app.exit(if accepted && write_ok { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context).map_err(|error| error.to_string())?;
    app.run_return(|_, _| {});
    drop(db);
    drop(cleanup);
    let removed = matches!(
        std::fs::symlink_metadata(&root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound
    );
    let bytes =
        std::fs::read(&output).map_err(|_| "Native inventory report missing after app exit")?;
    let mut report: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Native inventory report is invalid JSON")?;
    report["temporaryDataRemoved"] = json!(removed);
    if !removed {
        report["passed"] = json!(false);
    }
    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap())
        .map_err(|_| "Native inventory final report write failed")?;
    let final_report: Value = serde_json::from_slice(
        &std::fs::read(&output).map_err(|_| "Native inventory final report unreadable")?,
    )
    .map_err(|_| "Native inventory final report is invalid JSON")?;
    if passed_after.load(Ordering::Acquire)
        && removed
        && final_report["passed"] == true
        && final_report["temporaryDataRemoved"] == true
        && final_report["listPluginsIpcCount"] == 1
        && final_report["pasteboardBackendCalls"] == 0
        && final_report["pasteboardCaptureTaskStarted"] == false
        && final_report["windowVisibleObserved"] == false
        && final_report["windowFocusedObserved"] == false
    {
        Ok(())
    } else {
        Err("Hidden inventory logo smoke failed; see report".into())
    }
}
