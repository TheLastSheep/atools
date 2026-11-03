//! Opt-in native acceptance for one explicitly selected published package.
use super::{Cleanup, NoClipboard};
use crate::{pasteboard_runtime::PasteboardRuntime, state::AppState};
use atools_core::{AppConfig, Database};
use parking_lot::Mutex;
use serde_json::{json, Value};
#[path = "desktop_smoke_published_data.rs"]
mod data_evidence;
#[path = "desktop_smoke_deepread_fixture.rs"]
mod deepread_fixture;
#[path = "desktop_smoke_image_stitch_fixture.rs"]
mod image_stitch_fixture;
#[path = "desktop_smoke_published_lifecycle.rs"]
mod lifecycle;
#[path = "published_package_verification.rs"]
mod package_verification;
#[path = "desktop_smoke_published_paths.rs"]
mod path_evidence;
#[path = "desktop_smoke_published_reporting.rs"]
mod reporting;
#[path = "desktop_smoke_published_shutdown.rs"]
mod shutdown;
use package_verification::read_bounded_regular;
#[path = "desktop_smoke_editor_input_exchange.rs"]
mod editor_input_exchange;
#[path = "published_fixture_profile.rs"]
mod fixture_profile;
use fixture_profile::profile_digest;
#[path = "converted_handoff_arguments.rs"]
mod converted_handoff_arguments;
#[path = "converted_handoff_host.rs"]
mod converted_handoff_host;
#[path = "converted_handoff_verification.rs"]
mod converted_handoff_verification;
#[path = "converted_source_evidence_verification.rs"]
mod converted_source_evidence_verification;
#[path = "desktop_smoke_published_fixture_metadata.rs"]
mod fixture_metadata;
#[path = "published_fixture_root.rs"]
mod published_fixture_root;
use converted_handoff_verification::{
    fixture_metadata as converted_handoff_metadata, VerifiedHandoff,
};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

struct PublishedFixture {
    plugin_root: PathBuf,
    package_import_path: PathBuf,
    asset_probe_path: PathBuf,
    token: String,
    run_id: String,
    profile: Value,
    downloads: Option<PathBuf>,
    worker_contract_only: bool,
    native_ui_input: bool,
    require_foreground: bool,
    deepread_text_encoding: deepread_fixture::TextEncoding,
    converted_handoff: Option<VerifiedHandoff>,
    converted_import_proof: Arc<Mutex<Option<converted_handoff_host::ConvertedImportProof>>>,
}
fn published_data_snapshot(db: &Database, profile: &Value) -> Result<Value, String> {
    data_evidence::snapshot(db, profile)
}

#[tauri::command]
fn native_published_data_snapshot(app: tauri::AppHandle) -> Result<Value, String> {
    let fixture = app.state::<PublishedFixture>();
    let state = app.state::<AppState>();
    published_data_snapshot(&state.db, &fixture.profile)
}

fn published_data_audit(db: &Database, profile: &Value) -> Result<Value, String> {
    data_evidence::audit(db, profile)
}

#[tauri::command]
fn native_published_data_audit(app: tauri::AppHandle) -> Result<Value, String> {
    published_data_audit(
        &app.state::<AppState>().db,
        &app.state::<PublishedFixture>().profile,
    )
}

#[tauri::command]
fn native_published_path_evidence(app: tauri::AppHandle) -> Result<Value, String> {
    let fixture = app.state::<PublishedFixture>();
    path_evidence::evidence(
        &app.state::<AppState>().db,
        &fixture.profile,
        fixture.downloads.as_deref(),
    )
}

#[tauri::command]
fn native_published_deepread_fixture(app: tauri::AppHandle) -> Result<Value, String> {
    let fixture = app.state::<PublishedFixture>();
    if fixture.profile["caseId"] != deepread_fixture::CASE_ID {
        return Err("DeepRead input is unavailable for this fixture".into());
    }
    let downloads = fixture
        .downloads
        .as_deref()
        .ok_or("Private DeepRead Downloads were not prepared")?;
    let path = downloads.join(deepread_fixture::FILE_NAME);
    let mut evidence =
        deepread_fixture::evidence(&path, &fixture.profile, fixture.deepread_text_encoding)?;
    evidence["path"] = json!(path.to_string_lossy());
    Ok(evidence)
}

