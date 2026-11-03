use super::is_file_tool;
use crate::legacy_runtime::registry;
use atools_core::agent::{PermissionScope, ToolDefinition};
use serde_json::json;

#[cfg(unix)]
#[path = "native_filesystem_session_tests.rs"]
mod session_tests;
#[cfg(unix)]
#[path = "native_filesystem_write_session_tests.rs"]
mod write_session_tests;

fn tool(plugin_id: &str, source: &str, scopes: Vec<PermissionScope>) -> ToolDefinition {
    ToolDefinition {
        name: registry::tool_name(plugin_id),
        description: "fixture".into(),
        input_schema: json!({"type":"object"}),
        output_schema: None,
        scopes,
        enabled_by_default: true,
        enabled: true,
        source: source.into(),
        plugin_id: Some(plugin_id.into()),
    }
}

#[test]
fn only_the_exact_registered_legacy_tool_with_file_read_is_accepted() {
    let is_file_read_tool = |tool: &ToolDefinition, plugin: &str, name: &str| {
        is_file_tool(tool, plugin, name, &PermissionScope::FileRead)
    };
    let valid = tool(
        "harris-live-md",
        registry::SOURCE,
        vec![PermissionScope::FileRead],
    );
    assert!(is_file_read_tool(
        &valid,
        "harris-live-md",
        &registry::tool_name("harris-live-md")
    ));

    let wrong_plugin = tool("other", registry::SOURCE, vec![PermissionScope::FileRead]);
    assert!(!is_file_read_tool(
        &wrong_plugin,
        "harris-live-md",
        &registry::tool_name("harris-live-md")
    ));
    let wrong_source = tool("harris-live-md", "other", vec![PermissionScope::FileRead]);
    assert!(!is_file_read_tool(
        &wrong_source,
        "harris-live-md",
        &registry::tool_name("harris-live-md")
    ));
    let missing_scope = tool(
        "harris-live-md",
        registry::SOURCE,
        vec![PermissionScope::FileWrite],
    );
    assert!(!is_file_read_tool(
        &missing_scope,
        "harris-live-md",
        &registry::tool_name("harris-live-md")
    ));
}

#[test]
fn file_write_does_not_accept_a_read_only_scope() {
    let name = registry::tool_name("harris-live-md");
    let valid = tool(
        "harris-live-md",
        registry::SOURCE,
        vec![PermissionScope::FileWrite],
    );
    assert!(is_file_tool(
        &valid,
        "harris-live-md",
        &name,
        &PermissionScope::FileWrite
    ));
    assert!(!is_file_tool(
        &valid,
        "other",
        &name,
        &PermissionScope::FileWrite
    ));
    let read_only = tool(
        "harris-live-md",
        registry::SOURCE,
        vec![PermissionScope::FileRead],
    );
    assert!(!is_file_tool(
        &read_only,
        "harris-live-md",
        &name,
        &PermissionScope::FileWrite
    ));
}

#[tokio::test]
async fn invalid_request_schema_is_a_fixed_error_and_unsupported_path_declines() {
    for request in [
        json!({"method":"readTextPath","params":{"path":"/tmp/x","ignored":true}}),
        json!({"method":"readFilePath","params":{"path":"/tmp/x"}}),
    ] {
        let result = crate::plugin_filesystem::node_text_read::handle(&request)
            .await
            .unwrap_err();
        assert_eq!(result, "ERR_ATOOLS_NATIVE_FS:EINVAL");
    }
    let result = crate::plugin_filesystem::node_text_read::handle(
        &json!({"method":"readTextPath","params":{"path":"relative"}}),
    )
    .await
    .unwrap();
    assert_eq!(result, json!({"handled":false}));
}
