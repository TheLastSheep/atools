use atools_plugin::package_resolution::page_requirements::{inspect_plugin_page, Usage};
use serde_json::json;
use std::{fs, path::Path};
use tempfile::TempDir;

fn write(root: &Path, path: &str, contents: &[u8]) {
    let file = root.join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, contents).unwrap();
}
fn plugin(root: &Path, main: &str, body: &str) {
    write(
        root,
        "plugin.json",
        json!({"name":"fixture","version":"1","main":main})
            .to_string()
            .as_bytes(),
    );
    if main.starts_with("http") {
        return;
    }
    write(root, main, body.as_bytes());
}

#[test]
fn analyzes_only_inline_and_referenced_local_script_graph() {
    let temp = TempDir::new().unwrap();
    plugin(
        temp.path(),
        "index.html",
        r#"<script>const fs = require('node:fs');</script><script src="app.js"></script>"#,
    );
    write(temp.path(), "app.js", b"require('./helper')");
    write(temp.path(), "helper.js", b"module.exports = require('fs')");
    write(temp.path(), "unused.js", b"require('child_process')");
    let result = inspect_plugin_page(temp.path()).unwrap();
    assert_eq!(result.node_usage, Usage::Detected);
    assert_eq!(result.electron_usage, Usage::NotDetected);
}

#[test]
fn follows_esm_side_effect_and_from_imports_without_marking_web_modules_as_node() {
    let side_effect = TempDir::new().unwrap();
    plugin(
        side_effect.path(),
        "index.html",
        r#"<script type="module" src="app.js"></script>"#,
    );
    write(side_effect.path(), "app.js", b"import './helper.js';");
    write(
        side_effect.path(),
        "helper.js",
        b"const fs = require('fs'); export { fs };",
    );
    assert_eq!(
        inspect_plugin_page(side_effect.path()).unwrap().node_usage,
        Usage::Detected
    );

    let from_import = TempDir::new().unwrap();
    plugin(
        from_import.path(),
        "index.html",
        r#"<script type="module" src="app.js"></script>"#,
    );
    write(
        from_import.path(),
        "app.js",
        b"import { value } from './helper.js'; console.log(value);",
    );
    write(
        from_import.path(),
        "helper.js",
        b"const fs = require('fs'); export const value = fs.readFileSync;",
    );
    assert_eq!(
        inspect_plugin_page(from_import.path()).unwrap().node_usage,
        Usage::Detected
    );

    let web_module = TempDir::new().unwrap();
    plugin(
        web_module.path(),
        "index.html",
        r#"<script type="module" src="app.js"></script>"#,
    );
    write(
        web_module.path(),
        "app.js",
        b"import { value } from './helper.js'; console.log(value);",
    );
    write(
        web_module.path(),
        "helper.js",
        b"export const value = window.location.href;",
    );
    assert_eq!(
        inspect_plugin_page(web_module.path()).unwrap().node_usage,
        Usage::NotDetected
    );
}

#[test]
fn ignores_node_spellings_inside_comments_strings_and_unreferenced_files() {
    let temp = TempDir::new().unwrap();
    plugin(
        temp.path(),
        "index.html",
        r#"<script>const text = "require('fs')"; // require('child_process')</script>"#,
    );
    write(temp.path(), "unused.js", b"process.exit(1)");
    let result = inspect_plugin_page(temp.path()).unwrap();
    assert_eq!(result.node_usage, Usage::NotDetected);

    let buffer = TempDir::new().unwrap();
    plugin(
        buffer.path(),
        "index.html",
        r#"<script>const data = typeof Buffer === 'undefined' ? null : Buffer.from('web');</script>"#,
    );
    assert_eq!(
        inspect_plugin_page(buffer.path()).unwrap().node_usage,
        Usage::NotDetected
    );
}

#[test]
fn detects_electron_separately_from_node_requirements() {
    let temp = TempDir::new().unwrap();
    plugin(
        temp.path(),
        "index.html",
        r#"<script>window.require('electron')</script>"#,
    );
    let result = inspect_plugin_page(temp.path()).unwrap();
    assert_eq!(result.electron_usage, Usage::Detected);
    assert_eq!(result.node_usage, Usage::NotDetected);
}

#[test]
fn recognizes_global_window_require_but_not_arbitrary_member_methods() {
    let node = TempDir::new().unwrap();
    plugin(
        node.path(),
        "index.html",
        r#"<script>window.require('fs')</script>"#,
    );
    assert_eq!(
        inspect_plugin_page(node.path()).unwrap().node_usage,
        Usage::Detected
    );

    let web = TempDir::new().unwrap();
    plugin(
        web.path(),
        "index.html",
        r#"<script>widget.require('fs')</script>"#,
    );
    assert_eq!(
        inspect_plugin_page(web.path()).unwrap().node_usage,
        Usage::NotDetected
    );
}

#[test]
fn detects_literal_bracket_global_require_and_marks_dynamic_calls_unknown() {
    let bracket = TempDir::new().unwrap();
    plugin(
        bracket.path(),
        "index.html",
        r#"<script>window['require']('fs')</script>"#,
    );
    assert_eq!(
        inspect_plugin_page(bracket.path()).unwrap().node_usage,
        Usage::Detected
    );

    let dynamic = TempDir::new().unwrap();
    plugin(
        dynamic.path(),
        "index.html",
        r#"<script>window[loader]('fs')</script>"#,
    );
    assert_eq!(
        inspect_plugin_page(dynamic.path()).unwrap().node_usage,
        Usage::Unknown
    );
}

