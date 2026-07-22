//! Integration tests for the plugin loader.

use atools_plugin::loader::{load_manifest, load_plugin_from_disk, read_preload_js};
use std::fs;
use tempfile::TempDir;

/// Helper: create a plugin directory with the given plugin.json content.
fn make_plugin_dir(json_content: &str) -> TempDir {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("plugin.json"), json_content).unwrap();
    dir
}

/// Helper: create a minimal valid manifest.
fn minimal_manifest() -> &'static str {
    r#"{"name": "test-plugin"}"#
}

/// Helper: create a full manifest with all fields.
fn full_manifest() -> &'static str {
    r#"{
      "name": "我的插件",
      "version": "2.1.0",
      "main": "index.html",
      "logo": "logo.png",
      "preload": "preload.js",
      "description": "A test plugin for unit testing",
      "author": "Test Author <test@example.com>",
      "homepage": "https://example.com/plugin",
      "pluginSetting": { "single": true, "height": 500 },
      "features": [
        {
          "code": "timestamp",
          "label": "时间戳",
          "explain": "Unix 时间戳与日期互转",
          "cmds": ["时间戳", "timestamp", "shijiancuo"]
        },
        {
          "code": "calculator",
          "label": "计算器",
          "explain": "Simple calculator",
          "icon": "calc.png",
          "mainPush": true,
          "cmds": ["calc", "calculator"]
        }
      ],
      "development": {
        "main": "dev-index.html",
        "preload": "dev-preload.js"
      }
    }"#
}

// --- load_manifest tests ---

#[test]
fn test_load_manifest_minimal() {
    let dir = make_plugin_dir(minimal_manifest());
    let manifest = load_manifest(dir.path()).unwrap();

    assert_eq!(manifest.name, "test-plugin");
    assert_eq!(manifest.version, ""); // default
    assert!(manifest.main.is_none());
    assert!(manifest.logo.is_none());
    assert!(manifest.preload.is_none());
    assert!(manifest.features.is_empty());
    assert!(manifest.plugin_setting.is_none());
    assert!(manifest.development.is_none());
}

#[test]
fn test_load_manifest_full() {
    let dir = make_plugin_dir(full_manifest());
    let manifest = load_manifest(dir.path()).unwrap();

    assert_eq!(manifest.name, "我的插件");
    assert_eq!(manifest.version, "2.1.0");
    assert_eq!(manifest.main, Some("index.html".to_string()));
    assert_eq!(manifest.logo, Some("logo.png".to_string()));
    assert_eq!(manifest.preload, Some("preload.js".to_string()));
    assert_eq!(
        manifest.description.as_deref(),
        Some("A test plugin for unit testing")
    );
    assert_eq!(
        manifest.author.as_deref(),
        Some("Test Author <test@example.com>")
    );
    assert_eq!(
        manifest.homepage.as_deref(),
        Some("https://example.com/plugin")
    );

    // Plugin setting
    let setting = manifest.plugin_setting.unwrap();
    assert!(setting.single);
    assert_eq!(setting.height, 500);

    // Features
    assert_eq!(manifest.features.len(), 2);

    let f1 = &manifest.features[0];
    assert_eq!(f1.code, "timestamp");
    assert_eq!(f1.label.as_deref(), Some("时间戳"));
    assert_eq!(f1.cmds.len(), 3);

    let f2 = &manifest.features[1];
    assert_eq!(f2.code, "calculator");
    assert!(f2.main_push);
    assert_eq!(f2.icon.as_deref(), Some("calc.png"));

    // Development
    let dev = manifest.development.unwrap();
    assert_eq!(dev.main, Some("dev-index.html".to_string()));
    assert_eq!(dev.preload, Some("dev-preload.js".to_string()));
}

#[test]
fn test_load_manifest_missing_file() {
    let dir = TempDir::new().unwrap();
    let result = load_manifest(dir.path());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("plugin.json"),
        "Error should mention plugin.json: {}",
        err
    );
}

#[test]
fn test_load_manifest_invalid_json() {
    let dir = make_plugin_dir("{ not valid json }");
    let result = load_manifest(dir.path());
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("parse") || err.contains("JSON") || err.contains("json"),
        "Error should mention parse failure: {}",
        err
    );
}

#[test]
fn test_load_manifest_missing_required_name() {
    // `name` is required (no #[serde(default)] on it)
    let dir = make_plugin_dir(r#"{"version": "1.0.0"}"#);
    let result = load_manifest(dir.path());
    assert!(result.is_err());
}

#[test]
fn test_load_manifest_rejects_in_process_node_contract() {
    let dir = make_plugin_dir(
        r#"{
          "name": "unsafe-node",
          "main": "index.js",
          "runtime": {
            "kind": "node",
            "transport": "host_bridge"
          }
        }"#,
    );
    let error = load_manifest(dir.path()).unwrap_err().to_string();
    assert!(error.contains("Invalid runtime contract"));
}

#[test]
fn test_load_manifest_empty_directory() {
    let dir = TempDir::new().unwrap();
    let result = load_manifest(dir.path());
    assert!(result.is_err());
}

#[test]
fn test_load_manifest_with_empty_features() {
    let json = r#"{"name": "empty-features", "features": []}"#;
    let dir = make_plugin_dir(json);
    let manifest = load_manifest(dir.path()).unwrap();
    assert!(manifest.features.is_empty());
}

#[test]
fn test_load_manifest_plugin_setting_defaults() {
    let json = r#"{"name": "defaults", "pluginSetting": {}}"#;
    let dir = make_plugin_dir(json);
    let manifest = load_manifest(dir.path()).unwrap();
    let setting = manifest.plugin_setting.unwrap();
    assert!(!setting.single); // default false
    assert_eq!(setting.height, 544); // default_height()
}

