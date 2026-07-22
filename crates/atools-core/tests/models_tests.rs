//! Integration tests for models serialization/deserialization.

use std::collections::HashMap;

use atools_core::models::{
    Cmd, CmdType, Document, Feature, Plugin, PluginCompatibilityKind, PluginManifest,
    PluginRuntimeKind, PluginRuntimeTransport, PluginSetting, ProviderManifest,
};
use serde_json::json;

#[test]
fn test_plugin_manifest_roundtrip() {
    let manifest = PluginManifest {
        name: "test-plugin".to_string(),
        version: "1.0.0".to_string(),
        main: Some("index.html".to_string()),
        logo: Some("logo.png".to_string()),
        preload: Some("preload.js".to_string()),
        description: Some("A test plugin".to_string()),
        author: Some("Test Author".to_string()),
        homepage: Some("https://example.com".to_string()),
        plugin_setting: Some(PluginSetting {
            single: true,
            height: 600,
        }),
        features: vec![],
        development: None,
        tools: HashMap::new(),
        providers: HashMap::from([(
            "cloud".to_string(),
            ProviderManifest {
                type_: "translation".to_string(),
                label: Some("Cloud".to_string()),
                description: Some("Fixture".to_string()),
            },
        )]),
        permissions: vec!["clipboard".to_string(), "shell".to_string()],
        runtime: None,
    };

    let serialized = serde_json::to_string(&manifest).unwrap();
    let deserialized: PluginManifest = serde_json::from_str(&serialized).unwrap();

    assert_eq!(deserialized.name, "test-plugin");
    assert_eq!(deserialized.version, "1.0.0");
    assert_eq!(deserialized.main, Some("index.html".to_string()));
    assert_eq!(deserialized.logo, Some("logo.png".to_string()));
    assert_eq!(
        deserialized.permissions,
        vec!["clipboard".to_string(), "shell".to_string()]
    );
    assert_eq!(deserialized.providers["cloud"].type_, "translation");
    let settings = deserialized.plugin_setting.unwrap();
    assert!(settings.single);
    assert_eq!(settings.height, 600);
}

#[test]
fn test_plugin_manifest_from_real_json() {
    // Real plugin.json content from the project
    let json = r#"{
      "name": "时间戳",
      "version": "1.0.0",
      "description": "Unix 时间戳与日期互相转换",
      "main": "index.html",
      "author": "ATools",
      "permissions": ["clipboard", "shell.openExternal"],
      "pluginSetting": { "single": true, "height": 500 },
      "features": [
        {
          "code": "时间戳",
          "label": "时间戳",
          "explain": "Unix 时间戳与日期互转",
          "cmds": ["时间戳", "timestamp", "shijiancuo", "time"]
        }
      ],
      "logo": "logo.png"
    }"#;

    let manifest: PluginManifest = serde_json::from_str(json).unwrap();
    assert_eq!(manifest.name, "时间戳");
    assert_eq!(manifest.version, "1.0.0");
    assert_eq!(manifest.main, Some("index.html".to_string()));
    assert_eq!(
        manifest.permissions,
        vec!["clipboard".to_string(), "shell.openExternal".to_string()]
    );

    let setting = manifest.plugin_setting.unwrap();
    assert!(setting.single);
    assert_eq!(setting.height, 500);

    assert_eq!(manifest.features.len(), 1);
    assert_eq!(manifest.features[0].code, "时间戳");
    assert_eq!(manifest.features[0].cmds.len(), 4);
}

#[test]
fn test_plugin_manifest_minimal() {
    let json = r#"{"name": "minimal"}"#;
    let manifest: PluginManifest = serde_json::from_str(json).unwrap();
    assert_eq!(manifest.name, "minimal");
    assert_eq!(manifest.version, "");
    assert!(manifest.features.is_empty());
    assert!(manifest.permissions.is_empty());
    assert_eq!(manifest.effective_runtime_kind(), PluginRuntimeKind::Web);
    assert_eq!(
        manifest.effective_compatibility(),
        PluginCompatibilityKind::Ztools
    );
    assert_eq!(
        manifest.effective_runtime_transport(),
        PluginRuntimeTransport::HostBridge
    );
}

