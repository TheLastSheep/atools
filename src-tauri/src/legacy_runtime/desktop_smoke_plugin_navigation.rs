//! Isolated production App/PluginPanel navigation acceptance using one generated pure-Web plugin.
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

struct NavigationFixture {
    root: PathBuf,
    token: String,
}
struct NavigationReport(Arc<Mutex<Option<tokio::sync::oneshot::Sender<Value>>>>);

#[tauri::command]
fn native_navigation_fixture(app: tauri::AppHandle) -> Value {
    let fixture = app.state::<NavigationFixture>();
    json!({"token":fixture.token,"sourcePath":fixture.root.join("source").to_string_lossy(),
        "pluginId":"navigation-probe","featureCode":"navigation-probe"})
}
#[tauri::command]
fn native_navigation_report(app: tauri::AppHandle, report: Value) {
    if let Some(sender) = app.state::<NavigationReport>().0.lock().take() {
        let _ = sender.send(report);
    }
}
#[tauri::command]
async fn native_navigation_runtime_state(app: tauri::AppHandle) -> Value {
    let runtime = app.state::<Arc<crate::legacy_runtime::Sessions>>();
    let state = app.state::<AppState>();
    let sessions = runtime.sessions.read().len();
    let openings = runtime.openings.lock().len();
    let transport = runtime.server.lock().await.is_some();
    let host = crate::host_runtime::manager(&app).expect("isolated host manager installed");
    let (host_sessions, host_intents, host_invocations) = {
        let store = host.store.lock();
        (
            store.sessions.len(),
            store.intents.len(),
            store.invocations.len(),
        )
    };
    let host_transport = host.server.lock().await.is_some();
    json!({"legacySessions":sessions,"legacyOpenings":openings,"legacyTransport":transport,
        "hostSessions":host_sessions,"hostIntents":host_intents,"hostInvocations":host_invocations,"hostTransport":host_transport,
        "pendingRequests":state.pending_agent_requests.lock().len()})
}

