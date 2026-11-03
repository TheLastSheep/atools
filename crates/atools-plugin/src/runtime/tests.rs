    use super::*;
    use crate::ipc_handler::{IpcError, IpcHandler};
    use async_trait::async_trait;
    use serde_json::json;

    /// A no-op IPC handler for tests.
    struct NoopHandler;

    #[async_trait]
    impl IpcHandler for NoopHandler {
        async fn handle(
            &self,
            _plugin_id: &str,
            _method: &str,
            _args: Vec<serde_json::Value>,
        ) -> Result<serde_json::Value, IpcError> {
            Ok(json!(null))
        }
    }

    fn make_runtime() -> JsRuntime {
        JsRuntime::new(Arc::new(NoopHandler)).expect("Failed to create runtime")
    }

    #[tokio::test]
    async fn test_runtime_creation() {
        let runtime = make_runtime();
        assert!(runtime.is_alive());
    }

    #[tokio::test]
    async fn test_create_context() {
        let runtime = make_runtime();
        let result = runtime.create_context("test-plugin").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_execute_preload() {
        let runtime = make_runtime();
        let preload_code = r#"
            globalThis.testValue = 42;
        "#;
        let result = runtime.execute_preload("test-plugin", preload_code).await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn call_agent_tool_invokes_registered_sync_handler() {
        let runtime = make_runtime();
        let preload_code = r#"
            utools.registerTool('echo', { description: 'Echo text' }, function(args) {
                return { echoed: args.text, count: args.count + 1 };
            });
        "#;
        runtime
            .execute_preload("test-plugin", preload_code)
            .await
            .unwrap();

        let result = runtime
            .call_function(
                "test-plugin",
                "____callAgentTool____",
                vec![json!({
                    "tool": "echo",
                    "normalizedTool": "plugin_test_plugin_echo",
                    "arguments": { "text": "hello", "count": 2 }
                })],
            )
            .await
            .unwrap();

        assert_eq!(result, json!({ "echoed": "hello", "count": 3 }));
    }

    #[tokio::test]
    async fn call_agent_tool_awaits_async_handler_promise() {
        let runtime = make_runtime();
        let preload_code = r#"
            utools.registerTool('echo_async', { description: 'Echo text asynchronously' }, async function(args) {
                var upper = await Promise.resolve(String(args.text).toUpperCase());
                return { echoed: upper, count: args.count + 1 };
            });
        "#;
        runtime
            .execute_preload("test-plugin", preload_code)
            .await
            .unwrap();

        let result = runtime
            .call_function(
                "test-plugin",
                "____callAgentTool____",
                vec![json!({
                    "tool": "echo_async",
                    "normalizedTool": "plugin_test_plugin_echo_async",
                    "arguments": { "text": "hello", "count": 2 }
                })],
            )
            .await
            .unwrap();

        assert_eq!(result, json!({ "echoed": "HELLO", "count": 3 }));
    }

    #[tokio::test]
    async fn call_agent_tool_awaits_async_handler_ipc_promise() {
        let runtime = make_runtime();
        let preload_code = r#"
            utools.registerTool('echo_ipc', { description: 'Echo after IPC' }, async function(args) {
                await utools.dbStorage.setItem('lastText', args.text);
                return { echoed: args.text, ipcCompleted: true };
            });
        "#;
        runtime
            .execute_preload("test-plugin", preload_code)
            .await
            .unwrap();

        let result = runtime
            .call_function(
                "test-plugin",
                "____callAgentTool____",
                vec![json!({
                    "tool": "echo_ipc",
                    "normalizedTool": "plugin_test_plugin_echo_ipc",
                    "arguments": { "text": "hello" }
                })],
            )
            .await
            .unwrap();

        assert_eq!(result, json!({ "echoed": "hello", "ipcCompleted": true }));
    }
