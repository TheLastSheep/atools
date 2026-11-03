use std::{fs, path::Path};

use serde_json::json;

use crate::package_resolution::{PackageReadiness, ResolvedPluginPackage};

use super::{inspect_runtime_dependencies, DependencyKind, DependencyStatus};

fn package(root: &Path) -> ResolvedPluginPackage {
    package_with_preload(root, "preload/index.cjs")
}

fn package_with_preload(root: &Path, preload: &str) -> ResolvedPluginPackage {
    let root = root.canonicalize().unwrap();
    let value = json!({ "name": "synthetic-fixture", "preload": preload });
    ResolvedPluginPackage {
        source_root: root.clone(),
        manifest_path: root.join("plugin.json"),
        package_root: root,
        manifest: serde_json::from_value(value.clone()).unwrap(),
        raw_manifest: value,
        readiness: PackageReadiness::Ready,
        diagnostics: Vec::new(),
    }
}

fn fixture() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("preload")).unwrap();
    dir
}

fn write(root: &Path, path: &str, content: &str) {
    let path = root.join(path);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

fn finding<'a>(
    report: &'a super::RuntimeDependencyReport,
    specifier: &str,
) -> &'a super::RuntimeDependencyFinding {
    report
        .findings
        .iter()
        .find(|item| item.specifier == specifier)
        .unwrap()
}

#[test]
fn resolves_preload_subdirectory_modules_and_reports_nested_transitive_missing() {
    let dir = fixture();
    write(dir.path(), "preload/index.cjs", "require('outer');");
    write(
        dir.path(),
        "preload/node_modules/outer/package.json",
        r#"{"main":"lib/index.js"}"#,
    );
    write(
        dir.path(),
        "preload/node_modules/outer/lib/index.js",
        "require('nested-missing');",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert_eq!(finding(&report, "outer").status, DependencyStatus::Resolved);
    assert_eq!(
        finding(&report, "nested-missing").status,
        DependencyStatus::Missing
    );
    assert!(report.complete);
    assert!(!report.runtime_verified);
}

#[test]
fn resolves_scoped_package_subpath_from_node_modules_ancestor() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "require('@scope/pkg/lib/entry');",
    );
    write(
        dir.path(),
        "preload/node_modules/@scope/pkg/lib/entry.js",
        "// fixture only",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    let item = finding(&report, "@scope/pkg/lib/entry");
    assert_eq!(item.status, DependencyStatus::Resolved);
    assert_eq!(
        item.resolved_path.as_deref(),
        Some(Path::new("preload/node_modules/@scope/pkg/lib/entry.js"))
    );
}

#[test]
fn resolves_package_directory_index_when_main_is_absent() {
    let dir = fixture();
    write(dir.path(), "preload/index.cjs", "require('index-pkg');");
    write(
        dir.path(),
        "preload/node_modules/index-pkg/index.js",
        "// fixture only",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    let item = finding(&report, "index-pkg");
    assert_eq!(item.status, DependencyStatus::Resolved);
    assert_eq!(
        item.resolved_path.as_deref(),
        Some(Path::new("preload/node_modules/index-pkg/index.js"))
    );
}

#[test]
fn recognizes_node_builtins_and_electron_host_shim() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "require('node:fs/promises'); require('electron');",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert_eq!(
        finding(&report, "node:fs/promises").kind,
        DependencyKind::Builtin
    );
    assert_eq!(
        finding(&report, "electron").kind,
        DependencyKind::ElectronShim
    );
    assert_eq!(
        finding(&report, "electron").status,
        DependencyStatus::HostProvided
    );
    assert!(report.complete);
}

#[test]
fn ignores_frontend_module_strings_and_only_walks_selected_preload() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "module.exports = {}; // throw-if-executed",
    );
    write(
        dir.path(),
        "index.html",
        "<script>require('frontend-only-string')</script>",
    );
    write(dir.path(), "dist/app.js", "require('also-frontend-only')");
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert!(report.findings.is_empty());
    assert!(!report
        .findings
        .iter()
        .any(|item| item.specifier.contains("frontend")));
}

