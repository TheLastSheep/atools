use std::sync::Arc;

use atools_core::db::Database;
use atools_core::mcp::{handle_mcp_message_with_capabilities, McpToolCallRequest};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerStatus {
    pub enabled: bool,
    pub bind: String,
    pub token: String,
}

pub async fn start(app: AppHandle, db: Arc<Database>) -> Result<McpServerStatus, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let bind = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .to_string();
    let token = atools_core::utils::generate_rev();
    let token_for_loop = token.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let app = app.clone();
                    let db = db.clone();
                    let token = token_for_loop.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(error) = handle_connection(stream, app, db, token).await {
                            tracing::warn!("MCP connection failed: {}", error);
                        }
                    });
                }
                Err(error) => {
                    tracing::warn!("MCP accept failed: {}", error);
                    break;
                }
            }
        }
    });

    Ok(McpServerStatus {
        enabled: true,
        bind,
        token,
    })
}

async fn handle_connection(
    mut stream: TcpStream,
    app: AppHandle,
    db: Arc<Database>,
    token: String,
) -> Result<(), String> {
    let mut buffer = vec![0u8; 1024 * 1024];
    let read = stream.read(&mut buffer).await.map_err(|e| e.to_string())?;
    if read == 0 {
        return Ok(());
    }
    let request = String::from_utf8_lossy(&buffer[..read]).to_string();
    let (headers, body) = split_http_request(&request)?;
    let first_line = headers.lines().next().unwrap_or_default();

    if first_line.starts_with("GET /health ") {
        return write_json(
            &mut stream,
            200,
            json!({ "ok": true, "server": "atools-mcp" }),
        )
        .await;
    }

    if !first_line.starts_with("POST /mcp ") {
        return write_json(&mut stream, 404, json!({ "error": "not_found" })).await;
    }

    if !headers
        .lines()
        .any(|line| line.eq_ignore_ascii_case(&format!("authorization: bearer {}", token)))
    {
        return write_json(&mut stream, 401, json!({ "error": "unauthorized" })).await;
    }

    let payload: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let response = handle_mcp_payload(app, db, payload).await;
    match response {
        Some(response) => write_json(&mut stream, 200, response).await,
        None => write_empty(&mut stream, 204).await,
    }
}

async fn handle_mcp_payload(app: AppHandle, db: Arc<Database>, payload: Value) -> Option<Value> {
    if let Some(batch) = payload.as_array() {
        if batch.is_empty() {
            return Some(json!({
                "jsonrpc": "2.0",
                "id": Value::Null,
                "error": {
                    "code": -32600,
                    "message": "Invalid Request: batch must not be empty"
                }
            }));
        }

        let mut responses = Vec::new();
        for message in batch {
            if let Some(response) =
                handle_single_mcp_payload(app.clone(), db.clone(), message.clone()).await
            {
                responses.push(response);
            }
        }

        return (!responses.is_empty()).then_some(Value::Array(responses));
    }

    handle_single_mcp_payload(app, db, payload).await
}

async fn handle_single_mcp_payload(
    app: AppHandle,
    db: Arc<Database>,
    payload: Value,
) -> Option<Value> {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();
    payload.get("id")?;
    let registry = crate::agent_tools::enabled_tool_registry(&db)
        .unwrap_or_else(|_| crate::agent_tools::builtin_tool_registry());

    if method != "tools/call" {
        let skills = db.list_skills(false, 500).unwrap_or_default();
        let capabilities = crate::commands::capability_catalog_for_db(&db).unwrap_or_default();
        return handle_mcp_message_with_capabilities(
            &registry,
            &skills,
            &capabilities,
            payload,
            |_| atools_core::mcp::McpToolCallResult::success(json!({})),
        );
    }

    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    let params = payload.get("params").cloned().unwrap_or_else(|| json!({}));
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    if registry.get(&name).is_none() {
        return Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32602, "message": format!("Unknown tool: {}", name) }
        }));
    }

    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &db,
        "mcp-http",
        &name,
        arguments.clone(),
        false,
    )
    .await;
    let request = McpToolCallRequest { name, arguments };
    tracing::debug!("MCP tool call handled: {}", request.name);

    Some(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "content": [{
                "type": "text",
                "text": serde_json::to_string(&result.structured_content).unwrap_or_default()
            }],
            "structuredContent": result.structured_content,
            "isError": result.is_error
        }
    }))
}

fn split_http_request(request: &str) -> Result<(String, String), String> {
    let (headers, body) = request
        .split_once("\r\n\r\n")
        .ok_or_else(|| "Invalid HTTP request".to_string())?;
    Ok((headers.to_string(), body.to_string()))
}

async fn write_json(stream: &mut TcpStream, status: u16, payload: Value) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "OK",
    };
    let body = serde_json::to_vec(&payload).map_err(|e| e.to_string())?;
    let header = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nAccess-Control-Allow-Origin: http://127.0.0.1\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        status,
        reason,
        body.len()
    );
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(&body).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn write_empty(stream: &mut TcpStream, status: u16) -> Result<(), String> {
    let reason = match status {
        204 => "No Content",
        _ => "OK",
    };
    let header = format!(
        "HTTP/1.1 {} {}\r\nAccess-Control-Allow-Origin: http://127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        status, reason
    );
    stream
        .write_all(header.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}
