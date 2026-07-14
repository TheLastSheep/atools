use std::sync::Arc;

use atools_core::db::Database;
use atools_core::mcp::{handle_mcp_message_with_capabilities, McpToolCallRequest};
use atools_core::task_run::{TaskRun, TaskRunStatus};
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
        .unwrap_or_default()
        .to_string();
    payload.get("id")?;
    let registry = crate::agent_tools::enabled_tool_registry(&db)
        .unwrap_or_else(|_| crate::agent_tools::builtin_tool_registry());

    if matches!(
        method.as_str(),
        "tasks/get" | "tasks/result" | "tasks/cancel"
    ) {
        return handle_task_request(&app, &db, &payload, &method).await;
    }

    if method != "tools/call" {
        let skills = db.list_skills(false, 500).unwrap_or_default();
        let capabilities = crate::commands::capability_catalog_for_db(&db).unwrap_or_default();
        let response = handle_mcp_message_with_capabilities(
            &registry,
            &skills,
            &capabilities,
            payload,
            |_| atools_core::mcp::McpToolCallResult::success(json!({})),
        );
        return response.map(|response| augment_http_task_capabilities(response, &method));
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

    if let Some(task) = params.get("task") {
        if !valid_task_parameters(task) {
            return Some(json_rpc_error(
                id,
                -32602,
                "Invalid task parameters: ttl must be a non-negative integer".to_string(),
            ));
        }
        let run = match crate::commands::start_agent_tool_background(
            &app,
            name,
            arguments,
            "mcp-http".to_string(),
            false,
            None,
        ) {
            Ok(run) => run,
            Err(error) => return Some(json_rpc_error(id, -32603, error)),
        };
        return Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "task": task_run_to_mcp(&run),
                "_meta": {
                    "io.modelcontextprotocol/model-immediate-response":
                        format!("ATools started durable task {}. Poll tasks/get, then read tasks/result.", run.id),
                    "io.modelcontextprotocol/related-task": { "taskId": run.id }
                }
            }
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

    Some(tool_call_response(id, result, None))
}

fn valid_task_parameters(task: &Value) -> bool {
    let Some(task) = task.as_object() else {
        return false;
    };
    match task.get("ttl") {
        None => true,
        Some(ttl) => ttl.is_u64(),
    }
}

fn augment_http_task_capabilities(mut response: Value, method: &str) -> Value {
    if method == "initialize" {
        response["result"]["capabilities"]["tasks"] = json!({
            "cancel": {},
            "requests": {
                "tools": {
                    "call": {}
                }
            }
        });
    } else if method == "tools/list" {
        if let Some(tools) = response["result"]["tools"].as_array_mut() {
            for tool in tools {
                tool["execution"] = json!({ "taskSupport": "optional" });
            }
        }
    }
    response
}

async fn handle_task_request(
    app: &AppHandle,
    db: &Database,
    payload: &Value,
    method: &str,
) -> Option<Value> {
    let id = payload.get("id").cloned().unwrap_or(Value::Null);
    let task_id = payload
        .get("params")
        .and_then(|params| params.get("taskId"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if task_id.is_empty() {
        return Some(json_rpc_error(
            id,
            -32602,
            "Invalid params: taskId is required".to_string(),
        ));
    }

    let Some(run) = mcp_task_run(db, task_id) else {
        return Some(json_rpc_error(
            id,
            -32602,
            format!("Invalid or unknown taskId: {task_id}"),
        ));
    };

    match method {
        "tasks/get" => Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": task_run_to_mcp(&run)
        })),
        "tasks/cancel" => match crate::commands::cancel_task_run_by_id(app, task_id) {
            Ok(run) => Some(json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": task_run_to_mcp(&run)
            })),
            Err(error) => Some(json_rpc_error(id, -32602, error)),
        },
        "tasks/result" => {
            let mut current = run;
            while !current.status.is_terminal() {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                let Some(updated) = mcp_task_run(db, task_id) else {
                    return Some(json_rpc_error(
                        id,
                        -32602,
                        format!("Task no longer exists: {task_id}"),
                    ));
                };
                current = updated;
            }
            let result = crate::agent_tools::task_run_result(&current);
            Some(tool_call_response(id, result, Some(task_id)))
        }
        _ => Some(json_rpc_error(
            id,
            -32601,
            format!("Method not found: {method}"),
        )),
    }
}