#[test]
fn conditions_optional_try_catch_and_rebound_require_never_become_missing() {
    for source in [
        "if (process.platform) require('optional-platform');",
        "try { require('optional-try'); } catch (_) {}",
        "require?.('optional-chain');",
        "const require = fake; require('shadowed');",
        "const load = require; load('aliased');",
        "function load(require) { require('parameter-shadow'); }",
    ] {
        let dir = fixture();
        write(dir.path(), "preload/index.cjs", source);
        let report = inspect_runtime_dependencies(&package(dir.path()));
        assert!(!report.complete, "source unexpectedly complete: {source}");
        assert!(
            report
                .findings
                .iter()
                .all(|item| item.status != DependencyStatus::Missing),
            "{source}"
        );
        assert!(
            report
                .findings
                .iter()
                .any(|item| item.kind == DependencyKind::DynamicUnknown),
            "{source}"
        );
    }
}

#[test]
fn deferred_function_arrow_class_and_object_method_calls_are_unknown() {
    for source in [
        "function later() { require('missing-function'); }",
        "const later = function () { require('missing-function-expression'); };",
        "const later = () => require('missing-arrow');",
        "class Deferred { constructor() { require('missing-constructor'); } method() { require('missing-class-method'); } }",
        "const obj = { load() { require('missing-object-method'); }, get value() { require('missing-getter'); } };",
        "try { boot(); } catch (error) { class Recovery {} require('missing-catch'); }",
        "require('missing-short-circuit') && boot();",
    ] {
        let dir = fixture();
        write(dir.path(), "preload/index.cjs", source);
        let report = inspect_runtime_dependencies(&package(dir.path()));
        assert!(!report.complete, "source unexpectedly complete: {source}");
        assert!(
            report
                .findings
                .iter()
                .all(|item| item.status != DependencyStatus::Missing),
            "deferred or conditional call was reported missing: {source}"
        );
        assert!(
            report
                .findings
                .iter()
                .any(|item| item.kind == DependencyKind::DynamicUnknown),
            "source did not retain an unknown diagnostic: {source}"
        );
    }
}

#[test]
fn ambiguous_regex_after_close_brace_cannot_create_complete_missing_edges() {
    for source in [
        "function later() {} /require('ghost-package')/.test('');",
        "{} /require('ghost-package')/.test('');",
    ] {
        let dir = fixture();
        write(dir.path(), "preload/index.cjs", source);
        let report = inspect_runtime_dependencies(&package(dir.path()));
        assert!(!report.complete, "source unexpectedly complete: {source}");
        assert!(
            report
                .findings
                .iter()
                .all(|item| item.status != DependencyStatus::Missing),
            "regex body was reported as a missing dependency: {source}"
        );
        assert!(report.findings.iter().any(|item| {
            item.reason_code == "ambiguous_regex_or_division_syntax"
                && item.status == DependencyStatus::Unknown
        }));
    }

    // The shared lexer can identify a regexp after a statement terminator, so this
    // source has no dependency edge and is allowed to be complete.
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "const obj = {}; /require('ghost-package')/.test('');",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert!(report.complete);
    assert!(report
        .findings
        .iter()
        .all(|item| item.specifier != "ghost-package"));
    assert!(report
        .findings
        .iter()
        .all(|item| item.status != DependencyStatus::Missing));
}

#[test]
fn node_prefix_only_builtins_and_unknown_prefixes_are_not_guessed() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "require('node:test'); require('node:quic'); require('test');",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert_eq!(finding(&report, "node:test").kind, DependencyKind::Builtin);
    assert_eq!(
        finding(&report, "node:quic").status,
        DependencyStatus::Unknown
    );
    assert_eq!(finding(&report, "test").status, DependencyStatus::Missing);
}

#[test]
fn extensionless_resolution_does_not_assume_cjs_or_index_cjs() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "require('./implicit'); require('./explicit.cjs'); require('./folder');",
    );
    write(
        dir.path(),
        "preload/implicit.cjs",
        "// not an implicit Node extension",
    );
    write(
        dir.path(),
        "preload/explicit.cjs",
        "// explicit CJS edge is supported",
    );
    write(
        dir.path(),
        "preload/folder/index.cjs",
        "// not an implicit Node index suffix",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert_eq!(
        finding(&report, "./implicit").status,
        DependencyStatus::Missing
    );
    assert_eq!(
        finding(&report, "./explicit.cjs").status,
        DependencyStatus::Resolved
    );
    assert_eq!(
        finding(&report, "./folder").status,
        DependencyStatus::Missing
    );
}

