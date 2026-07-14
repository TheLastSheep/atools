use atools_api_shim::handler::ApiHandler;
use atools_api_shim::handler_wrapper::ApiHandlerWrapper;
use atools_core::agent::{AuditLogEntry, AuditStatus};
use atools_core::models::{Plugin, PluginManifest};
use atools_core::Database;
use atools_lib::agent_tools::{
    agent_ai_config_from_settings, ask_ai_model, builtin_tool_registry, compress_images,
    execute_plugin_tool, find_local_files, find_local_files_with_options, get_current_context,
    ocr_image, open_or_reveal_path, plan_renames, search_clipboard_history, FindLocalFilesOptions,
    RenameOperation,
};
use atools_plugin::runtime::JsRuntime;
use std::fs;
use std::sync::Arc;
use tempfile::TempDir;

fn sample_plugin_with_manifest_tool(enabled: bool) -> Plugin {
    Plugin {
        id: "clipboard-plus".to_string(),
        name: "Clipboard Plus".to_string(),
        version: "1.0.0".to_string(),
        path: "/tmp/clipboard-plus".to_string(),
        enabled,
        manifest: serde_json::from_value::<PluginManifest>(serde_json::json!({
            "name": "Clipboard Plus",
            "version": "1.0.0",
            "main": "index.html",
            "features": [],
            "tools": {
                "search_history": {
                    "description": "Search plugin clipboard history",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "query": { "type": "string" }
                        }
                    },
                    "outputSchema": {
                        "type": "object",
                        "properties": {
                            "items": { "type": "array" }
                        }
                    }
                }
            }
        }))
        .unwrap(),
        created_at: "2026-06-03T09:00:00Z".to_string(),
        updated_at: "2026-06-03T09:00:00Z".to_string(),
    }
}

#[test]
fn builtin_registry_contains_agent_whitelist() {
    let registry = builtin_tool_registry();
    let names: Vec<_> = registry
        .list_enabled()
        .into_iter()
        .map(|tool| tool.name)
        .collect();

    assert_eq!(
        names,
        vec![
            "ask_ai_model",
            "compress_images",
            "find_local_files",
            "get_current_context",
            "ocr_image",
            "open_or_reveal_path",
            "open_url",
            "rename_files",
            "search_clipboard",
        ]
    );

    let compress_tool = registry.get("compress_images").unwrap();
    assert_eq!(
        compress_tool.input_schema["properties"]["format"]["enum"],
        serde_json::json!(["original", "webp"])
    );
    let find_tool = registry.get("find_local_files").unwrap();
    assert_eq!(
        find_tool.input_schema["properties"]["ignore_patterns"]["items"]["type"],
        "string"
    );
}

#[tokio::test]
async fn plugin_manifest_tool_executes_registered_plugin_handler() {
    let db = Database::in_memory().unwrap();
    let plugin = sample_plugin_with_manifest_tool(true);
    db.save_plugin(&plugin).unwrap();
    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();
    db.set_agent_tool_enabled("plugin_clipboard_plus_search_history", true)
        .unwrap();
    let tool = db
        .get_agent_tool("plugin_clipboard_plus_search_history")
        .unwrap()
        .expect("plugin tool");
    let temp = TempDir::new().unwrap();
    let runtime = JsRuntime::new(Arc::new(ApiHandlerWrapper::new(ApiHandler::new(
        Arc::new(Database::in_memory().unwrap()),
        temp.path().join("plugins"),
    ))))
    .unwrap();
    runtime
        .execute_preload(
            &plugin.id,
            r#"
            utools.registerTool('search_history', { description: 'Search' }, function(args) {
                return { status: 'ok', query: args.query, limit: args.limit };
            });
            "#,
        )
        .await
        .unwrap();

    let output = execute_plugin_tool(
        &runtime,
        &db,
        &tool,
        serde_json::json!({ "query": "invoice", "limit": 3 }),
    )
    .await
    .unwrap();

    assert_eq!(
        output,
        serde_json::json!({ "status": "ok", "query": "invoice", "limit": 3 })
    );
}

