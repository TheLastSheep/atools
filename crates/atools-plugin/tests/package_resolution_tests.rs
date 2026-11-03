//! Selection tests use only synthetic files; no plugin is executed or built.

use std::fs;
use std::path::{Path, PathBuf};

use atools_plugin::loader::{
    load_manifest, load_plugin_from_disk, read_preload_js, try_resolve_manifest_path,
};
use atools_plugin::package_resolution::{
    has_manifest_candidate, resolve_plugin_package, PackageReadiness, MAX_HTML_BYTES,
    MAX_MANIFEST_BYTES,
};
use serde_json::json;
use tempfile::TempDir;

fn write(root: &Path, name: &str, contents: &str) {
    let file = root.join(name);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, contents).unwrap();
}

fn manifest(
    root: &Path,
    at: &str,
    name: &str,
    version: &str,
    main: Option<&str>,
    preload: Option<&str>,
) {
    let mut value = json!({"name": name, "version": version, "platform": ["darwin"]});
    if let Some(main) = main {
        value["main"] = main.into();
    }
    if let Some(preload) = preload {
        value["preload"] = preload.into();
    }
    write(root, at, &value.to_string());
}

fn package(root: &Path, base: &str, html: &str) {
    let prefix = if base.is_empty() {
        String::new()
    } else {
        format!("{base}/")
    };
    manifest(
        root,
        &format!("{prefix}plugin.json"),
        "demo",
        "1.2.0",
        Some("index.html"),
        None,
    );
    write(root, &format!("{prefix}index.html"), html);
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap()
}

#[test]
fn valid_root_wins_without_parsing_unrelated_dist() {
    let dir = TempDir::new().unwrap();
    package(dir.path(), "", "<main>published</main>");
    write(dir.path(), "dist/plugin.json", "invalid ignored JSON");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.package_root, canonical(dir.path()));
    assert_eq!(result.readiness, PackageReadiness::Ready);
    assert_eq!(result.raw_manifest["platform"][0], "darwin");
}

#[test]
fn source_root_selects_complete_same_version_dist_and_loader_uses_its_base() {
    let dir = TempDir::new().unwrap();
    package(
        dir.path(),
        "",
        r#"<script type="module" src="/src/main.ts"></script>"#,
    );
    package(
        dir.path(),
        "dist",
        r#"<script src="./assets/main.js"></script>"#,
    );
    write(dir.path(), "dist/assets/main.js", "console.log('built')");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.package_root, canonical(&dir.path().join("dist")));
    assert!(result.readiness.is_local_ready());
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.code == "selected_published_package"));
    assert_eq!(
        try_resolve_manifest_path(dir.path()).unwrap(),
        result.manifest_path
    );
    assert_eq!(
        load_plugin_from_disk(dir.path()).unwrap().path,
        result.package_root.to_string_lossy()
    );
}

#[test]
fn public_manifest_source_selects_matching_dist() {
    let dir = TempDir::new().unwrap();
    package(
        dir.path(),
        "public",
        r#"<script src="../src/main.js"></script>"#,
    );
    package(dir.path(), "dist", "<main>built</main>");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.package_root, canonical(&dir.path().join("dist")));
    assert!(has_manifest_candidate(dir.path()));
}

#[test]
fn published_identity_and_version_mismatches_are_rejected() {
    for (name, version) in [("other", "1.2.0"), ("demo", "1.1.9")] {
        let dir = TempDir::new().unwrap();
        package(dir.path(), "", r#"<script src="src/main.ts"></script>"#);
        manifest(
            dir.path(),
            "dist/plugin.json",
            name,
            version,
            Some("index.html"),
            None,
        );
        write(dir.path(), "dist/index.html", "built");
        assert!(resolve_plugin_package(dir.path())
            .unwrap_err()
            .to_string()
            .contains("identity/version mismatch"));
    }
}

#[test]
fn incomplete_dist_cannot_borrow_source_script_or_replace_source() {
    let dir = TempDir::new().unwrap();
    package(dir.path(), "", r#"<script src="src/main.ts"></script>"#);
    package(
        dir.path(),
        "dist",
        r#"<script src="assets/main.js"></script>"#,
    );
    write(dir.path(), "assets/main.js", "must not be borrowed");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.package_root, canonical(dir.path()));
    assert_eq!(result.readiness, PackageReadiness::RequiresBuild);
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.code == "incomplete_published_package"));
}

