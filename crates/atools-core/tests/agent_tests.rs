use atools_core::agent::{
    AuditLogEntry, AuditLogPage, AuditLogQuery, AuditStatus, PermissionDecision, PermissionMode,
    PermissionPolicy, PermissionRequest, PermissionScope, ToolDefinition, ToolRegistry,
};
use atools_core::mcp::{handle_static_mcp_message, handle_static_mcp_request, McpToolCallResult};
use atools_core::Database;
use serde_json::json;

fn sample_tool(name: &str) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: "Sample tool".to_string(),
        input_schema: json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": { "type": "string" }
            }
        }),
        output_schema: Some(json!({
            "type": "object",
            "properties": {
                "ok": { "type": "boolean" }
            }
        })),
        scopes: vec![PermissionScope::ClipboardRead],
        enabled_by_default: true,
        enabled: true,
        source: "builtin".to_string(),
        plugin_id: None,
    }
}

#[test]
fn manifest_tools_parse_ztools_shape() {
    let manifest: atools_core::models::PluginManifest = serde_json::from_value(json!({
        "name": "clipboard",
        "version": "1.0.0",
        "main": "index.html",
        "features": [],
        "tools": {
            "search_history": {
                "description": "搜索剪贴板历史记录",
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
    .unwrap();

    let tool = manifest.tools.get("search_history").unwrap();
    assert_eq!(tool.description, "搜索剪贴板历史记录");
    assert_eq!(tool.input_schema["type"], "object");
    assert_eq!(
        tool.output_schema.as_ref().unwrap()["properties"]["items"]["type"],
        "array"
    );
}

#[test]
fn permission_policy_matches_user_selectable_modes() {
    let request = PermissionRequest {
        client_id: "codex".to_string(),
        tool_name: "rename_files".to_string(),
        scopes: vec![PermissionScope::FileWrite],
        mutates: true,
    };

    let conservative = PermissionPolicy::new(PermissionMode::Conservative);
    assert_eq!(conservative.evaluate(&request), PermissionDecision::Confirm);

    let mut per_tool = PermissionPolicy::new(PermissionMode::PerTool);
    per_tool.grant_tool("codex", "rename_files");
    assert_eq!(per_tool.evaluate(&request), PermissionDecision::Allow);

    let developer = PermissionPolicy::new(PermissionMode::Developer);
    assert_eq!(developer.evaluate(&request), PermissionDecision::Allow);
}

#[test]
fn audit_entry_is_fully_replayable_json() {
    let entry = AuditLogEntry::new(
        "codex",
        "find_local_files",
        json!({"root": "/tmp", "query": "invoice"}),
        AuditStatus::Allowed,
    )
    .with_output(json!({"items": ["/tmp/invoice.pdf"]}))
    .with_duration_ms(12);

    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(value["client_id"], "codex");
    assert_eq!(value["tool_name"], "find_local_files");
    assert_eq!(value["input"]["query"], "invoice");
    assert_eq!(value["output"]["items"][0], "/tmp/invoice.pdf");
    assert_eq!(value["duration_ms"], 12);
}

#[test]
fn mcp_static_handler_exposes_initialize_list_and_call_shapes() {
    let mut registry = ToolRegistry::default();
    registry.register(sample_tool("search_clipboard"));

    let init = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {},
                "clientInfo": { "name": "test", "version": "0.0.0" }
            }
        }),
        |_| McpToolCallResult::success(json!({"ok": true})),
    );
    assert_eq!(init["result"]["serverInfo"]["name"], "atools");
    assert_eq!(init["result"]["capabilities"]["tools"]["listChanged"], true);
    assert_eq!(init["result"]["capabilities"]["resources"], json!({}));
    assert_eq!(init["result"]["capabilities"]["prompts"], json!({}));

    let list = handle_static_mcp_request(
        &registry,
        json!({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}),
        |_| McpToolCallResult::success(json!({"ok": true})),
    );
    assert_eq!(list["result"]["tools"][0]["name"], "search_clipboard");
    assert_eq!(list["result"]["tools"][0]["inputSchema"]["type"], "object");

    let call = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "search_clipboard",
                "arguments": { "query": "token" }
            }
        }),
        |request| {
            assert_eq!(request.name, "search_clipboard");
            assert_eq!(request.arguments["query"], "token");
            McpToolCallResult::success(json!({"items": []}))
        },
    );
    assert_eq!(
        call["result"]["structuredContent"]["items"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    assert_eq!(call["result"]["isError"], false);
}

#[test]
fn mcp_tools_list_includes_user_enabled_plugin_tools() {
    let mut plugin_tool = sample_tool("plugin_clipboard_plus_search_history");
    plugin_tool.enabled_by_default = false;
    plugin_tool.enabled = true;
    plugin_tool.source = "plugin".to_string();
    plugin_tool.plugin_id = Some("clipboard-plus".to_string());

    let mut registry = ToolRegistry::default();
    registry.register(plugin_tool);

    let listed = handle_static_mcp_request(
        &registry,
        json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}),
        |_| McpToolCallResult::success(json!({"ok": true})),
    );

    let tools = listed["result"]["tools"].as_array().expect("tools list");
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0]["name"], "plugin_clipboard_plus_search_history");
}