#[tokio::test]
async fn plugin_manifest_tool_executes_async_handler_that_uses_ipc_bridge() {
    let db = Database::in_memory().unwrap();
    let plugin = sample_plugin_with_manifest_tool(true);
    db.save_plugin(&plugin).unwrap();
    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();
    db.set_agent_tool_enabled("plugin_clipboard_plus_search_history", true)
        .unwrap();
    let tool = db
        .get_agent_tool("plugin_clipboard_plus_search_history")
        .unwrap()
        .expect("plugin tool");
    let temp = TempDir::new().unwrap();
    let runtime = JsRuntime::new(Arc::new(ApiHandlerWrapper::new(ApiHandler::new(
        Arc::new(db.clone()),
        temp.path().join("plugins"),
    ))))
    .unwrap();
    runtime
        .execute_preload(
            &plugin.id,
            r#"
            utools.registerTool('search_history', { description: 'Search' }, async function(args) {
                await utools.dbStorage.setItem('lastQuery', args.query);
                var saved = await utools.dbStorage.getItem('lastQuery');
                return { status: 'ok', saved: saved, limit: args.limit };
            });
            "#,
        )
        .await
        .unwrap();

    let output = execute_plugin_tool(
        &runtime,
        &db,
        &tool,
        serde_json::json!({ "query": "invoice", "limit": 3 }),
    )
    .await
    .unwrap();

    assert_eq!(
        output,
        serde_json::json!({ "status": "ok", "saved": "invoice", "limit": 3 })
    );
}

#[tokio::test]
async fn plugin_manifest_tool_lazy_loads_preload_when_context_is_missing() {
    let db = Database::in_memory().unwrap();
    let temp = TempDir::new().unwrap();
    fs::write(
        temp.path().join("preload.js"),
        r#"
        utools.registerTool('search_history', { description: 'Search' }, function(args) {
            return { status: 'lazy-loaded', query: args.query };
        });
        "#,
    )
    .unwrap();

    let mut plugin = sample_plugin_with_manifest_tool(true);
    plugin.path = temp.path().to_string_lossy().to_string();
    plugin.manifest.preload = Some("preload.js".to_string());
    db.save_plugin(&plugin).unwrap();
    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();
    db.set_agent_tool_enabled("plugin_clipboard_plus_search_history", true)
        .unwrap();
    let tool = db
        .get_agent_tool("plugin_clipboard_plus_search_history")
        .unwrap()
        .expect("plugin tool");
    let runtime = JsRuntime::new(Arc::new(ApiHandlerWrapper::new(ApiHandler::new(
        Arc::new(db.clone()),
        temp.path().join("plugins"),
    ))))
    .unwrap();

    let output = execute_plugin_tool(
        &runtime,
        &db,
        &tool,
        serde_json::json!({ "query": "invoice" }),
    )
    .await
    .unwrap();

    assert_eq!(
        output,
        serde_json::json!({ "status": "lazy-loaded", "query": "invoice" })
    );
}

#[tokio::test]
async fn plugin_manifest_tool_lazy_load_rejects_preload_outside_plugin_directory() {
    let db = Database::in_memory().unwrap();
    let temp = TempDir::new().unwrap();
    let mut plugin = sample_plugin_with_manifest_tool(true);
    plugin.path = temp.path().to_string_lossy().to_string();
    plugin.manifest.preload = Some("../preload.js".to_string());
    db.save_plugin(&plugin).unwrap();
    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();
    db.set_agent_tool_enabled("plugin_clipboard_plus_search_history", true)
        .unwrap();
    let tool = db
        .get_agent_tool("plugin_clipboard_plus_search_history")
        .unwrap()
        .expect("plugin tool");
    let runtime = JsRuntime::new(Arc::new(ApiHandlerWrapper::new(ApiHandler::new(
        Arc::new(db.clone()),
        temp.path().join("plugins"),
    ))))
    .unwrap();

    let error = execute_plugin_tool(
        &runtime,
        &db,
        &tool,
        serde_json::json!({ "query": "invoice" }),
    )
    .await
    .unwrap_err();

    assert!(error.contains("outside the plugin directory"));
}

#[test]
fn agent_ai_config_requires_agent_default_toggle_and_complete_settings() {
    let disabled = agent_ai_config_from_settings(&serde_json::json!({
        "aiProvider": "compatible",
        "aiBaseUrl": "https://api.example.com/v1",
        "aiDefaultModel": "qwen-max",
        "aiApiKey": "sk-local",
        "aiUseForAgent": false
    }))
    .unwrap_err();
    assert!(disabled.contains("Agent"));

    let missing_key = agent_ai_config_from_settings(&serde_json::json!({
        "aiProvider": "compatible",
        "aiBaseUrl": "https://api.example.com/v1",
        "aiDefaultModel": "qwen-max",
        "aiUseForAgent": true
    }))
    .unwrap_err();
    assert!(missing_key.contains("API key"));
}