#[test]
fn selected_dist_cannot_borrow_source_preload() {
    let dir = TempDir::new().unwrap();
    package(dir.path(), "dist", "<main>built</main>");
    manifest(
        dir.path(),
        "dist/plugin.json",
        "demo",
        "1.2.0",
        Some("index.html"),
        Some("preload.js"),
    );
    write(dir.path(), "preload.js", "source preload");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.readiness, PackageReadiness::Incomplete);
    assert!(read_preload_js(dir.path(), "preload.js").is_err());
    write(dir.path(), "dist/preload.js", "published preload");
    assert_eq!(
        read_preload_js(dir.path(), "preload.js").unwrap(),
        "published preload"
    );
}

#[test]
fn nested_entry_assets_are_relative_to_html_parent() {
    let dir = TempDir::new().unwrap();
    manifest(
        dir.path(),
        "plugin.json",
        "nested",
        "1",
        Some("ui/page.html"),
        Some("bridge/preload.js"),
    );
    write(
        dir.path(),
        "ui/page.html",
        r#"<script src="../assets/app.js?q=1#x"></script><link rel="alternate stylesheet" href="styles/app.css">"#,
    );
    write(dir.path(), "assets/app.js", "built");
    write(dir.path(), "ui/styles/app.css", "body{}");
    write(dir.path(), "bridge/preload.js", "// preload");
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
}

#[test]
fn public_parent_main_uses_plugin_root_and_remaps_public_assets() {
    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "public/plugin.json",
        r#"{"name":"public-layout","version":"1","main":"../index.html","logo":"logo.png","preload":"preload/services.js","features":[{"code":"open","icon":"logo.png"}]}"#,
    );
    write(
        dir.path(),
        "index.html",
        r#"<script type="module" src="./src/main.ts"></script>"#,
    );
    write(dir.path(), "src/main.ts", "export {};");
    write(dir.path(), "public/logo.png", "logo");
    write(
        dir.path(),
        "public/preload/services.js",
        "// public preload",
    );

    let package = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(package.package_root, canonical(dir.path()));
    assert_eq!(package.manifest.main.as_deref(), Some("index.html"));
    assert_eq!(package.manifest.logo.as_deref(), Some("public/logo.png"));
    assert_eq!(
        package.manifest.preload.as_deref(),
        Some("public/preload/services.js")
    );
    assert_eq!(
        package.manifest.features[0].icon.as_deref(),
        Some("public/logo.png")
    );
    assert_eq!(package.raw_manifest["main"], "../index.html");
    assert_eq!(package.readiness, PackageReadiness::RequiresBuild);
}

#[test]
fn public_leading_slash_main_remains_relative_to_the_public_package() {
    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "public/plugin.json",
        r#"{"name":"public-slash","main":"/index.html"}"#,
    );
    write(dir.path(), "public/index.html", "<main>public</main>");
    write(dir.path(), "index.html", "<main>plugin root</main>");

    let package = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(package.package_root, canonical(&dir.path().join("public")));
    assert_eq!(package.manifest.main.as_deref(), Some("index.html"));
    assert_eq!(package.readiness, PackageReadiness::Ready);
}

#[test]
fn public_and_dist_candidates_do_not_borrow_each_others_entry_files() {
    let dir = TempDir::new().unwrap();
    manifest(
        dir.path(),
        "public/plugin.json",
        "same-plugin",
        "1",
        Some("../index.html"),
        None,
    );
    write(dir.path(), "index.html", "<main>source package</main>");
    manifest(
        dir.path(),
        "dist/plugin.json",
        "same-plugin",
        "1",
        Some("index.html"),
        None,
    );

    let selected = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(selected.package_root, canonical(dir.path()));
    assert_eq!(selected.manifest.main.as_deref(), Some("index.html"));
    assert!(selected.readiness.is_local_ready());

    write(dir.path(), "dist/index.html", "<main>published</main>");
    let selected = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(selected.package_root, canonical(&dir.path().join("dist")));
    assert!(selected.readiness.is_local_ready());
}

#[test]
fn missing_script_and_stylesheet_are_explicitly_incomplete() {
    let dir = TempDir::new().unwrap();
    package(
        dir.path(),
        "",
        r#"<script src="app.js"></script><link REL="StyleSheet" href="app.css">"#,
    );
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.readiness, PackageReadiness::Incomplete);
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.code == "missing_script"));
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.code == "missing_stylesheet"));
}

