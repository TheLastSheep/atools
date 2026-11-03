//! Full production App/PluginPanel acceptance with temporary data and read-only originals.
use super::{Cleanup, NoClipboard};
use crate::{pasteboard_runtime::PasteboardRuntime, state::AppState};
use atools_core::{AppConfig, Database};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;
#[path = "desktop_smoke_child_node_privacy.rs"]
mod child_node;
#[path = "desktop_smoke_panel_developer_codec_tools_head.rs"]
mod developer_codec_tools_head;
#[path = "desktop_smoke_panel_file_tree_head.rs"]
mod file_tree_head;
#[path = "desktop_smoke_panel_fixture_setup.rs"]
mod fixture_setup;
#[path = "desktop_smoke_panel_fixture_state.rs"]
mod fixture_state;
use fixture_state::PanelFixture;
struct PanelReport(Arc<Mutex<Option<tokio::sync::oneshot::Sender<Value>>>>);

#[tauri::command]
fn native_panel_report(app: tauri::AppHandle, report: Value) {
    if let Some(sender) = app.state::<PanelReport>().0.lock().take() {
        let _ = sender.send(report);
    }
}

#[tauri::command]
fn native_panel_node_page_evidence(app: tauri::AppHandle) -> Result<Value, String> {
    if std::env::var("ATOOLS_NODE_PAGE_ACCEPTANCE").as_deref() != Ok("true") {
        return Err("Dedicated page-only Node evidence is disabled".into());
    }
    let fixture = app.state::<PanelFixture>();
    let output = fixture.root.join("node-page-output.png");
    let task_runs = fixture
        .db
        .list_task_runs(1000)
        .map_err(|_| "TaskRun privacy evidence unavailable")?;
    let task_runs_json =
        serde_json::to_vec(&task_runs).map_err(|_| "TaskRun privacy evidence unavailable")?;
    super::panel_node_page::inspect_png(&output, &task_runs_json)
}

#[tauri::command]
fn native_panel_document_probe_source(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    if !crate::plugin_page_runtime::enabled(&app)
        || window.label() != "main"
        || window
            .url()
            .map_err(|_| "Fixture parent unavailable")?
            .as_str()
            != "atools-panel://localhost/"
    {
        return Err("Document observer is restricted to the dedicated native fixture".into());
    }
    Ok(app.state::<PanelFixture>().document_probe.clone())
}