#[tokio::test]
async fn ask_ai_model_posts_chat_completion_using_agent_settings() {
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[derive(Debug, Clone)]
    struct RecordedRequest {
        path: String,
        authorization: String,
        body: serde_json::Value,
    }

    let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server_requests = requests.clone();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0; 64 * 1024];
        let bytes_read = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
        let path = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or_default()
            .to_string();
        let authorization = request
            .lines()
            .find_map(|line| {
                line.split_once(": ").and_then(|(name, value)| {
                    name.eq_ignore_ascii_case("authorization").then_some(value)
                })
            })
            .unwrap_or_default()
            .to_string();
        let body = request
            .split_once("\r\n\r\n")
            .and_then(|(_, body)| serde_json::from_str::<serde_json::Value>(body).ok())
            .unwrap();
        server_requests.lock().unwrap().push(RecordedRequest {
            path,
            authorization,
            body,
        });

        let response_body = r#"{"id":"chatcmpl-local","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"ok summary"},"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}"#;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    let db = Database::in_memory().unwrap();
    db.set_setting(
        "settings-general",
        &serde_json::json!({
            "aiProvider": "compatible",
            "aiBaseUrl": base_url,
            "aiDefaultModel": "qwen-max",
            "aiApiKey": "sk-agent",
            "aiTemperature": 0.3,
            "aiUseForAgent": true
        })
        .to_string(),
    )
    .unwrap();

    let output = ask_ai_model(
        &db,
        serde_json::json!({
            "system": "Be terse.",
            "prompt": "Summarize local state.",
            "max_tokens": 128
        }),
    )
    .await
    .unwrap();

    assert_eq!(output["text"], "ok summary");
    assert_eq!(output["provider"], "compatible");
    assert_eq!(output["model"], "qwen-max");
    assert_eq!(output["finish_reason"], "stop");
    assert_eq!(output["usage"]["total_tokens"], 9);
    assert!(output.get("api_key").is_none());

    let requests = requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].path, "/v1/chat/completions");
    assert_eq!(requests[0].authorization, "Bearer sk-agent");
    assert_eq!(requests[0].body["model"], "qwen-max");
    assert_eq!(requests[0].body["temperature"], 0.3);
    assert_eq!(requests[0].body["max_tokens"], 128);
    assert_eq!(requests[0].body["messages"][0]["role"], "system");
    assert_eq!(requests[0].body["messages"][0]["content"], "Be terse.");
    assert_eq!(requests[0].body["messages"][1]["role"], "user");
    assert_eq!(
        requests[0].body["messages"][1]["content"],
        "Summarize local state."
    );
}

#[tokio::test]
async fn ask_ai_model_success_audit_keeps_prompt_and_output_without_api_key() {
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let requests: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let server_requests = requests.clone();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0; 64 * 1024];
        let bytes_read = socket.read(&mut buffer).await.unwrap();
        server_requests
            .lock()
            .unwrap()
            .push(String::from_utf8_lossy(&buffer[..bytes_read]).to_string());

        let response_body = r#"{"id":"chatcmpl-audit","object":"chat.completion","choices":[{"index":0,"message":{"role":"assistant","content":"local audit summary"},"finish_reason":"stop"}],"usage":{"prompt_tokens":6,"completion_tokens":3,"total_tokens":9}}"#;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    let db = Database::in_memory().unwrap();
    db.set_setting(
        "settings-general",
        &serde_json::json!({
            "aiProvider": "compatible",
            "aiBaseUrl": base_url,
            "aiDefaultModel": "qwen-max",
            "aiApiKey": "sk-agent-audit-secret",
            "aiTemperature": 0.3,
            "aiUseForAgent": true
        })
        .to_string(),
    )
    .unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();

    let arguments = serde_json::json!({
        "system": "Keep it local.",
        "prompt": "Summarize clipboard notes for audit.",
        "max_tokens": 96
    });
    let output = ask_ai_model(&db, arguments.clone()).await.unwrap();
    let entry = AuditLogEntry::new(
        "mcp-http",
        "ask_ai_model",
        arguments,
        AuditStatus::Confirmed,
    )
    .with_output(output)
    .with_duration_ms(42);
    db.insert_audit_entry(&entry).unwrap();

    let audit = db.list_audit_entries(1).unwrap().remove(0);
    assert_eq!(audit.tool_name, "ask_ai_model");
    assert_eq!(
        audit.input["prompt"],
        "Summarize clipboard notes for audit."
    );
    assert_eq!(audit.output["text"], "local audit summary");
    assert_eq!(audit.output["model"], "qwen-max");

    let audit_json = serde_json::to_string(&audit).unwrap();
    assert!(audit_json.contains("Summarize clipboard notes for audit."));
    assert!(audit_json.contains("local audit summary"));
    assert!(!audit_json.contains("sk-agent-audit-secret"));
    assert!(!audit_json.to_ascii_lowercase().contains("api_key"));

    let requests = requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 1);
    assert!(requests[0]
        .to_ascii_lowercase()
        .contains("authorization: bearer sk-agent-audit-secret"));
}

