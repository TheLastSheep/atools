//! Hidden real-Tauri smoke for the unmodified Image-Toolbox plugin entry path.
//! Only the copied entry HTML gains a bounded observer; App, preload, and modules stay original.
use super::native_image_toolbox_grants::{self, FIXTURE_ID};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, PasteboardItem, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;
use tokio::sync::oneshot;

const FEATURE_CODE: &str = "image-edit";
const INPUT_BYTES: usize = 5031;
const INPUT_SHA256: &str = "390aaa92636d3b3811341f418ca05497bc8751f6df760fa64c3aa5de6c5f3353";

struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
struct NoClipboard(Arc<AtomicUsize>);
#[async_trait]
impl crate::pasteboard_runtime::PasteboardBackend for NoClipboard {
    async fn snapshot_if_changed(
        &self,
        _: i64,
    ) -> Result<Option<crate::pasteboard_runtime::NativePasteboardSnapshot>, String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in Image-Toolbox fixture".into())
    }
    async fn write_item(&self, _: &PasteboardItem, _: &Path, _: bool) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in Image-Toolbox fixture".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in Image-Toolbox fixture".into())
    }
}

#[tauri::command]
fn native_image_toolbox_fixture(
    state: tauri::State<'_, super::native_image_toolbox_stage::FixtureState>,
) -> Value {
    json!({"token":state.token,"inputPath":state.input_path,"pluginId":FIXTURE_ID,"featureCode":FEATURE_CODE})
}
#[tauri::command]
fn native_image_toolbox_report(
    state: tauri::State<'_, super::native_image_toolbox_stage::FixtureState>,
    token: String,
    mut report: Value,
) -> Result<(), String> {
    if token != state.token {
        return Err("Image-Toolbox smoke token mismatch".into());
    }
    state.enrich_report(&mut report);
    state
        .report
        .lock()
        .take()
        .ok_or("Image-Toolbox report already received")?
        .send(report)
        .map_err(|_| "Image-Toolbox report receiver closed".into())
}