#[test]
fn mcp_static_handler_exposes_empty_resource_templates_list() {
    let registry = ToolRegistry::default();

    let templates = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 12,
            "method": "resources/templates/list"
        }),
        |_| panic!("resources/templates/list must not call tools"),
    );
    assert_eq!(templates["jsonrpc"], "2.0");
    assert_eq!(templates["id"], 12);
    assert_eq!(templates["result"]["resourceTemplates"], json!([]));
    assert!(templates["result"].get("nextCursor").is_none());
}

#[test]
fn mcp_static_handler_exposes_builtin_agent_tools_resource_and_read() {
    let mut registry = ToolRegistry::default();
    registry.register(sample_tool("search_clipboard"));
    registry.register(sample_tool("find_local_files"));

    let list = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "resources/list"
        }),
        |_| panic!("resources/list must not call tools"),
    );
    assert_eq!(list["jsonrpc"], "2.0");
    assert_eq!(list["id"], 21);
    assert_eq!(
        list["result"]["resources"][0]["uri"],
        "atools://agent/tools"
    );
    assert_eq!(list["result"]["resources"][0]["name"], "agent_tools");
    assert_eq!(
        list["result"]["resources"][0]["mimeType"],
        "application/json"
    );

    let resource = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "resources/read",
            "params": { "uri": "atools://agent/tools" }
        }),
        |_| panic!("resources/read must not call tools"),
    );
    assert_eq!(resource["jsonrpc"], "2.0");
    assert_eq!(resource["id"], 22);
    assert_eq!(
        resource["result"]["contents"][0]["uri"],
        "atools://agent/tools"
    );
    assert_eq!(
        resource["result"]["contents"][0]["mimeType"],
        "application/json"
    );
    let text = resource["result"]["contents"][0]["text"].as_str().unwrap();
    assert!(text.contains("search_clipboard"));
    assert!(text.contains("find_local_files"));
    assert!(text.contains("inputSchema"));

    let missing = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 23,
            "method": "resources/read",
            "params": { "uri": "atools://agent/missing" }
        }),
        |_| panic!("missing resources/read must not call tools"),
    );
    assert_eq!(missing["error"]["code"], -32002);
}