#[test]
fn test_load_manifest_cmds_typed_regex() {
    let json = r#"{
      "name": "regex-plugin",
      "features": [{
        "code": "color",
        "explain": "Match hex color",
        "cmds": [{"type": "regex", "match": "^#[0-9a-fA-F]{6}$"}]
      }]
    }"#;
    let dir = make_plugin_dir(json);
    let manifest = load_manifest(dir.path()).unwrap();
    assert_eq!(manifest.features.len(), 1);
    assert_eq!(manifest.features[0].cmds.len(), 1);
}

// --- load_plugin_from_disk tests ---

#[test]
fn test_load_plugin_from_disk() {
    let dir = make_plugin_dir(full_manifest());
    let plugin = load_plugin_from_disk(dir.path()).unwrap();

    assert_eq!(plugin.name, "我的插件");
    assert_eq!(plugin.version, "2.1.0");
    assert!(plugin.enabled);
    assert!(plugin.id.starts_with("plugin_"));
    assert!(plugin
        .path
        .contains(dir.path().to_str().unwrap().chars().next().unwrap()));

    // Timestamps should be ISO 8601
    assert!(plugin.created_at.contains("T"));
    assert!(plugin.updated_at.contains("T"));

    // Manifest should be fully populated
    assert_eq!(plugin.manifest.features.len(), 2);
    assert_eq!(plugin.manifest.version, "2.1.0");
}

#[test]
fn test_load_plugin_from_disk_stable_id() {
    // Same name should always produce same ID
    let dir1 = make_plugin_dir(r#"{"name": "stable-test"}"#);
    let dir2 = make_plugin_dir(r#"{"name": "stable-test"}"#);

    let p1 = load_plugin_from_disk(dir1.path()).unwrap();
    let p2 = load_plugin_from_disk(dir2.path()).unwrap();

    assert_eq!(p1.id, p2.id);
}

#[test]
fn test_load_plugin_from_disk_different_names_different_ids() {
    let dir1 = make_plugin_dir(r#"{"name": "plugin-alpha"}"#);
    let dir2 = make_plugin_dir(r#"{"name": "plugin-beta"}"#);

    let p1 = load_plugin_from_disk(dir1.path()).unwrap();
    let p2 = load_plugin_from_disk(dir2.path()).unwrap();

    assert_ne!(p1.id, p2.id);
}

#[test]
fn test_load_plugin_from_disk_missing_dir() {
    let result = load_plugin_from_disk(std::path::Path::new("/nonexistent/path"));
    assert!(result.is_err());
}

// --- read_preload_js tests ---

#[test]
fn test_read_preload_js_success() {
    let dir = TempDir::new().unwrap();
    let preload_content = r#"
        // Plugin preload script
        const { clipboard, db } = require('utools');
        module.exports = { init() { console.log('loaded'); } };
    "#;
    fs::write(dir.path().join("preload.js"), preload_content).unwrap();

    let result = read_preload_js(dir.path(), "preload.js").unwrap();
    assert!(result.contains("Plugin preload script"));
    assert!(result.contains("module.exports"));
}

#[test]
fn test_read_preload_js_in_subdirectory() {
    let dir = TempDir::new().unwrap();
    let sub_dir = dir.path().join("dist");
    fs::create_dir(&sub_dir).unwrap();
    fs::write(sub_dir.join("preload.js"), "// dist preload").unwrap();

    let result = read_preload_js(dir.path(), "dist/preload.js").unwrap();
    assert!(result.contains("dist preload"));
}

#[test]
fn test_read_preload_js_missing_file() {
    let dir = TempDir::new().unwrap();
    let result = read_preload_js(dir.path(), "nonexistent.js");
    assert!(result.is_err());
    let err = result.unwrap_err().to_string();
    assert!(
        err.contains("nonexistent.js"),
        "Error should mention the file: {}",
        err
    );
}

#[test]
fn test_read_preload_js_empty_file() {
    let dir = TempDir::new().unwrap();
    fs::write(dir.path().join("preload.js"), "").unwrap();

    let result = read_preload_js(dir.path(), "preload.js").unwrap();
    assert!(result.is_empty());
}

// --- End-to-end: load manifest then read preload ---

#[test]
fn test_full_load_and_read_preload() {
    let dir = TempDir::new().unwrap();
    let manifest_json = r#"{
      "name": "full-plugin",
      "version": "1.0.0",
      "preload": "dist/preload.js",
      "features": [{"code": "test", "explain": "test", "cmds": ["test"]}]
    }"#;
    fs::write(dir.path().join("plugin.json"), manifest_json).unwrap();

    let preload_js = "// Full preload script content\nconsole.log('hello');";
    fs::create_dir(dir.path().join("dist")).unwrap();
    fs::write(dir.path().join("dist/preload.js"), preload_js).unwrap();

    // Load manifest
    let manifest = load_manifest(dir.path()).unwrap();
    assert_eq!(manifest.name, "full-plugin");
    assert_eq!(manifest.preload.as_deref(), Some("dist/preload.js"));

    // Read preload using the manifest's preload path
    let preload = read_preload_js(dir.path(), manifest.preload.as_deref().unwrap()).unwrap();
    assert_eq!(preload, preload_js);

    // Load full plugin record
    let plugin = load_plugin_from_disk(dir.path()).unwrap();
    assert_eq!(plugin.name, "full-plugin");
    assert_eq!(plugin.manifest.features.len(), 1);
}
