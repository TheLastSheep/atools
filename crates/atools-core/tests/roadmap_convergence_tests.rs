//! TDD test suite for Architecture Roadmap Convergence (Plan A + Plan D + Plan B):
//! - Plan D Convergence: Raycast-style declarative `SchemaView` (`List`, `Detail`, `Form`, `ActionPanel`)
//!   that renders identically for human UIs and AI Agent Markdown/JSON observations.
//! - Plan B Convergence: `PluginRuntimeKind::Wasm` runtime contract validation.
//! - Headless MCP + Harness execution without WebView dependency.

use atools_core::models::{
    PluginCompatibilityKind, PluginManifest, PluginRuntimeKind, PluginRuntimeManifest,
    PluginRuntimeTransport,
};
use atools_core::schema_ui::{
    SchemaAction, SchemaDataItem, SchemaField, SchemaFieldKind, SchemaView, SchemaViewKind,
};
use serde_json::json;

#[test]
fn declarative_schema_view_validates_and_renders_agent_markdown() {
    let view = SchemaView {
        id: "view.git-worktrees".to_string(),
        title: "Git Worktree Cockpit".to_string(),
        kind: SchemaViewKind::List {
            items: vec![
                SchemaDataItem {
                    id: "wt-main".to_string(),
                    title: "main".to_string(),
                    subtitle: Some("/Users/harris/Desktop/atools".to_string()),
                    badge: Some("clean".to_string()),
                    metadata: json!({ "branch": "main", "commit": "7ee865bb" }),
                },
                SchemaDataItem {
                    id: "wt-feat".to_string(),
                    title: "feat/wasm-runtime".to_string(),
                    subtitle: Some("/Users/harris/Desktop/atools-wasm".to_string()),
                    badge: Some("2 modified".to_string()),
                    metadata: json!({ "branch": "feat/wasm-runtime" }),
                },
            ],
        },
        actions: vec![SchemaAction {
            id: "action.open_terminal".to_string(),
            title: "Open in Terminal".to_string(),
            capability_id: "atools.shell.open".to_string(),
            shortcut: Some("Cmd+Enter".to_string()),
        }],
    };

    assert!(view.validate().is_ok());
    let md = view.to_agent_markdown();
    assert!(md.contains("# Git Worktree Cockpit"));
    assert!(md.contains("main"));
    assert!(md.contains("feat/wasm-runtime"));
    assert!(md.contains("atools.shell.open"));
}

#[test]
fn declarative_schema_form_validates_fields() {
    let form_view = SchemaView {
        id: "view.webhook-hmac".to_string(),
        title: "Webhook HMAC Generator".to_string(),
        kind: SchemaViewKind::Form {
            fields: vec![
                SchemaField {
                    name: "secret".to_string(),
                    label: "Signing Secret".to_string(),
                    kind: SchemaFieldKind::Password,
                    required: true,
                    default_value: None,
                },
                SchemaField {
                    name: "payload".to_string(),
                    label: "JSON Payload".to_string(),
                    kind: SchemaFieldKind::Textarea,
                    required: true,
                    default_value: Some(json!("{}")),
                },
            ],
        },
        actions: vec![],
    };

    assert!(form_view.validate().is_ok());
}

#[test]
fn wasm_component_runtime_contract_is_supported_in_plugin_manifest() {
    let manifest_json = json!({
        "name": "wasm-hash-tool",
        "version": "0.1.0",
        "description": "WASI 0.2 Component Model plugin",
        "runtime": {
            "kind": "wasm",
            "transport": "mcp_stdio",
            "entry": "plugin.wasm"
        },
        "features": []
    });

    let manifest: PluginManifest =
        serde_json::from_value(manifest_json).expect("deserialize wasm plugin manifest");
    assert_eq!(manifest.effective_runtime_kind(), PluginRuntimeKind::Wasm);
    assert_eq!(
        manifest.effective_runtime_transport(),
        PluginRuntimeTransport::McpStdio
    );
    assert_eq!(manifest.effective_runtime_entry(), Some("plugin.wasm"));
    assert!(manifest.validate_runtime_contract().is_ok());

    // Wasm runtime without an entry file must fail validation
    let invalid = PluginManifest {
        platform: vec![],
        name: "bad-wasm".to_string(),
        title: None,
        version: "0.1.0".to_string(),
        description: None,
        author: None,
        homepage: None,
        main: None,
        preload: None,
        logo: None,
        development: None,
        plugin_setting: None,
        features: vec![],
        permissions: vec![],
        tools: Default::default(),
        providers: Default::default(),
        runtime: Some(PluginRuntimeManifest {
            kind: PluginRuntimeKind::Wasm,
            compatibility: PluginCompatibilityKind::Native,
            transport: PluginRuntimeTransport::McpStdio,
            entry: None,
        }),
    };
    assert!(invalid.validate_runtime_contract().is_err());
}