#[test]
fn mcp_static_handler_exposes_builtin_prompt_catalog_and_get() {
    let registry = ToolRegistry::default();

    let list = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 31,
            "method": "prompts/list"
        }),
        |_| panic!("prompts/list must not call tools"),
    );
    assert_eq!(list["jsonrpc"], "2.0");
    assert_eq!(list["id"], 31);
    assert_eq!(
        list["result"]["prompts"][0]["name"],
        "atools_agent_tool_guide"
    );
    assert_eq!(list["result"]["prompts"][0]["arguments"][0]["name"], "task");
    assert_eq!(
        list["result"]["prompts"][0]["arguments"][0]["required"],
        false
    );

    let prompt = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 32,
            "method": "prompts/get",
            "params": {
                "name": "atools_agent_tool_guide",
                "arguments": {
                    "task": "find recent screenshots"
                }
            }
        }),
        |_| panic!("prompts/get must not call tools"),
    );
    assert_eq!(prompt["jsonrpc"], "2.0");
    assert_eq!(prompt["id"], 32);
    assert_eq!(
        prompt["result"]["description"],
        "Guide for choosing ATools local Agent tools"
    );
    assert_eq!(prompt["result"]["messages"][0]["role"], "user");
    let text = prompt["result"]["messages"][0]["content"]["text"]
        .as_str()
        .unwrap();
    assert!(text.contains("find_local_files"));
    assert!(text.contains("search_clipboard"));
    assert!(text.contains("find recent screenshots"));

    let unknown = handle_static_mcp_request(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 33,
            "method": "prompts/get",
            "params": { "name": "missing_prompt" }
        }),
        |_| panic!("unknown prompts/get must not call tools"),
    );
    assert_eq!(unknown["error"]["code"], -32602);
}

#[test]
fn mcp_static_handler_accepts_initialized_notification_without_response() {
    let registry = ToolRegistry::default();
    let response = handle_static_mcp_message(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
        |_| panic!("initialized notification must not call tools"),
    );

    assert!(response.is_none());
}

#[test]
fn mcp_static_handler_treats_idless_requests_as_notifications() {
    let mut registry = ToolRegistry::default();
    registry.register(sample_tool("search_clipboard"));

    let ping_response = handle_static_mcp_message(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "method": "ping"
        }),
        |_| panic!("id-less ping notification must not call tools"),
    );
    assert!(ping_response.is_none());

    let tools_call_response = handle_static_mcp_message(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": "search_clipboard",
                "arguments": { "query": "token" }
            }
        }),
        |_| panic!("id-less tools/call notification must not execute tools"),
    );
    assert!(tools_call_response.is_none());
}

#[test]
fn mcp_static_handler_responds_to_ping() {
    let registry = ToolRegistry::default();
    let response = handle_static_mcp_message(
        &registry,
        json!({
            "jsonrpc": "2.0",
            "id": 99,
            "method": "ping"
        }),
        |_| panic!("ping must not call tools"),
    )
    .unwrap();

    assert_eq!(response["jsonrpc"], "2.0");
    assert_eq!(response["id"], 99);
    assert_eq!(response["result"], json!({}));
}

#[test]
fn mcp_static_handler_handles_json_rpc_batches() {
    let mut registry = ToolRegistry::default();
    registry.register(sample_tool("search_clipboard"));

    let response = handle_static_mcp_message(
        &registry,
        json!([
            { "jsonrpc": "2.0", "id": 101, "method": "ping" },
            { "jsonrpc": "2.0", "method": "notifications/initialized" },
            { "jsonrpc": "2.0", "id": 102, "method": "tools/list" }
        ]),
        |_| panic!("batch ping/list must not call tools"),
    )
    .unwrap();

    let responses = response.as_array().unwrap();
    assert_eq!(responses.len(), 2);
    assert_eq!(responses[0]["id"], 101);
    assert_eq!(responses[0]["result"], json!({}));
    assert_eq!(responses[1]["id"], 102);
    assert_eq!(
        responses[1]["result"]["tools"][0]["name"],
        "search_clipboard"
    );

    let all_notifications = handle_static_mcp_message(
        &registry,
        json!([{ "jsonrpc": "2.0", "method": "notifications/initialized" }]),
        |_| panic!("notification-only batch must not call tools"),
    );
    assert!(all_notifications.is_none());

    let empty_batch = handle_static_mcp_message(&registry, json!([]), |_| {
        panic!("empty batch must not call tools")
    })
    .unwrap();
    assert_eq!(empty_batch["error"]["code"], -32600);
}