#[test]
fn headless_preload_is_ready_but_no_entry_is_incomplete() {
    let dir = TempDir::new().unwrap();
    manifest(
        dir.path(),
        "plugin.json",
        "headless",
        "1",
        None,
        Some("preload.cjs"),
    );
    write(dir.path(), "preload.cjs", "module.exports = {}");
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
    manifest(dir.path(), "plugin.json", "headless", "1", None, None);
    assert_eq!(
        resolve_plugin_package(dir.path()).unwrap().readiness,
        PackageReadiness::Incomplete
    );
}

#[test]
fn explicit_runtime_entries_keep_native_and_web_headless_contracts() {
    for kind in ["node", "rust", "wasm", "web"] {
        let dir = TempDir::new().unwrap();
        let transport = if kind == "web" {
            "host_bridge"
        } else {
            "json_rpc_stdio"
        };
        write(dir.path(), "plugin.json", &json!({"name":"runtime", "runtime": {"kind":kind,"entry":"entry.js","transport":transport}}).to_string());
        write(dir.path(), "entry.js", "placeholder, never executed");
        assert!(
            resolve_plugin_package(dir.path())
                .unwrap()
                .readiness
                .is_local_ready(),
            "{kind}"
        );
    }
}

#[test]
fn remote_entry_is_metadata_and_never_local_ready() {
    let dir = TempDir::new().unwrap();
    manifest(
        dir.path(),
        "plugin.json",
        "remote",
        "1",
        Some("https://127.0.0.1:1/no-network"),
        None,
    );
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.readiness, PackageReadiness::Remote);
    assert!(!result.readiness.is_local_ready());
}

#[test]
fn source_main_extensions_and_missing_logo_are_distinct() {
    let dir = TempDir::new().unwrap();
    manifest(
        dir.path(),
        "plugin.json",
        "source",
        "1",
        Some("src/App.vue"),
        None,
    );
    assert_eq!(
        resolve_plugin_package(dir.path()).unwrap().readiness,
        PackageReadiness::RequiresBuild
    );
    write(
        dir.path(),
        "plugin.json",
        r#"{"name":"logo","main":"index.html","logo":"missing.png"}"#,
    );
    write(dir.path(), "index.html", "<main>ready</main>");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert!(result.readiness.is_local_ready());
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.code == "missing_logo"));
}

#[test]
fn empty_html_is_incomplete_and_empty_main_with_preload_is_headless() {
    let dir = TempDir::new().unwrap();
    package(dir.path(), "", "  \n\t");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.readiness, PackageReadiness::Incomplete);
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.code == "empty_main"));
    manifest(
        dir.path(),
        "plugin.json",
        "headless",
        "1",
        Some(""),
        Some("preload.js"),
    );
    write(dir.path(), "preload.js", "// executable JS");
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
}

#[test]
fn source_preload_requires_compilation_even_when_main_is_published() {
    let dir = TempDir::new().unwrap();
    manifest(
        dir.path(),
        "plugin.json",
        "source-preload",
        "1",
        Some("index.html"),
        Some("preload.ts"),
    );
    write(dir.path(), "index.html", "<main>built UI</main>");
    write(dir.path(), "preload.ts", "const value: number = 1");
    let result = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(result.readiness, PackageReadiness::RequiresBuild);
    assert!(result
        .diagnostics
        .iter()
        .any(|item| item.code == "source_preload_entry"));
}

#[test]
fn manifest_and_html_byte_budgets_fail_closed() {
    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "plugin.json",
        &" ".repeat(MAX_MANIFEST_BYTES + 1),
    );
    assert!(resolve_plugin_package(dir.path()).is_err());
    package(dir.path(), "", &" ".repeat(MAX_HTML_BYTES + 1));
    assert!(resolve_plugin_package(dir.path()).is_err());
}

#[test]
fn plugin_id_depends_on_name_and_not_selected_package_or_title() {
    let source = TempDir::new().unwrap();
    let published = TempDir::new().unwrap();
    package(source.path(), "", r#"<script src="src/main.ts"></script>"#);
    package(source.path(), "dist", "built");
    package(published.path(), "", "built");
    assert_eq!(
        load_plugin_from_disk(source.path()).unwrap().id,
        load_plugin_from_disk(published.path()).unwrap().id
    );
    assert_eq!(load_manifest(source.path()).unwrap().name, "demo");
}