#[tauri::command]
fn native_published_image_stitch_fixture(app: tauri::AppHandle) -> Result<Value, String> {
    let fixture = app.state::<PublishedFixture>();
    path_evidence::image_stitch_fixture(
        &fixture.profile,
        fixture.downloads.as_deref(),
        &fixture.run_id,
    )
}

#[tauri::command]
async fn native_published_runtime_state(app: tauri::AppHandle) -> Value {
    native_published_state(&app).await
}

#[tauri::command]
fn native_published_resource_sessions(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let fixture = app.state::<PublishedFixture>();
    let state = app.state::<AppState>();
    let plugin_id = fixture.profile["id"]
        .as_str()
        .ok_or("Missing fixture plugin")?;
    let expected_root = std::fs::canonicalize(state.config.plugins_dir().join(plugin_id))
        .map_err(|_| "Expected installed fixture package is unavailable")?;
    crate::plugin_asset_protocol::resource_sessions_for_package(
        &app,
        "main",
        plugin_id,
        &expected_root,
    )
}

fn arg_path(args: &[String], flag: &str) -> Result<PathBuf, String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| PathBuf::from(&pair[1]))
        .filter(|path| path.is_absolute())
        .ok_or_else(|| format!("Missing absolute {flag}"))
}

fn arg_value<'a>(args: &'a [String], flag: &str) -> Result<&'a str, String> {
    args.windows(2)
        .find(|pair| pair[0] == flag)
        .map(|pair| pair[1].as_str())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing {flag}"))
}

fn parse_require_foreground(
    args: &[String],
    explicit_reviewed: bool,
    worker: bool,
    native_ui_input: bool,
) -> Result<bool, String> {
    let positions: Vec<_> = args
        .iter()
        .enumerate()
        .filter(|(_, arg)| arg.as_str() == "--require-foreground")
        .map(|(i, _)| i)
        .collect();
    if positions.len() > 1
        || args
            .iter()
            .any(|arg| arg.starts_with("--require-foreground="))
    {
        return Err("Foreground opt-in is duplicated or malformed".into());
    }
    let Some(index) = positions.first().copied() else {
        return Ok(false);
    };
    if args
        .get(index + 1)
        .is_some_and(|value| !value.starts_with("--"))
    {
        return Err("Foreground opt-in does not accept a value".into());
    }
    if !explicit_reviewed || worker || native_ui_input {
        return Err("Foreground preconditions require reviewed UI execution without worker or native input modes".into());
    }
    Ok(true)
}

const CSP: &str = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: asset://localhost atools-plugin://localhost; style-src 'self' 'unsafe-inline' data: blob: atools-plugin://localhost; img-src 'self' data: blob: asset://localhost atools-plugin://localhost; font-src 'self' data: asset://localhost atools-plugin://localhost; connect-src 'self' ipc://localhost atools-published://localhost atools-plugin://localhost http://127.0.0.1:*; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";

