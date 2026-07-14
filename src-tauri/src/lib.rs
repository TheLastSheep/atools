pub mod agent_tools;
mod builtin_plugins;
mod commands;
pub mod crash;
mod desktop_smoke;
mod hotkey;
pub mod mcp_server;
mod state;
mod tray;
mod updater;
pub mod webdav;
mod window;
pub mod ztools_import;

use crate::state::ReleaseSmokeConfig;
use atools_api_shim::handler::ApiHandler;
use atools_api_shim::handler_wrapper::ApiHandlerWrapper;
use atools_core::config::AppConfig;
use atools_core::db::Database;
use atools_plugin::ipc_handler::IpcHandler;
use state::AppState;
use std::sync::Arc;
use tauri::Manager;

const RELEASE_SMOKE_TOKEN_ARG: &str = "--atools-release-smoke-token=";
const RELEASE_SMOKE_REPORT_PATH_ARG: &str = "--atools-release-smoke-report=";
const RELEASE_SMOKE_TOKEN_ENV: &str = "ATOOLS_RELEASE_SMOKE_TOKEN";
const RELEASE_SMOKE_REPORT_PATH_ENV: &str = "ATOOLS_RELEASE_SMOKE_REPORT_PATH";

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "atools=debug,atools_core=debug".into()),
        )
        .init();

    let config = AppConfig::new().expect("Failed to create AppConfig");
    config
        .ensure_dirs()
        .expect("Failed to create app directories");
    crash::install_panic_hook(crash::crash_log_path(&config));

    let db = Arc::new(Database::new().expect("Failed to open database"));
    let release_smoke = parse_release_smoke_config();
    let app_state = AppState::new(config, db, release_smoke);
    app_state.record_runtime_event("info", "ATools state initialized");

    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(app_state)
        .manage(updater::UpdateCoordinator::default())
        .invoke_handler(tauri::generate_handler![
            commands::search_features,
            commands::search_local_apps,
            commands::activate_feature,
            desktop_smoke::desktop_smoke_plugin_panel_action,
            desktop_smoke::desktop_smoke_plugin_panel_actions,
            desktop_smoke::report_plugin_panel_render_smoke,
            commands::install_plugin,
            commands::update_plugin_from_path,
            commands::authorize_plugin_permissions,
            commands::fetch_plugin_market_catalog,
            commands::install_plugin_from_market,
            commands::update_plugin_from_market,
            commands::cancel_plugin_market_operation,
            commands::scan_ztools_plugins,
            commands::import_ztools_plugins,
            commands::uninstall_plugin,
            commands::list_plugins,
            commands::toggle_plugin,
            commands::get_setting,
            commands::set_setting,
            commands::get_plugin_data,
            commands::put_plugin_data,
            commands::remove_plugin_data,
            commands::list_clipboard_history,
            commands::clear_clipboard_history,
            commands::export_clipboard_history_json,
            commands::get_plugin_data_item,
            commands::put_plugin_data_bulk,
            commands::show_main_window,
            commands::hide_main_window,
            commands::expand_window,
            commands::reset_window,
            commands::set_floating_ball_visible,
            commands::set_super_panel_visible,
            commands::open_plugin_detach_window,
            commands::open_devtools_for_window,
            commands::update_global_hotkey,
            commands::set_tray_icon_visible,
            commands::set_launch_at_login,
            commands::copy_text,
            commands::show_notification,
            commands::system_get_path,
            commands::shell_open,
            commands::shell_show_item_in_folder,
            commands::screen_capture,
            commands::read_current_browser_url,
            commands::read_current_folder_path,
            commands::read_frontmost_app_name,
            commands::copy_file,
            commands::copy_image,
            commands::get_copyed_files,
            commands::put_plugin_data_attachment,
            commands::get_plugin_data_attachment,
            commands::list_agent_tools,
            commands::list_capabilities,
            commands::set_agent_tool_enabled,
            commands::grant_agent_tool,
            commands::revoke_agent_tool,
            commands::list_agent_tool_grants,
            commands::list_agent_scope_policies,
            commands::set_agent_scope_policy,
            commands::list_pending_agent_requests,
            commands::dismiss_pending_agent_request,
            commands::call_agent_tool,
            commands::list_task_runs,
            commands::get_task_run,
            commands::cancel_task_run,
            commands::list_skills,
            commands::create_skill,
            commands::update_skill,
            commands::set_skill_enabled,
            commands::delete_skill,
            commands::export_skills_json,
            commands::list_memory_items,
            commands::create_memory_item,
            commands::update_memory_item,
            commands::set_memory_item_enabled,
            commands::delete_memory_item,
            commands::clear_memory_items,
            commands::export_memory_items_json,
            commands::list_audit_entries,
            commands::query_audit_entries,
            commands::query_audit_entries_page,
            commands::clear_audit_entries,
            commands::prune_audit_entries,
            commands::export_audit_entries_jsonl,
            commands::export_audit_entries_jsonl_filtered,
            commands::archive_audit_entries_jsonl,
            commands::get_permission_mode,
            commands::set_permission_mode,
            commands::get_mcp_status,
            commands::install_mcp_client_config,
            commands::get_runtime_diagnostics,
            commands::list_crash_logs,
            commands::export_crash_log,
            commands::clear_crash_log,
            commands::sync_webdav_now,
            commands::preview_webdav_backup,
            commands::plan_webdav_restore,
            commands::restore_webdav_settings,
            commands::restore_webdav_clipboard_history,
            commands::restore_webdav_plugin_data,
            commands::test_ai_connection,
            commands::release_smoke_info,
            commands::report_release_smoke_progress,
            updater::check_app_update,
            updater::install_app_update,
            updater::get_app_update_status,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let app_state = app.state::<AppState>();
            app_state
                .inner()
                .record_runtime_event("info", "Tauri setup started");

            tray::setup_tray(&handle)?;
            hotkey::setup_hotkey(&handle)?;
            if let Err(error) = window::center_main_window(&handle) {
                tracing::error!("Failed to center main window on startup: {}", error);
                app_state.inner().record_runtime_event(
                    "error",
                    format!("Failed to center main window: {error}"),
                );
            }
            let settings_json = app_state
                .inner()
                .db
                .get_setting("settings-general")
                .ok()
                .flatten();
            let floating_ball_enabled =
                window::floating_ball_enabled_from_settings(settings_json.as_deref());
            let super_panel_enabled =
                window::super_panel_enabled_from_settings(settings_json.as_deref());
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
            let api_handler = ApiHandler::new(db, plugins_dir);
            let handler: Arc<dyn IpcHandler + Send + Sync> =
                Arc::new(ApiHandlerWrapper::new(api_handler));

            // Initialize plugin runtime with handler
            let plugin_runtime = Arc::new(
                atools_plugin::runtime::JsRuntime::new(handler)
                    .expect("Failed to create plugin runtime"),
            );
            app.manage(plugin_runtime);

            // Load builtin plugins (registers them in DB + executes preloads)
            let runtime_for_plugins = app
                .state::<Arc<atools_plugin::runtime::JsRuntime>>()
                .inner()
                .clone();
            let db_for_plugins = app_state.inner().db.clone();
            let app_for_plugins = handle.clone();
            let builtin_plugins_dir = handle
                .path()
                .resolve("plugins/builtin", tauri::path::BaseDirectory::Resource)
                .ok();
            std::thread::spawn(move || {
                tauri::async_runtime::block_on(async move {
                    let db_for_plugin_tools = db_for_plugins.clone();
                    if let Err(e) = builtin_plugins::load_builtin_plugins(
                        runtime_for_plugins,
                        db_for_plugins,
                        builtin_plugins_dir,
                    )
                    .await
                    {
                        tracing::error!("Failed to load builtin plugins: {}", e);
                        let state = app_for_plugins.state::<AppState>();
                        state.inner().record_runtime_event(
                            "error",
                            format!("Failed to load builtin plugins: {e}"),
                        );
                    } else {
                        let state = app_for_plugins.state::<AppState>();
                        state
                            .inner()
                            .record_runtime_event("info", "Builtin plugins loaded");
                        if let Err(error) = agent_tools::sync_plugin_tools(&db_for_plugin_tools) {
                            tracing::error!("Failed to sync plugin Agent tools: {}", error);
                            state.inner().record_runtime_event(
                                "error",
                                format!("Failed to sync plugin Agent tools: {error}"),
                            );
                        } else {
                            state
                                .inner()
                                .record_runtime_event("info", "Plugin Agent tools synced");
                        }
                    }
                });
            });

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
                        app_state.inner().record_runtime_event(
                            "error",
                            format!("Failed to start MCP server: {error}"),
                        );
                    }
                }
            });

            if desktop_smoke::desktop_smoke_enabled() {
                desktop_smoke::spawn_desktop_smoke_reporter(handle.clone());
            }

            tracing::info!("ATools 3.0 started");
            app_state
                .inner()
                .record_runtime_event("info", "ATools 3.0 started");
            updater::start_package_smoke_if_requested(&handle);
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    window.hide().ok();
                    api.prevent_close();
                }
            }
            tauri::WindowEvent::Focused(focused) if window.label() == "main" && !focused => {
                window.hide().ok();
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("error building ATools 3.0")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                api.prevent_exit();
            }
        });
}