fn arg_path(args: &[String], name: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|pair| pair[0] == name)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {name}"))
}
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|_| "Private plugin copy setup failed")?;
    for entry in std::fs::read_dir(source).map_err(|_| "Image-Toolbox source unavailable")? {
        let entry = entry.map_err(|_| "Image-Toolbox source entry unavailable")?;
        let kind = entry
            .file_type()
            .map_err(|_| "Image-Toolbox source type unavailable")?;
        if kind.is_symlink() {
            return Err("Image-Toolbox source contains symlink".into());
        }
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target).map_err(|_| "Image-Toolbox source copy failed")?;
        } else {
            return Err("Image-Toolbox source contains unsupported entry".into());
        }
    }
    Ok(())
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn report_bool(report: &Value, key: &str) -> bool {
    report.get(key).and_then(Value::as_bool) == Some(true)
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Image-Toolbox original-entry fixture targets macOS".into());
    }
    let args: Vec<String> = std::env::args().collect();
    let root = arg_path(&args, "--fixture-root")?;
    let source = arg_path(&args, "--image-toolbox-plugin-source")?;
    let input_source = arg_path(&args, "--image-toolbox-input-source")?;
    let fixture_entry = arg_path(&args, "--image-toolbox-fixture-entry")?;
    let output = arg_path(&args, "--output")?;
    let scenario_flags = [
        "--image-toolbox-original-ui",
        "--pasteboard-pro-native-image-ui",
        "--inventory-logo-ui",
        "--plugin-navigation-panel-ui",
        "--published-plugin-panel-ui",
        "--display-metadata-ui",
        "--source-build-ui",
        "--main-push-ui",
        "--plugin-mutation-panel-ui",
    ];
    if scenario_flags
        .iter()
        .filter(|flag| args.iter().any(|arg| arg == **flag))
        .count()
        != 1
        || !args.iter().any(|arg| arg == "--image-toolbox-original-ui")
    {
        return Err("Image-Toolbox fixture requires its isolated scenario flag".into());
    }
    let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or("Workspace path unavailable")?;
    let expected_source = workspace
        .join("ZTools-plugins/plugins/Image-Toolbox")
        .canonicalize()
        .map_err(|_| "Pinned Image-Toolbox source unavailable")?;
    let expected_input = workspace
        .join("ZTools-plugins/plugins/calculation-paper/logo.png")
        .canonicalize()
        .map_err(|_| "Pinned input source unavailable")?;
    if source
        .canonicalize()
        .map_err(|_| "Image-Toolbox source path unavailable")?
        != expected_source
        || input_source
            .canonicalize()
            .map_err(|_| "Image input source path unavailable")?
            != expected_input
    {
        return Err(
            "Image-Toolbox fixture source paths do not match the pinned workspace inputs".into(),
        );
    }
    let scratch = root.parent().ok_or("Fixture root has no parent")?;
    let fixture_entry_bytes =
        super::native_image_toolbox_entry::read_staged_entry(scratch, &fixture_entry)?;
    let panel_js = std::fs::read(arg_path(&args, "--panel-ui")?)
        .map_err(|_| "Native panel bundle unavailable")?;
    let panel_css = std::fs::read(arg_path(&args, "--panel-css")?)
        .map_err(|_| "Native panel stylesheet unavailable")?;
    if !matches!(std::fs::symlink_metadata(&output), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    {
        return Err("Image-Toolbox report path must be fresh".into());
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Report directory setup failed")?;
    }
    std::fs::create_dir(&root).map_err(|_| "Image-Toolbox fixture root must be new".to_owned())?;
    let cleanup = Cleanup(root.clone());
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "Fixture root canonicalization failed")?;
    let output_parent = output
        .parent()
        .ok_or("Report path has no parent")?
        .canonicalize()
        .map_err(|_| "Report parent unavailable")?;
    if output_parent
        .join(output.file_name().ok_or("Report filename missing")?)
        .starts_with(&canonical_root)
    {
        return Err("Report must be outside fixture data".into());
    }
    let image_bytes = std::fs::read(&input_source).map_err(|_| "Pinned input image unavailable")?;
    if image_bytes.len() != INPUT_BYTES || sha256(&image_bytes) != INPUT_SHA256 {
        return Err("Pinned input image mismatch".into());
    }

    let config = AppConfig::with_base_dir(root.join("app-data"));
    config
        .ensure_dirs()
        .map_err(|_| "Private app-data setup failed")?;
    let plugin_root = config.plugins_dir().join(FIXTURE_ID);
    copy_tree(&source, &plugin_root)?;
    std::fs::write(plugin_root.join("src/index.html"), &fixture_entry_bytes)
        .map_err(|_| "Fixture observer entry staging failed")?;
    let input_path = root.join("selected-image.png");
    std::fs::write(&input_path, &image_bytes).map_err(|_| "Private input image copy failed")?;
    if std::fs::symlink_metadata(root.join("image-toolbox-export.png")).is_ok() {
        return Err("Image export destination must be absent before activation".into());
    }
    let manifest_bytes = std::fs::read(plugin_root.join("plugin.json"))
        .map_err(|_| "Copied plugin manifest missing")?;
    let manifest_text = std::str::from_utf8(&manifest_bytes)
        .map_err(|_| "Copied plugin manifest is not UTF-8")?
        .trim_start_matches('\u{feff}');
    let manifest: PluginManifest =
        serde_json::from_str(manifest_text).map_err(|_| "Copied Image-Toolbox manifest invalid")?;
    if manifest.main.as_deref() != Some("src/index.html")
        || manifest.preload.as_deref() != Some("preload.js")
    {
        return Err("Original Image-Toolbox entry contract changed".into());
    }
    let plugin = Plugin {
        id: FIXTURE_ID.into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: plugin_root.to_string_lossy().into_owned(),
        enabled: true,
        manifest,
        created_at: atools_core::utils::now_iso(),
        updated_at: atools_core::utils::now_iso(),
    };
    let db = Arc::new(
        Database::open(&root.join("fixture.sqlite"))
            .map_err(|_| "Private fixture database setup failed")?,
    );
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .map_err(|_| "Original plugin feature registration failed")?;
    let pregranted_capability_kinds =
        native_image_toolbox_grants::grant_bootstrap_capabilities(&db, &plugin)?;
    let clipboard_calls = Arc::new(AtomicUsize::new(0));
    let pasteboard = Arc::new(crate::pasteboard_runtime::PasteboardRuntime::new(
        Arc::new(NoClipboard(clipboard_calls.clone())),
        db.clone(),
        &config,
    )?);
    let state = crate::state::AppState::new(config, db.clone(), None, pasteboard);
    let token = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    let fixture = super::native_image_toolbox_stage::FixtureState::new(token, input_path, sender);
    let report_db = db.clone();
    let output_for_setup = output.clone();
    let mut context = tauri::generate_context!();
    let configured_main_window = super::native_image_toolbox_window::configured_main_window_size(
        &context.config().app.windows,
    )
    .map_err(|_| "Production main-window size unavailable")?;
    let window_measurements = Arc::new(Mutex::new(
        json!({"configuredMainWindow":{"logical":{"width":configured_main_window.size.width,"height":configured_main_window.size.height},"decorations":configured_main_window.decorations},"initialNative":null,"finalNative":null}),
    ));
    let window_measurements_for_setup = window_measurements.clone();
    context.config_mut().identifier = format!(
        "dev.atools.native-image-toolbox.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy(
        super::native_image_toolbox_entry::FIXTURE_CSP.into(),
    ));
    let csp_count = Arc::new(AtomicUsize::new(0));
    let csp_for_protocol = csp_count.clone();
    let header = Arc::new(Mutex::new(None::<String>));
    let header_for_protocol = header.clone();
    let root_for_setup = root.clone();
    let commands: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            native_image_toolbox_fixture,
            native_image_toolbox_report,
            super::native_image_toolbox_stage::native_image_toolbox_stage,
            crate::launcher_media::activate_file_content_feature,
            crate::plugin_page_runtime::commands::prepare_plugin_page,
            crate::plugin_page_runtime::commands::claim_plugin_page,
            crate::plugin_page_runtime::commands::close_plugin_page,
            crate::plugin_asset_protocol::prepare_plugin_resources,
            crate::plugin_asset_protocol::close_plugin_resources,
            crate::legacy_runtime::commands::prepare_legacy_node,
            crate::legacy_runtime::commands::get_legacy_node_session,
            crate::legacy_runtime::commands::close_legacy_node,
            crate::legacy_runtime::commands::plugin_legacy_node_usage,
            crate::legacy_runtime::permission_context::get_permission_request_context,
            crate::plugin_resources::read_plugin_preload_module,
            crate::plugin_display_runtime::commands::prepare_plugin_display,
            crate::plugin_display_runtime::commands::get_plugin_display_session,
            crate::plugin_display_runtime::commands::close_plugin_display,
            crate::plugin_display_runtime::commands::rotate_plugin_display,
            crate::plugin_data_runtime::commands::prepare_plugin_data,
            crate::plugin_data_runtime::commands::get_plugin_data_session,
            crate::plugin_data_runtime::commands::close_plugin_data,
            crate::plugin_data_runtime::commands::rotate_plugin_data,
            crate::plugin_system_paths::commands::prepare_plugin_paths,
            crate::plugin_system_paths::commands::get_plugin_path_snapshot,
            crate::plugin_system_paths::commands::close_plugin_paths,
            crate::plugin_system_paths::commands::rotate_plugin_paths,
            crate::plugin_dialog_runtime::commands::prepare_plugin_dialogs,
            crate::plugin_dialog_runtime::commands::get_plugin_dialog_session,
            crate::plugin_dialog_runtime::commands::close_plugin_dialogs,
            crate::plugin_dialog_runtime::commands::rotate_plugin_dialogs,
            crate::host_runtime::commands::prepare_host_clipboard,
            crate::host_runtime::commands::get_host_clipboard_session,
            crate::host_runtime::commands::close_host_clipboard,
            crate::host_runtime::commands::rotate_host_clipboard,
            crate::commands::feature_catalog,
            crate::commands::search_features,
            crate::commands::activate_feature,
            crate::commands::get_setting,
            crate::commands::expand_window,
            crate::commands::reset_window,
            crate::commands::list_pending_agent_requests,
            crate::commands::get_task_run,
            crate::commands::dismiss_pending_agent_request,
            crate::commands::call_agent_tool,
            crate::commands::grant_agent_tool,
            crate::commands::list_agent_tool_grants,
            crate::commands::revoke_agent_tool
        ]);
    let (commands, startup_receipts) = super::native_image_toolbox_startup_receipts::wrap(commands);
    let app = crate::plugin_page_runtime::register(crate::plugin_asset_protocol::register(tauri::Builder::default()))
        .plugin(tauri_plugin_fs::init()).manage(state).manage(fixture).invoke_handler(move |invoke| commands(invoke))
        .register_uri_scheme_protocol("atools-image-toolbox", move |_, request| {
            let root_request = request.uri().path() == "/";
            if root_request { csp_for_protocol.fetch_add(1, Ordering::Relaxed); }
            let (mime, bytes) = match request.uri().path() {
                "/panel.js" => ("text/javascript", panel_js.clone()),
                "/panel.css" => ("text/css", panel_css.clone()),
                "/" => ("text/html", super::native_image_toolbox_window::fixture_document(super::native_image_toolbox_entry::FIXTURE_CSP).into_bytes()),
                _ => ("text/plain", Vec::new())
            };
            let status = if matches!(request.uri().path(), "/" | "/panel.js" | "/panel.css") { 200 } else { 404 };
            let mut response = tauri::http::Response::builder().status(status).header("content-type", mime);
            if root_request { response = response.header("content-security-policy", super::native_image_toolbox_entry::FIXTURE_CSP); }
            let response = response.body(bytes).unwrap();
            if root_request { *header_for_protocol.lock() = response.headers().get("content-security-policy").and_then(|value| value.to_str().ok()).map(str::to_owned); }
            response
        })
        .setup(move |app| {
            crate::legacy_runtime::install_manager(app.handle()); crate::plugin_display_runtime::install_manager(app.handle());
            crate::plugin_data_runtime::install_manager(app.handle()); crate::plugin_system_paths::install_manager(app.handle());
            crate::plugin_dialog_runtime::install_manager(app.handle()); crate::host_runtime::install_isolated_manager(app.handle());
            app.fs_scope().allow_directory(&root_for_setup, true)?; app.asset_protocol_scope().allow_directory(&root_for_setup, true)?;
            app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-image-toolbox").window("main")
                .remote("atools-image-toolbox://localhost/*".into()).permission("core:event:allow-listen")
                .permission("core:event:allow-unlisten").permission("fs:allow-read-text-file"))?;
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol("atools-image-toolbox://localhost/".parse().unwrap()))
                .title("Hidden Image-Toolbox original-entry fixture").inner_size(configured_main_window.size.width, configured_main_window.size.height)
                .decorations(configured_main_window.decorations).visible(false).focused(false).incognito(true).data_directory(root_for_setup.join("webview")).build()?;
            window_measurements_for_setup.lock()["initialNative"] = super::native_image_toolbox_window::measure_window(&window);
            let app = app.handle().clone(); let csp_response_count = csp_count.clone(); let csp_header = header.clone();
            tauri::async_runtime::spawn(async move {
                let mut report = match tokio::time::timeout(Duration::from_secs(100), receiver).await {
                    Ok(Ok(value)) => value, _ => json!({"passed":false,"stage":"report-timeout","errorCode":"image-toolbox-report-timeout",
                        "lastHarnessStage":app.state::<super::native_image_toolbox_stage::FixtureState>().last_stage(),
                        "lastHarnessWorkStage":app.state::<super::native_image_toolbox_stage::FixtureState>().last_work_stage()})
                };
                app.state::<super::native_image_toolbox_stage::FixtureState>().enrich_report(&mut report);
                let receipts = startup_receipts.snapshot();
                report["startupAppCommandReceipts"] = receipts.clone();
                let output_artifact = super::native_image_toolbox_artifact::verify_output(&root_for_setup, &output_for_setup, &report);
                let artifact_passed = output_artifact.passed;
                report["writtenPngArtifact"] = output_artifact.report;
                let geometry_passed = super::native_image_toolbox_artifact::geometry_passed(&report);
                report["geometryPassed"] = json!(geometry_passed);
                let final_native = app.get_webview_window("main")
                    .map(|window| super::native_image_toolbox_window::measure_window(&window)).unwrap_or(Value::Null);
                let (window_report, window_geometry_passed) = super::native_image_toolbox_window::evaluate_window_geometry(
                    &report, configured_main_window, &window_measurements.lock()["initialNative"], &final_native, &receipts);
                report["launcherWindowGeometry"] = window_report;
                report["launcherWindowGeometryPassed"] = json!(window_geometry_passed);
                let runtime = app.state::<Arc<crate::legacy_runtime::Sessions>>();
                let runtime_before = smoke_runtime_counts(&runtime);
                let host_before = smoke_host_counts(&app);
                runtime.stop_all().await;
                crate::plugin_page_runtime::close_window(&app, "main"); crate::plugin_asset_protocol::close_window(&app, "main");
                crate::plugin_display_runtime::stop(&app).await; crate::plugin_dialog_runtime::stop(&app).await;
                crate::plugin_system_paths::stop(&app); crate::plugin_data_runtime::stop(&app).await;
                if let Ok(host) = crate::host_runtime::manager(&app) { host.close(None, None, true).await; }
                let runtime_after = smoke_runtime_counts(&runtime); let host_after = smoke_host_counts(&app);
                let capture_started = app.state::<crate::state::AppState>().pasteboard_capture_task.lock().is_some();
                let clipboard_backend_calls = clipboard_calls.load(Ordering::Relaxed);
                let window = app.get_webview_window("main");
                let visible = window.as_ref().and_then(|window| window.is_visible().ok());
                let focused = window.as_ref().and_then(|window| window.is_focused().ok());
                report["windowVisibleObserved"] = json!(visible); report["windowFocusedObserved"] = json!(focused);
                report["clipboardBackendCalls"] = json!(clipboard_backend_calls); report["clipboardCaptureTaskStarted"] = json!(capture_started);
                report["nodeRuntimeBeforeCleanup"] = runtime_before.clone(); report["nodeRuntimeAfterCleanup"] = runtime_after.clone();
                report["hostRuntimeBeforeCleanup"] = host_before.clone(); report["hostRuntimeAfterCleanup"] = host_after.clone();
                report["topCspMeta"] = json!(super::native_image_toolbox_entry::FIXTURE_CSP); report["topCspResponseCount"] = json!(csp_response_count.load(Ordering::Relaxed));
                report["expectedChildCsp"] = json!(super::native_image_toolbox_entry::CHILD_FIXTURE_CSP);
                report["topCspResponseHeader"] = json!(csp_header.lock().clone());
                let private_paths = [root_for_setup.to_string_lossy().into_owned(), output_for_setup.to_string_lossy().into_owned()];
                let task_runs = smoke_task_run_evidence(&report_db, &private_paths);
                report["taskRunEvidence"] = task_runs.clone();
                let entered = report_bool(&report, "entryObserved") && report["entryCode"] == FEATURE_CODE && report["entryType"] == "files";
                let loaded = report_bool(&report, "imageLoaded") && report["imageWidth"] == 200 && report["imageHeight"] == 200;
                let edited = report_bool(&report, "editVerified") && report["canvasObjectCountAfterEdit"] == 2;
                let exported = super::native_image_toolbox_window::original_export_passed(
                    &report, artifact_passed, geometry_passed, window_geometry_passed);
                let frame = report_bool(&report, "pluginFramePresent") && report["iframeSandboxAllowsSameOrigin"] == false && report["iframeContentDocumentIsNull"] == true;
                let csp_ok = report["iframeCspMeta"] == super::native_image_toolbox_entry::CHILD_FIXTURE_CSP && report["expectedChildCsp"] == super::native_image_toolbox_entry::CHILD_FIXTURE_CSP && report["topCspMeta"] == super::native_image_toolbox_entry::FIXTURE_CSP && report["topCspResponseHeader"] == super::native_image_toolbox_entry::FIXTURE_CSP
                    && report["topCspResponseCount"].as_u64().unwrap_or(0) > 0
                    && report["topCspViolationCount"].as_u64() == Some(0) && report["iframeCspViolationCount"].as_u64() == Some(0);
                let runtime_drained = runtime_after["sessions"] == 0 && runtime_after["intents"] == 0 && runtime_after["openings"] == 0 && runtime_after["invocations"] == 0;
                let host_drained = host_after["sessions"] == 0 && host_after["intents"] == 0 && host_after["invocations"] == 0;
                let native_isolation = visible == Some(false) && focused == Some(false) && clipboard_backend_calls == 0 && !capture_started;
                report["fixturePregrantedCapabilityKinds"] = json!(pregranted_capability_kinds);
                let accepted = report_bool(&report, "passed")
                    && report["fixturePregrantedCapabilityKinds"] == json!(native_image_toolbox_grants::PREGRANTED_CAPABILITY_KINDS)
                    && entered && loaded && edited && exported && frame && csp_ok && runtime_drained && host_drained && native_isolation
                    && task_runs["allTerminal"] == true && task_runs["activationTaskRunCount"] == 1
                    && task_runs["activationSucceededCount"] == 1 && task_runs["privacyNoPrivatePathOrImagePayload"] == true;
                report["onPluginEnterPathPassed"] = json!(entered); report["originalCanvasLoadPassed"] = json!(loaded);
                report["originalTextEditPassed"] = json!(edited); report["originalExportDecodePassed"] = json!(exported);
                report["fullInputAndAnnotationVisibleOnCanvas"] = json!(super::native_image_toolbox_window::visible_canvas_object(&report, "imageBounds") && super::native_image_toolbox_window::visible_canvas_object(&report, "annotationBounds"));
                report["launcherWindowGeometryPassed"] = json!(window_geometry_passed);
                report["opaqueFramePassed"] = json!(frame); report["cspPassed"] = json!(csp_ok);
                report["runtimeDrained"] = json!(runtime_drained); report["hostRuntimeDrained"] = json!(host_drained);
                report["nativeIsolationPassed"] = json!(native_isolation);
                report["scope"] = json!("Original Image-Toolbox plugin.json/preload/ES-module App through production PluginPanel; real files activation, original canvas/TextModule edit, ExportModule dataURL and WebView decode plus original writeImageFile to the fixture output path");
                report["limitations"] = json!(["The file/files activation is invoked programmatically through the existing command; no physical input is exercised", "No native open/save dialog or clipboard operation is used; export uses the original ExportModule PNG dataURL, WebView decode, and original writeImageFile to a fixed fixture path", "The copied plugin index.html has a fixture-only observer script and restrictive CSP added; plugin.json, preload.js, App, CanvasManager, TextModule, ExportModule and helper functions remain byte-identical", "The isolated database pregrants the exact legacy Node, PluginData, standard-path, dialog-open and dialog-save tools to atools-ui for this fixture; this is bootstrap only, permission-prompt UX is not measured, and no native dialog is invoked", "The legacy Node tool has broader scopes; this run does not claim a general network or OS sandbox"]);
                report["passed"] = json!(accepted);
                let written = std::fs::write(&output_for_setup, serde_json::to_vec_pretty(&report).unwrap()).is_ok();
                app.exit(if accepted && written { 0 } else { 1 });
            });
            Ok(())
        })
        .build(context).map_err(|_| "Native Image-Toolbox WebView build failed")?;
    app.run_return(|_, _| {});
    drop(db);
    drop(cleanup);
    let removed = matches!(std::fs::symlink_metadata(&root), Err(error) if error.kind() == std::io::ErrorKind::NotFound);
    let mut report: Value = serde_json::from_slice(
        &std::fs::read(&output).map_err(|_| "Image-Toolbox report missing")?,
    )
    .map_err(|_| "Image-Toolbox report invalid")?;
    report["temporaryDataRemoved"] = json!(removed);
    if !removed {
        report["passed"] = json!(false);
    }
    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap())
        .map_err(|_| "Final report write failed")?;
    if report["passed"] == true && removed {
        Ok(())
    } else {
        Err("Image-Toolbox original-entry smoke failed; inspect bounded report".into())
    }
}