fn absolute_arg(args: &[String], flag: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|value| value.is_absolute())
        .ok_or_else(|| format!("Missing absolute {flag}"))
}

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Native plugin navigation fixture currently targets macOS only".into());
    }
    let args: Vec<_> = std::env::args().collect();
    let root = absolute_arg(&args, "--fixture-root")?;
    std::fs::create_dir(&root).map_err(|error| error.to_string())?;
    let cleanup = Cleanup(root.clone());
    let output = absolute_arg(&args, "--output")?;
    let script =
        std::fs::read(absolute_arg(&args, "--panel-ui")?).map_err(|error| error.to_string())?;
    let css =
        std::fs::read(absolute_arg(&args, "--panel-css")?).map_err(|error| error.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let probe = std::fs::read_to_string(absolute_arg(&args, "--panel-probe")?)
        .map_err(|error| error.to_string())?
        .replace("__ATOOLS_NAVIGATION_TOKEN__", &token);
    let source = root.join("source");
    std::fs::create_dir_all(&source).map_err(|error| error.to_string())?;
    std::fs::write(source.join("plugin.json"),r#"{"name":"navigation-probe","title":"导航探针","version":"1.0.0","main":"index.html","description":"Synthetic pure-Web navigation fixture","features":[{"code":"navigation-probe","label":"导航探针","explain":"验证插件搜索导航","mainPush":true,"cmds":["navigation probe"]}]}"#.as_bytes()).map_err(|error|error.to_string())?;
    std::fs::write(source.join("index.html"),r#"<!doctype html><meta charset="utf-8"><title>导航探针</title>
<main><button id="show-subinput-default">显示默认插件搜索</button><button id="show-subinput">显示带占位符插件搜索</button><button id="set-value">设置值</button><button id="focus-subinput">聚焦</button><button id="blur-subinput">失焦</button><button id="select-subinput">全选</button><button id="remove-subinput">移除</button></main>
<script>
window.__navCallbackValues=[];
document.querySelector('#show-subinput-default').onclick=()=>window.ztools.setSubInput(value=>{window.__navCallbackValues.push(value.text);window.parent.postMessage({kind:'navigation-callback',text:value.text},'*')});
document.querySelector('#show-subinput').onclick=()=>window.ztools.setSubInput(value=>{window.__navCallbackValues.push(value.text);window.parent.postMessage({kind:'navigation-callback',text:value.text},'*')},'筛选条目',true);
document.querySelector('#set-value').onclick=()=>window.ztools.setSubInputValue('select-me');
document.querySelector('#focus-subinput').onclick=()=>window.ztools.subInputFocus();
document.querySelector('#blur-subinput').onclick=()=>window.ztools.subInputBlur();
document.querySelector('#select-subinput').onclick=()=>window.ztools.subInputSelect();
document.querySelector('#remove-subinput').onclick=()=>window.ztools.removeSubInput();
window.parent.postMessage({kind:'navigation-plugin-ready'},'*');
</script>"#).map_err(|error|error.to_string())?;

    let config = AppConfig::with_base_dir(root.join("app-data"));
    config.ensure_dirs().map_err(|error| error.to_string())?;
    let db = Arc::new(
        Database::open(&root.join("navigation.sqlite")).map_err(|error| error.to_string())?,
    );
    db.set_setting(
        "settings-general",
        &json!({"autoPaste":"never","localAppSearch":false,"pluginEscapeToSearch":false})
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
    context.config_mut().identifier = format!(
        "dev.atools.plugin-navigation.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let app=tauri::Builder::default().plugin(tauri_plugin_fs::init())
        .manage(state).manage(NavigationFixture{root:root.clone(),token}).manage(NavigationReport(sender))
        .manage(super::panel_perf::PanelPerformance::default())
        .invoke_handler(tauri::generate_handler![native_navigation_fixture,native_navigation_report,native_navigation_runtime_state,
            super::panel_perf::native_panel_perf_snapshot,super::panel_perf::native_panel_perf_phase,super::panel_perf::native_panel_perf_quiet_window,
            crate::commands::import_ztools_plugins,crate::commands::feature_catalog,crate::commands::search_features,
            crate::commands::activate_feature,crate::commands::get_setting,crate::commands::expand_window,crate::commands::reset_window,
            crate::commands::list_pending_agent_requests,crate::commands::get_task_run,crate::commands::dismiss_pending_agent_request,
            crate::commands::call_agent_tool,crate::commands::grant_agent_tool,
            crate::plugin_display_runtime::commands::prepare_plugin_display,
            crate::plugin_display_runtime::commands::get_plugin_display_session,
            crate::plugin_display_runtime::commands::close_plugin_display,
            crate::plugin_display_runtime::commands::rotate_plugin_display,
            crate::host_runtime::commands::prepare_host_clipboard,crate::host_runtime::commands::get_host_clipboard_session,
            crate::host_runtime::commands::close_host_clipboard,crate::host_runtime::commands::rotate_host_clipboard,
            crate::legacy_runtime::commands::prepare_legacy_node,crate::legacy_runtime::commands::get_legacy_node_session,
            crate::legacy_runtime::commands::close_legacy_node,crate::legacy_runtime::permission_context::get_permission_request_context,
            crate::plugin_resources::read_plugin_preload_module])
        .register_uri_scheme_protocol("atools-navigation",move|_,request|{
            let(mime,body)=match request.uri().path(){"/panel.js"=>("text/javascript",script.clone()),"/panel.css"=>("text/css",css.clone()),"/"=>("text/html",br#"<!doctype html><meta charset="utf-8"><script>if(window===window.top){window.addEventListener('error',e=>window.__TAURI__.core.invoke('native_navigation_report',{report:{passed:false,error:String(e.message),file:e.filename,line:e.lineno}}));window.addEventListener('unhandledrejection',e=>window.__TAURI__.core.invoke('native_navigation_report',{report:{passed:false,error:String(e.reason)}}));}</script><link rel="stylesheet" href="atools-navigation://localhost/panel.css"><div id="app"></div><script src="atools-navigation://localhost/panel.js"></script>"#.to_vec()),_=>("text/plain",Vec::new())};
            let status=if matches!(request.uri().path(),"/"|"/panel.js"|"/panel.css"){200}else{404};tauri::http::Response::builder().status(status).header("content-type",mime).body(body).unwrap()})
        .setup(move|app|{
            crate::legacy_runtime::install_manager(app.handle());
            crate::plugin_display_runtime::install_manager(app.handle());
            #[cfg(target_os="macos")]crate::host_runtime::install_isolated_manager(app.handle());
            app.fs_scope().allow_directory(&root,true)?;app.asset_protocol_scope().allow_directory(&root,true)?;
            app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-plugin-navigation").window("main")
                .remote("atools-navigation://localhost/*".into()).permission("core:event:allow-listen")
                .permission("core:event:allow-unlisten").permission("fs:allow-read-text-file"))?;
            WebviewWindowBuilder::new(app,"main",WebviewUrl::CustomProtocol("atools-navigation://localhost/".parse().unwrap()))
                .title("ATools synthetic plugin navigation acceptance").always_on_top(true)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled).inner_size(800.0,600.0)
                .incognito(true).data_directory(root.join("webview")).initialization_script_for_all_frames(probe).build()?;
            crate::window::show_main_window_for_startup(app.handle())?;let app=app.handle().clone();
            tauri::async_runtime::spawn(async move{
                let result=tokio::time::timeout(std::time::Duration::from_secs(90),receiver).await;
                let mut report=match result{Ok(Ok(value))=>value,_=>json!({"passed":false,"error":"Synthetic navigation report timed out"})};
                let runtime=app.state::<Arc<crate::legacy_runtime::Sessions>>();runtime.stop_all().await;
                crate::plugin_display_runtime::stop(&app).await;
                if let Ok(host)=crate::host_runtime::manager(&app){host.close(None,None,true).await;}
                let runs=db.list_task_runs(1000).unwrap_or_default();report["taskRuns"]=json!(runs.len());
                report["allTaskRunsTerminal"]=json!(runs.iter().all(|run|run.status.is_terminal()));
                report["runtimeStateAtFinalClose"]=native_navigation_state_value(&app).await;
                report["scope"]=json!("Synthetic pure-Web plugin only, real Tauri IPC and production App/PluginPanel on macOS Wry; backgroundServices=false");
                report["limitations"]=json!(["No original or community plugin code imported/executed","Synthetic pure-Web package has no preload; runtime zero counters do not prove absence of arbitrary OS processes","Custom protocol/CSP and minimal command registration; no release binary, physical hotkey, or unmodified idle-service budget claim","One macOS Wry run; no multi-platform coverage"]);
                let success=report["passed"]==true&&report["allTaskRunsTerminal"]==true;report["passed"]=json!(success);passed.store(success,Ordering::Release);
                if let Some(parent)=output.parent(){let _=std::fs::create_dir_all(parent);}let _=std::fs::write(&output,serde_json::to_vec_pretty(&report).unwrap());app.exit(if success{0}else{1});
            });Ok(())
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
        Err("Synthetic plugin navigation acceptance failed; inspect fixture report".into())
    }
}

async fn native_navigation_state_value(app: &tauri::AppHandle) -> Value {
    let runtime = app.state::<Arc<crate::legacy_runtime::Sessions>>();
    let sessions = runtime.sessions.read().len();
    let openings = runtime.openings.lock().len();
    let transport = runtime.server.lock().await.is_some();
    let host = crate::host_runtime::manager(app).expect("isolated host manager installed");
    let (host_sessions, host_intents, host_invocations) = {
        let store = host.store.lock();
        (
            store.sessions.len(),
            store.intents.len(),
            store.invocations.len(),
        )
    };
    let host_transport = host.server.lock().await.is_some();
    json!({"legacySessions":sessions,"legacyOpenings":openings,"legacyTransport":transport,"hostSessions":host_sessions,
        "hostIntents":host_intents,"hostInvocations":host_invocations,"hostTransport":host_transport})
}
