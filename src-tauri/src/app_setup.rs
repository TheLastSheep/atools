//! Initialize Tauri-managed runtime state and launch host background services.

use std::sync::Arc;

use atools_api_shim::handler::ApiHandler;
use atools_api_shim::handler_wrapper::ApiHandlerWrapper;
use atools_plugin::ipc_handler::IpcHandler;
use tauri::{Emitter, Manager};

use crate::{
    agent_tools, desktop_smoke, host_runtime, hotkey, legacy_runtime, mcp_server,
    node_runtime_provider, pasteboard_runtime, pasteboard_window, plugin_ai_runtime,
    plugin_background_runtime, plugin_data_runtime, plugin_dialog_runtime, plugin_display_runtime,
    plugin_file_drop, plugin_main_push, plugin_secret_storage_runtime, plugin_system_paths,
    state::AppState, tray, updater, window,
};

const PASTEBOARD_SHELF_SMOKE_ARG: &str = "--atools-pasteboard-shelf-smoke";
const VISUAL_SMOKE_ARG: &str = "--atools-visual-smoke";

pub(super) fn pasteboard_shelf_smoke_enabled() -> bool {
    std::env::args().any(|arg| arg == PASTEBOARD_SHELF_SMOKE_ARG)
        || std::env::var("ATOOLS_PASTEBOARD_SHELF_SMOKE").is_ok_and(|value| value == "1")
}

pub(super) fn visual_smoke_enabled() -> bool {
    std::env::args().any(|arg| arg == VISUAL_SMOKE_ARG)
        || std::env::var("ATOOLS_VISUAL_SMOKE").is_ok_and(|value| value == "1")
}

