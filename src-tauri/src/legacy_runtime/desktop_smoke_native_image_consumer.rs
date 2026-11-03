//! Hidden real-Tauri/WKWebView smoke for the original PasteboardPro thumbnail consumer.
//! The fixture runs only the original ja consumer through the production PluginPanel bridge.
use super::native_image_consumer_audit;
use super::Cleanup;
#[cfg(feature = "legacy-node-smoke")]
use crate::legacy_runtime::native_node_startup_fixture::NativeNodeStartupFixture;
use crate::{
    pasteboard_runtime::{NativePasteboardSnapshot, PasteboardBackend, PasteboardRuntime},
    state::AppState,
};
use async_trait::async_trait;
use atools_core::{AppConfig, Database, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::{json, Value};
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

const FIXTURE_ID: &str = "batch59-pasteboard-pro-native-image";
const CSP:&str="default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' asset:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; connect-src ipc: http://ipc.localhost http://127.0.0.1:*; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
struct FixtureState {
    plugin: Plugin,
    token: String,
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
        Err("Clipboard disabled in native image fixture".into())
    }
    async fn write_item(
        &self,
        _: &atools_core::PasteboardItem,
        _: &Path,
        _: bool,
    ) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in native image fixture".into())
    }
    async fn paste_frontmost(&self) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::Relaxed);
        Err("Clipboard disabled in native image fixture".into())
    }
}
#[tauri::command]
fn native_pasteboard_consumer_fixture(fixture: tauri::State<'_, FixtureState>) -> Value {
    let p = &fixture.plugin;
    json!({"token":fixture.token,"action":{"plugin_id":p.id,"plugin_name":p.name,"feature_code":"pasteboard-pro-cached-thumbnail","feature_label":"Generate cached thumbnails","feature_label_source":"declared","main_url":"index.html","plugin_path":p.path,"expand_height":600,"plugin_permissions":[],"payload":null}})
}
#[tauri::command]
fn native_pasteboard_consumer_report(
    fixture: tauri::State<'_, FixtureState>,
    token: String,
    report: Value,
) -> Result<(), String> {
    if token != fixture.token {
        return Err("Native consumer report token mismatch".into());
    }
    fixture
        .report
        .lock()
        .take()
        .ok_or("Native consumer report already received")?
        .send(report)
        .map_err(|_| "Native consumer report receiver closed".into())
}
fn arg_path(args: &[String], name: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|w| w[0] == name)
        .map(|w| PathBuf::from(&w[1]))
        .filter(|p| p.is_absolute())
        .ok_or_else(|| format!("Missing absolute {name}"))
}
fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|_| "Fixture plugin root setup failed")?;
    for entry in std::fs::read_dir(source).map_err(|_| "Fixture source unavailable")? {
        let entry = entry.map_err(|_| "Fixture source entry unavailable")?;
        let ty = entry
            .file_type()
            .map_err(|_| "Fixture source type unavailable")?;
        if ty.is_symlink() {
            return Err("Fixture source contains a symlink".into());
        }
        let target = destination.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&entry.path(), &target)?
        } else if ty.is_file() {
            std::fs::copy(entry.path(), target).map_err(|_| "Fixture plugin file copy failed")?;
        } else {
            return Err("Fixture source contains unsupported entry".into());
        }
    }
    Ok(())
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("PasteboardPro native image fixture targets macOS only".into());
    }
    let args: Vec<String> = std::env::args().collect();
    let root = arg_path(&args, "--fixture-root")?;
    let source = arg_path(&args, "--pasteboard-plugin-source")?;
    let output = arg_path(&args, "--output")?;
    let panel_js = std::fs::read(arg_path(&args, "--panel-ui")?)
        .map_err(|_| "Native panel bundle unavailable")?;
    let panel_css = std::fs::read(arg_path(&args, "--panel-css")?)
        .map_err(|_| "Native panel stylesheet unavailable")?;
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "Report directory setup failed")?
    }
    match std::fs::symlink_metadata(&output) {
        Ok(_) => return Err("Native consumer report path must be fresh".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err("Native consumer report path could not be inspected".into()),
    }
    std::fs::create_dir(&root)
        .map_err(|_| "Native consumer fixture root must be new".to_owned())?;
    let cleanup = Cleanup(root.clone());
    let canonical_root = root
        .canonicalize()
        .map_err(|_| "Native fixture root canonicalization failed")?;
    let output_parent = output
        .parent()
        .ok_or("Report path has no parent")?
        .canonicalize()
        .map_err(|_| "Report parent canonicalization failed")?;
    let output_name = output.file_name().ok_or("Report path has no filename")?;
    if output_parent.join(output_name).starts_with(&canonical_root) {
        return Err("Native report must be outside fixture data".into());
    }
    let config = AppConfig::with_base_dir(root.join("app-data"));
    config
        .ensure_dirs()
        .map_err(|_| "Private app-data setup failed")?;
    let plugin_root = config.plugins_dir().join(FIXTURE_ID);
    copy_tree(&source, &plugin_root)?;
    let manifest:PluginManifest=serde_json::from_value(json!({"name":"PasteboardPro native image consumer fixture","version":"1.0.0","main":"index.html"})).map_err(|_|"Fixture plugin manifest invalid")?;
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
    let fixture_private_paths = vec![
        root.to_string_lossy().into_owned(),
        plugin_root.to_string_lossy().into_owned(),
        plugin.path.clone(),
        root.join("app-data/plugins")
            .join(FIXTURE_ID)
            .join("logo.png")
            .to_string_lossy()
            .into_owned(),
    ];
    let db = Arc::new(
        Database::open(&root.join("fixture.sqlite"))
            .map_err(|_| "Private fixture database setup failed")?,
    );
    db.save_plugin_with_features(&plugin, &[])
        .map_err(|_| "Fixture plugin registration failed")?;
    let tool = crate::legacy_runtime::registry::ensure_tool(&db, &plugin)?;
    db.grant_agent_tool("atools-ui", &tool)
        .map_err(|_| "Fixture Node tool grant setup failed")?;
    let calls = Arc::new(AtomicUsize::new(0));
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard(calls.clone())),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db.clone(), None, pasteboard);
    let token = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    let fixture = FixtureState {
        plugin,
        token,
        report: Mutex::new(Some(sender)),
    };
    #[cfg(feature = "legacy-node-smoke")]
    let app_run_id = uuid::Uuid::new_v4().to_string();
    #[cfg(feature = "legacy-node-smoke")]
    let startup_fixture = Arc::new(NativeNodeStartupFixture::new_pasteboard_native_image(
        &json!({"caseId":"pasteboard-pro-native-image","id":FIXTURE_ID,"runtime":"node"}),
        &app_run_id,
        args.iter()
            .filter(|arg| arg.as_str() == "--pasteboard-pro-native-image-ui")
            .count()
            == 1,
        &output,
        &root,
    )?);
    let calls_handler = calls.clone();
    let report_db = db.clone();
    let output_for_setup = output.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.native-image-consumer.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    let csp_policy = tauri::utils::config::Csp::Policy(CSP.into());
    let top_csp_configured = matches!(
        &csp_policy,
        tauri::utils::config::Csp::Policy(value) if value == CSP
    );
    context.config_mut().app.security.csp = Some(csp_policy);
    let top_csp_response_count = Arc::new(AtomicUsize::new(0));
    let csp_response_for_protocol = top_csp_response_count.clone();
    let csp_response_for_setup = top_csp_response_count.clone();
    let csp_header_observed = Arc::new(Mutex::new(None::<String>));
    let csp_header_for_protocol = csp_header_observed.clone();
    let csp_header_for_setup = csp_header_observed.clone();
    let root_for_setup = root.clone();
    let command_handler: Box<dyn Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync> =
        Box::new(tauri::generate_handler![
            native_pasteboard_consumer_fixture,
            native_pasteboard_consumer_report,
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
            crate::commands::grant_agent_tool
        ]);
    let app = crate::plugin_page_runtime::register(
        crate::plugin_asset_protocol::register(tauri::Builder::default()),
    )
    .plugin(tauri_plugin_fs::init())
    .manage(state)
    .manage(fixture)
    .invoke_handler(move |invoke| command_handler(invoke))
    .register_uri_scheme_protocol("atools-image-consumer", move |_, request| {
        let is_root = request.uri().path() == "/";
        if is_root {
            csp_response_for_protocol.fetch_add(1, Ordering::Relaxed);
        }
        let (mime, body) = match request.uri().path() {
            "/panel.js" => ("text/javascript", panel_js.clone()),
            "/panel.css" => ("text/css", panel_css.clone()),
            "/" => (
                "text/html",
                format!(
                    "<!doctype html><meta charset=utf-8><meta http-equiv=\"Content-Security-Policy\" content=\"{}\"><link rel=stylesheet href=\"atools-image-consumer://localhost/panel.css\"><div id=app></div><script src=\"atools-image-consumer://localhost/panel.js\"></script>",
                    CSP
                )
                .into_bytes(),
            ),
            _ => ("text/plain", Vec::new()),
        };
        let status = if matches!(request.uri().path(), "/" | "/panel.js" | "/panel.css") {
            200
        } else {
            404
        };
        let response = tauri::http::Response::builder()
            .status(status)
            .header("content-type", mime);
        let response = if is_root {
            response
                .header("content-security-policy", CSP)
                .body(body)
                .unwrap()
        } else {
            response.body(body).unwrap()
        };
        if is_root {
            *csp_header_for_protocol.lock() = response
                .headers()
                .get("content-security-policy")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
        }
        response
    })
  .setup(move|app|{
   crate::legacy_runtime::install_manager(app.handle());crate::plugin_display_runtime::install_manager(app.handle());
   crate::plugin_data_runtime::install_manager(app.handle());crate::plugin_system_paths::install_manager(app.handle());crate::plugin_dialog_runtime::install_manager(app.handle());
   crate::host_runtime::install_isolated_manager(app.handle());
   #[cfg(feature = "legacy-node-smoke")]
   app.manage(startup_fixture.clone());
   app.fs_scope().allow_directory(&root_for_setup,true)?;app.asset_protocol_scope().allow_directory(&root_for_setup,true)?;
   app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-pasteboard-consumer").window("main").remote("atools-image-consumer://localhost/*".into()).permission("core:event:allow-listen").permission("core:event:allow-unlisten").permission("fs:allow-read-text-file"))?;
   WebviewWindowBuilder::new(app,"main",WebviewUrl::CustomProtocol("atools-image-consumer://localhost/".parse().unwrap())).title("Hidden PasteboardPro native consumer").visible(false).focused(false).incognito(true).data_directory(root_for_setup.join("webview")).build()?;
    let app=app.handle().clone();
   let csp_configured_for_report=top_csp_configured;
   let csp_response_for_report=csp_response_for_setup.clone();
   let csp_header_for_report=csp_header_for_setup.clone();
   tauri::async_runtime::spawn(async move{
    let mut report=match tokio::time::timeout(Duration::from_secs(120),receiver).await{Ok(Ok(value))=>value,_=>json!({"passed":false,"stage":"native-panel-report","errorCode":"consumer-report-timeout"})};
    let runtime=app.state::<Arc<crate::legacy_runtime::Sessions>>();
    let node_before=native_image_consumer_audit::runtime_counts(&runtime);
    let fixture_session=runtime.sessions.read().values().find(|session|session.plugin_id==FIXTURE_ID).cloned();
    #[cfg(feature = "legacy-node-smoke")]
    let image_before = fixture_session.as_ref().map(|session| {
        let engine = session.smoke_native_image_engine();
        native_image_consumer_audit::image_snapshot(&engine.smoke_snapshot())
    }).unwrap_or(Value::Null);
    #[cfg(not(feature = "legacy-node-smoke"))]
    let image_before = Value::Null;
    let tool_name=crate::legacy_runtime::registry::tool_name(FIXTURE_ID);
    #[cfg(feature = "legacy-node-smoke")]
    let startup_diagnostic_associated = app.state::<Arc<NativeNodeStartupFixture>>().report(&report_db)
        .is_some_and(|value| value["captureComplete"] == true && value["associationVerified"] == true);
    let grant_evidence=native_image_consumer_audit::grant_evidence(&report_db,&tool_name);
    let host_manager=crate::host_runtime::manager(&app).ok();
    let host_before=host_manager.as_ref().map(|host|{let state=host.store.lock();json!({"sessions":state.sessions.len(),"intents":state.intents.len(),"invocations":state.invocations.len()})}).unwrap_or(Value::Null);
    runtime.stop_all().await;
    crate::plugin_page_runtime::close_window(&app,"main");crate::plugin_asset_protocol::close_window(&app,"main");
    crate::plugin_display_runtime::stop(&app).await;crate::plugin_dialog_runtime::stop(&app).await;
    crate::plugin_system_paths::stop(&app);crate::plugin_data_runtime::stop(&app).await;
    if let Some(host)=&host_manager{host.close(None,None,true).await;}
    let node_after=native_image_consumer_audit::runtime_counts(&runtime);
    let transport_after=runtime.server.lock().await.is_some();
    #[cfg(feature = "legacy-node-smoke")]
    let mut image_after = fixture_session.as_ref().map(|session| {
        let engine = session.smoke_native_image_engine();
        native_image_consumer_audit::image_snapshot(&engine.smoke_snapshot())
    }).unwrap_or(Value::Null);
    #[cfg(not(feature = "legacy-node-smoke"))]
    let image_after = Value::Null;
    #[cfg(feature = "legacy-node-smoke")]
    for _ in 0..100 {
     if image_after["workerBusy"]==false {break;}
     tokio::time::sleep(Duration::from_millis(10)).await;
     image_after=fixture_session.as_ref().map(|session| {
        let engine = session.smoke_native_image_engine();
        native_image_consumer_audit::image_snapshot(&engine.smoke_snapshot())
     }).unwrap_or(Value::Null);
    }
    let host_after=host_manager.as_ref().map(|host|{let state=host.store.lock();json!({"sessions":state.sessions.len(),"intents":state.intents.len(),"invocations":state.invocations.len()})}).unwrap_or(Value::Null);
    let task_runs = native_image_consumer_audit::task_run_counts(&report_db, &tool_name, &fixture_private_paths);
    let node_runtime_before_expected=node_before["sessions"]==1&&node_before["intents"]==0&&node_before["openings"]==0&&node_before["invocations"]==0;
    let node_runtime_drained=node_after["sessions"]==0&&node_after["intents"]==0&&node_after["openings"]==0&&node_after["invocations"]==0&&!transport_after;
    let host_runtime_drained=host_after["sessions"]==0&&host_after["intents"]==0&&host_after["invocations"]==0;
    let host_runtime_before_expected=host_before["sessions"]==0&&host_before["intents"]==0&&host_before["invocations"]==0;
    let image_before_ok=image_before["globalSourceBytes"]==241870&&image_before["globalReservedBytes"]==0&&image_before["handles"]==64&&image_before["uniqueSources"]==1&&image_before["openReservations"]==0&&image_before["sessionCount"]==1&&image_before["workerBusy"]==false;
    let image_after_ok=image_after["globalSourceBytes"]==0&&image_after["globalReservedBytes"]==0&&image_after["handles"]==0&&image_after["uniqueSources"]==0&&image_after["openReservations"]==0&&image_after["sessionCount"]==0&&image_after["workerBusy"]==false;
    let window=app.get_webview_window("main");let visible=window.as_ref().and_then(|w|w.is_visible().ok());let focused=window.as_ref().and_then(|w|w.is_focused().ok());
    let capture_started=app.state::<AppState>().pasteboard_capture_task.lock().is_some();
    let clipboard_calls=calls_handler.load(Ordering::Relaxed);
    let native_ok=visible==Some(false)&&focused==Some(false)&&node_runtime_before_expected&&clipboard_calls==0&&!capture_started;
    let top_csp_response_count=csp_response_for_report.load(Ordering::Relaxed);
    report["topCspConfigured"]=json!(csp_configured_for_report);
    report["topCspResponseCount"]=json!(top_csp_response_count);
    let top_csp_response_header=csp_header_for_report.lock().clone();
    report["topCspResponseHeader"]=json!(top_csp_response_header);
    let csp_violations=report["topCspViolationCount"].as_u64().unwrap_or(u64::MAX);
    let iframe_csp_violations=report["iframeCspViolationCount"].as_u64().unwrap_or(u64::MAX);
    let csp_ok=report["topCspConfigured"]==true&&top_csp_response_count>0&&report["topCspResponseHeader"]==CSP
      &&report["topCspMeta"]==CSP&&report["iframeCspMeta"]==CSP&&csp_violations==0&&iframe_csp_violations==0;
    let opaque_frame_ok=report["pluginFramePresent"]==true&&report["iframeSandboxAllowsSameOrigin"]==false&&report["iframeContentDocumentIsNull"]==true;
    report["topCspViolationCount"]=json!(csp_violations);report["iframeCspViolationCount"]=json!(iframe_csp_violations);report["cspPassed"]=json!(csp_ok);report["opaqueFramePassed"]=json!(opaque_frame_ok);
    report["taskRunEvidence"]=task_runs.clone();
    #[cfg(feature = "legacy-node-smoke")]
    { report["nodeStartupDiagnosticAssociated"]=json!(startup_diagnostic_associated); }
    report["nodeRuntimeBeforeCleanup"]=node_before;report["nodeRuntimeAfterCleanup"]=node_after;
    report["nodeRuntimeBeforeExpected"]=json!(node_runtime_before_expected);
    report["nodeRuntimeTransportRunningAfterCleanup"]=json!(transport_after);
    report["nodeRuntimeDrained"]=json!(node_runtime_drained);
    report["hostClipboardRuntimeBeforeCleanup"]=host_before;report["hostClipboardRuntimeAfterCleanup"]=host_after;
    report["hostClipboardRuntimeDrained"]=json!(host_runtime_drained);
    report["hostClipboardRuntimeBeforeExpected"]=json!(host_runtime_before_expected);
    report["nativeImageEngineBeforeCleanup"]=image_before;report["nativeImageEngineAfterCleanup"]=image_after;
    report["nativeImageEngineBeforeExpected"]=json!(image_before_ok);report["nativeImageEngineAfterZero"]=json!(image_after_ok);
    report["imageSourceOperation"]=json!("nativeImageTransform.openPath");
    report["imageEncodeOperation"]=json!("nativeImageTransform.encode");
    report["permissionEvidence"]=grant_evidence.clone();
    report["pasteboardBackendCalls"]=json!(clipboard_calls);report["pasteboardCaptureTaskStarted"]=json!(capture_started);
    report["windowVisibleObserved"]=json!(visible);report["windowFocusedObserved"]=json!(focused);report["nativeIsolationPassed"]=json!(native_ok);
    report["scope"]=json!("Exact original PasteboardPro ja.cachedThumbnail/generate through production PluginPanel opaque iframe, authenticated Node image session, nativeImageTransform loopback TaskRuns and Rust decoder/encoder; private fixture plugin and fixed PNG");
    report["limitations"]=json!(["Only the original ja class executes, not the complete PasteboardPro preload/business flow","PasteboardBackend calls and global capture are disabled; no OS clipboard, shown/focused window, or physical input; this fixed consumer path reads a local image and the WebView CSP limits its connections, while the legacy Node tool still has its Network scope and this fixture does not isolate or globally audit Node networking","The fixture grants only its existing legacy Node tool, whose broad registered scopes are FileRead/FileWrite/Network/Shell/ClipboardRead/ClipboardWrite/Screenshot/BrowserContext/PluginData/SystemSettings; no separate host clipboard or image_write grant is added","The original createFromPath flow uses nativeImageTransform.openPath plus encode; legacy readPngPath is not exercised","64 fixed image records use the same 512x512 source and produce resized 480x480 JPEG summaries; the 65th returns null at the existing bounded session capacity","TaskRun evidence is filtered by the exact fixture Node capability, request method, and atools-ui initiator; it does not reveal per-operation transport counts","Per-call duration records cover the original cachedThumbnail await only, excluding startup, Node bootstrap, WebView image decoding and any cold-start claim"]);
    let dimensions_ok = report["jpegDecodeDimensions"].as_array().map_or(false, |values| values.len() == 64
        && values.iter().all(|value| value["width"] == 480 && value["height"] == 480));
    let jpeg_lengths_ok = report["jpegPayloadByteLengths"].as_array().map_or(false, |values| values.len() == 64
        && values.iter().all(|value| value.as_u64().map_or(false, |length| length > 0 && length <= 524_288)));
    let duration_values_ok = report["imageOperationDurationsMs"].as_array().map_or(false, |values| values.len() == 64
        && values.iter().all(|value| value.as_f64().is_some_and(|duration| duration.is_finite() && duration >= 0.0)));
    let accepted = report["passed"] == true
        && report["successfulRecords"] == 64
        && report["generateCallsBeforeCapacityProbe"] == 64
        && report["generateCallsAfterCapacityProbe"] == 65
        && report["cacheHitNoReplay"] == true
        && report["sixtyFifthIsNull"] == true
        && report["frameOriginOpaque"] == true
        && report["nodePathBootstrapVerified"] == true
        && report["sourceImageBytes"] == 241870
        && report["imageDimensions"]["width"] == 512
        && report["imageDimensions"]["height"] == 512
        && report["thumbnailDecodeSucceeded"] == true
        && report["thumbnailDimensions"]["width"] == 480
        && report["thumbnailDimensions"]["height"] == 480
        && dimensions_ok && jpeg_lengths_ok && duration_values_ok && csp_ok && opaque_frame_ok
        && report["pasteboardBackendCalls"] == 0
        && report["pasteboardCaptureTaskStarted"] == false
        && report["windowVisibleObserved"] == false
        && report["windowFocusedObserved"] == false
        && report["nativeIsolationPassed"] == true
        && report["nodeRuntimeBeforeExpected"] == true
        && { #[cfg(feature = "legacy-node-smoke")] { report["nodeStartupDiagnosticAssociated"] == true } #[cfg(not(feature = "legacy-node-smoke"))] { true } }
        && task_runs["imageTaskRunsExpected"] == true
        && task_runs["allTaskRunsTerminal"] == true
        && task_runs["serializedImageTaskRowsContainNoFixturePaths"] == true
        && task_runs["serializedImageTaskRowsContainNoImagePayload"] == true
        && grant_evidence["fixtureLegacyNodeGrantCount"] == 1
        && grant_evidence["onlyFixtureLegacyNodeGrant"] == true
        && grant_evidence["fixtureToolIsRegisteredLegacyNode"] == true
        && grant_evidence["hostClipboardGrantCount"] == 0
        && grant_evidence["legacyNodeHasFileRead"] == true
        && grant_evidence["legacyNodeScopeCount"] == 10
        && grant_evidence["legacyNodeHasFileWrite"] == true
        && grant_evidence["legacyNodeHasNetwork"] == true
        && grant_evidence["legacyNodeHasShell"] == true
        && grant_evidence["legacyNodeHasClipboardRead"] == true
        && grant_evidence["legacyNodeHasClipboardWrite"] == true
        && grant_evidence["legacyNodeHasScreenshot"] == true
        && grant_evidence["legacyNodeHasBrowserContext"] == true
        && grant_evidence["legacyNodeHasPluginData"] == true
        && grant_evidence["legacyNodeHasSystemSettings"] == true
        && report["hostClipboardRuntimeBeforeExpected"] == true
        && native_ok
        && node_runtime_drained
        && host_runtime_drained
        && image_before_ok
        && image_after_ok;
    report["passed"] = json!(accepted);
    let written = std::fs::write(&output_for_setup, serde_json::to_vec_pretty(&report).unwrap()).is_ok();
    app.exit(if accepted && written { 0 } else { 1 });
   });Ok(())
  }).build(context).map_err(|_|"Native consumer WebView build failed")?;
    app.run_return(|_, _| {});
    drop(db);
    drop(cleanup);
    let removed =
        matches!(std::fs::symlink_metadata(&root),Err(e) if e.kind()==std::io::ErrorKind::NotFound);
    let mut report: Value = serde_json::from_slice(
        &std::fs::read(&output).map_err(|_| "Native consumer report missing")?,
    )
    .map_err(|_| "Native consumer report invalid")?;
    report["temporaryDataRemoved"] = json!(removed);
    if !removed {
        report["passed"] = json!(false)
    }
    std::fs::write(&output, serde_json::to_vec_pretty(&report).unwrap())
        .map_err(|_| "Final consumer report write failed")?;
    if report["passed"] == true && removed {
        Ok(())
    } else {
        Err("Native PasteboardPro consumer fixture failed; inspect report".into())
    }
}