#[test]
fn search_clipboard_history_records_current_text_and_searches_previous_items() {
    let db = Database::in_memory().unwrap();
    db.record_clipboard_text("last week API error", "2026-06-01T09:00:00Z")
        .unwrap();

    let output = search_clipboard_history(
        &db,
        Some("today API key"),
        serde_json::json!({ "query": "api", "limit": 10 }),
    )
    .unwrap();

    assert_eq!(output["total"], 2);
    assert_eq!(output["items"][0]["text"], "today API key");
    assert_eq!(output["items"][0]["source"], "clipboard_history");
    assert_eq!(output["items"][1]["text"], "last week API error");
}

#[test]
fn search_clipboard_history_respects_query_and_limit() {
    let db = Database::in_memory().unwrap();
    db.record_clipboard_text("alpha token", "2026-06-01T09:00:00Z")
        .unwrap();
    db.record_clipboard_text("beta token", "2026-06-01T10:00:00Z")
        .unwrap();

    let output = search_clipboard_history(
        &db,
        None,
        serde_json::json!({ "query": "token", "limit": 1 }),
    )
    .unwrap();

    assert_eq!(output["total"], 1);
    assert_eq!(output["items"][0]["text"], "beta token");
}

#[test]
fn find_local_files_matches_names_with_limit() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("invoice-001.pdf"), "pdf").unwrap();
    fs::write(temp.path().join("notes.txt"), "notes").unwrap();
    fs::create_dir(temp.path().join("nested")).unwrap();
    fs::write(temp.path().join("nested").join("invoice-002.pdf"), "pdf").unwrap();

    let matches = find_local_files(temp.path(), "invoice", 1).unwrap();

    assert_eq!(matches.len(), 1);
    assert!(matches[0].path.contains("invoice-"));
}

#[test]
fn find_local_files_respects_ignore_dirs_and_max_depth() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("invoice-root.pdf"), "pdf").unwrap();
    fs::create_dir(temp.path().join("nested")).unwrap();
    fs::write(temp.path().join("nested").join("invoice-nested.pdf"), "pdf").unwrap();
    fs::create_dir(temp.path().join("ignored")).unwrap();
    fs::write(
        temp.path().join("ignored").join("invoice-ignored.pdf"),
        "pdf",
    )
    .unwrap();

    let report = find_local_files_with_options(
        temp.path(),
        "invoice",
        &FindLocalFilesOptions {
            limit: 20,
            max_depth: Some(1),
            ignore_dirs: vec!["ignored".to_string()],
            ignore_patterns: Vec::new(),
        },
    )
    .unwrap();

    let names: Vec<_> = report.items.iter().map(|item| item.name.as_str()).collect();
    assert!(names.contains(&"invoice-root.pdf"));
    assert!(names.contains(&"invoice-nested.pdf"));
    assert!(!names.contains(&"invoice-ignored.pdf"));
    assert_eq!(report.skipped_permission_errors, 0);
}

#[test]
fn find_local_files_respects_ignore_patterns_for_files_and_paths() {
    let temp = TempDir::new().unwrap();
    fs::write(temp.path().join("invoice-root.pdf"), "pdf").unwrap();
    fs::write(temp.path().join("invoice-cache.tmp"), "tmp").unwrap();
    fs::create_dir(temp.path().join("generated")).unwrap();
    fs::write(
        temp.path().join("generated").join("invoice-generated.pdf"),
        "pdf",
    )
    .unwrap();

    let report = find_local_files_with_options(
        temp.path(),
        "invoice",
        &FindLocalFilesOptions {
            limit: 20,
            max_depth: Some(2),
            ignore_dirs: Vec::new(),
            ignore_patterns: vec!["*.tmp".to_string(), "generated/**".to_string()],
        },
    )
    .unwrap();

    let names: Vec<_> = report.items.iter().map(|item| item.name.as_str()).collect();
    assert!(names.contains(&"invoice-root.pdf"));
    assert!(!names.contains(&"invoice-cache.tmp"));
    assert!(!names.contains(&"invoice-generated.pdf"));
}