pub fn run() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Published-plugin native fixture targets macOS only".into());
    }
    let args: Vec<_> = std::env::args().collect();
    let converted_args = converted_handoff_arguments::validate(&args)?;
    if converted_args.is_none() && !args.iter().any(|arg| arg == "--execute-reviewed-package") {
        return Err("Native execution requires explicit reviewed-package opt-in".into());
    }
    let case_id = if let Some(parsed) = &converted_args {
        parsed.case_id.as_str()
    } else {
        arg_value(&args, "--published-case")?
    };
    let worker_contract_only = args.iter().any(|arg| arg == "--worker-contract-only");
    let native_ui_input = args.iter().any(|arg| arg == "--native-ui-input");
    let require_foreground = parse_require_foreground(
        &args,
        args.iter().any(|arg| arg == "--execute-reviewed-package"),
        worker_contract_only,
        native_ui_input,
    )?;
    if worker_contract_only && case_id != "local-json-editor" {
        return Err("Worker contract mode requires the registered JSON Editor case".into());
    }
    if native_ui_input
        && (!matches!(case_id, "local-json-editor" | "local-plain-text") || worker_contract_only)
    {
        return Err(
            "Native UI input requires a registered editor and excludes worker-only mode".into(),
        );
    }
    let run_id = arg_value(&args, "--run-id")?.to_string();
    uuid::Uuid::parse_str(&run_id).map_err(|e| e.to_string())?;
    let requested_root = arg_path(&args, "--fixture-root")?;
    std::fs::create_dir(&requested_root).map_err(|e| e.to_string())?;
    let mut cleanup = Cleanup(requested_root.clone());
    let root = published_fixture_root::canonicalize_created_root(&requested_root)?;
    cleanup.0 = root.clone();
    let output = arg_path(&args, "--output")?;
    let prepared_source = converted_handoff_host::prepare_source(&args, case_id, &root)?;
    let deepread_text_encoding = prepared_source.deepread_text_encoding;
    let plugin_root = prepared_source.plugin_root;
    let package_import_path = prepared_source.package_import_path;
    let profile = prepared_source.profile;
    let downloads = prepared_source.downloads;
    let source_verification = prepared_source.source_verification;
    let converted_handoff = prepared_source.converted_handoff;
    let asset_probe_path = root.join("asset-probe.js");
    std::fs::write(&asset_probe_path, r#"(function(){var node=document.getElementById('asset-probe-root');window.parent.postMessage({kind:'atools-asset-defer-result',rootFound:!!node,rootText:node&&node.textContent||'',readyState:document.readyState,origin:location.origin},'*')})();"#).map_err(|e|e.to_string())?;
    let script = read_bounded_regular(
        &arg_path(&args, "--panel-ui")?,
        package_verification::MAX_PANEL_JS_BYTES,
    )?;
    let css = read_bounded_regular(
        &arg_path(&args, "--panel-css")?,
        package_verification::MAX_PANEL_CSS_BYTES,
    )?;
    let token = uuid::Uuid::new_v4().to_string();
    let probe = String::from_utf8(read_bounded_regular(
        &arg_path(&args, "--panel-probe")?,
        package_verification::MAX_PROBE_BYTES,
    )?)
    .map_err(|e| e.to_string())?
    .replace("__ATOOLS_PUBLISHED_TOKEN__", &token)
    .replace("__ATOOLS_PUBLISHED_CASE_ID__", case_id);
    let config = AppConfig::with_base_dir(root.join("app-data"));
    config.ensure_dirs().map_err(|e| e.to_string())?;
    let db = Arc::new(Database::open(&root.join("published.sqlite")).map_err(|e| e.to_string())?);
    db.set_setting(
        "settings-general",
        &json!({"autoPaste":"never","localAppSearch":false,"localLaunchSearch":false,
        "aiProvider":"disabled","aiDefaultModel":"","aiApiKey":"","pluginEscapeToSearch":true})
        .to_string(),
    )
    .map_err(|e| e.to_string())?;
    let pasteboard = Arc::new(PasteboardRuntime::new(
        Arc::new(NoClipboard),
        db.clone(),
        &config,
    )?);
    let installed_plugin_root =
        std::fs::canonicalize(config.plugins_dir()).map_err(|error| error.to_string())?;
    let probe = probe.replace(
        "\"__ATOOLS_EXPECTED_WORKER_ASSET_ROOT__\"",
        &serde_json::to_string(&format!(
            "asset://localhost/{}",
            installed_plugin_root
                .join(profile["id"].as_str().ok_or("Missing fixture plugin")?)
                .display()
        ))
        .map_err(|error| error.to_string())?,
    );
    let state = AppState::new(config, db.clone(), None, pasteboard);
    let (sender, receiver) = tokio::sync::oneshot::channel::<Value>();
    let passed = Arc::new(AtomicBool::new(false));
    let passed_after = passed.clone();
    let foreground = super::panel_foreground::PanelForeground::from_environment()?;
    if require_foreground && foreground.mode() != "foreground" {
        return Err(
            "Foreground opt-in requires the fixture's required native foreground mode".into(),
        );
    }
    let editor_exchange = editor_input_exchange::Exchange::from_environment(
        native_ui_input,
        profile["caseId"].as_str().unwrap_or(""),
    )?;
    let startup_diagnostics = Arc::new(if case_id == "converted-deepread-source" {
        let identity = converted_handoff.as_ref().map(|handoff| {
            crate::legacy_runtime::native_node_startup_fixture::StartupDiagnosticHandoffIdentity {
                case_id: handoff.case_id.clone(),
                source_case_id: handoff.producer_source_case_id.clone(),
                plugin_id: handoff.plugin_id.clone(),
                plugin_version: handoff.plugin_version.clone(),
                artifact_kind: handoff.artifact_kind.clone(),
                handoff_status: handoff.handoff_status.clone(),
                native_ui_consumer_supported: handoff.native_ui_consumer_supported,
                manifest_sha256: handoff.manifest_sha256.clone(),
                installed_package_tree_sha256: handoff.installed_package_tree_sha256.clone(),
            }
        });
        crate::legacy_runtime::native_node_startup_fixture::NativeNodeStartupFixture::new_converted_deepread(
            &profile, &run_id, identity.as_ref(),
        )
    } else {
        crate::legacy_runtime::native_node_startup_fixture::NativeNodeStartupFixture::new(
            &profile,
            &run_id,
            native_ui_input,
            worker_contract_only,
        )
    });
    let cleanup_path = root.clone();
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = format!(
        "dev.atools.published-plugin.{}",
        uuid::Uuid::new_v4().simple()
    );
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy(CSP.into()));
    let lifecycle = Arc::new(lifecycle::Lifecycle::new(
        output.clone(),
        json!({"runId":run_id,
        "profile":profile,"packageSha256":profile_digest(&profile),
        "executionMode":if worker_contract_only {"original_worker_contract"} else {"original_ui"}}),
    ));
    let _ = lifecycle.phase("native-configured");
    let app=crate::plugin_asset_protocol::register(tauri::Builder::default()).plugin(tauri_plugin_fs::init()).manage(state).manage(crate::general_settings_runtime::GeneralSettingsCoordinator::default())
        .manage(PublishedFixture{plugin_root:plugin_root.clone(),package_import_path,asset_probe_path,token,run_id,profile,downloads,worker_contract_only,native_ui_input,require_foreground,deepread_text_encoding,converted_handoff,converted_import_proof:Arc::new(Mutex::new(None))})
        .manage(startup_diagnostics.clone())
        .manage(reporting::PublishedReport(Arc::new(Mutex::new(Some(sender))))).manage(foreground).manage(lifecycle.clone()).manage(editor_exchange)
        .invoke_handler(tauri::generate_handler![lifecycle::native_published_phase,fixture_metadata::native_published_fixture,converted_handoff_host::native_published_import_converted_handoff,reporting::native_published_report,native_published_runtime_state,native_published_resource_sessions,native_published_data_snapshot,native_published_data_audit,native_published_path_evidence,native_published_deepread_fixture,native_published_image_stitch_fixture,converted_handoff_host::native_published_installed_package,
            super::panel_foreground::native_panel_foreground,
            editor_input_exchange::native_editor_input_exchange,
            crate::commands::import_ztools_plugins,crate::commands::list_plugins,crate::commands::toggle_plugin,crate::commands::feature_catalog,crate::commands::search_features,
            crate::launcher_media::activate_file_content_feature,crate::commands::activate_feature,crate::commands::get_setting,crate::general_settings_runtime::commands::save_general_settings,crate::commands::system_get_path,crate::commands::expand_window,crate::commands::reset_window,
            crate::commands::list_pending_agent_requests,crate::commands::get_task_run,crate::commands::list_task_runs,crate::commands::dismiss_pending_agent_request,
            crate::commands::call_agent_tool,crate::commands::grant_agent_tool,crate::commands::revoke_agent_tool,
            crate::plugin_display_runtime::commands::prepare_plugin_display,
            crate::plugin_display_runtime::commands::get_plugin_display_session,
            crate::plugin_display_runtime::commands::close_plugin_display,
            crate::plugin_display_runtime::commands::rotate_plugin_display,
            crate::host_runtime::commands::prepare_host_clipboard,crate::host_runtime::commands::get_host_clipboard_session,
            crate::host_runtime::commands::close_host_clipboard,crate::host_runtime::commands::rotate_host_clipboard,
            crate::plugin_data_runtime::commands::prepare_plugin_data,crate::plugin_data_runtime::commands::get_plugin_data_session,
            crate::plugin_data_runtime::commands::close_plugin_data,crate::plugin_data_runtime::commands::rotate_plugin_data,
            crate::plugin_system_paths::commands::prepare_plugin_paths,crate::plugin_system_paths::commands::get_plugin_path_snapshot,
            crate::plugin_system_paths::commands::close_plugin_paths,crate::plugin_system_paths::commands::rotate_plugin_paths,
            crate::plugin_dialog_runtime::commands::prepare_plugin_dialogs,crate::plugin_dialog_runtime::commands::get_plugin_dialog_session,
            crate::plugin_dialog_runtime::commands::close_plugin_dialogs,crate::plugin_dialog_runtime::commands::rotate_plugin_dialogs,
            crate::legacy_runtime::commands::prepare_legacy_node,crate::legacy_runtime::commands::get_legacy_node_session,
            crate::legacy_runtime::commands::close_legacy_node,crate::legacy_runtime::commands::plugin_legacy_node_usage,
            crate::legacy_runtime::permission_context::get_permission_request_context,
            crate::plugin_resources::read_plugin_preload_module,
            crate::plugin_asset_protocol::prepare_plugin_resources,crate::plugin_asset_protocol::close_plugin_resources])
        .register_uri_scheme_protocol("atools-published",move|_,request|{
            let(mime,body)=match request.uri().path(){"/panel.js"=>("text/javascript",script.clone()),"/panel.css"=>("text/css",css.clone()),"/"=>("text/html",br#"<!doctype html><meta charset="utf-8"><div id="app"></div><script src="atools-published://localhost/panel.js"></script>"#.to_vec()),_ =>("text/plain",Vec::new())};
            let status=if matches!(request.uri().path(),"/"|"/panel.js"|"/panel.css"){200}else{404};
            tauri::http::Response::builder().status(status).header("content-type",mime).header("content-security-policy",CSP).body(body).unwrap()})
        .setup(move|app|{
            let _ = app.state::<Arc<lifecycle::Lifecycle>>().phase("native-setup");
            crate::legacy_runtime::install_manager(app.handle());
            crate::plugin_display_runtime::install_manager(app.handle());
            crate::plugin_data_runtime::install_manager(app.handle());
            crate::plugin_system_paths::install_manager(app.handle());
            crate::plugin_dialog_runtime::install_manager(app.handle());
            #[cfg(target_os="macos")]crate::host_runtime::install_isolated_manager(app.handle());
            app.fs_scope().allow_directory(&plugin_root,true)?;
            app.fs_scope().allow_directory(&installed_plugin_root,true)?;
            app.asset_protocol_scope().allow_directory(&plugin_root,true)?;
            app.asset_protocol_scope().allow_directory(&installed_plugin_root,true)?;
            app.asset_protocol_scope().allow_directory(&root,true)?;
            app.add_capability(tauri::ipc::CapabilityBuilder::new("isolated-published-plugin").window("main")
                .remote("atools-published://localhost/*".into()).permission("core:event:allow-listen").permission("core:event:allow-unlisten")
                .permission("fs:allow-read-text-file"))?;
            WebviewWindowBuilder::new(app,"main",WebviewUrl::CustomProtocol("atools-published://localhost/".parse().unwrap()))
                .title("ATools reviewed published plugin acceptance").always_on_top(true)
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                .inner_size(900.0,680.0).incognito(true).data_directory(root.join("webview"))
                .initialization_script_for_all_frames(probe).build()?;
            let _ = app.state::<Arc<lifecycle::Lifecycle>>().phase("native-window-created");
            crate::window::show_main_window_for_startup(app.handle())?;let app=app.handle().clone();let db=db.clone();
            tauri::async_runtime::spawn(async move{
                shutdown::run(app,db,receiver,source_verification,passed).await;
            });Ok(())
        }).on_window_event(|window,event|{
            super::panel_foreground::record_window_event(window.app_handle(),window.label(),event);
            if window.label()=="main" && matches!(event,tauri::WindowEvent::Focused(_)|tauri::WindowEvent::CloseRequested{..}|tauri::WindowEvent::Destroyed) {
                window.app_handle().state::<Arc<lifecycle::Lifecycle>>().foreground(super::panel_foreground::event_snapshot(window.app_handle()));
            }
            if matches!(event,tauri::WindowEvent::Destroyed){crate::plugin_asset_protocol::close_window(window.app_handle(),window.label());crate::plugin_system_paths::close_window(window.app_handle(),window.label());let app=window.app_handle().clone();let label=window.label().to_string();tauri::async_runtime::spawn(async move{crate::plugin_dialog_runtime::close_window(&app,&label).await;crate::plugin_data_runtime::close_window(&app,&label).await;});}})
        .build(context).map_err(|e|{let _=lifecycle.phase("native-build-failed");e.to_string()})?;
    let handle = app.handle().clone();
    let loop_lifecycle = lifecycle.clone();
    let exit_code = app.run_return(move |app, event| {
        match event {
            tauri::RunEvent::ExitRequested { code, .. } => {
                loop_lifecycle.run_event("exit-requested", code)
            }
            tauri::RunEvent::Exit => loop_lifecycle.run_event("exit", None),
            _ => {}
        }
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            crate::plugin_dialog_runtime::stop_on_main_thread(app);
        }
    });
    lifecycle.loop_returned(exit_code);
    let foreground = super::panel_foreground::event_snapshot(&handle);
    drop(cleanup);
    let removed = !cleanup_path.exists();
    let report_passed = lifecycle.after_loop(exit_code, removed, foreground)?;
    if passed_after.load(Ordering::Acquire) && removed && report_passed {
        Ok(())
    } else {
        Err("Published plugin fixture failed; inspect its report".into())
    }
}

