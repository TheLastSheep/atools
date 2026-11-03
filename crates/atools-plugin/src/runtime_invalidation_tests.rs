use super::{drain_one_callback, IpcCallback, JsRuntime};
use crate::bridge::IpcResult;
use crate::ipc_handler::{IpcError, IpcHandler};
use crate::node_preload::NodePreloadBridge;
use anyhow::Result;
use async_trait::async_trait;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;

struct NoopHandler;

#[async_trait]
impl IpcHandler for NoopHandler {
    async fn handle(
        &self,
        _plugin_id: &str,
        _method: &str,
        _args: Vec<serde_json::Value>,
    ) -> Result<serde_json::Value, IpcError> {
        Ok(serde_json::Value::Null)
    }
}

fn runtime() -> JsRuntime {
    JsRuntime::new(Arc::new(NoopHandler)).expect("create test runtime")
}

struct HeldCall {
    args: Vec<serde_json::Value>,
    finish: tokio::sync::oneshot::Sender<std::result::Result<serde_json::Value, IpcError>>,
}

struct HeldHandler {
    calls: tokio::sync::mpsc::UnboundedSender<HeldCall>,
}

#[async_trait]
impl IpcHandler for HeldHandler {
    async fn handle(
        &self,
        _plugin_id: &str,
        _method: &str,
        args: Vec<serde_json::Value>,
    ) -> std::result::Result<serde_json::Value, IpcError> {
        let (finish, result) = tokio::sync::oneshot::channel();
        self.calls
            .send(HeldCall { args, finish })
            .map_err(|_| IpcError::Internal("test handler receiver closed".into()))?;
        result
            .await
            .map_err(|_| IpcError::Internal("test completion sender dropped".into()))?
    }
}

async fn next_held_call(calls: &mut tokio::sync::mpsc::UnboundedReceiver<HeldCall>) -> HeldCall {
    tokio::time::timeout(std::time::Duration::from_secs(3), calls.recv())
        .await
        .expect("timed out waiting for IPC handler")
        .expect("IPC handler channel closed")
}

async fn wait_for_outcome(runtime: &JsRuntime, expected: &str) -> serde_json::Value {
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let result = runtime
                .call_function("reused-plugin", "readOutcome", vec![json!({})])
                .await
                .expect("read promise outcome");
            if result != json!("pending") {
                return result;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("promise never settled to {expected}"))
}

async fn read_runtime_value(runtime: &JsRuntime, plugin_id: &str) -> serde_json::Value {
    runtime
        .call_function(plugin_id, "readRuntimeValue", vec![json!({})])
        .await
        .expect("call plugin value")
}

#[tokio::test]
async fn invalidation_removes_only_target_context_and_allows_same_id_reload() {
    let runtime = runtime();
    runtime
        .execute_preload(
            "updated-plugin",
            "globalThis.packageVersion = '1.0.0'; globalThis.readRuntimeValue = () => 'old preload:' + packageVersion;",
        )
        .await
        .unwrap();
    runtime
        .execute_preload(
            "other-plugin",
            "globalThis.readRuntimeValue = () => 'other remains';",
        )
        .await
        .unwrap();
    assert_eq!(
        read_runtime_value(&runtime, "updated-plugin").await,
        json!("old preload:1.0.0")
    );

    runtime.invalidate_plugin("updated-plugin").await.unwrap();
    let missing = runtime
        .call_function("updated-plugin", "readRuntimeValue", vec![json!({})])
        .await
        .unwrap_err()
        .to_string();
    assert!(missing.contains("Context not found"), "{missing}");
    assert_eq!(
        read_runtime_value(&runtime, "other-plugin").await,
        json!("other remains")
    );

    // The runtime has no package-version cache: a newly loaded preload for the
    // same stable ID replaces the removed context, even with the same version.
    runtime
        .execute_preload(
            "updated-plugin",
            "globalThis.packageVersion = '1.0.0'; globalThis.readRuntimeValue = () => 'new preload:' + packageVersion;",
        )
        .await
        .unwrap();
    assert_eq!(
        read_runtime_value(&runtime, "updated-plugin").await,
        json!("new preload:1.0.0")
    );
    assert_eq!(
        read_runtime_value(&runtime, "other-plugin").await,
        json!("other remains")
    );
}

