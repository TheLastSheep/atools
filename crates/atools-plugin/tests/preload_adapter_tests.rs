//! TDD test suite for the 3-Tier ZTools Preload Adapter Layer:
//! - QuickJS 2-arg / 3-arg `ztools.registerTool` compatibility
//! - QuickJS `window`, `module.exports`, `process`, `Buffer`, `ztools.getAppVersion()` globals
//! - `NodePreloadBridge` for Tier 2B Node.js CommonJS & Electron preload scripts
//! - Transparent fallback in `JsRuntime` from QuickJS to `NodePreloadBridge`

use std::sync::Arc;

use async_trait::async_trait;
use atools_plugin::ipc_handler::{IpcHandler, IpcResult};
use atools_plugin::node_preload::NodePreloadBridge;
use atools_plugin::runtime::JsRuntime;
use serde_json::{json, Value};

struct DummyIpcHandler;

#[async_trait]
impl IpcHandler for DummyIpcHandler {
    async fn handle(&self, _plugin_id: &str, method: &str, _args: Vec<Value>) -> IpcResult {
        match method {
            "system.isMacOS" => Ok(Value::Bool(cfg!(target_os = "macos"))),
            "system.isWindows" => Ok(Value::Bool(cfg!(target_os = "windows"))),
            "system.isLinux" => Ok(Value::Bool(cfg!(target_os = "linux"))),
            "system.nativeId" => Ok(Value::String("atools-test-native-id".to_string())),
            "system.getPath" => Ok(Value::String("/tmp".to_string())),
            _ => Ok(Value::Null),
        }
    }
}

fn write_synthetic_file(root: &std::path::Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, contents).unwrap();
}

fn synthetic_manifest(main: &str, preload: Option<&str>) -> String {
    let mut manifest = json!({
        "name": "synthetic-preload-root",
        "version": "1.0.0",
        "platform": ["darwin"],
        "main": main,
    });
    if let Some(preload) = preload {
        manifest["preload"] = json!(preload);
    }
    manifest.to_string()
}

#[tokio::test]
async fn quickjs_shim_supports_two_arg_ztools_register_tool_and_globals() {
    let runtime = JsRuntime::new(Arc::new(DummyIpcHandler)).expect("create runtime");
    let preload = r#"
        if (typeof window === 'undefined') {
            throw new Error('window global must be defined in QuickJS shim');
        }
        if (typeof module === 'undefined' || typeof exports === 'undefined') {
            throw new Error('CommonJS module/exports globals must be defined in QuickJS shim');
        }
        if (typeof ztools.getAppVersion !== 'function' || !ztools.getAppVersion()) {
            throw new Error('ztools.getAppVersion() must be available for ZTools 2.4+ plugins');
        }

        // Official ZTools 2-argument signature: ztools.registerTool(name, handler)
        ztools.registerTool('two_arg_tool', function(input) {
            return {
                echoed: input.text,
                version: ztools.getAppVersion(),
                hasProcess: typeof process === 'object'
            };
        });
    "#;

    runtime
        .execute_preload("plugin_two_arg", preload)
        .await
        .expect("execute preload with 2-arg registerTool");

    let result = runtime
        .call_function(
            "plugin_two_arg",
            "____callAgentTool____",
            vec![json!({
                "tool": "two_arg_tool",
                "arguments": { "text": "hello-ztools" }
            })],
        )
        .await
        .expect("invoke 2-arg registered tool");

    assert_eq!(result["echoed"], "hello-ztools");
    assert_eq!(result["hasProcess"], true);
    assert!(result["version"]
        .as_str()
        .unwrap_or_default()
        .starts_with("3."));
}