async fn native_published_state(app: &tauri::AppHandle) -> Value {
    let legacy = app.state::<Arc<crate::legacy_runtime::Sessions>>();
    let state = app.state::<AppState>();
    let host = crate::host_runtime::manager(app).expect("fixture host manager installed");
    let (sessions, intents, invocations) = {
        let store = host.store.lock();
        (
            store.sessions.len(),
            store.intents.len(),
            store.invocations.len(),
        )
    };
    let mut value = json!({"resourceLeases":crate::plugin_asset_protocol::lease_count(app),"legacySessions":legacy.sessions.read().len(),"legacyOpenings":legacy.openings.lock().len(),
        "legacyTransport":legacy.server.lock().await.is_some(),"pendingRequests":state.pending_agent_requests.lock().len(),
        "hostSessions":sessions,"hostIntents":intents,"hostInvocations":invocations,
        "hostTransport":host.server.lock().await.is_some()});
    if let (Some(target), Some(data)) = (
        value.as_object_mut(),
        crate::plugin_data_runtime::runtime_state(app)
            .await
            .as_object(),
    ) {
        target.extend(data.clone());
    }
    if let (Some(target), Some(paths)) = (
        value.as_object_mut(),
        crate::plugin_system_paths::runtime_state(app).as_object(),
    ) {
        target.extend(paths.clone());
    }
    if let (Some(target), Some(dialogs)) = (
        value.as_object_mut(),
        crate::plugin_dialog_runtime::runtime_state(app)
            .await
            .as_object(),
    ) {
        target.extend(dialogs.clone());
    }
    if let Some(target) = value.as_object_mut() {
        if let Some(display) = crate::plugin_display_runtime::runtime_state(app).as_object() {
            target.extend(display.clone());
        }
        if let Some(diagnostics) = app
            .try_state::<Arc<crate::legacy_runtime::native_node_startup_fixture::NativeNodeStartupFixture>>()
            .and_then(|fixture| fixture.report(&state.db))
        {
            target.insert("nodeStartupDiagnostics".into(), diagnostics);
        }
    }
    value
}

#[cfg(test)]
#[path = "desktop_smoke_published_fixture_tests.rs"]
mod published_fixture_profile_tests;