#[test]
fn package_type_module_scope_is_unknown_without_reporting_missing_dependencies() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.js",
        "require('not-a-commonjs-edge');",
    );
    write(dir.path(), "preload/package.json", r#"{"type":"module"}"#);
    let report =
        inspect_runtime_dependencies(&package_with_preload(dir.path(), "preload/index.js"));
    assert!(!report.complete);
    assert!(report.findings.iter().any(|item| {
        item.reason_code == "package_type_module_unsupported"
            && item.status == DependencyStatus::Unknown
    }));
    assert!(report
        .findings
        .iter()
        .all(|item| item.status != DependencyStatus::Missing));
}

#[test]
fn complex_exports_and_dynamic_calls_remain_unknown() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "const name = getName(); require(name); require('exports-pkg');",
    );
    write(
        dir.path(),
        "preload/node_modules/exports-pkg/package.json",
        r#"{"exports":{".":"./index.js"},"main":"index.js"}"#,
    );
    write(
        dir.path(),
        "preload/node_modules/exports-pkg/index.js",
        "// not followed: exports are unsupported",
    );
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert!(!report.complete);
    assert_eq!(
        finding(&report, "exports-pkg").status,
        DependencyStatus::Unknown
    );
    assert!(report
        .findings
        .iter()
        .any(|item| item.reason_code == "dynamic_or_nonliteral_require"));

    let exports = fixture();
    write(
        exports.path(),
        "preload/index.cjs",
        "require('exports-pkg');",
    );
    write(
        exports.path(),
        "preload/node_modules/exports-pkg/package.json",
        r#"{"exports":{".":"./index.js"},"main":"index.js"}"#,
    );
    write(
        exports.path(),
        "preload/node_modules/exports-pkg/index.js",
        "// fixture only",
    );
    let report = inspect_runtime_dependencies(&package(exports.path()));
    assert_eq!(
        finding(&report, "exports-pkg").reason_code,
        "package_exports_resolution_unsupported"
    );
}

#[test]
fn native_addons_are_reported_but_never_loaded() {
    let dir = fixture();
    write(dir.path(), "preload/index.cjs", "require('./guard.node');");
    fs::write(dir.path().join("preload/guard.node"), b"throw-if-executed").unwrap();
    let report = inspect_runtime_dependencies(&package(dir.path()));
    let native = report
        .findings
        .iter()
        .find(|item| item.kind == DependencyKind::NativeAddon)
        .unwrap();
    assert_eq!(native.status, DependencyStatus::Unknown);
    assert_eq!(
        fs::read(dir.path().join("preload/guard.node")).unwrap(),
        b"throw-if-executed"
    );
    assert!(!report.complete);
}

#[cfg(unix)]
#[test]
fn symlink_and_package_root_traversal_are_unknown_not_missing() {
    use std::os::unix::fs::symlink;
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "require('./linked'); require('../../../outside');",
    );
    write(dir.path(), "outside.js", "// outside package root");
    symlink(
        dir.path().join("outside.js"),
        dir.path().join("preload/linked.js"),
    )
    .unwrap();
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert!(!report.complete);
    assert!(report
        .findings
        .iter()
        .all(|item| item.status != DependencyStatus::Missing));
    assert!(report
        .findings
        .iter()
        .any(|item| item.reason_code == "unsafe_or_unreadable_package_path"));
    assert!(report
        .findings
        .iter()
        .any(|item| item.reason_code == "unsafe_or_unsupported_module_specifier"));
}

#[test]
fn oversized_selected_source_exhausts_budget_as_unknown() {
    let dir = fixture();
    fs::write(
        dir.path().join("preload/index.cjs"),
        vec![b'a'; 256 * 1024 + 1],
    )
    .unwrap();
    let report = inspect_runtime_dependencies(&package(dir.path()));
    assert!(!report.complete);
    assert!(report
        .findings
        .iter()
        .any(|item| item.reason_code == "preload_file_budget_exhausted"));
}

#[test]
fn findings_are_stable_sorted_and_duplicate_edges_are_deduplicated() {
    let dir = fixture();
    write(
        dir.path(),
        "preload/index.cjs",
        "require('z-missing'); require('a-missing'); require('z-missing');",
    );
    let first = inspect_runtime_dependencies(&package(dir.path()));
    let second = inspect_runtime_dependencies(&package(dir.path()));
    let a: Vec<_> = first
        .findings
        .iter()
        .map(|item| item.specifier.as_str())
        .collect();
    assert_eq!(a, ["a-missing", "z-missing"]);
    assert_eq!(
        serde_json::to_string(&first).unwrap(),
        serde_json::to_string(&second).unwrap()
    );
}
