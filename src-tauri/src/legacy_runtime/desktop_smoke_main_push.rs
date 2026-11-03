//! Actual App + native MainPush pipeline, using private profiles and untouched originals.
#[path = "desktop_smoke_main_push_evidence.rs"]
mod evidence;
#[path = "desktop_smoke_main_push_progress.rs"]
mod progress;
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

struct Fixture {
    token: String,
    db: Arc<Database>,
    app_data: PathBuf,
}
struct Report(Mutex<Option<tokio::sync::oneshot::Sender<Value>>>);

#[tauri::command]
fn native_main_push_fixture(app: tauri::AppHandle) -> Result<Value, String> {
    app.state::<progress::Progress>()
        .record("fixture-requested")?;
    let fixture = app.state::<Fixture>();
    let plugins = fixture.db.list_plugins().map_err(|e| e.to_string())?;
    let capabilities = plugins
        .iter()
        .map(|p| {
            let paths = crate::plugin_system_paths::registry::tool_name(
                &p.id,
                crate::plugin_system_paths::registry::Access::Standard,
            );
            json!({"id":p.id,"title":p.display_name(),
            "mainPush":crate::plugin_main_push::registry::tool_name(&p.id),
            "node":crate::legacy_runtime::registry::tool_name(&p.id),
            "data":crate::plugin_data_runtime::registry::tool_name(&p.id),"paths":paths})
        })
        .collect::<Vec<_>>();
    Ok(json!({"token":fixture.token,"capabilities":capabilities,
        "privateQuery":evidence::PRIVATE_QUERY,"appData":fixture.app_data,
        "scope":"Actual production commands/managers; programmatic fixture UI, no physical-input claim"}))
}

#[tauri::command]
fn native_main_push_report(app: tauri::AppHandle, report: Value) -> Result<(), String> {
    if serde_json::to_vec(&report)
        .map_err(|e| e.to_string())?
        .len()
        > 2 * 1024 * 1024
    {
        return Err("Native MainPush report exceeds fixture budget".into());
    }
    if let Some(sender) = app.state::<Report>().0.lock().take() {
        app.state::<progress::Progress>().finish();
        sender
            .send(report)
            .map_err(|_| "Native MainPush report receiver closed")?;
    }
    Ok(())
}

#[tauri::command]
async fn native_main_push_state(app: tauri::AppHandle) -> Value {
    evidence::snapshot(&app).await
}

fn fixture_bookmarks(root: &std::path::Path) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("Missing isolated HOME")?;
    let app_data = dirs::config_dir().ok_or("Missing isolated appData")?;
    let environment_root = root.parent().ok_or("Missing fixture environment parent")?;
    // Fail before reading or writing any browser profile if macOS ignores the isolated HOME.
    if !home.starts_with(environment_root) || !app_data.starts_with(&home) {
        return Err("Resolved appData is outside the explicitly isolated environment".into());
    }
    for (browser, title) in [
        ("Google/Chrome", "Chrome fixture-needle"),
        ("Microsoft Edge", "Edge fixture-needle"),
    ] {
        let folder = app_data.join(browser).join("Default");
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let content = json!({"roots":{"bookmark_bar":{"type":"folder","name":"Fixture","children":[{
            "type":"url","name":title,"url":"https://atools-fixture.invalid/fixed","id":"1"
        }]},"other":{"type":"folder","children":[]},"synced":{"type":"folder","children":[]}},"version":1});
        std::fs::write(folder.join("Bookmarks"), content.to_string()).map_err(|e| e.to_string())?;
    }
    Ok(app_data)
}