#[cfg(unix)]
#[test]
fn find_local_files_skips_permission_denied_directories() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDir::new().unwrap();
    let locked = temp.path().join("locked");
    fs::create_dir(&locked).unwrap();
    fs::write(locked.join("invoice-secret.pdf"), "pdf").unwrap();
    fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();

    let report = find_local_files_with_options(
        temp.path(),
        "invoice",
        &FindLocalFilesOptions {
            limit: 20,
            max_depth: Some(2),
            ignore_dirs: Vec::new(),
            ignore_patterns: Vec::new(),
        },
    )
    .unwrap();

    fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
    assert!(report.items.is_empty());
    assert!(report.skipped_permission_errors >= 1);
}

#[test]
fn plan_renames_reports_dry_run_without_mutating_files() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("old.txt");
    let dest = temp.path().join("new.txt");
    fs::write(&source, "content").unwrap();

    let result = plan_renames(
        &[RenameOperation {
            from: source.to_string_lossy().to_string(),
            to: dest.to_string_lossy().to_string(),
        }],
        true,
    )
    .unwrap();

    assert_eq!(result.len(), 1);
    assert_eq!(result[0].status, "planned");
    assert!(result[0].dry_run);
    assert!(result[0].from_exists);
    assert!(!result[0].to_exists);
    assert!(result[0].parent_exists);
    assert!(source.exists());
    assert!(!dest.exists());
}

#[test]
fn plan_renames_rejects_target_conflicts_even_in_dry_run() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("old.txt");
    let dest = temp.path().join("new.txt");
    fs::write(&source, "content").unwrap();
    fs::write(&dest, "existing").unwrap();

    let error = plan_renames(
        &[RenameOperation {
            from: source.to_string_lossy().to_string(),
            to: dest.to_string_lossy().to_string(),
        }],
        true,
    )
    .unwrap_err();

    assert!(error.contains("target already exists"));
    assert!(source.exists());
    assert_eq!(fs::read_to_string(dest).unwrap(), "existing");
}

#[test]
fn plan_renames_rejects_missing_target_parent_before_mutating() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("old.txt");
    let dest = temp.path().join("missing-parent").join("new.txt");
    fs::write(&source, "content").unwrap();

    let error = plan_renames(
        &[RenameOperation {
            from: source.to_string_lossy().to_string(),
            to: dest.to_string_lossy().to_string(),
        }],
        false,
    )
    .unwrap_err();

    assert!(error.contains("parent directory does not exist"));
    assert!(source.exists());
    assert!(!dest.exists());
}

#[test]
fn open_or_reveal_path_returns_error_when_platform_command_fails() {
    let missing = "/definitely/missing/atools-agent-tool-path";
    let error =
        open_or_reveal_path(serde_json::json!({ "path": missing, "reveal": true })).unwrap_err();

    #[cfg(target_os = "macos")]
    assert!(error.contains("open -R failed"));

    #[cfg(not(target_os = "macos"))]
    assert!(error.contains("Unsupported platform"));
}

#[test]
fn compress_images_reports_original_and_output_sizes() {
    let temp = TempDir::new().unwrap();
    let input = temp.path().join("pixel.png");
    let output_dir = temp.path().join("out");
    fs::create_dir(&output_dir).unwrap();
    image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]))
        .save(&input)
        .unwrap();

    let output = compress_images(serde_json::json!({
        "paths": [input],
        "output_dir": output_dir,
        "max_width": 100
    }))
    .unwrap();

    let item = &output["items"][0];
    assert_eq!(item["status"], "compressed");
    assert!(item["original_size"].as_u64().unwrap() > 0);
    assert!(item["output_size"].as_u64().unwrap() > 0);
}

