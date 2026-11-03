//! Comprehensive end-to-end test suite for all 29 plugins developed by Harris
//! embedded in `resources/plugins/builtin/`.
//!
//! Verifies:
//! 1. Manifest parsing, runtime contract validation, and asset integrity (`main` + `preload`).
//! 2. SQLite WAL indexing + `FeatureSearchIndex` searchability for every feature.
//! 3. Preload file presence without evaluating all plugins during discovery.
//! 4. Real end-to-end Agent/MCP tool execution (`____callAgentTool____`) on Harris's plugins.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use async_trait::async_trait;
use atools_core::db::Database;
use atools_core::matcher::{search_all, FeatureSearchIndex};
use atools_core::models::{Cmd, FeatureEntry};
use atools_plugin::ipc_handler::{IpcHandler, IpcResult};
use atools_plugin::loader::{load_plugin_from_disk, resolve_manifest_path};
use atools_plugin::runtime::JsRuntime;
use serde_json::{json, Value};
#[path = "common/isolated_process.rs"]
mod isolated_process;

const HARRIS_PLUGINS: &[&str] = &[
    "address-parser",
    "ai-automation-workbench",
    "archive-workbench",
    "content-workbench",
    "dev-data-workbench",
    "device-link",
    "file-workbench",
    "format-converter",
    "git-worktree-cockpit",
    "har-doctor",
    "image-batch-studio",
    "image-delivery-workbench",
    "knowledge-workbench",
    "office-suite-workbench",
    "openapi-contract-gate",
    "pasteboard-pro",
    "pdf-office-workbench",
    "plugin-guard",
    "project-launchpad",
    "share-sanitizer",
    "snipaste",
    "startup-manager",
    "subtitle-workbench",
    "system-diagnostic-report",
    "system-manager",
    "typora-markdown",
    "video-enhancer",
    "webhook-lab",
    "ztools-cc-switch",
];

struct E2eIpcHandler;

#[async_trait]
impl IpcHandler for E2eIpcHandler {
    async fn handle(&self, _plugin_id: &str, method: &str, _args: Vec<Value>) -> IpcResult {
        match method {
            "system.isMacOS" => Ok(Value::Bool(cfg!(target_os = "macos"))),
            "system.isWindows" => Ok(Value::Bool(cfg!(target_os = "windows"))),
            "system.isLinux" => Ok(Value::Bool(cfg!(target_os = "linux"))),
            "system.nativeId" => Ok(Value::String("atools-e2e-native-id".to_string())),
            "system.getPath" => Ok(Value::String("/tmp".to_string())),
            _ => Ok(Value::Null),
        }
    }
}

fn builtin_plugins_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("resources")
        .join("plugins")
        .join("builtin")
}