#[tokio::test]
async fn node_preload_bridge_executes_cjs_and_electron_preload_and_invokes_tools() {
    let temp = tempfile::tempdir().expect("create temp plugin dir");
    let plugin_dir = temp.path();

    // Write a relative CommonJS helper module
    std::fs::write(
        plugin_dir.join("helper.cjs"),
        r#"
        const crypto = require('node:crypto');
        module.exports = {
            sha256(input) {
                return crypto.createHash('sha256').update(String(input)).digest('hex');
            }
        };
        "#,
    )
    .expect("write helper.cjs");

    // Write a preload.cjs that uses node:fs, node:path, electron, relative require, window.services, and ztools.registerTool
    std::fs::write(
        plugin_dir.join("preload.cjs"),
        r#"
        'use strict';
        const fs = require('node:fs');
        const path = require('node:path');
        const electron = require('electron');
        const { sha256 } = require('./helper.cjs');

        window.services = {
            hashText(text) {
                return {
                    hash: sha256(text),
                    hasElectronClipboard: Boolean(electron && electron.clipboard),
                    pluginDirExists: fs.existsSync(path.join(__dirname, 'helper.cjs'))
                };
            }
        };

        ztools.registerTool('compute_sha256', async (args) => {
            return window.services.hashText(args.text || '');
        });

        module.exports = {
            TOOL_NAMES: { compute: 'compute_sha256' },
            directHash: (text) => sha256(text)
        };
        "#,
    )
    .expect("write preload.cjs");

    let bridge = NodePreloadBridge::new(plugin_dir.to_path_buf(), "preload.cjs".to_string());
    let inspection = bridge.inspect().await.expect("inspect CJS preload");

    assert!(inspection.services.contains(&"hashText".to_string()));
    assert!(inspection.exports.contains(&"TOOL_NAMES".to_string()));
    assert!(inspection
        .registered_tools
        .contains(&"compute_sha256".to_string()));

    let tool_output = bridge
        .call_tool("compute_sha256", json!({ "text": "atools-rock-solid" }))
        .await
        .expect("call registered CJS tool");
    assert_eq!(tool_output["hasElectronClipboard"], true);
    assert_eq!(tool_output["pluginDirExists"], true);
    assert_eq!(tool_output["hash"].as_str().expect("sha256 hex").len(), 64);

    let service_output = bridge
        .call_service("hashText", vec![json!("service-call")])
        .await
        .expect("call window.services.hashText");
    assert_eq!(service_output["pluginDirExists"], true);
}

#[tokio::test]
async fn js_runtime_transparently_falls_back_to_node_preload_for_cjs_plugins() {
    let temp = tempfile::tempdir().expect("create temp plugin dir");
    let plugin_dir = temp.path();

    std::fs::write(
        plugin_dir.join("preload.cjs"),
        r#"
        const path = require('node:path');
        ztools.registerTool('join_segments', (args) => {
            return { joined: path.posix.join(args.a, args.b) };
        });
        "#,
    )
    .expect("write preload.cjs");

    let runtime = JsRuntime::new(Arc::new(DummyIpcHandler)).expect("create runtime");
    runtime
        .execute_preload_from_dir("plugin_cjs_fallback", plugin_dir, "preload.cjs")
        .await
        .expect("execute_preload_from_dir should succeed via NodePreloadBridge fallback");

    let output = runtime
        .call_function(
            "plugin_cjs_fallback",
            "____callAgentTool____",
            vec![json!({
                "tool": "join_segments",
                "arguments": { "a": "/workspace/atools", "b": "DESIGN.md" }
            })],
        )
        .await
        .expect("call_function should delegate to NodePreloadBridge for CJS plugin");

    assert_eq!(output["joined"], "/workspace/atools/DESIGN.md");
}

#[tokio::test]
async fn runtime_executes_preload_and_relative_helper_from_the_selected_dist_root() {
    let temp = tempfile::tempdir().expect("create synthetic source package");
    let root = temp.path();
    write_synthetic_file(root, "plugin.json", &synthetic_manifest("index.html", None));
    write_synthetic_file(
        root,
        "index.html",
        r#"<script type="module" src="/src/main.ts"></script>"#,
    );
    write_synthetic_file(root, "src/main.ts", "// source needs a build");
    write_synthetic_file(root, "helper.cjs", "module.exports = 'source-helper';");
    write_synthetic_file(
        root,
        "dist/plugin.json",
        &synthetic_manifest("index.html", Some("preload.cjs")),
    );
    write_synthetic_file(root, "dist/index.html", "<main>built</main>");
    write_synthetic_file(root, "dist/helper.cjs", "module.exports = 'dist-helper';");
    write_synthetic_file(
        root,
        "dist/preload.cjs",
        "const path = require('node:path'); const helper = require('./helper.cjs'); ztools.registerTool('selected-root', () => path.basename(__dirname) + ':' + helper);",
    );

    let runtime = JsRuntime::new(Arc::new(DummyIpcHandler)).expect("create runtime");
    runtime
        .execute_preload_from_dir("selected-dist", root, "preload.cjs")
        .await
        .expect("selected dist preload should execute");
    let result = runtime
        .call_function(
            "selected-dist",
            "____callAgentTool____",
            vec![json!({"tool":"selected-root","arguments":{}})],
        )
        .await
        .expect("call synthetic selected-root tool");
    assert_eq!(result, "dist:dist-helper");
}