fn mcp_task_run(db: &Database, task_id: &str) -> Option<TaskRun> {
    db.get_task_run(task_id)
        .ok()
        .flatten()
        .filter(|run| run.initiator.client_id.as_deref() == Some("mcp-http"))
}

fn task_run_to_mcp(run: &TaskRun) -> Value {
    let status = match run.status {
        TaskRunStatus::Created | TaskRunStatus::Running => "working",
        TaskRunStatus::AwaitingPermission => "input_required",
        TaskRunStatus::Partial | TaskRunStatus::Succeeded => "completed",
        TaskRunStatus::Failed => "failed",
        TaskRunStatus::Cancelled => "cancelled",
    };
    let status_message = run
        .summary
        .clone()
        .or_else(|| run.errors.first().map(|issue| issue.message.clone()));
    let mut task = json!({
        "taskId": run.id,
        "status": status,
        "createdAt": run.created_at,
        "lastUpdatedAt": run.updated_at,
        "ttl": Value::Null,
        "pollInterval": 250
    });
    if let Some(status_message) = status_message {
        task["statusMessage"] = Value::String(status_message);
    }
    task
}

fn tool_call_response(
    id: Value,
    result: atools_core::mcp::McpToolCallResult,
    related_task_id: Option<&str>,
) -> Value {
    let mut response = json!({
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
    });
    if let Some(task_id) = related_task_id {
        response["result"]["_meta"] = json!({
            "io.modelcontextprotocol/related-task": { "taskId": task_id }
        });
    }
    response
}

fn json_rpc_error(id: Value, code: i64, message: String) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
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

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::task_run::TaskRunInitiator;

    fn run_with_status(status: TaskRunStatus) -> TaskRun {
        let mut run = TaskRun::new("test_tool", TaskRunInitiator::agent("mcp-http"), json!({}));
        match status {
            TaskRunStatus::Created => {}
            TaskRunStatus::AwaitingPermission => {
                run.transition(TaskRunStatus::AwaitingPermission).unwrap();
            }
            TaskRunStatus::Running => {
                run.transition(TaskRunStatus::Running).unwrap();
            }
            TaskRunStatus::Partial
            | TaskRunStatus::Succeeded
            | TaskRunStatus::Failed
            | TaskRunStatus::Cancelled => {
                run.transition(TaskRunStatus::Running).unwrap();
                run.transition(status).unwrap();
            }
        }
        run
    }

    #[test]
    fn maps_task_run_statuses_to_mcp_tasks() {
        let cases = [
            (TaskRunStatus::Created, "working"),
            (TaskRunStatus::AwaitingPermission, "input_required"),
            (TaskRunStatus::Running, "working"),
            (TaskRunStatus::Partial, "completed"),
            (TaskRunStatus::Succeeded, "completed"),
            (TaskRunStatus::Failed, "failed"),
            (TaskRunStatus::Cancelled, "cancelled"),
        ];
        for (status, expected) in cases {
            let task = task_run_to_mcp(&run_with_status(status));
            assert_eq!(task["status"], expected);
            assert_eq!(task["ttl"], Value::Null);
            assert_eq!(task["pollInterval"], 250);
        }
    }

    #[test]
    fn augments_only_running_http_mcp_with_task_capabilities() {
        let response = json!({
            "result": {
                "capabilities": { "tools": {} }
            }
        });
        let response = augment_http_task_capabilities(response, "initialize");
        assert_eq!(
            response["result"]["capabilities"]["tasks"]["requests"]["tools"]["call"],
            json!({})
        );
        assert_eq!(
            response["result"]["capabilities"]["tasks"]["cancel"],
            json!({})
        );

        let response = augment_http_task_capabilities(
            json!({ "result": { "tools": [{ "name": "test_tool" }] } }),
            "tools/list",
        );
        assert_eq!(
            response["result"]["tools"][0]["execution"]["taskSupport"],
            "optional"
        );
    }

    #[test]
    fn validates_task_ttl_shape() {
        assert!(valid_task_parameters(&json!({})));
        assert!(valid_task_parameters(&json!({ "ttl": 60_000 })));
        assert!(!valid_task_parameters(&json!({ "ttl": -1 })));
        assert!(!valid_task_parameters(&json!({ "ttl": 1.5 })));
        assert!(!valid_task_parameters(&json!(true)));
    }
}