#[tokio::test]
async fn all_29_harris_plugins_are_embedded_indexed_searchable_and_preload_present() {
    let root = builtin_plugins_root();
    let db = Database::in_memory().expect("open in-memory db");

    let mut missing = Vec::new();
    let mut preload_failures = Vec::new();

    for &dir_name in HARRIS_PLUGINS {
        let plugin_dir = root.join(dir_name);
        if !plugin_dir.is_dir() {
            missing.push(format!(
                "{dir_name}: directory missing in resources/plugins/builtin"
            ));
            continue;
        }

        let plugin = match load_plugin_from_disk(&plugin_dir) {
            Ok(p) => p,
            Err(err) => {
                missing.push(format!("{dir_name}: manifest load failed: {err}"));
                continue;
            }
        };

        let manifest_base = resolve_manifest_path(&plugin_dir)
            .parent()
            .unwrap_or(&plugin_dir)
            .to_path_buf();

        // 1. Verify main HTML entry exists
        if let Some(ref main_rel) = plugin.manifest.main {
            let main_ok =
                manifest_base.join(main_rel).is_file() || plugin_dir.join(main_rel).is_file();
            if !main_ok {
                missing.push(format!("{dir_name}: main entry missing ({main_rel})"));
            }
        }

        // 2. Save to DB and index features
        db.save_plugin_with_features(&plugin, &plugin.manifest.features)
            .unwrap_or_else(|e| panic!("failed to save plugin {dir_name} to DB: {e}"));

        // Discovery validates files; execution belongs to explicit tool/UI cases.
        if let Some(ref preload_rel) = plugin.manifest.preload {
            let preload_base = if manifest_base.join(preload_rel).is_file() {
                manifest_base.clone()
            } else {
                plugin_dir.clone()
            };
            if !preload_base.join(preload_rel).is_file() {
                preload_failures.push(format!("{dir_name}: preload file missing ({preload_rel})"));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "Missing or invalid Harris plugins:\n{}",
        missing.join("\n")
    );
    assert!(
        preload_failures.is_empty(),
        "Preload failures in Harris plugins:\n{}",
        preload_failures.join("\n")
    );

    // 4. Verify all features across Harris plugins are indexed and searchable via FeatureSearchIndex
    let db_features: Vec<FeatureEntry> = db.all_features().expect("list all indexed features");
    assert!(
        db_features.len() >= HARRIS_PLUGINS.len(),
        "Expected at least {} features indexed, got {}",
        HARRIS_PLUGINS.len(),
        db_features.len()
    );

    let index = FeatureSearchIndex::build(&db_features);

    for feature in &db_features {
        if let Some(first_cmd) = feature.cmds.first() {
            let query = match first_cmd {
                Cmd::Text(label) => Some(label.as_str()),
                _ => None,
            };
            if let Some(q) = query {
                if !q.trim().is_empty() {
                    let results = index.search(q);
                    let direct = search_all(&db_features, q);
                    assert_eq!(results, direct);
                    assert!(
                        results.iter().any(|r| r.feature_code == feature.code),
                        "Feature {} ({}) should match its own command query '{}'",
                        feature.code,
                        feature.plugin_id,
                        q
                    );
                }
            }
        }
    }
}

#[tokio::test]
async fn harris_plugins_agent_tools_execute_end_to_end() {
    if isolated_process::reexec("harris_plugins_agent_tools_execute_end_to_end") {
        return;
    }
    let root = builtin_plugins_root();
    let runtime = JsRuntime::new(Arc::new(E2eIpcHandler)).expect("create JsRuntime");

    // 1. share-sanitizer: detect_text & redact_text
    let share_dir = root.join("share-sanitizer");
    let share_plugin = load_plugin_from_disk(&share_dir).expect("load share-sanitizer");
    let share_base = resolve_manifest_path(&share_dir)
        .parent()
        .unwrap()
        .to_path_buf();
    runtime
        .execute_preload_from_dir(
            &share_plugin.id,
            &share_base,
            share_plugin.manifest.preload.as_deref().unwrap(),
        )
        .await
        .expect("preload share-sanitizer");

    let redact_res = runtime
        .call_function(
            &share_plugin.id,
            "____callAgentTool____",
            vec![json!({
                "tool": "redact_text",
                "arguments": {
                    "text": "Contact dev@example.com or 13800138000 from 192.168.1.10"
                }
            })],
        )
        .await
        .expect("call share-sanitizer redact_text");
    let redacted_text = redact_res["text"].as_str().unwrap_or_default();
    assert!(
        !redacted_text.is_empty() && !redacted_text.contains("dev@example.com"),
        "expected redacted text without email, got: {redact_res}"
    );
    assert!(
        redact_res["counts"]["total"].as_u64().unwrap_or(0) >= 2,
        "expected >= 2 sensitive findings, got: {redact_res}"
    );

    // 2. webhook-lab: hmac
    let webhook_dir = root.join("webhook-lab");
    let webhook_plugin = load_plugin_from_disk(&webhook_dir).expect("load webhook-lab");
    let webhook_base = resolve_manifest_path(&webhook_dir)
        .parent()
        .unwrap()
        .to_path_buf();
    runtime
        .execute_preload_from_dir(
            &webhook_plugin.id,
            &webhook_base,
            webhook_plugin.manifest.preload.as_deref().unwrap(),
        )
        .await
        .expect("preload webhook-lab");

    let hmac_res = runtime
        .call_function(
            &webhook_plugin.id,
            "____callAgentTool____",
            vec![json!({
                "tool": "hmac",
                "arguments": {
                    "secret": "my-webhook-secret",
                    "body": "{\"event\":\"push\"}"
                }
            })],
        )
        .await
        .expect("call webhook-lab hmac");
    assert_eq!(hmac_res["algorithm"], "sha256");
    assert!(
        hmac_res["digest"]
            .as_str()
            .map(|s| s.len() == 64)
            .unwrap_or(false),
        "expected 64-char sha256 hex digest, got: {hmac_res}"
    );

    // 3. subtitle-workbench: analyze
    let sub_dir = root.join("subtitle-workbench");
    let sub_plugin = load_plugin_from_disk(&sub_dir).expect("load subtitle-workbench");
    let sub_base = resolve_manifest_path(&sub_dir)
        .parent()
        .unwrap()
        .to_path_buf();
    runtime
        .execute_preload_from_dir(
            &sub_plugin.id,
            &sub_base,
            sub_plugin.manifest.preload.as_deref().unwrap(),
        )
        .await
        .expect("preload subtitle-workbench");

    let srt_content = "1\n00:00:01,000 --> 00:00:03,000\nHello ATools!\n\n2\n00:00:04,000 --> 00:00:06,000\nExtreme Rust Performance.\n";
    let sub_res = runtime
        .call_function(
            &sub_plugin.id,
            "____callAgentTool____",
            vec![json!({
                "tool": "analyze",
                "arguments": {
                    "content": srt_content,
                    "format": "srt"
                }
            })],
        )
        .await
        .expect("call subtitle-workbench analyze");
    assert_eq!(
        sub_res["cueCount"], 2,
        "expected 2 cues analyzed, got: {sub_res}"
    );

    // 4. system-manager: get_capabilities
    let sys_dir = root.join("system-manager");
    let sys_plugin = load_plugin_from_disk(&sys_dir).expect("load system-manager");
    let sys_base = resolve_manifest_path(&sys_dir)
        .parent()
        .unwrap()
        .to_path_buf();
    runtime
        .execute_preload_from_dir(
            &sys_plugin.id,
            &sys_base,
            sys_plugin.manifest.preload.as_deref().unwrap(),
        )
        .await
        .expect("preload system-manager");

    let sys_res = runtime
        .call_function(
            &sys_plugin.id,
            "____callAgentTool____",
            vec![json!({
                "tool": "get_capabilities",
                "arguments": {}
            })],
        )
        .await
        .expect("call system-manager get_capabilities");
    assert!(
        sys_res.is_object(),
        "expected capabilities object, got: {sys_res}"
    );
}