#[test]
fn audit_entries_round_trip_through_database() {
    let db = Database::in_memory().unwrap();
    let entry = AuditLogEntry::new(
        "claude-code",
        "search_clipboard",
        json!({"query": "invoice"}),
        AuditStatus::Confirmed,
    )
    .with_output(json!({"items": [{"text": "invoice-001"}]}))
    .with_duration_ms(7);

    db.insert_audit_entry(&entry).unwrap();
    let entries = db.list_audit_entries(10).unwrap();

    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].client_id, "claude-code");
    assert_eq!(entries[0].tool_name, "search_clipboard");
    assert_eq!(entries[0].input["query"], "invoice");
    assert_eq!(entries[0].output["items"][0]["text"], "invoice-001");

    assert_eq!(db.clear_audit_entries().unwrap(), 1);
    assert!(db.list_audit_entries(10).unwrap().is_empty());
}

#[test]
fn agent_tools_round_trip_through_database_with_enabled_state() {
    let db = Database::in_memory().unwrap();
    let tool = ToolDefinition {
        name: "find_local_files".to_string(),
        description: "Find local files".to_string(),
        input_schema: json!({"type": "object"}),
        output_schema: Some(json!({"type": "object"})),
        scopes: vec![PermissionScope::FileRead],
        enabled_by_default: true,
        enabled: true,
        source: "builtin".to_string(),
        plugin_id: None,
    };

    db.sync_agent_tools(std::slice::from_ref(&tool)).unwrap();
    let tools = db.list_agent_tools().unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "find_local_files");
    assert!(tools[0].enabled);

    db.set_agent_tool_enabled("find_local_files", false)
        .unwrap();
    let disabled = db.get_agent_tool("find_local_files").unwrap().unwrap();
    assert!(!disabled.enabled);
}

#[test]
fn agent_tool_grants_round_trip_by_client_and_tool() {
    let db = Database::in_memory().unwrap();

    assert!(!db
        .is_agent_tool_granted("mcp-http", "find_local_files")
        .unwrap());
    db.grant_agent_tool("mcp-http", "find_local_files").unwrap();
    assert!(db
        .is_agent_tool_granted("mcp-http", "find_local_files")
        .unwrap());

    let grants = db.list_agent_tool_grants().unwrap();
    assert_eq!(grants.len(), 1);
    assert_eq!(grants[0].client_id, "mcp-http");
    assert_eq!(grants[0].tool_name, "find_local_files");

    assert!(db
        .revoke_agent_tool("mcp-http", "find_local_files")
        .unwrap());
    assert!(!db
        .is_agent_tool_granted("mcp-http", "find_local_files")
        .unwrap());
}

#[test]
fn audit_entries_export_as_jsonl() {
    let db = Database::in_memory().unwrap();
    let entry = AuditLogEntry::new(
        "mcp-http",
        "find_local_files",
        json!({"query": "invoice"}),
        AuditStatus::Allowed,
    )
    .with_output(json!({"items": []}))
    .with_duration_ms(9);
    db.insert_audit_entry(&entry).unwrap();

    let jsonl = db.export_audit_entries_jsonl(100).unwrap();
    let lines: Vec<&str> = jsonl.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(value["client_id"], "mcp-http");
    assert_eq!(value["tool_name"], "find_local_files");
}

