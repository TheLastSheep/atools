#![cfg(unix)]

use atools_core::PluginManifest;
use atools_plugin::{JsonRpcSidecar, McpSidecar, SidecarError, SidecarLaunchSpec, SidecarSupervisor};
use serde_json::json;
use std::os::unix::fs::PermissionsExt;
use std::time::Duration;

fn write_worker(directory: &std::path::Path) {
    let worker = directory.join("worker.py");
    std::fs::write(
        &worker,
        r#"#!/usr/bin/python3
import json
import sys
import time
import threading

write_lock = threading.Lock()

def emit(message):
    with write_lock:
        print(json.dumps(message), flush=True)

def emit_after(request_id, delay, value):
    time.sleep(delay)
    emit({"jsonrpc": "2.0", "id": request_id, "result": value})

for line in sys.stdin:
    message = json.loads(line)
    method = message.get("method")
    if "id" not in message:
        continue
    request_id = message["id"]
    params = message.get("params", {})
    if method == "initialize":
        result = {
            "protocolVersion": "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "fixture", "version": "1.0.0"}
        }
    elif method == "tools/list":
        result = {"tools": [{
            "name": "echo",
            "description": "Echo input",
            "inputSchema": {"type": "object"},
            "outputSchema": {"type": "object"}
        }]}
    elif method == "tools/call":
        result = {
            "content": [{"type": "text", "text": "echoed"}],
            "structuredContent": params.get("arguments", {}),
            "isError": False
        }
    elif method == "delay":
        time.sleep(0.25)
        result = {"late": True}
    elif method == "concurrent":
        delay = params.get("delay", 0) / 1000
        threading.Thread(target=emit_after, args=(request_id, delay, params), daemon=True).start()
        continue
    elif method == "crash":
        print("intentional crash", file=sys.stderr, flush=True)
        sys.exit(7)
    elif method == "fail":
        emit({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32001, "message": "fixture failure"}})
        continue
    else:
        result = {"method": method, "params": params}
    emit({"jsonrpc": "2.0", "id": request_id, "result": result})
"#,
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&worker).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(worker, permissions).unwrap();
}

fn manifest(transport: &str) -> PluginManifest {
    serde_json::from_value(json!({
        "name": "sidecar-fixture",
        "version": "1.0.0",
        "features": [],
        "runtime": {
            "kind": "rust",
            "compatibility": "native",
            "transport": transport,
            "entry": "worker.py"
        }
    }))
    .unwrap()
}

#[tokio::test]
async fn json_rpc_sidecar_routes_results_errors_timeouts_and_shutdown() {
    let temp = tempfile::tempdir().unwrap();
    write_worker(temp.path());
    let mut spec = SidecarLaunchSpec::from_manifest(
        "fixture-jsonrpc",
        temp.path(),
        &manifest("json_rpc_stdio"),
    )
    .unwrap();
    spec.request_timeout = Duration::from_secs(2);
    let supervisor = SidecarSupervisor::new();
    let process = supervisor.start(spec).await.unwrap();
    let client = JsonRpcSidecar::new(process.clone()).unwrap();

    let result = client.call("echo", json!({"value": 42})).await.unwrap();
    assert_eq!(result.structured_content, Some(json!({"method":"echo", "params":{"value":42}})));

    let error = client.call("fail", json!({})).await.unwrap_err();
    assert_eq!(
        error,
        SidecarError::Remote {
            code: -32001,
            message: "fixture failure".to_string()
        }
    );

    let (slow, fast) = tokio::join!(
        client.call("concurrent", json!({"label":"slow", "delay":120})),
        client.call("concurrent", json!({"label":"fast", "delay":10}))
    );
    assert_eq!(slow.unwrap().structured_content.unwrap()["label"], "slow");
    assert_eq!(fast.unwrap().structured_content.unwrap()["label"], "fast");

    let timeout = process
        .request_with_timeout("delay", json!({}), Duration::from_millis(80))
        .await
        .unwrap_err();
    assert_eq!(timeout, SidecarError::Timeout(80));
    supervisor.stop("fixture-jsonrpc").await.unwrap();
    assert!(supervisor.get("fixture-jsonrpc").await.is_none());
}

#[tokio::test]
async fn mcp_sidecar_initializes_lists_and_calls_tools() {
    let temp = tempfile::tempdir().unwrap();
    write_worker(temp.path());
    let spec = SidecarLaunchSpec::from_manifest(
        "fixture-mcp",
        temp.path(),
        &manifest("mcp_stdio"),
    )
    .unwrap();
    let supervisor = SidecarSupervisor::new();
    let process = supervisor.start(spec).await.unwrap();
    let client = McpSidecar::new(process).unwrap();

    let initialized = client.initialize().await.unwrap();
    assert_eq!(initialized.protocol_version, "2025-06-18");
    let tools = client.list_tools().await.unwrap();
    assert_eq!(tools.len(), 1);
    assert_eq!(tools[0].name, "echo");
    let result = client.call_tool("echo", json!({"value": 7})).await.unwrap();
    assert_eq!(result.structured_content, Some(json!({"value":7})));
    assert_eq!(result.content[0].text.as_deref(), Some("echoed"));
    supervisor.stop_all().await;
}

#[tokio::test]
async fn sidecar_reports_crash_and_captures_stderr() {
    let temp = tempfile::tempdir().unwrap();
    write_worker(temp.path());
    let spec = SidecarLaunchSpec::from_manifest(
        "fixture-crash",
        temp.path(),
        &manifest("json_rpc_stdio"),
    )
    .unwrap();
    let supervisor = SidecarSupervisor::new();
    let process = supervisor.start(spec).await.unwrap();
    let client = JsonRpcSidecar::new(process.clone()).unwrap();
    let error = client.call("crash", json!({})).await.unwrap_err();
    assert!(matches!(error, SidecarError::Crashed(_) | SidecarError::NotRunning));
    tokio::time::sleep(Duration::from_millis(80)).await;
    assert!(process
        .stderr_tail()
        .await
        .iter()
        .any(|line| line.contains("intentional crash")));
}

#[test]
fn sidecar_entry_must_remain_inside_plugin_directory() {
    let temp = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let manifest: PluginManifest = serde_json::from_value(json!({
        "name": "escape",
        "runtime": {
            "kind": "rust",
            "compatibility": "native",
            "transport": "json_rpc_stdio",
            "entry": outside.path()
        }
    }))
    .unwrap();
    assert!(matches!(
        SidecarLaunchSpec::from_manifest("escape", temp.path(), &manifest),
        Err(SidecarError::InvalidEntry(_))
    ));
}