#[test]
fn bundler_and_umd_identifiers_are_uncertain_not_node_evidence() {
    for body in [
        "const bundle={id:1,loaded:false,exports:{}};",
        "const commonJs=typeof exports==='object' && typeof module==='object';",
        "const vueRuntime={process(input){return input;}};",
    ] {
        let temp = TempDir::new().unwrap();
        plugin(
            temp.path(),
            "index.html",
            &format!("<script>{body}</script>"),
        );
        let usage = inspect_plugin_page(temp.path()).unwrap().node_usage;
        assert_eq!(usage, Usage::Unknown, "source: {body}");
    }

    let pure_web = TempDir::new().unwrap();
    plugin(
        pure_web.path(),
        "index.html",
        "<script>document.body.textContent = window.location.href;</script>",
    );
    assert_eq!(
        inspect_plugin_page(pure_web.path()).unwrap().node_usage,
        Usage::NotDetected
    );
}

#[test]
fn require_resolve_is_unknown_until_the_bridge_supports_resolution() {
    let temp = TempDir::new().unwrap();
    plugin(
        temp.path(),
        "index.html",
        "<script>const path = require.resolve('path');</script>",
    );
    assert_eq!(
        inspect_plugin_page(temp.path()).unwrap().node_usage,
        Usage::Unknown
    );
}

#[test]
fn scans_inline_html_event_handlers_as_executable_javascript() {
    let temp = TempDir::new().unwrap();
    plugin(
        temp.path(),
        "index.html",
        r#"<button onclick="window.require('fs').readFileSync('/tmp/input')">Read</button>"#,
    );
    assert_eq!(
        inspect_plugin_page(temp.path()).unwrap().node_usage,
        Usage::Detected
    );
}

#[test]
fn compatibility_tier_uses_actual_page_requirements() {
    use atools_plugin::loader::{assess_ztools_plugin_compatibility, ZToolsCompatibilityTier};
    let node = TempDir::new().unwrap();
    plugin(
        node.path(),
        "index.html",
        r#"<script src="app.js"></script>"#,
    );
    write(node.path(), "app.js", b"window.require('fs')");
    let report = assess_ztools_plugin_compatibility(node.path()).unwrap();
    assert!(report.uses_node_builtins);
    assert_eq!(report.page_node_usage, Usage::Detected);
    assert_eq!(
        report.tier,
        ZToolsCompatibilityTier::Tier2QuickJsOrNodeSidecar
    );

    let web = TempDir::new().unwrap();
    plugin(web.path(), "index.html", "<h1>web only</h1>");
    let report = assess_ztools_plugin_compatibility(web.path()).unwrap();
    assert!(!report.uses_node_builtins);
    assert_eq!(report.tier, ZToolsCompatibilityTier::Tier1DirectWebView);
}

#[test]
fn remote_entry_and_out_of_root_or_missing_dependencies_are_unknown() {
    let remote = TempDir::new().unwrap();
    plugin(remote.path(), "https://example.invalid/main.html", "");
    assert_eq!(
        inspect_plugin_page(remote.path()).unwrap().node_usage,
        Usage::Unknown
    );

    let escaped = TempDir::new().unwrap();
    plugin(
        escaped.path(),
        "index.html",
        r#"<script src="../outside.js"></script>"#,
    );
    assert!(inspect_plugin_page(escaped.path()).is_err());

    let missing = TempDir::new().unwrap();
    plugin(
        missing.path(),
        "index.html",
        r#"<script src="missing.js"></script>"#,
    );
    assert_eq!(
        inspect_plugin_page(missing.path()).unwrap().node_usage,
        Usage::Unknown
    );
}

#[cfg(unix)]
#[test]
fn symlinked_script_source_is_unknown() {
    use std::os::unix::fs::symlink;
    let temp = TempDir::new().unwrap();
    plugin(
        temp.path(),
        "index.html",
        r#"<script src="linked.js"></script>"#,
    );
    let outside = temp.path().join("outside.js");
    fs::write(&outside, b"require('fs')").unwrap();
    symlink(outside, temp.path().join("linked.js")).unwrap();
    assert!(inspect_plugin_page(temp.path()).is_err());
}

#[test]
fn byte_and_source_count_budgets_fail_closed_to_unknown() {
    let oversized = TempDir::new().unwrap();
    plugin(
        oversized.path(),
        "index.html",
        r#"<script src="large.js"></script>"#,
    );
    write(
        oversized.path(),
        "large.js",
        &vec![b' '; 4 * 1024 * 1024 + 1],
    );
    assert_eq!(
        inspect_plugin_page(oversized.path()).unwrap().node_usage,
        Usage::Unknown
    );

    let aggregate = TempDir::new().unwrap();
    let html_prefix = r#"<script src="app.js"></script>"#;
    let mut html = html_prefix.as_bytes().to_vec();
    html.resize(2 * 1024 * 1024, b' ');
    plugin(aggregate.path(), "index.html", "");
    write(aggregate.path(), "index.html", &html);
    write(aggregate.path(), "app.js", &vec![b' '; 2 * 1024 * 1024 + 1]);
    assert_eq!(
        inspect_plugin_page(aggregate.path()).unwrap().node_usage,
        Usage::Unknown
    );

    let many = TempDir::new().unwrap();
    let refs = (0..65)
        .map(|i| format!(r#"<script src="{i}.js"></script>"#))
        .collect::<String>();
    plugin(many.path(), "index.html", &refs);
    for i in 0..65 {
        write(many.path(), &format!("{i}.js"), b"");
    }
    assert_eq!(
        inspect_plugin_page(many.path()).unwrap().node_usage,
        Usage::Unknown
    );
}