pub(super) fn setup(app: &mut tauri::App<tauri::Wry>) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(crate::plugin_detach_runtime::PluginDetachRuntime::default());
    let handle = app.handle().clone();
    crate::renderer_updater::initialize(&handle)
        .map_err(|_| std::io::Error::other("Updater state unavailable"))?;
    crate::plugin_browser_window_runtime::install_manager(&handle);
    crate::plugin_browser_window_native::create_main_from_config(app)?;
    let close_needs_recovery = crate::renderer_close_shortcut::setup(&handle).is_err();
    if close_needs_recovery {
        tracing::warn!("Native Close menu requires recovery; opening Main");
    }
    let app_state = app.state::<AppState>();
    app_state
        .inner()
        .record_runtime_event("info", "Tauri setup started");
    #[cfg(target_os = "macos")]
    {
        let login_app = handle.clone();
        tauri::async_runtime::spawn_blocking(move || {
            if let Err(error) =
                crate::general_settings_runtime::login_items::recover_for_startup(&login_app)
            {
                tracing::warn!(error_code = %error, "Login item recovery could not be confirmed at startup");
            }
        });
    }
    let settings_json = app_state
        .inner()
        .db
        .get_setting("settings-general")
        .ok()
        .flatten();
    crate::renderer_window_material::install_configured(&handle, settings_json.as_deref())
        .map_err(std::io::Error::other)?;

    tray::setup_tray(&handle)?;
    crate::renderer_context_menu::setup(&handle);
    let hotkey_needs_recovery = matches!(
        hotkey::setup_hotkey(&handle)?,
        hotkey::MainHotkeyStartup::NeedsRecovery
    );
    crate::app_global_shortcuts::install(&handle);
    if hotkey_needs_recovery {
        tracing::warn!(
            "Main hotkey registration was safely rejected; opening the app for settings recovery"
        );
        app_state
            .inner()
            .record_runtime_event("warning", "Main hotkey requires settings recovery");
    }
    if pasteboard_shelf_smoke_enabled() {
        pasteboard_window::show_pasteboard_shelf(&handle)?;
    }
    if let Err(error) = window::center_main_window(&handle) {
        tracing::error!("Failed to center main window on startup: {}", error);
        app_state
            .inner()
            .record_runtime_event("error", format!("Failed to center main window: {error}"));
    }
    if app_state.inner().release_smoke.lock().is_some()
        || visual_smoke_enabled()
        || hotkey_needs_recovery
        || close_needs_recovery
    {
        window::show_main_window_for_startup(&handle)?;
    }
    let floating_ball_enabled =
        window::floating_ball_enabled_from_settings(settings_json.as_deref());
    let super_panel_enabled = window::super_panel_enabled_from_settings(settings_json.as_deref());
    if let Err(error) = window::set_super_panel_visible(&handle, super_panel_enabled) {
        tracing::error!("Failed to apply super panel setting: {}", error);
        app_state.inner().record_runtime_event(
            "error",
            format!("Failed to apply super panel setting: {error}"),
        );
    }
    if let Err(error) = window::set_floating_ball_visible(&handle, floating_ball_enabled) {
        tracing::error!("Failed to apply floating ball setting: {}", error);
        app_state.inner().record_runtime_event(
            "error",
            format!("Failed to apply floating ball setting: {error}"),
        );
    }

    // Get database reference for API handler
    let db = app_state.inner().db.clone();
    let plugins_dir = app_state.inner().config.plugins_dir();
    if let Err(error) = agent_tools::sync_builtin_tools(&db) {
        tracing::error!("Failed to sync builtin Agent tools: {}", error);
        app_state.inner().record_runtime_event(
            "error",
            format!("Failed to sync builtin Agent tools: {error}"),
        );
    } else {
        app_state
            .inner()
            .record_runtime_event("info", "Builtin Agent tools synced");
    }

    // Create API handler wrapped as IpcHandler
    let api_handler = Arc::new(ApiHandler::new(db, plugins_dir));
    let handler: Arc<dyn IpcHandler + Send + Sync> =
        Arc::new(ApiHandlerWrapper::from_shared(api_handler.clone()));

    // One trusted selector serves every production Node entry point.
    let node_runtime_selector = node_runtime_provider::for_app(&handle);
    let plugin_runtime = Arc::new(
        atools_plugin::runtime::JsRuntime::new_with_node_runtime_selector(
            handler,
            node_runtime_selector.clone(),
        )
        .expect("Failed to create plugin runtime"),
    );
    let sidecar_supervisor = Arc::new(
        atools_plugin::SidecarSupervisor::new_with_node_runtime_selector(
            node_runtime_selector.clone(),
        ),
    );
    api_handler.attach_runtime(&plugin_runtime);
    app.manage(api_handler);
    app.manage(plugin_runtime);
    app.manage(sidecar_supervisor);
    plugin_main_push::install_manager(app.handle());
    plugin_background_runtime::install_manager(app.handle());
    legacy_runtime::commands::install_manager_with_node_runtime_selector(
        app.handle(),
        node_runtime_selector,
    );
    host_runtime::install_manager(app.handle());
    plugin_display_runtime::install_manager(app.handle());
    plugin_data_runtime::install_manager(app.handle());
    plugin_secret_storage_runtime::install_manager(app.handle());
    plugin_system_paths::install_manager(app.handle());
    plugin_dialog_runtime::install_manager(app.handle());
    plugin_file_drop::install_manager(app.handle());
    crate::plugin_file_drag::install_manager(app.handle());
    plugin_ai_runtime::install_manager(app.handle());

    // Register metadata only; actual invocation lazily loads plugin code.
    let inventory_readiness = app_state.inner().plugin_inventory_readiness.clone();
    let completion = inventory_readiness
        .begin_bootstrap()
        .map_err(std::io::Error::other)?;
    let builtin_plugins_dir = handle
        .path()
        .resolve("plugins/builtin", tauri::path::BaseDirectory::Resource)
        .ok();
    let app_for_plugins = handle.clone();
    std::thread::Builder::new()
        .name("atools-builtin-plugin-metadata".into())
        .spawn(move || {
            tauri::async_runtime::block_on(crate::plugin_inventory::bootstrap::load(
                app_for_plugins,
                builtin_plugins_dir,
                completion,
            ));
        })
        .map_err(std::io::Error::other)?;

    let db_for_mcp = app_state.inner().db.clone();
    let app_for_mcp = handle.clone();
    tauri::async_runtime::spawn(async move {
        let state_handle = app_for_mcp.clone();
        match mcp_server::start(app_for_mcp, db_for_mcp).await {
            Ok(status) => {
                tracing::info!("ATools MCP server listening on {}", status.bind);
                let app_state = state_handle.state::<AppState>();
                let _ = app_state
                    .inner()
                    .db
                    .set_setting("agent.mcp_bind", &status.bind);
                let _ = app_state
                    .inner()
                    .db
                    .set_setting("agent.mcp_token", &status.token);
                app_state.inner().record_runtime_event(
                    "info",
                    format!("MCP server listening on {}", status.bind),
                );
                *app_state.inner().mcp_status.lock() = Some(status);
            }
            Err(error) => {
                tracing::error!("Failed to start MCP server: {}", error);
                let app_state = state_handle.state::<AppState>();
                app_state
                    .inner()
                    .record_runtime_event("error", format!("Failed to start MCP server: {error}"));
            }
        }
    });

    if desktop_smoke::desktop_smoke_enabled() {
        desktop_smoke::spawn_desktop_smoke_reporter(handle.clone());
    }

    let pasteboard_runtime = app_state.inner().pasteboard_runtime.clone();
    let pasteboard_app = handle.clone();
    let pasteboard_capture_task = tauri::async_runtime::spawn(async move {
        loop {
            match pasteboard_runtime.capture_once().await {
                Ok(outcome) => {
                    if outcome.plugin_history_projected() {
                        let _ = pasteboard_app.emit("clipboard://history-projected", ());
                    }
                    if !matches!(outcome, pasteboard_runtime::CaptureOutcome::Unchanged) {
                        let _ = pasteboard_app.emit("pasteboard://changed", &outcome);
                    }
                }
                Err(error) => {
                    tracing::warn!(%error, "Native Paste clipboard capture failed");
                    let _ = pasteboard_app.emit(
                        "pasteboard://capture-error",
                        serde_json::json!({ "message": error }),
                    );
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
    });
    *app_state.inner().pasteboard_capture_task.lock() = Some(pasteboard_capture_task);
    app_state
        .inner()
        .record_runtime_event("info", "Native Paste clipboard capture started");

    tracing::info!("ATools 3.0 started");
    app_state
        .inner()
        .record_runtime_event("info", "ATools 3.0 started");
    updater::start_package_smoke_if_requested(&handle);
    Ok(())
}
