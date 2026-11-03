mod accessibility;
pub mod agent_tools;
pub(crate) mod ai_runtime;
mod app_builder;
mod app_global_shortcuts;
mod app_launch_fence;
mod app_launch_service;
mod app_lifecycle;
mod app_setup;
mod app_startup;
#[cfg(feature = "legacy-node-smoke")]
mod renderer_desktop_smoke;
#[cfg(feature = "legacy-node-smoke")]
pub use renderer_desktop_smoke::run as run_ztools_renderer_desktop_smoke;
mod builtin_plugins;
mod command_registry;
mod commands;
mod content_search;
mod feature_activation;
mod feature_activation_audit;
mod general_settings_runtime;
mod launcher_app_catalog;
mod launcher_app_catalog_source;
mod launcher_app_catalog_watch;
mod launcher_app_icons;
mod launcher_catalog;
mod launcher_clipboard_context;
mod launcher_media;
mod launcher_media_clipboard;
mod launcher_media_work;
mod native_tray_visibility;
mod native_window_opacity;
mod plugin_market_http;
mod plugin_market_target;
#[cfg(feature = "market-metadata-probe")]
mod plugin_market_target_probe;
mod renderer_app_state;
mod renderer_clipboard;
mod renderer_close_shortcut;
#[cfg(feature = "ztools-multiwebview")]
mod renderer_commands_catalog;
mod renderer_context_menu;
mod renderer_general_settings;
mod renderer_main_drop;
mod renderer_recommendation_pins;
mod renderer_settings;
#[cfg(feature = "ztools-multiwebview")]
mod renderer_settings_view;
mod renderer_window_drag;
mod renderer_window_material;
mod webview_command_policy;
#[cfg(feature = "market-metadata-probe")]
pub use plugin_market_target_probe::run as run_official_market_target_probe;
pub mod crash;
mod desktop_smoke;
mod hotkey;
pub mod mcp_server;
pub mod pasteboard_native;
pub mod pasteboard_runtime;
pub mod pasteboard_sync;
pub mod pasteboard_window;
#[cfg(test)]
mod plugin_activation_tests;
mod plugin_asset_protocol;
mod plugin_code_revision;
mod plugin_detach_runtime;
mod plugin_detach_validation;
mod plugin_detach_window;
mod plugin_directory_copy;
mod plugin_inventory;
mod plugin_lifecycle;
mod plugin_main_push;
mod plugin_source_build;
mod plugin_window_preferences;
pub(crate) use plugin_source_build::{
    calculate_converted_package_tree, read_converted_handoff, read_converted_package_manifest,
    ConvertedPackageTree,
};
#[cfg(all(feature = "source-dependency-smoke", target_os = "macos"))]
pub fn run_source_dependency_pipeline_smoke() -> Result<(), String> {
    plugin_source_build::run_source_dependency_pipeline_smoke()
}
pub(crate) mod plugin_source_dependencies;
/// Handles trusted worker modes before the host initializes Tauri. Keep this as
/// the first call in every executable entry point; both worker paths either
/// return to normal startup or exit with a fixed error code.
pub fn run_source_build_bootstrap_if_requested() {
    plugin_source_dependencies::run_if_requested();
    plugin_source_build::bootstrap::run_if_requested();
}
mod plugin_background_runtime;
mod plugin_browser_window_native;
mod plugin_lifecycle_permissions;
mod plugin_loopback;
mod plugin_mutation_runs;
mod plugin_mutations;
mod plugin_packages;
mod plugin_page_runtime;
mod plugin_resources;
mod plugin_runtime_inventory;
mod plugin_window_sources;
mod plugin_zip_archive;
/// Reuse the real transport in isolated native experiments without exposing it
/// as part of the ordinary application API.
#[cfg(feature = "legacy-node-smoke")]
pub mod plugin_origin_transport {
    pub use crate::plugin_loopback::{
        BridgeServer, OriginPolicy, RequestHandler, TransportObservation,
    };
}
#[cfg(feature = "legacy-node-smoke")]
#[path = "legacy_runtime/desktop_smoke.rs"]
mod legacy_node_desktop_smoke;
mod permission_requests;
mod plugin_execution_gates;
#[cfg(feature = "legacy-node-smoke")]
pub use legacy_node_desktop_smoke::run as run_legacy_node_desktop_smoke;
mod host_runtime;
mod legacy_runtime;
mod node_runtime_provider;
mod plugin_browser_window_runtime;
mod plugin_data_runtime;
mod plugin_dialog_runtime;
pub(crate) mod plugin_file_drag;
pub(crate) mod plugin_file_drop;
mod plugin_secret_storage_runtime;
mod plugin_system_paths;
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub use plugin_file_drag::desktop_smoke::run as run_file_drag_native_smoke;
#[cfg(all(feature = "plugin-ai-desktop-smoke", target_os = "macos"))]
#[path = "plugin_ai_runtime/desktop_smoke.rs"]
mod plugin_ai_desktop_smoke;
pub(crate) mod plugin_ai_runtime;
mod plugin_filesystem;
#[cfg(all(feature = "plugin-ai-desktop-smoke", target_os = "macos"))]
pub fn run_plugin_ai_desktop_smoke() -> Result<(), String> {
    plugin_ai_desktop_smoke::run()
}
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub use plugin_file_drop::run_desktop_smoke as run_plugin_file_drop_desktop_smoke;
mod plugin_display_runtime;
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub use host_runtime::desktop_smoke::run as run_host_clipboard_desktop_smoke;
mod providers;
mod renderer_updater;
mod settings_write;
mod state;
mod tray;
mod updater;
pub mod webdav;
mod window;
pub mod ztools_import;

use atools_core::config::AppConfig;
use atools_core::db::Database;

pub fn run() {
    app_startup::run();
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