#[test]
fn compress_images_writes_webp_output_when_requested() {
    let temp = TempDir::new().unwrap();
    let input = temp.path().join("pixel.png");
    let output_dir = temp.path().join("out");
    fs::create_dir(&output_dir).unwrap();
    image::RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]))
        .save(&input)
        .unwrap();

    let output = compress_images(serde_json::json!({
        "paths": [input],
        "output_dir": output_dir,
        "max_width": 100,
        "format": "webp"
    }))
    .unwrap();

    let item = &output["items"][0];
    let output_path = item["output"].as_str().unwrap();
    assert_eq!(item["format"], "webp");
    assert_eq!(item["status"], "compressed");
    assert!(output_path.ends_with("compressed-pixel.webp"));
    let bytes = fs::read(output_path).unwrap();
    assert_eq!(&bytes[0..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WEBP");
    assert!(item["original_size"].as_u64().unwrap() > 0);
    assert!(item["output_size"].as_u64().unwrap() > 0);
}

#[test]
fn compress_images_reports_met_size_target() {
    let temp = TempDir::new().unwrap();
    let input = temp.path().join("pixel.png");
    let output_dir = temp.path().join("out");
    fs::create_dir(&output_dir).unwrap();
    fs::write(
        &input,
        [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0,
            5, 0, 1, 13, 10, 42, 185, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ],
    )
    .unwrap();

    let output = compress_images(serde_json::json!({
        "paths": [input],
        "output_dir": output_dir,
        "max_width": 100,
        "max_bytes": 4096
    }))
    .unwrap();

    let item = &output["items"][0];
    assert_eq!(item["target_size"], 4096);
    assert_eq!(item["target_met"], true);
    assert_eq!(item["target_reason"], serde_json::Value::Null);
    assert!(item["compression_ratio"].as_f64().unwrap() > 0.0);
    assert!(item["output_size"].as_u64().unwrap() <= 4096);
}

#[test]
fn compress_images_reports_unmet_size_target_without_claiming_success() {
    let temp = TempDir::new().unwrap();
    let input = temp.path().join("pixel.png");
    let output_dir = temp.path().join("out");
    fs::create_dir(&output_dir).unwrap();
    fs::write(
        &input,
        [
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1,
            8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 0, 1, 0, 0,
            5, 0, 1, 13, 10, 42, 185, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
        ],
    )
    .unwrap();

    let output = compress_images(serde_json::json!({
        "paths": [input],
        "output_dir": output_dir,
        "max_width": 100,
        "max_bytes": 1
    }))
    .unwrap();

    let item = &output["items"][0];
    assert_eq!(item["status"], "target_unmet");
    assert_eq!(item["target_size"], 1);
    assert_eq!(item["target_met"], false);
    assert!(item["target_reason"]
        .as_str()
        .unwrap()
        .contains("Could not reach max_bytes"));
    assert!(item["output_size"].as_u64().unwrap() > 1);
}

#[cfg(target_os = "macos")]
#[test]
fn compress_images_does_not_mark_failed_sips_as_compressed() {
    let temp = TempDir::new().unwrap();
    let input = temp.path().join("not-an-image.txt");
    let output_dir = temp.path().join("out");
    fs::create_dir(&output_dir).unwrap();
    fs::write(&input, "plain text").unwrap();

    let error = compress_images(serde_json::json!({
        "paths": [input],
        "output_dir": output_dir,
        "max_width": 100
    }))
    .unwrap_err();

    assert!(error.contains("sips failed"));
}

#[tokio::test]
async fn ocr_image_uses_input_mime_type_in_local_request() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let temp = TempDir::new().unwrap();
    let input = temp.path().join("scan.jpg");
    fs::write(&input, [0xff, 0xd8, 0xff, 0xd9]).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/ocr", listener.local_addr().unwrap());
    let (body_tx, body_rx) = tokio::sync::oneshot::channel();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut buffer = vec![0; 4096];
        let bytes_read = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..bytes_read]).to_string();
        let _ = body_tx.send(request);
        let response_body = r#"{"ok":true,"text":"done"}"#;
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response_body.len(),
                    response_body
                )
                .as_bytes(),
            )
            .await
            .unwrap();
    });

    let result = ocr_image(serde_json::json!({ "path": input, "endpoint": endpoint }))
        .await
        .unwrap();
    let request = body_rx.await.unwrap();

    assert_eq!(result["text"], "done");
    assert!(request.contains("data:image/jpeg;base64,"));
}

#[tokio::test]
async fn ocr_image_returns_actionable_error_when_local_service_is_unavailable() {
    let temp = TempDir::new().unwrap();
    let input = temp.path().join("scan.gif");
    fs::write(&input, *b"GIF8").unwrap();

    let error = ocr_image(serde_json::json!({
        "path": input,
        "endpoint": "http://127.0.0.1:1/ocr"
    }))
    .await
    .unwrap_err();

    assert!(error.contains("Local OCR service is unavailable"));
    assert!(error.contains("Start the OCR service"));
}