fn parse_release_smoke_config() -> Option<ReleaseSmokeConfig> {
    let token = parse_from_args_or_env(RELEASE_SMOKE_TOKEN_ARG, RELEASE_SMOKE_TOKEN_ENV)?;
    let report_path =
        parse_from_args_or_env(RELEASE_SMOKE_REPORT_PATH_ARG, RELEASE_SMOKE_REPORT_PATH_ENV);
    tracing::info!(
        "Release smoke mode enabled: token={} report_path={}",
        token,
        report_path
            .clone()
            .unwrap_or_else(|| "<not-provided>".to_string())
    );
    Some(ReleaseSmokeConfig { token, report_path })
}

fn parse_from_args_or_env(arg_prefix: &str, env_key: &str) -> Option<String> {
    if let Some(value) = std::env::args().find_map(|arg| {
        parse_prefixed_arg(&arg, arg_prefix)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }) {
        return Some(value);
    }

    let env_arg_prefix = format!("--{env_key}=");
    if let Some(value) = std::env::args().find_map(|arg| {
        parse_prefixed_arg(&arg, &env_arg_prefix)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }) {
        return Some(value);
    }

    std::env::var(env_key).ok().and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn parse_prefixed_arg<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    value.strip_prefix(prefix)
}

pub fn run_mcp_stdio_proxy() -> Result<(), String> {
    use std::io::{BufRead, Write};

    let config = AppConfig::new().map_err(|e| e.to_string())?;
    config.ensure_dirs().map_err(|e| e.to_string())?;
    let db = Database::new().map_err(|e| e.to_string())?;
    let bind = db
        .get_setting("agent.mcp_bind")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let token = db
        .get_setting("agent.mcp_token")
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let rt = tokio::runtime::Runtime::new().map_err(|e| e.to_string())?;
    let client = reqwest::Client::new();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    for line in stdin.lock().lines() {
        let line = line.map_err(|e| e.to_string())?;
        if line.trim().is_empty() {
            continue;
        }
        let request: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let response = if bind.is_empty() || token.is_empty() {
            local_stdio_fallback(request)
        } else {
            rt.block_on(async {
                let response = client
                    .post(format!("http://{}/mcp", bind))
                    .bearer_auth(&token)
                    .json(&request)
                    .send()
                    .await
                    .map_err(|e| e.to_string())?;

                if response.status() == reqwest::StatusCode::NO_CONTENT {
                    return Ok(None);
                }

                response
                    .json::<serde_json::Value>()
                    .await
                    .map(Some)
                    .map_err(|e| e.to_string())
            })?
        };
        if let Some(response) = response {
            writeln!(stdout, "{}", response).map_err(|e| e.to_string())?;
            stdout.flush().map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn local_stdio_fallback(request: serde_json::Value) -> Option<serde_json::Value> {
    if let Some(batch) = request.as_array() {
        if batch.is_empty() {
            return Some(serde_json::json!({
                "jsonrpc": "2.0",
                "id": serde_json::Value::Null,
                "error": {
                    "code": -32600,
                    "message": "Invalid Request: batch must not be empty"
                }
            }));
        }

        let responses = batch
            .iter()
            .filter_map(|message| local_stdio_fallback(message.clone()))
            .collect::<Vec<_>>();

        return (!responses.is_empty()).then_some(serde_json::Value::Array(responses));
    }

    let method = request
        .get("method")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default();
    if matches!(
        method,
        "initialize"
            | "tools/list"
            | "resources/list"
            | "resources/read"
            | "resources/templates/list"
            | "prompts/list"
            | "prompts/get"
            | "ping"
            | "notifications/initialized"
    ) {
        return atools_core::mcp::handle_static_mcp_message(
            &agent_tools::builtin_tool_registry(),
            request,
            |_| atools_core::mcp::McpToolCallResult::success(serde_json::json!({})),
        );
    }

    request.get("id")?;

    Some(serde_json::json!({
        "jsonrpc": "2.0",
        "id": request.get("id").cloned().unwrap_or(serde_json::Value::Null),
        "error": {
            "code": -32000,
            "message": "ATools desktop MCP server is not running"
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn local_stdio_fallback_skips_initialized_notification() {
        let response = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }));

        assert!(response.is_none());
    }

    #[test]
    fn local_stdio_fallback_skips_idless_notifications() {
        let ping = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "method": "ping"
        }));
        assert!(ping.is_none());

        let tools_call = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "find_local_files",
                "arguments": { "query": "invoice" }
            }
        }));
        assert!(tools_call.is_none());
    }

    #[test]
    fn local_stdio_fallback_responds_to_ping() {
        let response = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "id": 7,
            "method": "ping"
        }))
        .unwrap();

        assert_eq!(response["jsonrpc"], "2.0");
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"], json!({}));
    }

    #[test]
    fn local_stdio_fallback_handles_mcp_discovery_lists() {
        let resources = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "id": 8,
            "method": "resources/list"
        }))
        .unwrap();
        assert_eq!(resources["id"], 8);
        assert_eq!(
            resources["result"]["resources"][0]["uri"],
            "atools://agent/tools"
        );

        let templates = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "resources/templates/list"
        }))
        .unwrap();
        assert_eq!(templates["id"], 9);
        assert_eq!(templates["result"]["resourceTemplates"], json!([]));

        let prompts = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "prompts/list"
        }))
        .unwrap();
        assert_eq!(prompts["id"], 10);
        assert_eq!(
            prompts["result"]["prompts"][0]["name"],
            "atools_agent_tool_guide"
        );
    }

    #[test]
    fn local_stdio_fallback_handles_builtin_resource_read() {
        let resource = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "resources/read",
            "params": {
                "uri": "atools://agent/tools"
            }
        }))
        .unwrap();

        assert_eq!(resource["id"], 12);
        assert_eq!(
            resource["result"]["contents"][0]["uri"],
            "atools://agent/tools"
        );
        let text = resource["result"]["contents"][0]["text"].as_str().unwrap();
        assert!(text.contains("search_clipboard"));
        assert!(text.contains("find_local_files"));
    }

    #[test]
    fn local_stdio_fallback_handles_builtin_prompt_get() {
        let prompt = local_stdio_fallback(json!({
            "jsonrpc": "2.0",
            "id": 11,
            "method": "prompts/get",
            "params": {
                "name": "atools_agent_tool_guide",
                "arguments": {
                    "task": "summarize clipboard"
                }
            }
        }))
        .unwrap();

        assert_eq!(prompt["id"], 11);
        assert_eq!(
            prompt["result"]["description"],
            "Guide for choosing ATools local Agent tools"
        );
        assert!(prompt["result"]["messages"][0]["content"]["text"]
            .as_str()
            .unwrap()
            .contains("summarize clipboard"));
    }

    #[test]
    fn local_stdio_fallback_handles_json_rpc_batches() {
        let response = local_stdio_fallback(json!([
            { "jsonrpc": "2.0", "id": 21, "method": "ping" },
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 22, "method": "prompts/list" }
        ]))
        .unwrap();

        let responses = response.as_array().unwrap();
        assert_eq!(responses.len(), 2);
        assert_eq!(responses[0]["id"], 21);
        assert_eq!(responses[0]["result"], json!({}));
        assert_eq!(responses[1]["id"], 22);
        assert_eq!(
            responses[1]["result"]["prompts"][0]["name"],
            "atools_agent_tool_guide"
        );
    }
}