#[test]
fn audit_entries_query_and_filtered_export_match_frontend_filters() {
    let db = Database::in_memory().unwrap();

    let mut rename = AuditLogEntry::new(
        "codex",
        "rename_files",
        json!({
            "operations": [{
                "source": "/Users/harris/Downloads/invoice.pdf",
                "target": "/Users/harris/Documents/Invoices/invoice.pdf"
            }]
        }),
        AuditStatus::Confirmed,
    )
    .with_output(json!({
        "operations": [{
            "source": "/Users/harris/Downloads/invoice.pdf",
            "target": "/Users/harris/Documents/Invoices/invoice.pdf",
            "status": "renamed"
        }]
    }))
    .with_duration_ms(42);
    rename.id = "audit-rename".to_string();
    rename.timestamp = "2026-06-02T10:00:00Z".to_string();

    let mut denied = AuditLogEntry::new(
        "claude",
        "find_local_files",
        json!({ "root": "/Users/harris/Downloads", "query": "invoice" }),
        AuditStatus::Denied,
    )
    .with_error("Permission confirmation required");
    denied.id = "audit-denied".to_string();
    denied.timestamp = "2026-06-02T10:01:00Z".to_string();

    let mut ocr = AuditLogEntry::new(
        "cursor",
        "ocr_image",
        json!({ "path": "/Users/harris/Desktop/receipt.png" }),
        AuditStatus::Error,
    )
    .with_error("Local OCR service is unavailable");
    ocr.id = "audit-ocr".to_string();
    ocr.timestamp = "2026-06-02T10:02:00Z".to_string();

    let mut clipboard = AuditLogEntry::new(
        "codex",
        "search_clipboard",
        json!({ "query": "api key" }),
        AuditStatus::Allowed,
    )
    .with_output(json!({ "items": [{ "text": "api key copied last week" }] }));
    clipboard.id = "audit-clipboard".to_string();
    clipboard.timestamp = "2026-06-02T10:03:00Z".to_string();

    for entry in [&rename, &denied, &ocr, &clipboard] {
        db.insert_audit_entry(entry).unwrap();
    }

    let success = db
        .query_audit_entries(&AuditLogQuery {
            limit: 50,
            offset: 0,
            status: Some("success".to_string()),
            tool_name: Some("rename_files".to_string()),
            client_id: Some("codex".to_string()),
            query: Some("invoice".to_string()),
        })
        .unwrap();
    assert_eq!(
        success
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["audit-rename"]
    );

    let error = db
        .query_audit_entries(&AuditLogQuery {
            limit: 50,
            status: Some("error".to_string()),
            query: Some("ocr service".to_string()),
            ..AuditLogQuery::default()
        })
        .unwrap();
    assert_eq!(error[0].id, "audit-ocr");

    let denied_matches = db
        .query_audit_entries(&AuditLogQuery {
            limit: 50,
            status: Some("denied".to_string()),
            query: Some("permission".to_string()),
            ..AuditLogQuery::default()
        })
        .unwrap();
    assert_eq!(denied_matches[0].id, "audit-denied");

    let jsonl = db
        .export_audit_entries_jsonl_filtered(&AuditLogQuery {
            limit: 50,
            status: Some("success".to_string()),
            client_id: Some("codex".to_string()),
            query: Some("api key".to_string()),
            ..AuditLogQuery::default()
        })
        .unwrap();
    let lines: Vec<&str> = jsonl.lines().collect();
    assert_eq!(lines.len(), 1);
    let value: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(value["id"], "audit-clipboard");
}

#[test]
fn audit_entries_query_page_returns_total_and_offset_window() {
    let db = Database::in_memory().unwrap();

    for index in 0..5 {
        let mut entry = AuditLogEntry::new(
            "codex",
            if index == 4 {
                "search_clipboard"
            } else {
                "find_local_files"
            },
            json!({ "query": format!("invoice-{index}") }),
            if index == 4 {
                AuditStatus::Denied
            } else {
                AuditStatus::Allowed
            },
        );
        entry.id = format!("audit-{index}");
        entry.timestamp = format!("2026-06-02T10:0{index}:00Z");
        db.insert_audit_entry(&entry).unwrap();
    }

    let page: AuditLogPage = db
        .query_audit_entries_page(&AuditLogQuery {
            limit: 2,
            offset: 1,
            status: Some("success".to_string()),
            client_id: Some("codex".to_string()),
            query: Some("invoice".to_string()),
            ..AuditLogQuery::default()
        })
        .unwrap();

    assert_eq!(page.total, 4);
    assert_eq!(page.limit, 2);
    assert_eq!(page.offset, 1);
    assert_eq!(
        page.entries
            .iter()
            .map(|entry| entry.id.as_str())
            .collect::<Vec<_>>(),
        vec!["audit-2", "audit-1"]
    );
}
