//! Isolated real-Tauri acceptance for plugin install/update/disable lifecycle.
//! Only synthetic packages are generated under the runner-owned temporary root.
use super::{Cleanup, NoClipboard};
use crate::{pasteboard_runtime::PasteboardRuntime, state::AppState};
use atools_api_shim::{handler::ApiHandler, handler_wrapper::ApiHandlerWrapper};
use atools_core::{AppConfig, Database};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

struct MutationFixture {
    root: PathBuf,
    token: String,
}
struct MutationReport(Arc<Mutex<Option<tokio::sync::oneshot::Sender<Value>>>>);
#[derive(Default)]
struct MutationGateHolds(Mutex<HashMap<String, tokio::sync::OwnedRwLockWriteGuard<()>>>);

#[tauri::command]
fn native_mutation_fixture(app: tauri::AppHandle) -> Value {
    let fixture = app.state::<MutationFixture>();
    json!({
        "token": fixture.token,
        "v1Path": fixture.root.join("source-v1").to_string_lossy(),
        "v2Path": fixture.root.join("source-v2").to_string_lossy(),
        "unrelatedPath": fixture.root.join("source-unrelated").to_string_lossy(),
        "malformedPath": fixture.root.join("source-malformed").to_string_lossy(),
        "pluginId": "mutation-probe",
        "featureCode": "mutation-probe-v1"
    })
}

#[tauri::command]
fn native_mutation_report(app: tauri::AppHandle, report: Value) {
    if let Some(sender) = app.state::<MutationReport>().0.lock().take() {
        let _ = sender.send(report);
    }
}

#[tauri::command]
async fn native_mutation_state(app: tauri::AppHandle) -> Value {
    let legacy = app.state::<Arc<crate::legacy_runtime::Sessions>>();
    let host = crate::host_runtime::manager(&app).expect("fixture host manager installed");
    let db = app.state::<AppState>().db.clone();
    let (legacy_count, openings) = { (legacy.sessions.read().len(), legacy.openings.lock().len()) };
    let legacy_transport = legacy.server.lock().await.is_some();
    let (host_sessions, host_intents, host_invocations) = {
        let store = host.store.lock();
        (
            store.sessions.len(),
            store.intents.len(),
            store.invocations.len(),
        )
    };
    let host_transport = host.server.lock().await.is_some();
    let plugin = db.get_plugin("mutation-probe").ok();
    let installed = plugin.as_ref().map(|p| PathBuf::from(&p.path));
    let runs = db.list_task_runs(1000).unwrap_or_default();
    let pending = app.state::<AppState>().pending_agent_requests.lock().len();
    json!({"legacySessions":legacy_count,"openings":openings,"legacyTransport":legacy_transport,
        "hostSessions":host_sessions,"hostIntents":host_intents,"hostInvocations":host_invocations,"hostTransport":host_transport,
        "pluginEnabled":plugin.as_ref().is_some_and(|p| p.enabled),"pluginVersion":plugin.as_ref().map(|p| p.version.clone()),
        "installedPreload":plugin.as_ref().and_then(|p|p.manifest.preload.clone()),
        "oldPreloadPresent":installed.as_ref().is_some_and(|p|p.join("preload-v1.cjs").exists()),
        "v2PreloadPresent":installed.as_ref().is_some_and(|p|p.join("preload-v2.cjs").exists()),
        "taskRuns":runs.len(),"pendingRequests":pending,"allTaskRunsTerminal":runs.iter().all(|run|run.status.is_terminal())})
}

#[tauri::command]
async fn native_mutation_hold_write_gate(
    app: tauri::AppHandle,
    plugin_id: String,
) -> Result<(), String> {
    if plugin_id != "mutation-probe" {
        return Err("Fixture gate accepts only mutation-probe".into());
    }
    let gates = app
        .state::<Arc<crate::plugin_execution_gates::PluginExecutionGates>>()
        .inner()
        .clone();
    let guard = gates.write(&plugin_id).await;
    let previous = app
        .state::<MutationGateHolds>()
        .0
        .lock()
        .insert(plugin_id, guard);
    if previous.is_some() {
        return Err("Fixture write gate is already held".into());
    }
    Ok(())
}

#[tauri::command]
fn native_mutation_release_write_gate(app: tauri::AppHandle, plugin_id: String) -> bool {
    app.state::<MutationGateHolds>()
        .0
        .lock()
        .remove(&plugin_id)
        .is_some()
}

#[tauri::command]
fn native_mutation_latest_run(app: tauri::AppHandle, capability_id: String) -> Value {
    let runs = app
        .state::<AppState>()
        .db
        .list_task_runs(1000)
        .unwrap_or_default();
    let latest = runs
        .iter()
        .filter(|run| run.capability_id == capability_id)
        .max_by(|left, right| left.created_at.cmp(&right.created_at));
    latest
        .map(|run| json!({"id":run.id,"status":run.status.as_str(),"output":run.output}))
        .unwrap_or(Value::Null)
}