#[test]
fn test_native_node_and_rust_runtime_manifests() {
    let node: PluginManifest = serde_json::from_value(json!({
        "name": "node-worker",
        "runtime": {
            "kind": "node",
            "transport": "json_rpc_stdio",
            "entry": "dist/index.mjs"
        }
    }))
    .unwrap();
    assert_eq!(node.effective_runtime_kind(), PluginRuntimeKind::Node);
    assert_eq!(
        node.effective_compatibility(),
        PluginCompatibilityKind::Native
    );
    assert_eq!(
        node.effective_runtime_transport(),
        PluginRuntimeTransport::JsonRpcStdio
    );
    assert_eq!(node.effective_runtime_entry(), Some("dist/index.mjs"));
    assert!(node.validate_runtime_contract().is_ok());

    let rust: PluginManifest = serde_json::from_value(json!({
        "name": "rust-worker",
        "runtime": {
            "kind": "rust",
            "transport": "mcp_stdio",
            "entry": "bin/rust-worker"
        }
    }))
    .unwrap();
    assert_eq!(rust.effective_runtime_kind(), PluginRuntimeKind::Rust);
    assert_eq!(
        rust.effective_runtime_transport(),
        PluginRuntimeTransport::McpStdio
    );
    assert!(rust.validate_runtime_contract().is_ok());

    let unsafe_node: PluginManifest = serde_json::from_value(json!({
        "name": "unsafe-node",
        "main": "index.js",
        "runtime": {
            "kind": "node",
            "transport": "host_bridge"
        }
    }))
    .unwrap();
    assert!(unsafe_node.validate_runtime_contract().is_err());
}

#[test]
fn test_feature_with_label() {
    let feature = Feature {
        code: "calc".to_string(),
        label: Some("Calculator".to_string()),
        explain: "Simple calculator".to_string(),
        icon: Some("calc.png".to_string()),
        main_push: true,
        main_hide: false,
        cmds: vec![Cmd::Text("calc".to_string())],
    };

    let json = serde_json::to_value(&feature).unwrap();
    assert_eq!(json["code"], "calc");
    assert_eq!(json["label"], "Calculator");

    let de: Feature = serde_json::from_value(json).unwrap();
    assert_eq!(de.label, Some("Calculator".to_string()));
}

#[test]
fn test_cmd_typed_regex() {
    let json = r#"{"type": "regex", "match": "^\\d+$"}"#;
    let cmd: Cmd = serde_json::from_str(json).unwrap();
    match cmd {
        Cmd::Typed(t) => {
            assert_eq!(t.type_, CmdType::Regex);
            assert_eq!(t.match_, Some("^\\d+$".to_string()));
        }
        _ => panic!("Expected Typed variant"),
    }
}

#[test]
fn test_cmd_typed_over() {
    let json = r#"{"type": "over", "length": 100}"#;
    let cmd: Cmd = serde_json::from_str(json).unwrap();
    match cmd {
        Cmd::Typed(t) => {
            assert_eq!(t.type_, CmdType::Over);
            assert_eq!(t.length, Some(100));
        }
        _ => panic!("Expected Typed variant"),
    }
}

#[test]
fn test_document_roundtrip() {
    let doc = Document {
        id: "doc1".to_string(),
        rev: Some("1-abc".to_string()),
        data: json!({"text": "hello", "count": 42}),
    };

    let serialized = serde_json::to_value(&doc).unwrap();
    assert_eq!(serialized["_id"], "doc1");
    assert_eq!(serialized["_rev"], "1-abc");
    assert_eq!(serialized["text"], "hello");
    assert_eq!(serialized["count"], 42);

    let deserialized: Document = serde_json::from_value(serialized).unwrap();
    assert_eq!(deserialized.id, "doc1");
    assert_eq!(deserialized.data["text"], "hello");
}

#[test]
fn test_plugin_record_roundtrip() {
    let manifest = PluginManifest {
        name: "p".to_string(),
        version: "1".to_string(),
        main: None,
        logo: None,
        preload: None,
        description: None,
        author: None,
        homepage: None,
        plugin_setting: None,
        features: vec![],
        development: None,
        tools: HashMap::new(),
        providers: HashMap::new(),
        permissions: vec![],
        runtime: None,
    };

    let plugin = Plugin {
        id: "plugin_abc".to_string(),
        name: "p".to_string(),
        version: "1".to_string(),
        path: "/tmp/p".to_string(),
        enabled: true,
        manifest,
        created_at: "2026-01-01T00:00:00Z".to_string(),
        updated_at: "2026-01-01T00:00:00Z".to_string(),
    };

    let json = serde_json::to_value(&plugin).unwrap();
    let de: Plugin = serde_json::from_value(json).unwrap();
    assert_eq!(de.id, "plugin_abc");
    assert_eq!(de.name, "p");
    assert!(de.enabled);
}