#[test]
fn get_current_context_explains_empty_browser_foreground_and_finder_fields() {
    let context = get_current_context().unwrap();

    assert!(context.get("browser_url").is_some());
    assert!(context.get("foreground_app").is_some());
    assert!(context.get("finder_path").is_some());
    if context["browser_url"].is_null() {
        let reason = context["browser_url_reason"].as_str().unwrap();
        assert!(reason.len() > 10);
        assert!(!reason.contains("not implemented"));
    }
    if context["foreground_app"].is_null() {
        assert!(context["foreground_app_reason"].as_str().unwrap().len() > 10);
    }
    if context["finder_path"].is_null() {
        assert!(context["finder_path_reason"].as_str().unwrap().len() > 10);
    }
}

#[test]
fn builtin_tools_sync_to_database_and_list_enabled_tools() {
    let db = atools_core::Database::in_memory().unwrap();

    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();
    let tools = atools_lib::agent_tools::list_enabled_tools(&db).unwrap();

    assert!(tools.iter().any(|tool| tool.name == "find_local_files"));
    assert!(tools.iter().all(|tool| tool.enabled));

    db.set_agent_tool_enabled("find_local_files", false)
        .unwrap();
    let enabled = atools_lib::agent_tools::list_enabled_tools(&db).unwrap();
    assert!(!enabled.iter().any(|tool| tool.name == "find_local_files"));
}

#[test]
fn plugin_manifest_tools_sync_to_agent_whitelist_disabled_by_default() {
    let db = atools_core::Database::in_memory().unwrap();
    db.save_plugin(&sample_plugin_with_manifest_tool(true))
        .unwrap();

    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();

    let tools = db.list_agent_tools().unwrap();
    let plugin_tool = tools
        .iter()
        .find(|tool| tool.name == "plugin_clipboard_plus_search_history")
        .unwrap();
    assert_eq!(plugin_tool.source, "plugin");
    assert_eq!(plugin_tool.plugin_id.as_deref(), Some("clipboard-plus"));
    assert_eq!(
        plugin_tool.description,
        "Clipboard Plus: Search plugin clipboard history"
    );
    assert_eq!(
        plugin_tool.input_schema["properties"]["query"]["type"],
        "string"
    );
    assert_eq!(
        plugin_tool.output_schema.as_ref().unwrap()["properties"]["items"]["type"],
        "array"
    );
    assert_eq!(
        plugin_tool.scopes,
        vec![atools_core::agent::PermissionScope::PluginData]
    );
    assert!(!plugin_tool.enabled_by_default);
    assert!(!plugin_tool.enabled);
}

#[test]
fn enabled_tool_registry_includes_plugin_tool_only_after_user_enables_it() {
    let db = atools_core::Database::in_memory().unwrap();
    db.save_plugin(&sample_plugin_with_manifest_tool(true))
        .unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();
    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();

    assert!(atools_lib::agent_tools::enabled_tool_registry(&db)
        .unwrap()
        .get("plugin_clipboard_plus_search_history")
        .is_none());

    db.set_agent_tool_enabled("plugin_clipboard_plus_search_history", true)
        .unwrap();
    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();

    let decision = atools_lib::agent_tools::permission_decision_for_tool(
        &db,
        "mcp-http",
        "plugin_clipboard_plus_search_history",
    )
    .unwrap();
    assert_ne!(decision, atools_core::agent::PermissionDecision::Deny);

    assert!(atools_lib::agent_tools::enabled_tool_registry(&db)
        .unwrap()
        .get("plugin_clipboard_plus_search_history")
        .is_some());

    db.save_plugin(&sample_plugin_with_manifest_tool(false))
        .unwrap();
    atools_lib::agent_tools::sync_plugin_tools(&db).unwrap();
    assert!(db
        .list_agent_tools()
        .unwrap()
        .iter()
        .all(|tool| tool.name != "plugin_clipboard_plus_search_history"));
}

#[test]
fn permission_policy_uses_persisted_client_tool_grants() {
    let db = atools_core::Database::in_memory().unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();

    let before =
        atools_lib::agent_tools::permission_decision_for_tool(&db, "mcp-http", "find_local_files")
            .unwrap();
    assert_eq!(before, atools_core::agent::PermissionDecision::Confirm);

    db.grant_agent_tool("mcp-http", "find_local_files").unwrap();
    let after =
        atools_lib::agent_tools::permission_decision_for_tool(&db, "mcp-http", "find_local_files")
            .unwrap();
    assert_eq!(after, atools_core::agent::PermissionDecision::Allow);
}