#[tokio::test]
async fn invalidation_drops_node_bridge_metadata_and_repeats_safely() {
    let runtime = runtime();
    runtime
        .execute_preload("node-plugin", "globalThis.marker = true;")
        .await
        .unwrap();
    runtime.node_bridges.write().unwrap().insert(
        "node-plugin".into(),
        NodePreloadBridge::new(
            std::path::PathBuf::from("/synthetic/plugin"),
            "preload.cjs".into(),
        ),
    );
    runtime.node_bridges.write().unwrap().insert(
        "other-node-plugin".into(),
        NodePreloadBridge::new(
            std::path::PathBuf::from("/synthetic/other-plugin"),
            "preload.cjs".into(),
        ),
    );
    assert!(runtime
        .node_bridges
        .read()
        .unwrap()
        .contains_key("node-plugin"));

    runtime.invalidate_plugin("node-plugin").await.unwrap();
    assert!(!runtime
        .node_bridges
        .read()
        .unwrap()
        .contains_key("node-plugin"));
    assert!(runtime
        .node_bridges
        .read()
        .unwrap()
        .contains_key("other-node-plugin"));
    runtime.invalidate_plugin("node-plugin").await.unwrap();
    runtime
        .invalidate_plugin("never-loaded-plugin")
        .await
        .unwrap();
    let missing = runtime
        .call_function("node-plugin", "marker", vec![json!({})])
        .await
        .unwrap_err()
        .to_string();
    assert!(missing.contains("Context not found"), "{missing}");
}

#[tokio::test]
async fn late_ipc_completion_cannot_resolve_reincarnated_context_request() {
    let (call_tx, mut calls) = tokio::sync::mpsc::unbounded_channel();
    let runtime = JsRuntime::new(Arc::new(HeldHandler { calls: call_tx })).unwrap();
    let preload = r#"
        globalThis.outcome = 'pending';
        globalThis.startRequest = function(values) {
            utools.dbStorage.getItem(values[0].key).then(
                value => { globalThis.outcome = value; },
                error => { globalThis.outcome = 'error:' + String(error); }
            );
            return true;
        };
        globalThis.readOutcome = function() { return globalThis.outcome; };
    "#;

    runtime
        .execute_preload("reused-plugin", preload)
        .await
        .unwrap();
    runtime
        .call_function(
            "reused-plugin",
            "startRequest",
            vec![json!({ "key": "old" })],
        )
        .await
        .unwrap();
    let old_call = next_held_call(&mut calls).await;
    assert_eq!(old_call.args, vec![json!("old")]);

    runtime.invalidate_plugin("reused-plugin").await.unwrap();
    runtime
        .execute_preload("reused-plugin", preload)
        .await
        .unwrap();
    runtime
        .call_function(
            "reused-plugin",
            "startRequest",
            vec![json!({ "key": "new" })],
        )
        .await
        .unwrap();

    // The IPC dispatcher is sequential. The new request is now queued while
    // the old handler remains blocked, so its completion arrives first at the
    // reincarnated context and must not match that context's pending Promise.
    assert!(
        calls.try_recv().is_err(),
        "new IPC should still be queued behind old IPC"
    );
    old_call.finish.send(Ok(json!("old result"))).unwrap();
    let new_call = next_held_call(&mut calls).await;
    assert_eq!(new_call.args, vec![json!("new")]);

    // The dispatcher sends the old callback before notifying us of the new
    // handler call. A worker command drains queued callbacks before returning;
    // make one extra read so the assertion is independent of select ordering.
    let _ = runtime
        .call_function("reused-plugin", "readOutcome", vec![json!({})])
        .await
        .unwrap();
    let before_new_completion = runtime
        .call_function("reused-plugin", "readOutcome", vec![json!({})])
        .await
        .unwrap();
    assert_eq!(before_new_completion, json!("pending"));

    new_call.finish.send(Ok(json!("new result"))).unwrap();
    assert_eq!(
        wait_for_outcome(&runtime, "new result").await,
        json!("new result")
    );
}

#[test]
fn late_ipc_callback_for_removed_context_is_dropped() {
    let mut contexts = HashMap::new();
    let callback: IpcCallback = (
        "invalidated-plugin".into(),
        7,
        IpcResult::success(json!({ "late": true })),
    );
    drain_one_callback(&mut contexts, callback);
    assert!(contexts.is_empty());
}