#[tokio::test]
async fn selected_dist_does_not_borrow_a_relative_helper_from_source_root() {
    let temp = tempfile::tempdir().expect("create synthetic source package");
    let root = temp.path();
    write_synthetic_file(root, "plugin.json", &synthetic_manifest("index.html", None));
    write_synthetic_file(
        root,
        "index.html",
        r#"<script type="module" src="/src/main.ts"></script>"#,
    );
    write_synthetic_file(root, "src/main.ts", "// source needs a build");
    write_synthetic_file(root, "helper.cjs", "module.exports = 'source-only-helper';");
    write_synthetic_file(
        root,
        "dist/plugin.json",
        &synthetic_manifest("index.html", Some("preload.cjs")),
    );
    write_synthetic_file(root, "dist/index.html", "<main>built</main>");
    write_synthetic_file(
        root,
        "dist/preload.cjs",
        "module.exports = require('./helper.cjs');",
    );

    let runtime = JsRuntime::new(Arc::new(DummyIpcHandler)).expect("create runtime");
    let error = runtime
        .execute_preload_from_dir("missing-dist-helper", root, "preload.cjs")
        .await
        .expect_err("dist preload must not borrow the source helper");
    assert!(error
        .to_string()
        .contains("Cannot find module './helper.cjs'"));
}

#[tokio::test]
async fn unavailable_npm_dependency_is_reported_as_a_real_module_error() {
    let temp = tempfile::tempdir().expect("create synthetic standalone package");
    for dependency in [
        "yaml",
        "pdf-lib",
        "systeminformation",
        "atools-synthetic-missing-dependency-20261015",
    ] {
        write_synthetic_file(
            temp.path(),
            "preload.cjs",
            &format!("require('{dependency}');"),
        );
        let error = NodePreloadBridge::new(temp.path().to_path_buf(), "preload.cjs".into())
            .inspect()
            .await
            .expect_err("unavailable npm dependency must not be synthesized");
        assert!(error
            .to_string()
            .contains(&format!("Cannot find module '{dependency}'")));
    }
}

#[tokio::test]
async fn successful_quickjs_preload_replaces_a_stale_node_bridge_for_the_same_id() {
    let temp = tempfile::tempdir().expect("create synthetic plugin");
    write_synthetic_file(
        temp.path(),
        "preload.cjs",
        "ztools.registerTool('reload-source', () => 'node-preload');",
    );
    let runtime = JsRuntime::new(Arc::new(DummyIpcHandler)).expect("create runtime");
    runtime
        .execute_preload_from_dir("same-plugin-id", temp.path(), "preload.cjs")
        .await
        .expect("load initial synthetic Node preload");

    let call_node = runtime
        .call_function(
            "same-plugin-id",
            "____callAgentTool____",
            vec![json!({"tool":"reload-source","arguments":{}})],
        )
        .await
        .unwrap();
    assert_eq!(call_node, json!("node-preload"));

    assert!(runtime
        .execute_preload(
            "same-plugin-id",
            "throw new Error('synthetic reload failed');"
        )
        .await
        .is_err());
    let call_before_success = runtime
        .call_function(
            "same-plugin-id",
            "____callAgentTool____",
            vec![json!({"tool":"reload-source","arguments":{}})],
        )
        .await
        .unwrap();
    assert_eq!(call_before_success, json!("node-preload"));

    std::fs::remove_file(temp.path().join("preload.cjs")).unwrap();
    runtime
        .execute_preload(
            "same-plugin-id",
            "ztools.registerTool('reload-source', () => 'quickjs-preload');",
        )
        .await
        .expect("successful QuickJS reload should replace the old preload");
    let call_after_success = runtime
        .call_function(
            "same-plugin-id",
            "____callAgentTool____",
            vec![json!({"tool":"reload-source","arguments":{}})],
        )
        .await
        .unwrap();
    assert_eq!(call_after_success, json!("quickjs-preload"));
}

#[cfg(unix)]
#[tokio::test]
async fn preload_symlink_resolving_outside_package_is_rejected_before_execution() {
    use std::os::unix::fs::symlink;

    let temp = tempfile::tempdir().expect("create synthetic plugin root");
    let root = temp.path().join("package");
    std::fs::create_dir_all(&root).unwrap();
    let outside_preload = temp.path().join("outside-preload.cjs");
    let sentinel = temp.path().join("external-preload-executed");
    write_synthetic_file(
        temp.path(),
        "outside-preload.cjs",
        &format!(
            "require('node:fs').writeFileSync({:?}, 'executed'); module.exports = {{}};",
            sentinel.to_string_lossy()
        ),
    );
    symlink(&outside_preload, root.join("preload.cjs")).unwrap();

    let error = NodePreloadBridge::new(root, "preload.cjs".into())
        .inspect()
        .await
        .expect_err("symlinked preload must not escape the selected package root");
    assert!(error
        .to_string()
        .contains("resolved preload escapes the selected package"));
    assert!(
        !sentinel.exists(),
        "outside synthetic preload was not executed"
    );
}