#[tauri::command]
async fn native_panel_runtime_state(app: tauri::AppHandle) -> Value {
    let runtime = app.state::<Arc<crate::legacy_runtime::Sessions>>();
    let state = app.state::<AppState>();
    let sessions = runtime.sessions.read().len();
    let openings = runtime.openings.lock().len();
    let node_intents = runtime.intents.lock().len();
    let node_invocations = runtime.invocations.lock().len();
    let pending = state.pending_agent_requests.lock().len();
    let transport = runtime.server.lock().await.is_some();
    let host = crate::host_runtime::manager(&app).expect("fixture host manager installed");
    let (host_sessions, host_intents, host_invocations) = {
        let store = host.store.lock();
        (
            store.sessions.len(),
            store.intents.len(),
            store.invocations.len(),
        )
    };
    let host_transport = host.server.lock().await.is_some();
    let mut value = json!({"sessions":sessions,"openings":openings,"nodeIntents":node_intents,"nodeInvocations":node_invocations,"pending":pending,"transport":transport,
        "resourceLeases":crate::plugin_asset_protocol::lease_count(&app),
        "pageDocuments":crate::plugin_page_runtime::document_count(&app),
        "hostSessions":host_sessions,"hostIntents":host_intents,"hostInvocations":host_invocations,"hostTransport":host_transport});
    if let (Some(target), Some(data)) = (
        value.as_object_mut(),
        crate::plugin_data_runtime::runtime_state(&app)
            .await
            .as_object(),
    ) {
        target.extend(data.clone());
    }
    if let Some(target) = value.as_object_mut() {
        if let Some(paths) = crate::plugin_system_paths::runtime_state(&app).as_object() {
            target.extend(paths.clone());
        }
    }
    if let (Some(target), Some(dialogs)) = (
        value.as_object_mut(),
        crate::plugin_dialog_runtime::runtime_state(&app)
            .await
            .as_object(),
    ) {
        target.extend(dialogs.clone());
    }
    if let Some(target) = value.as_object_mut() {
        if let Some(display) = crate::plugin_display_runtime::runtime_state(&app).as_object() {
            target.extend(display.clone());
        }
    }
    value
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Full Panel native fixture currently targets macOS only".into());
    }
    let args: Vec<_> = std::env::args().collect();
    let path = |flag: &str| -> Result<PathBuf, String> {
        args.windows(2)
            .find(|pair| pair[0] == flag)
            .map(|pair| PathBuf::from(&pair[1]))
            .filter(|value| value.is_absolute())
            .ok_or_else(|| format!("Missing absolute {flag}"))
    };
    let root = path("--fixture-root")?;
    std::fs::create_dir(&root).map_err(|error| error.to_string())?;
    if super::panel_dialog::enabled() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| "Private dialog root mode failed")?;
        }
    }
    let cleanup = Cleanup(root.clone());
    let output = path("--output")?;
    let plugin_root = path("--plugin-root")?;
    let script = std::fs::read(path("--panel-ui")?).map_err(|error| error.to_string())?;
    let css = std::fs::read(path("--panel-css")?).map_err(|error| error.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let probe = std::fs::read_to_string(path("--panel-probe")?)
        .map_err(|error| error.to_string())?
        .replace("__ATOOLS_PANEL_TOKEN__", &token);
    let config = AppConfig::with_base_dir(root.join("app-data"));
    config.ensure_dirs().map_err(|error| error.to_string())?;
    let db =
        Arc::new(Database::open(&root.join("smoke.sqlite")).map_err(|error| error.to_string())?);
    let head_file_tree_acceptance = args.iter().any(|arg| arg == "--file-tree-head-ui");
    let head_developer_codec_tools_acceptance = args
        .iter()
        .any(|arg| arg == "--developer-codec-tools-head-ui");
    if head_file_tree_acceptance && head_developer_codec_tools_acceptance {
        return Err("Panel HEAD profiles are mutually exclusive".into());
    }
    let profile = if head_file_tree_acceptance {
        fixture_setup::OriginalPanelProfile::HeadFileTree
    } else if head_developer_codec_tools_acceptance {
        fixture_setup::OriginalPanelProfile::HeadDeveloperCodecTools
    } else {
        fixture_setup::OriginalPanelProfile::Standard
    };
    let installed = fixture_setup::install(&db, &root, &plugin_root, profile)?;
    let imported = installed.imported;
    let mut dataset = installed.dataset;
    if head_file_tree_acceptance {
        let profile = file_tree_head::registered_profile()?;
        let plugin = db
            .get_plugin("file-tree")
            .map_err(|_| "Pinned FileTree package was not imported")?;
        if plugin.version != profile["version"].as_str().unwrap_or("")
            || !plugin
                .manifest
                .features
                .iter()
                .any(|feature| feature.code == "file-tree")
        {
            return Err("Imported FileTree identity differs from the HEAD fixture profile".into());
        }
    }
    if head_developer_codec_tools_acceptance {
        let profile = developer_codec_tools_head::registered_profile()?;
        let plugin = db
            .get_plugin("developer-codec-tools")
            .map_err(|_| "Pinned developer codec package was not imported")?;
        if plugin.version != profile["version"].as_str().unwrap_or("")
            || !plugin
                .manifest
                .features
                .iter()
                .any(|feature| feature.code == "codec-tools")
        {
            return Err(
                "Imported developer codec identity differs from the HEAD fixture profile".into(),
            );
        }
    }
    let dialog_fixture = super::panel_dialog::DialogFixture::prepare(&root)?;
    let dialog_acceptance = dialog_fixture.is_some();
    let page_navigation =
        std::env::var("ATOOLS_PAGE_NAVIGATION_ACCEPTANCE").as_deref() == Ok("true");
    if page_navigation && !dialog_acceptance {
        return Err("Page navigation requires the private fixture guard".into());
    }
    let browser_window_acceptance =
        std::env::var("ATOOLS_BROWSER_WINDOW_ACCEPTANCE").as_deref() == Ok("true");
    if browser_window_acceptance
        && (dialog_acceptance
            || page_navigation
            || imported.iter().any(|id| {
                db.get_plugin(id).ok().is_none_or(|plugin| {
                    plugin.manifest.preload.is_some()
                        || plugin.manifest.version != "0.0.0-synthetic"
                })
            }))
    {
        return Err("Browser window acceptance requires its generated pure-Web packages".into());
    }
    let web_storage_acceptance =
        std::env::var("ATOOLS_WEB_STORAGE_ACCEPTANCE").as_deref() == Ok("true");
    let node_page_acceptance =
        std::env::var("ATOOLS_NODE_PAGE_ACCEPTANCE").as_deref() == Ok("true");
    if web_storage_acceptance
        && (dialog_acceptance
            || page_navigation
            || browser_window_acceptance
            || imported.iter().any(|id| {
                db.get_plugin(id).ok().is_none_or(|plugin| {
                    plugin.manifest.preload.is_some()
                        || plugin.manifest.version != "0.0.0-synthetic"
                })
            }))
    {
        return Err(
            "Web Storage acceptance requires generated no-preload pure-Web packages".into(),
        );
    }
    if web_storage_acceptance {
        dataset = dataset.with_generated_packages();
    }
    let child_node_acceptance = child_node::configure(
        &db,
        &mut dataset,
        dialog_acceptance
            || page_navigation
            || browser_window_acceptance
            || web_storage_acceptance
            || node_page_acceptance,
    )?;
    if node_page_acceptance {
        if dialog_acceptance
            || page_navigation
            || browser_window_acceptance
            || web_storage_acceptance
            || imported.iter().any(|id| {
                db.get_plugin(id).ok().is_none_or(|plugin| {
                    plugin.manifest.preload.is_some()
                        || plugin.manifest.version != "0.0.0-synthetic"
                })
            })
        {
            return Err("Page-only Node acceptance requires generated no-preload packages".into());
        }
        dataset = dataset.with_generated_packages();
    }
    db.set_setting(
        "settings-general",
        &json!({"autoPaste":"never","localAppSearch":false,"pluginEscapeToSearch":true})
            .to_string(),
    )
    .map_err(|error| error.to_string())?;
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db.clone(), None, pasteboard);
    let (sender, receiver) = tokio::sync::oneshot::channel::<Value>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let passed = Arc::new(AtomicBool::new(false));
    let passed_after = passed.clone();
    let report_path = output.clone();
    let cleanup_path = root.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier =
        format!("dev.atools.panel-smoke.{}", uuid::Uuid::new_v4().simple());
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let foreground = super::panel_foreground::PanelForeground::from_environment()?;
    let app=crate::plugin_page_runtime::register(crate::plugin_asset_protocol::register(tauri::Builder::default()))
        .plugin(tauri_plugin_fs::init())
        .manage(state).manage(PanelFixture{root:root.clone(),token,document_probe:probe.clone(),dataset,db:db.clone(),head_file_tree_acceptance,head_developer_codec_tools_acceptance}).manage(PanelReport(sender.clone()))
        .manage(super::panel_perf::PanelPerformance::default())
        .manage(crate::general_settings_runtime::GeneralSettingsCoordinator::default())
        .manage(foreground)
        .invoke_handler(tauri::generate_handler![
            crate::plugin_page_runtime::commands::prepare_plugin_page,
            crate::plugin_page_runtime::commands::claim_plugin_page,
            crate::plugin_page_runtime::commands::close_plugin_page,
            fixture_state::native_panel_fixture,native_panel_runtime_state,native_panel_report,
            file_tree_head::native_file_tree_head_task_run_evidence,
            developer_codec_tools_head::native_developer_codec_tools_profile,
            developer_codec_tools_head::native_developer_codec_tools_task_run_evidence,
            crate::launcher_media::activate_file_content_feature,
            native_panel_node_page_evidence,
            child_node::native_panel_child_node_privacy,
            native_panel_document_probe_source,
            crate::plugin_page_runtime::navigation_probe::native_page_navigation_snapshot,
            crate::plugin_asset_protocol::prepare_plugin_resources,
            crate::plugin_asset_protocol::close_plugin_resources,
            super::panel_perf::native_panel_perf_snapshot,super::panel_perf::native_panel_perf_phase,
            super::panel_perf::native_panel_perf_quiet_window,
            super::panel_foreground::native_panel_foreground,
            super::panel_dialog::native_panel_dialog_fixture,super::panel_dialog::native_panel_dialog_checkpoint,
            super::panel_dialog::native_panel_dialog_evidence,
            crate::plugin_dialog_runtime::commands::prepare_plugin_dialogs,
            crate::plugin_dialog_runtime::commands::get_plugin_dialog_session,
            crate::plugin_dialog_runtime::commands::close_plugin_dialogs,
            crate::plugin_dialog_runtime::commands::rotate_plugin_dialogs,
            crate::plugin_display_runtime::commands::prepare_plugin_display,
            crate::plugin_display_runtime::commands::get_plugin_display_session,
            crate::plugin_display_runtime::commands::close_plugin_display,
            crate::plugin_display_runtime::commands::rotate_plugin_display,
            crate::host_runtime::commands::prepare_host_clipboard,
            crate::host_runtime::commands::get_host_clipboard_session,
            crate::host_runtime::commands::close_host_clipboard,
            crate::host_runtime::commands::rotate_host_clipboard,
            crate::plugin_data_runtime::commands::prepare_plugin_data,
            crate::plugin_system_paths::commands::prepare_plugin_paths,
            crate::plugin_system_paths::commands::get_plugin_path_snapshot,
            crate::plugin_system_paths::commands::close_plugin_paths,
            crate::plugin_system_paths::commands::rotate_plugin_paths,
            crate::plugin_data_runtime::commands::get_plugin_data_session,
            crate::plugin_data_runtime::commands::close_plugin_data,
            crate::plugin_data_runtime::commands::rotate_plugin_data,
            crate::commands::feature_catalog,crate::commands::search_features,
            crate::commands::activate_feature,crate::commands::get_setting,
            crate::commands::expand_window,crate::commands::reset_window,
            crate::commands::list_pending_agent_requests,crate::commands::get_task_run,
            crate::commands::dismiss_pending_agent_request,crate::commands::call_agent_tool,
            crate::commands::grant_agent_tool,
            crate::legacy_runtime::commands::prepare_legacy_node,
            crate::legacy_runtime::commands::get_legacy_node_session,
            crate::legacy_runtime::commands::close_legacy_node,
            crate::legacy_runtime::commands::plugin_legacy_node_usage,
            crate::legacy_runtime::permission_context::get_permission_request_context,
            crate::plugin_resources::read_plugin_preload_module,
        ])
        .register_uri_scheme_protocol("atools-panel",move|_,request| {
            let (mime,body)=match request.uri().path() {
                "/panel.js"=>("text/javascript",script.clone()),
                "/panel.css"=>("text/css",css.clone()),
                "/"=>("text/html",br#"<!doctype html><meta charset="utf-8"><script>if(window===window.top){window.addEventListener('error',function(e){window.__TAURI__.core.invoke('native_panel_report',{report:{passed:false,error:String(e.message),file:e.filename,line:e.lineno}})});window.addEventListener('unhandledrejection',function(e){window.__TAURI__.core.invoke('native_panel_report',{report:{passed:false,error:String(e.reason)}})});}</script><link rel="stylesheet" href="atools-panel://localhost/panel.css"><div id="app"></div><script src="atools-panel://localhost/panel.js"></script>"#.to_vec()),
                _=>("text/plain",Vec::new()),
            };
            let status=if matches!(request.uri().path(),"/"|"/panel.js"|"/panel.css"){200}else{404};
            tauri::http::Response::builder().status(status).header("content-type",mime).body(body).unwrap()
        })
        .on_window_event(|window,event| {
            super::panel_foreground::record_window_event(window.app_handle(),window.label(),event);
            if matches!(event,tauri::WindowEvent::Destroyed) {
                crate::plugin_page_runtime::close_window(window.app_handle(),window.label());
                crate::plugin_asset_protocol::close_window(window.app_handle(),window.label());
                let app=window.app_handle().clone();let label=window.label().to_string();
                tauri::async_runtime::spawn(async move{crate::plugin_system_paths::close_window(&app,&label);crate::plugin_data_runtime::close_window(&app,&label).await;crate::plugin_dialog_runtime::close_window(&app,&label).await;crate::plugin_display_runtime::close_window(&app,&label).await;});
            }
        })
        .setup(move|app| {
            crate::legacy_runtime::install_manager(app.handle());
            crate::plugin_display_runtime::install_manager(app.handle());
            crate::plugin_data_runtime::install_manager(app.handle());
            crate::plugin_system_paths::install_manager(app.handle());
            crate::plugin_dialog_runtime::install_manager(app.handle());
            if let Some(fixture)=dialog_fixture { app.manage(fixture); super::panel_dialog::monitor(app.handle().clone()); }
            #[cfg(target_os="macos")]
            crate::host_runtime::install_isolated_manager(app.handle());
            app.fs_scope().allow_directory(&root,true)?;
            app.asset_protocol_scope().allow_directory(&root,true)?;
            app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-production-panel")
                .window("main").remote("atools-panel://localhost/*".into())
                .permission("core:event:allow-listen").permission("core:event:allow-unlisten")
                .permission("fs:allow-read-text-file"))?;
            WebviewWindowBuilder::new(app,"main",WebviewUrl::CustomProtocol("atools-panel://localhost/".parse().unwrap()))
                .title("ATools isolated production PluginPanel")
                .always_on_top(true)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .inner_size(800.0,600.0).incognito(true).data_directory(root.join("webview"))
                .initialization_script_for_all_frames(probe).build()?;
            crate::window::show_main_window_for_startup(app.handle())?;
            let app=app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let result=tokio::time::timeout(std::time::Duration::from_secs(if web_storage_acceptance||node_page_acceptance{240}else if page_navigation{180}else if dialog_acceptance{480}else{60}),receiver).await;
                let mut report=match result {
                    Ok(Ok(value))=>value,
                    _=>json!({"passed":false,"error":"Native full Panel report timed out"}),
                };
                report["fixturePhases"]=super::panel_perf::phase_snapshot(&app);
                report["nativeWindowEvents"]=super::panel_foreground::event_snapshot(&app);
                super::panel_dialog::finish(&app);
                crate::plugin_page_runtime::close_window(&app,"main");
                crate::plugin_display_runtime::stop(&app).await;
                crate::plugin_dialog_runtime::stop(&app).await;
                let runtime=app.state::<Arc<crate::legacy_runtime::Sessions>>();
                runtime.stop_all().await;
                crate::plugin_system_paths::stop(&app);
                crate::plugin_data_runtime::stop(&app).await;
                crate::plugin_display_runtime::stop(&app).await;
                if let Ok(host)=crate::host_runtime::manager(&app){host.close(None,None,true).await;}
                crate::plugin_asset_protocol::close_window(&app,"main");
                let resource_leases=crate::plugin_asset_protocol::lease_count(&app);
                report["resourceLeasesAfterCleanup"]=json!(resource_leases);
                report["pageDocumentMode"]=json!(crate::plugin_page_runtime::enabled(&app));
                let page_documents=crate::plugin_page_runtime::document_count(&app);
                report["pageDocumentsAfterCleanup"]=json!(page_documents);
                if page_documents!=0 {report["passed"]=json!(false);}
                let data_state=crate::plugin_data_runtime::runtime_state(&app).await;
                let data_drained=["dataSessions","dataIntents","dataInvocations","dataPreparations","webStorageEvents","webStorageEventBytes"].iter().all(|key|data_state[key].as_u64()==Some(0))&&data_state["dataTransport"]==false;
                report["dataRuntimeAfterCleanup"]=data_state;report["dataRuntimeDrained"]=json!(data_drained);
                let dialog_state=crate::plugin_dialog_runtime::runtime_state(&app).await;
                let dialog_drained=["dialogSessions","dialogIntents","dialogInvocations","dialogPreparations","nativeDialogs"].iter().all(|key|dialog_state[key].as_u64()==Some(0))&&dialog_state["dialogTransport"]==false;
                report["dialogRuntimeAfterCleanup"]=dialog_state;report["dialogRuntimeDrained"]=json!(dialog_drained);
                let paths_state=crate::plugin_system_paths::runtime_state(&app);
                let paths_drained=paths_state["pathRuntimeAvailable"]==true&&["activePathSnapshots","activePathIntents","activePathPreparations","pathSnapshotBytes"].iter().all(|key|paths_state[key].as_u64()==Some(0));
                report["pathRuntimeAfterCleanup"]=paths_state;report["pathRuntimeDrained"]=json!(paths_drained);
                let runs=db.list_task_runs(1000).unwrap_or_default();
                let all_terminal=runs.iter().all(|run|run.status.is_terminal());
                report["allTaskRunsTerminal"]=json!(all_terminal);
                report["taskRuns"]=json!(runs.len());
                let synthetic_never_activated=runs.iter().all(|run|!run.input.get("code").and_then(Value::as_str).is_some_and(super::catalog_fixture::is_synthetic_code));
                report["syntheticMetadataNeverActivated"]=json!(synthetic_never_activated);
                report["dataset"]=json!(app.state::<PanelFixture>().dataset);
                let success=report["passed"]==true && all_terminal && resource_leases==0 && data_drained && paths_drained && dialog_drained && synthetic_never_activated;
                report["passed"]=json!(success);
                report["scope"]=json!("Full production App and PluginPanel; 1200 synthetic search metadata features plus two original plugins for business/authorization checks; temporary database; programmatic source-bound DOM interaction");
                report["limitations"]=json!(["Controlled custom protocol/CSP and minimal command registration; fixture background throttling disabled","Background updater/clipboard disabled; no native file picker, clipboard copy/export or physical input tested","Single-platform macOS observation"]);
                if dialog_acceptance {
                    report["scope"]=json!("Dedicated genuine original file-tree UI native open/save cancellation and selection; private synthetic directory and independently decoded PNG; operator controls genuine OS panels");
                    report["limitations"]=json!(["Controlled incognito fixture with background services disabled","The operator controls genuine OS panels; private selection constraint only exists in this explicit smoke fixture","No physical global hotkey, packaged build, app restart, clipboard export or arbitrary user files exercised"]);
                }
                if page_navigation {
                    report["scope"]=json!("Synthetic page-navigation packages through the real App/PluginPanel and native data permission pipeline; no original package, Node, clipboard access or operating-system picker execution");
                    report["limitations"]=json!(["Private incognito macOS smoke fixture with background services disabled","Native target-frame policy evidence is separate from pagehide/load observations","No production enablement, original-plugin acceptance, packaged release or full-process performance claim"]);
                    report["generatedSourcesOnly"]=json!(true);
                }
                if browser_window_acceptance {
                    report["scope"]=json!("Generated pure-Web packages through real App/PluginPanel, plus complete hash-pinned original TipsWindow/ContextMenuWindow classes and original context menu HTML, Electron preload and color stylesheet; no complete original package, Node, clipboard operation or OS picker");
                    report["limitations"]=json!(["macOS incognito fixture; background services disabled; default opaque document path","Hosted iframe windows and programmatic DOM events, not independent native floating windows, physical input or complete plugin acceptance","Original context menu query configuration is not preserved by opaque srcdoc and is not verified","Reviewed original parts only; no packaged release or full-process performance claim"]);
                    report["generatedSourcesOnly"]=json!(false);
                    report["reviewedOriginalPartsOnly"]=json!(true);
                    report["reviewedOriginalContextMenuFiles"]=json!(true);
                }
                if web_storage_acceptance {
                    report["webStorageEventStoreDrained"]=json!(data_drained);
                    report["scope"]=json!("Generated 0.0.0-synthetic no-preload file-tree and char-transform packages through real App/PluginPanel opaque frames; only fixed-hash original ThemeManager and UIManager classes are embedded; no complete original plugin, Node, OS picker, clipboard, AppleScript or external network access; real data bridge uses the private local-loopback transport");
                    report["limitations"]=json!(["macOS incognito fixture with background services disabled","Only two unchanged original classes execute inside generated pages; no complete original package acceptance","Any synthetic key-count timing applies only to its reported fixture size and does not establish the full 4096-key budget"]);
                    report["generatedSourcesOnly"]=json!(false);
                    report["reviewedOriginalClassesOnly"]=json!(true);
                }
                if node_page_acceptance {
                    report["scope"]=json!("Generated 0.0.0-synthetic no-preload packages containing complete hash-pinned original image-stitch and developer-codec-tools UI assets through the real App/opaque PluginPanel; only fixture-owned save picker/reveal mocks; one-time page Node authorization and Rust-decoded private PNG; no complete original package export or OS picker");
                    report["limitations"]=json!(["macOS incognito fixture with background services disabled","Generated manifests and the image-stitch fixture entry are not the original package manifest; original UI assets remain byte-identical","The save function is embedded only in the fixture harness; picker/reveal are mocked and no operating-system UI is opened","No complete original package export, arbitrary files, clipboard action, packaged release or full-process performance claim"]);
                    report["generatedSourcesOnly"]=json!(false);
                    report["reviewedOriginalUiAssetsOnly"]=json!(true);
                }
                if child_node_acceptance { child_node::describe(&mut report); }
                passed.store(success,Ordering::Release);
                if let Some(parent)=output.parent(){let _=std::fs::create_dir_all(parent);}
                let _=std::fs::write(&output,serde_json::to_vec_pretty(&report).unwrap());
                app.exit(if success{0}else{1});
            });
            Ok(())
        }).build(context).map_err(|error|error.to_string())?;
    app.run_return(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            crate::plugin_dialog_runtime::stop_on_main_thread(app);
        }
    });
    drop(cleanup);
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
        Err("Full production Panel smoke failed; see report".into())
    }
}