#[test]
fn scope_policy_lists_all_scopes_and_restores_denied_scope_to_confirm() {
    let db = atools_core::Database::in_memory().unwrap();

    let policies = atools_lib::agent_tools::list_agent_scope_policies(&db).unwrap();
    let scopes: Vec<_> = policies
        .iter()
        .map(|policy| policy.scope.as_str())
        .collect();
    assert_eq!(
        scopes,
        vec![
            "clipboard_read",
            "clipboard_write",
            "file_read",
            "file_write",
            "network",
            "shell",
            "screenshot",
            "browser_context",
            "plugin_data",
            "system_settings",
        ]
    );
    assert!(policies.iter().all(|policy| policy.decision == "confirm"));
    assert_eq!(
        policies
            .iter()
            .filter(|policy| policy.high_risk)
            .map(|policy| policy.scope.as_str())
            .collect::<Vec<_>>(),
        vec![
            "file_write",
            "network",
            "shell",
            "screenshot",
            "system_settings"
        ]
    );

    let denied =
        atools_lib::agent_tools::set_agent_scope_policy(&db, "system_settings", "deny").unwrap();
    assert_eq!(
        denied
            .iter()
            .find(|policy| policy.scope == "system_settings")
            .map(|policy| policy.decision.as_str()),
        Some("deny")
    );

    let restored =
        atools_lib::agent_tools::set_agent_scope_policy(&db, "system_settings", "confirm").unwrap();
    assert_eq!(
        restored
            .iter()
            .find(|policy| policy.scope == "system_settings")
            .map(|policy| policy.decision.as_str()),
        Some("confirm")
    );
    assert!(atools_lib::agent_tools::list_agent_scope_policies(&db)
        .unwrap()
        .iter()
        .all(|policy| policy.decision == "confirm"));
}

#[test]
fn ask_ai_model_requires_network_scope_confirmation_in_conservative_mode() {
    let db = atools_core::Database::in_memory().unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();

    let tool = db
        .get_agent_tool("ask_ai_model")
        .unwrap()
        .expect("ask_ai_model tool");
    assert_eq!(
        tool.scopes,
        vec![atools_core::agent::PermissionScope::Network]
    );

    let decision =
        atools_lib::agent_tools::permission_decision_for_tool(&db, "mcp-http", "ask_ai_model")
            .unwrap();
    assert_eq!(decision, atools_core::agent::PermissionDecision::Confirm);

    let payload = atools_lib::agent_tools::build_permission_required_payload(
        &db,
        "mcp-http",
        "ask_ai_model",
        serde_json::json!({"prompt": "summarize private notes"}),
    )
    .unwrap();
    assert_eq!(payload["permission_required"], true);
    assert_eq!(payload["tool"], "ask_ai_model");
    assert_eq!(payload["arguments"]["prompt"], "summarize private notes");
    assert!(payload["scopes"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("network")));
}

#[test]
fn permission_policy_denies_blocked_scope_even_in_developer_mode() {
    let db = atools_core::Database::in_memory().unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();
    db.set_setting("agent.permission_mode", "developer")
        .unwrap();
    db.set_setting("agent.scope_policy", r#"{"shell":"deny"}"#)
        .unwrap();

    let decision = atools_lib::agent_tools::permission_decision_for_tool(
        &db,
        "mcp-http",
        "open_or_reveal_path",
    )
    .unwrap();

    assert_eq!(decision, atools_core::agent::PermissionDecision::Deny);
}

#[test]
fn confirmation_payload_contains_request_id_client_tool_and_scopes() {
    let db = atools_core::Database::in_memory().unwrap();
    atools_lib::agent_tools::sync_builtin_tools(&db).unwrap();

    let payload = atools_lib::agent_tools::build_permission_required_payload(
        &db,
        "mcp-http",
        "find_local_files",
        serde_json::json!({"query": "invoice"}),
    )
    .unwrap();

    assert_eq!(payload["permission_required"], true);
    assert!(payload["request_id"]
        .as_str()
        .unwrap()
        .starts_with("agent-confirm-"));
    assert_eq!(payload["client_id"], "mcp-http");
    assert_eq!(payload["tool"], "find_local_files");
    assert_eq!(payload["arguments"]["query"], "invoice");
    assert!(payload["scopes"]
        .as_array()
        .unwrap()
        .contains(&serde_json::json!("file_read")));
    assert_eq!(payload["retry_after_grant"], true);
}
