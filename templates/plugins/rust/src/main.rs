use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

fn result(method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "tools/list" => Ok(json!({ "tools": [{
            "name": "echo",
            "description": "Echo structured input through the Rust sidecar",
            "inputSchema": { "type": "object", "properties": { "message": { "type": "string" } }, "required": ["message"], "additionalProperties": false },
            "outputSchema": { "type": "object", "properties": { "message": { "type": "string" }, "runtime": { "const": "rust" } }, "required": ["message", "runtime"] }
        }] })),
        "tools/call" if params.get("name").and_then(Value::as_str) == Some("echo") => {
            let message = params
                .pointer("/arguments/message")
                .and_then(Value::as_str)
                .unwrap_or_default();
            Ok(json!({
                "content": [{ "type": "text", "text": message }],
                "structuredContent": { "message": message, "runtime": "rust" },
                "isError": false
            }))
        }
        "tools/call" => Err("unknown tool".to_string()),
        _ => Err(format!("unknown method: {method}")),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() { continue; }
        let request: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(error) => { eprintln!("invalid JSON-RPC request: {error}"); continue; }
        };
        let Some(id) = request.get("id").cloned() else { continue };
        let method = request.get("method").and_then(Value::as_str).unwrap_or_default();
        let params = request.get("params").cloned().unwrap_or_else(|| json!({}));
        let response = match result(method, &params) {
            Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
            Err(message) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": message } }),
        };
        writeln!(stdout, "{response}").expect("stdout write");
        stdout.flush().expect("stdout flush");
    }
}