fn smoke_runtime_counts(runtime: &crate::legacy_runtime::Sessions) -> Value {
    json!({"sessions":runtime.sessions.read().len(),"intents":runtime.intents.lock().len(),"openings":runtime.openings.lock().len(),"invocations":runtime.invocations.lock().len()})
}
fn smoke_host_counts(app: &tauri::AppHandle) -> Value {
    crate::host_runtime::manager(app).ok().map(|manager| { let store=manager.store.lock(); json!({"sessions":store.sessions.len(),"intents":store.intents.len(),"invocations":store.invocations.len()}) }).unwrap_or(Value::Null)
}
fn smoke_task_run_evidence(db: &Database, private_paths: &[String]) -> Value {
    let rows = match db.list_task_runs(1000) {
        Ok(rows) => rows,
        Err(_) => {
            return json!({"querySucceeded":false,"allTerminal":false,"privacyNoPrivatePathOrImagePayload":false})
        }
    };
    let activation: Vec<_> = rows
        .iter()
        .filter(|run| {
            run.capability_id == "plugin.feature.image-edit"
                && run.initiator.client_id.as_deref() == Some("atools-ui")
        })
        .collect();
    let terminal = rows.iter().all(|run| run.status.is_terminal());
    let privacy = rows
        .iter()
        .filter_map(|run| serde_json::to_string(run).ok())
        .all(|row| {
            private_paths
                .iter()
                .all(|path| path.is_empty() || !row.contains(path))
                && !row.contains("data:image/")
                && !row.contains("base64,")
        });
    json!({"querySucceeded":true,"allTaskRunCount":rows.len(),"allTerminal":terminal,"activationTaskRunCount":activation.len(),
        "activationSucceededCount":activation.iter().filter(|run| run.status == atools_core::task_run::TaskRunStatus::Succeeded).count(),
        "privacyNoPrivatePathOrImagePayload":privacy})
}