pub(super) fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Native MainPush fixture currently targets macOS".into());
    }
    let args = std::env::args().collect::<Vec<_>>();
    let path = |flag: &str| {
        args.windows(2)
            .find(|p| p[0] == flag)
            .map(|p| PathBuf::from(&p[1]))
            .filter(|p| p.is_absolute())
            .ok_or_else(|| format!("Missing absolute {flag}"))
    };
    let root = path("--fixture-root")?;
    std::fs::create_dir(&root).map_err(|e| e.to_string())?;
    let cleanup = Cleanup(root.clone());
    let output = path("--output")?;
    if output.exists() || output.starts_with(&root) {
        return Err("Use a fresh report outside disposable data".into());
    }
    let script = std::fs::read(path("--main-push-ui")?).map_err(|e| e.to_string())?;
    let css = std::fs::read(path("--main-push-css")?).map_err(|e| e.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let probe = std::fs::read_to_string(path("--main-push-probe")?)
        .map_err(|e| e.to_string())?
        .replace("__ATOOLS_MAIN_PUSH_TOKEN__", &token);
    let config = AppConfig::with_base_dir(root.join("app-data"));
    config.ensure_dirs().map_err(|e| e.to_string())?;
    let db = Arc::new(Database::open(&root.join("smoke.sqlite")).map_err(|e| e.to_string())?);
    let cohort = path("--plugin-root")?;
    let sources = ["calculation-paper", "bookmarks", "main-push-fixture"]
        .map(|id| cohort.join(id).to_string_lossy().into_owned());
    let imported =
        crate::ztools_import::import_ztools_plugins(&db, &config.plugins_dir(), &sources, false)?;
    if imported.imported.len() != 3 || !imported.failed.is_empty() || !imported.skipped.is_empty() {
        return Err(format!(
            "MainPush original/synthetic import failed: {imported:?}"
        ));
    }
    let app_data = fixture_bookmarks(&root)?;
    db.set_setting(
        "settings-general",
        &json!({"autoPaste":"never","localAppSearch":false,
        "localLaunchSearch":false,"pluginEscapeToSearch":true})
        .to_string(),
    )
    .map_err(|e| e.to_string())?;
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard),
        db.clone(),
        &config,
    )?);
    let state = AppState::new(config, db.clone(), None, pasteboard);
    let (sender, receiver) = tokio::sync::oneshot::channel::<Value>();
    let passed = Arc::new(AtomicBool::new(false));
    let passed_after = passed.clone();
    let report_path = output.clone();
    let cleanup_path = root.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.main-push-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = None;
    let app = crate::plugin_asset_protocol::register(tauri::Builder::default())
        .plugin(tauri_plugin_fs::init()).manage(state)
        .manage(Fixture{token,db:db.clone(),app_data}).manage(Report(Mutex::new(Some(sender))))
        .manage(progress::Progress::new(output.clone()))
        .invoke_handler(tauri::generate_handler![
            native_main_push_fixture,native_main_push_report,native_main_push_state,
            progress::native_main_push_phase,
            crate::plugin_main_push::commands::search_plugin_main_push_candidates,
            crate::plugin_main_push::commands::run_plugin_main_push,
            crate::plugin_main_push::commands::complete_plugin_main_push,
            crate::plugin_main_push::commands::cancel_plugin_main_push,
            crate::plugin_main_push::commands::set_plugin_main_push_waiting,
            crate::plugin_main_push::commands::close_plugin_main_push_runner,
            crate::commands::feature_catalog,crate::commands::search_features,crate::commands::activate_feature,
            crate::commands::get_setting,crate::commands::set_setting,crate::commands::expand_window,crate::commands::reset_window,
            crate::commands::list_pending_agent_requests,crate::commands::get_task_run,crate::commands::list_task_runs,
            crate::commands::dismiss_pending_agent_request,crate::commands::call_agent_tool,
            crate::commands::grant_agent_tool,crate::commands::revoke_agent_tool,crate::commands::toggle_plugin,
            crate::legacy_runtime::commands::prepare_legacy_node,crate::legacy_runtime::commands::get_legacy_node_session,
            crate::legacy_runtime::commands::close_legacy_node,crate::legacy_runtime::commands::plugin_legacy_node_usage,
            crate::legacy_runtime::permission_context::get_permission_request_context,
            crate::plugin_resources::read_plugin_preload_module,
            crate::plugin_asset_protocol::prepare_plugin_resources,crate::plugin_asset_protocol::close_plugin_resources,
            crate::plugin_data_runtime::commands::prepare_plugin_data,crate::plugin_data_runtime::commands::get_plugin_data_session,
            crate::plugin_data_runtime::commands::close_plugin_data,crate::plugin_data_runtime::commands::rotate_plugin_data,
            crate::plugin_system_paths::commands::prepare_plugin_paths,crate::plugin_system_paths::commands::get_plugin_path_snapshot,
            crate::plugin_system_paths::commands::close_plugin_paths,crate::plugin_system_paths::commands::rotate_plugin_paths,
            crate::plugin_dialog_runtime::commands::prepare_plugin_dialogs,crate::plugin_dialog_runtime::commands::get_plugin_dialog_session,
            crate::plugin_dialog_runtime::commands::close_plugin_dialogs,crate::plugin_dialog_runtime::commands::rotate_plugin_dialogs,
            crate::plugin_display_runtime::commands::prepare_plugin_display,
            crate::plugin_display_runtime::commands::get_plugin_display_session,
            crate::plugin_display_runtime::commands::close_plugin_display,
            crate::plugin_display_runtime::commands::rotate_plugin_display,
            crate::host_runtime::commands::prepare_host_clipboard,crate::host_runtime::commands::get_host_clipboard_session,
            crate::host_runtime::commands::close_host_clipboard,crate::host_runtime::commands::rotate_host_clipboard,
        ])
        .register_uri_scheme_protocol("atools-main-push",move|_,request|{
            let (mime,body) = match request.uri().path() {
                "/panel.js" => ("text/javascript",script.clone()),
                "/panel.css" => ("text/css",css.clone()),
                "/" => ("text/html",br#"<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="atools-main-push://localhost/panel.css"><div id="app"></div><script src="atools-main-push://localhost/panel.js"></script>"#.to_vec()),
                _ => ("text/plain",Vec::new()),
            };
            tauri::http::Response::builder().status(if body.is_empty(){404}else{200})
                .header("content-type",mime).body(body).unwrap()
        })
        .on_window_event(|window,event|{
            if matches!(event,tauri::WindowEvent::CloseRequested{..}) {
                let _ = window.app_handle().state::<progress::Progress>().record("window-close-requested");
            }
            if matches!(event,tauri::WindowEvent::Destroyed) {
                let _ = window.app_handle().state::<progress::Progress>().record("window-destroyed");
                crate::plugin_main_push::close_window(window.app_handle(),window.label());
                crate::plugin_asset_protocol::close_window(window.app_handle(),window.label());
            }
        })
        .setup(move|app|{
            crate::legacy_runtime::install_manager(app.handle());
            crate::plugin_display_runtime::install_manager(app.handle());
            crate::plugin_main_push::install_manager(app.handle());
            crate::plugin_data_runtime::install_manager(app.handle());
            crate::plugin_system_paths::install_manager(app.handle());
            crate::plugin_dialog_runtime::install_manager(app.handle());
            #[cfg(target_os="macos")] crate::host_runtime::install_isolated_manager(app.handle());
            app.fs_scope().allow_directory(&root,true)?;
            app.asset_protocol_scope().allow_directory(&root,true)?;
            app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-main-push")
                .window("main").remote("atools-main-push://localhost/*".into())
                .permission("core:event:allow-listen").permission("core:event:allow-unlisten")
                .permission("fs:allow-read-text-file"))?;
            WebviewWindowBuilder::new(app,"main",WebviewUrl::CustomProtocol("atools-main-push://localhost/".parse().unwrap()))
                .title("ATools isolated MainPush acceptance").always_on_top(true)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .inner_size(900.0,680.0).incognito(true).data_directory(root.join("webview"))
                .initialization_script_for_all_frames(probe).build()?;
            crate::window::show_main_window_for_startup(app.handle())?;
            app.state::<progress::Progress>().record("window-created")?;
            let app = app.handle().clone();
            tauri::async_runtime::spawn(async move{
                let received = tokio::time::timeout(std::time::Duration::from_secs(180),receiver).await;
                let mut report = match received { Ok(Ok(value))=>value,
                    _=>json!({"passed":false,"error":"Native MainPush frontend report missing or timed out"}) };
                report["phases"] = app.state::<progress::Progress>().finish();
                // Preserve a report even if a later resource shutdown fails.
                report["cleanupComplete"] = json!(false);
                let _ = std::fs::write(&output,serde_json::to_vec_pretty(&report).unwrap());
                eprintln!("[main-push-smoke] native-shutdown-start");
                let shutdown = tokio::time::timeout(std::time::Duration::from_secs(20),evidence::shutdown(&app,&db)).await;
                let cleanup_complete = shutdown.is_ok();
                let final_state = shutdown.unwrap_or_else(|_|json!({"error":"Native resource shutdown exceeded twenty seconds","stateVerified":false}));
                eprintln!("[main-push-smoke] native-shutdown-complete");
                let drained = evidence::drained(&final_state);
                report["runtimeAfterCleanup"] = final_state;
                report["runtimeDrained"] = json!(drained);
                let durable = evidence::durable(&db);
                let durable_ok = durable.as_ref().is_ok_and(|v| v["count"].as_u64().is_some_and(|n|n>0)
                    && v["allTerminal"]==true && v["privateQueryAndBookmarkFieldsAbsent"]==true
                    && v["auditCount"].as_u64().is_some_and(|n|n>0)
                    && v["auditPrivateFieldsAbsent"]==true && v["boundedInventoryComplete"]==true);
                report["durable"] = durable.unwrap_or_else(|e|json!({"error":e}));
                let success = report["passed"]==true && drained && durable_ok;
                report["passed"] = json!(success);
                report["cleanupComplete"] = json!(cleanup_complete);
                let wrote = std::fs::write(&output,serde_json::to_vec_pretty(&report).unwrap()).is_ok();
                passed.store(success && wrote,Ordering::Release);
                app.exit(if success && wrote{0}else{1});
            });
            Ok(())
        }).build(context).map_err(|e|e.to_string())?;
    app.run_return(|handle, event| match event {
        tauri::RunEvent::ExitRequested { code, .. } => {
            eprintln!("[main-push-smoke] event-exit-requested code={code:?}");
            let _ = handle
                .state::<progress::Progress>()
                .record("event-exit-requested");
        }
        tauri::RunEvent::Exit => {
            let _ = handle.state::<progress::Progress>().record("event-exit");
        }
        _ => {}
    });
    drop(cleanup);
    let removed = !cleanup_path.exists();
    let mut report = std::fs::read(&report_path).ok().and_then(|b|serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or_else(||json!({"passed":false,"error":"Native event loop exited before any fixture report","cleanupComplete":false}));
    report["temporaryDataRemoved"] = json!(removed);
    if !removed {
        report["passed"] = json!(false);
    }
    std::fs::write(&report_path, serde_json::to_vec_pretty(&report).unwrap())
        .map_err(|e| e.to_string())?;
    if passed_after.load(Ordering::Acquire) && removed {
        Ok(())
    } else {
        Err("Native MainPush fixture failed; inspect its report".into())
    }
}