fn write_package(
    root: &PathBuf,
    dir: &str,
    name: &str,
    title: &str,
    version: &str,
    marker: &str,
    preload: &str,
) -> Result<(), String> {
    let path = root.join(dir);
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    let manifest = json!({"name":name,"title":title,"version":version,"main":"index.html","preload":preload,
        "description":"Synthetic local lifecycle fixture","features":[{"code":format!("{name}-v1"),"label":title,"explain":"Synthetic lifecycle acceptance","mainPush":true,"cmds":["mutation probe","lifecycle probe"]}],
        "tools":{"probe":{"description":"Return a fixture version marker","inputSchema":{"type":"object","additionalProperties":false}}}});
    std::fs::write(
        path.join("plugin.json"),
        serde_json::to_vec_pretty(&manifest).unwrap(),
    )
    .map_err(|error| error.to_string())?;
    std::fs::write(path.join("index.html"), format!("<!doctype html><meta charset=utf-8><title>{title}</title><main id=fixture-version data-version={marker}>{title} / {marker}</main><script>parent.postMessage({{kind:'mutation-version',version:'{marker}'}},'*')</script>")).map_err(|error| error.to_string())?;
    let source = format!(
        "const crypto=require('node:crypto'); const marker={}; module.exports={{registerTools(api){{api.registerTool('probe', async()=>({{version:marker,digest:crypto.createHash('sha256').update(marker).digest('hex')}}));}}, bridge:{{version:marker,digest(){{return crypto.createHash('sha256').update(marker).digest('hex')}}}}}};",
        serde_json::to_string(marker).unwrap()
    );
    std::fs::write(path.join(preload), source).map_err(|error| error.to_string())?;
    Ok(())
}

fn prepare(root: &PathBuf) -> Result<(), String> {
    std::fs::create_dir(root).map_err(|error| error.to_string())?;
    write_package(
        root,
        "source-v1",
        "mutation-probe",
        "生命周期探针",
        "1.0.0",
        "v1",
        "preload-v1.cjs",
    )?;
    write_package(
        root,
        "source-v2",
        "mutation-probe",
        "生命周期探针",
        "1.0.0",
        "v2",
        "preload-v2.cjs",
    )?;
    write_package(
        root,
        "source-unrelated",
        "mutation-unrelated",
        "独立插件探针",
        "1.0.0",
        "unrelated",
        "preload.cjs",
    )?;
    std::fs::create_dir_all(root.join("source-malformed")).map_err(|error| error.to_string())?;
    std::fs::write(
        root.join("source-malformed/plugin.json"),
        br#"{"name":"mutation-probe","version": "1.0.0", "main":"index.html", "features": []"#,
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Native plugin mutation fixture currently targets macOS only".into());
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
    prepare(&root)?;
    let cleanup = Cleanup(root.clone());
    let output = path("--output")?;
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
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config.clone(), db.clone(), None, pasteboard);
    let handler = Arc::new(ApiHandler::new(db.clone(), config.plugins_dir()));
    let handler_trait: Arc<dyn atools_plugin::ipc_handler::IpcHandler + Send + Sync> =
        Arc::new(ApiHandlerWrapper::from_shared(handler.clone()));
    let runtime = Arc::new(
        atools_plugin::runtime::JsRuntime::new(handler_trait).map_err(|error| error.to_string())?,
    );
    handler.attach_runtime(&runtime);
    let supervisor = Arc::new(atools_plugin::SidecarSupervisor::new());
    let (sender, receiver) = tokio::sync::oneshot::channel::<Value>();
    let sender = Arc::new(Mutex::new(Some(sender)));
    let passed = Arc::new(AtomicBool::new(false));
    let passed_after = passed.clone();
    let report_path = output.clone();
    let cleanup_path = root.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.plugin-mutation-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let app=tauri::Builder::default().plugin(tauri_plugin_fs::init())
        .manage(state).manage(MutationFixture{root:root.clone(),token}).manage(MutationReport(sender.clone()))
        .manage(handler).manage(runtime).manage(supervisor)
        .manage(Arc::new(crate::plugin_execution_gates::PluginExecutionGates::default()))
        .manage(MutationGateHolds::default())
        .invoke_handler(tauri::generate_handler![
            native_mutation_fixture,native_mutation_report,native_mutation_state,native_mutation_latest_run,
            native_mutation_hold_write_gate,native_mutation_release_write_gate,
            crate::plugin_display_runtime::commands::prepare_plugin_display,
            crate::plugin_display_runtime::commands::get_plugin_display_session,
            crate::plugin_display_runtime::commands::close_plugin_display,
            crate::plugin_display_runtime::commands::rotate_plugin_display,
            crate::host_runtime::commands::prepare_host_clipboard,crate::host_runtime::commands::get_host_clipboard_session,
            crate::host_runtime::commands::close_host_clipboard,crate::host_runtime::commands::rotate_host_clipboard,
            crate::commands::install_plugin,crate::commands::update_plugin_from_path,crate::commands::import_ztools_plugins,
            crate::commands::toggle_plugin,crate::commands::uninstall_plugin,
            crate::commands::feature_catalog,crate::commands::search_features,crate::commands::activate_feature,
            crate::commands::call_agent_tool,crate::commands::get_task_run,crate::commands::list_task_runs,crate::commands::start_agent_tool,crate::commands::cancel_task_run,
            crate::commands::list_pending_agent_requests,crate::commands::dismiss_pending_agent_request,
            crate::commands::grant_agent_tool,crate::commands::revoke_agent_tool,crate::commands::list_agent_tool_grants,
            crate::commands::set_agent_tool_enabled,crate::commands::get_setting,
            crate::legacy_runtime::commands::prepare_legacy_node,crate::legacy_runtime::commands::get_legacy_node_session,
            crate::legacy_runtime::commands::close_legacy_node,crate::legacy_runtime::permission_context::get_permission_request_context,
            crate::plugin_resources::read_plugin_preload_module
        ])
        .register_uri_scheme_protocol("atools-mutation",move|_,request|{
            let (mime,body)=match request.uri().path(){"/panel.js"=>("text/javascript",script.clone()),"/panel.css"=>("text/css",css.clone()),"/"=>("text/html",br#"<!doctype html><meta charset=utf-8><script>if(window===window.top){window.addEventListener('error',e=>window.__TAURI__.core.invoke('native_mutation_report',{report:{passed:false,error:String(e.message),file:e.filename,line:e.lineno}}));window.addEventListener('unhandledrejection',e=>window.__TAURI__.core.invoke('native_mutation_report',{report:{passed:false,error:String(e.reason)}}));}</script><link rel=stylesheet href="atools-mutation://localhost/panel.css"><div id=app></div><script src="atools-mutation://localhost/panel.js"></script>"#.to_vec()),_=>("text/plain",Vec::new())};
            let status=if matches!(request.uri().path(),"/"|"/panel.js"|"/panel.css"){200}else{404};tauri::http::Response::builder().status(status).header("content-type",mime).body(body).unwrap()
        })
        .setup(move|app|{
            crate::legacy_runtime::install_manager(app.handle());
            crate::plugin_display_runtime::install_manager(app.handle());
            #[cfg(target_os="macos")] crate::host_runtime::install_isolated_manager(app.handle());
            app.fs_scope().allow_directory(&root,true)?; app.asset_protocol_scope().allow_directory(&root,true)?;
            app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-plugin-mutation")
                .window("main").remote("atools-mutation://localhost/*".into())
                .permission("core:event:allow-listen").permission("core:event:allow-unlisten")
                .permission("fs:allow-read-text-file"))?;
            WebviewWindowBuilder::new(app,"main",WebviewUrl::CustomProtocol("atools-mutation://localhost/".parse().unwrap()))
                .title("ATools synthetic plugin mutation acceptance").always_on_top(true).background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .inner_size(800.0,600.0).incognito(true).data_directory(root.join("webview")).initialization_script_for_all_frames(probe).build()?;
            crate::window::show_main_window_for_startup(app.handle())?;
            let app=app.handle().clone();
            tauri::async_runtime::spawn(async move{
                let result=tokio::time::timeout(std::time::Duration::from_secs(100),receiver).await;
                let mut report=match result{Ok(Ok(value))=>value,_=>json!({"passed":false,"error":"Synthetic mutation report timed out"})};
                let sessions=app.state::<Arc<crate::legacy_runtime::Sessions>>(); sessions.stop_all().await;
                crate::plugin_display_runtime::stop(&app).await;
                if let Ok(host)=crate::host_runtime::manager(&app){host.close(None,None,true).await;}
                let runs=db.list_task_runs(1000).unwrap_or_default(); report["finalTaskRunCount"]=json!(runs.len());
                report["allTaskRunsTerminal"]=json!(runs.iter().all(|run|run.status.is_terminal()));
                report["scope"]=json!("Real Tauri App/PluginPanel mutation commands against generated synthetic packages and a temporary database");
                report["limitations"]=json!(["macOS Wry fixture only; backgroundServices=false; no release build or physical hotkey claim","This exercises the Node preload/cache path only; no independent pure-QuickJS plugin cache fixture or late-activation-event race is covered","Node preload is a real local Node process; WebKit child and process RSS are not measured here","No original/builtin/community plugin code was imported or executed","Loopback/GUI test uses the opt-in isolated native runner"]);
                let success=report["passed"]==true&&report["allTaskRunsTerminal"]==true;report["passed"]=json!(success);passed.store(success,Ordering::Release);
                if let Some(parent)=output.parent(){let _=std::fs::create_dir_all(parent);}let _=std::fs::write(&output,serde_json::to_vec_pretty(&report).unwrap());app.exit(if success{0}else{1});
            }); Ok(())
        }).build(context).map_err(|error|error.to_string())?;
    app.run_return(|_, _| {});
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
        Err("Synthetic mutation acceptance failed; inspect fixture report".into())
    }
}
