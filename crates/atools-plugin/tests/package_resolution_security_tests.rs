use std::fs;
use std::path::Path;

use atools_plugin::loader::read_preload_js;
use atools_plugin::package_resolution::html::{
    html_entry_references, is_source_entry_path, HtmlAssetKind, MAX_HTML_REFERENCES,
};
use atools_plugin::package_resolution::{resolve_plugin_package, PackageReadiness};
use tempfile::TempDir;

fn write(root: &Path, name: &str, contents: &str) {
    let file = root.join(name);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, contents).unwrap();
}

fn package(root: &Path, html: &str) {
    write(
        root,
        "plugin.json",
        r#"{"name":"test","main":"index.html"}"#,
    );
    write(root, "index.html", html);
}

#[test]
fn tokenizer_ignores_comments_inline_strings_and_quoted_attribute_contents() {
    let html = r#"<!-- <script src='fake.ts'></script> -->
        <div title="<script src='fake.ts'>">Visible</div>
        <textarea><script src='fake.ts'></script></textarea>
        <style>/* <script src='fake.ts'></script> */</style>
        <script>const example = '<script src="fake.ts">';</script>
        <SCRIPT data-example='src="fake.ts"' SRC = "real.js?a=1&amp;b=2"></SCRIPT>
        <link rel="preload" href="ignored.css"><link href='real.css' rel='alternate stylesheet'>"#;
    let result = html_entry_references(html);
    assert_eq!(result.assets.len(), 2);
    assert_eq!(result.assets[0].value, "real.js?a=1&b=2");
    assert_eq!(result.assets[0].kind, HtmlAssetKind::Script);
    assert_eq!(result.assets[1].kind, HtmlAssetKind::Stylesheet);
    let dir = TempDir::new().unwrap();
    package(dir.path(), html);
    write(dir.path(), "real.js", "// built");
    write(dir.path(), "real.css", "body{}");
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
}

#[test]
fn source_helper_handles_source_roots_without_matching_bundle_directory_names() {
    for source in [
        "/src/main.ts",
        "src/main.js",
        "./src/index.js?x=1",
        "../src/main.js",
        "App.vue",
        "App.svelte",
    ] {
        assert!(is_source_entry_path(source), "{source}");
    }
    for built in [
        "assets/src/main.js",
        "src/compiled.js",
        "app.ts.js",
        "bundle.js",
    ] {
        assert!(!is_source_entry_path(built), "{built}");
    }
}

#[test]
fn manifest_absolute_traversal_and_windows_style_paths_are_rejected() {
    for entry in [
        "../outside.html",
        "C:\\outside.html",
        "nested/../../outside.html",
        "a\\b.html",
    ] {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            "plugin.json",
            &serde_json::json!({"name":"escape", "main":entry}).to_string(),
        );
        assert!(resolve_plugin_package(dir.path()).is_err(), "{entry}");
    }
}

#[test]
fn public_parent_entry_must_remain_inside_its_selected_plugin_root() {
    let root_parent = TempDir::new().unwrap();
    write(
        root_parent.path(),
        "plugin.json",
        &serde_json::json!({"name":"root-entry","version":"1","main":"../outside.html"})
            .to_string(),
    );
    write(root_parent.path(), "outside.html", "must not resolve");
    assert!(resolve_plugin_package(root_parent.path()).is_err());

    let workspace = TempDir::new().unwrap();
    let public_escape = workspace.path().join("plugin");
    fs::create_dir(&public_escape).unwrap();
    write(
        &public_escape,
        "public/plugin.json",
        &serde_json::json!({"name":"public-entry","version":"1","main":"../../sibling/index.html"})
            .to_string(),
    );
    let sibling = workspace.path().join("sibling");
    fs::create_dir_all(&sibling).unwrap();
    fs::write(sibling.join("index.html"), "must not resolve").unwrap();
    assert!(resolve_plugin_package(&public_escape).is_err());
}

#[test]
fn public_main_rejects_control_characters_and_nonpackage_absolute_forms() {
    for main in [
        "C:/outside.html",
        "\\\\server\\share.html",
        "bad\u{0001}name.html",
        "bad\u{0085}name.html",
    ] {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            "public/plugin.json",
            &serde_json::json!({"name":"unsafe-public","version":"1","main":main}).to_string(),
        );
        assert!(resolve_plugin_package(dir.path()).is_err(), "{main:?}");
    }
}

#[cfg(unix)]
#[test]
fn promoted_public_main_and_feature_icon_reject_symlink_assets() {
    use std::os::unix::fs::symlink;

    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "public/plugin.json",
        &serde_json::json!({"name":"symlink-main","version":"1","main":"../linked.html"})
            .to_string(),
    );
    let outside = TempDir::new().unwrap();
    write(outside.path(), "entry.html", "outside");
    symlink(
        outside.path().join("entry.html"),
        dir.path().join("linked.html"),
    )
    .unwrap();
    assert!(resolve_plugin_package(dir.path()).is_err());

    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "public/plugin.json",
        r#"{"name":"symlink-icon","main":"../index.html","features":[{"code":"x","icon":"icon.png"}]}"#,
    );
    write(dir.path(), "index.html", "<main>entry</main>");
    let outside = TempDir::new().unwrap();
    write(outside.path(), "icon.png", "outside");
    symlink(
        outside.path().join("icon.png"),
        dir.path().join("public/icon.png"),
    )
    .unwrap();
    assert!(resolve_plugin_package(dir.path()).is_err());
}

#[test]
fn web_manifest_leading_slash_is_a_confined_package_path_without_editing_source() {
    let dir = TempDir::new().unwrap();
    let original = r#"{"name":"slash","main":"/main/index.html"}"#;
    write(dir.path(), "plugin.json", original);
    write(dir.path(), "main/index.html", "<main>published</main>");
    let package = resolve_plugin_package(dir.path()).unwrap();
    assert!(package.readiness.is_local_ready());
    assert_eq!(package.manifest.main.as_deref(), Some("main/index.html"));
    assert_eq!(package.raw_manifest["main"], "/main/index.html");
    assert_eq!(
        fs::read_to_string(dir.path().join("plugin.json")).unwrap(),
        original
    );
    for main in [
        "/../outside.html",
        "/nested/../../outside.html",
        "/C:/outside.html",
        "/a\\b.html",
    ] {
        write(
            dir.path(),
            "plugin.json",
            &serde_json::json!({"name":"slash","main":main}).to_string(),
        );
        assert!(resolve_plugin_package(dir.path()).is_err(), "{main}");
    }
    write(
        dir.path(),
        "plugin.json",
        r#"{"name":"native","runtime":{"kind":"node","transport":"json_rpc_stdio","entry":"/usr/bin/node"}}"#,
    );
    assert!(resolve_plugin_package(dir.path()).is_err());
}

#[test]
fn html_traversal_and_encoded_traversal_cannot_escape_selected_root() {
    for reference in [
        "../outside.js",
        "%2e%2e/outside.js",
        "/%2e%2e/outside.js",
        "a/%2e%2e/%2e%2e/outside.js",
    ] {
        let dir = TempDir::new().unwrap();
        package(dir.path(), &format!("<script src='{reference}'></script>"));
        assert!(resolve_plugin_package(dir.path()).is_err(), "{reference}");
    }
}

#[test]
fn html_root_relative_assets_and_base_are_confined_to_selected_package() {
    let dir = TempDir::new().unwrap();
    package(
        dir.path(),
        "<script src='/assets/app.js'></script><link rel='stylesheet' href='/assets/app.css'>",
    );
    write(dir.path(), "assets/app.js", "// built");
    write(dir.path(), "assets/app.css", "body{}");
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
    package(
        dir.path(),
        "<base href='/assets/'><script src='app.js'></script>",
    );
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
    package(dir.path(), "<script src='/%2e%2e/outside.js'></script>");
    assert!(resolve_plugin_package(dir.path()).is_err());
    package(dir.path(), "<script src='%2f%2fnetwork/share.js'></script>");
    assert!(resolve_plugin_package(dir.path()).is_err());
}

#[test]
fn html_base_and_percent_encoded_filename_follow_entry_url_semantics() {
    let dir = TempDir::new().unwrap();
    package(
        dir.path(),
        "<base href='./assets/'><script src='space%20file.js'></script>",
    );
    write(dir.path(), "assets/space file.js", "// built");
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
    package(
        dir.path(),
        "<base href='./'><script src='assets/space%20file.js'></script>",
    );
    assert!(resolve_plugin_package(dir.path())
        .unwrap()
        .readiness
        .is_local_ready());
    package(
        dir.path(),
        "<base href='https://example.invalid/'><script src='a.js'></script>",
    );
    assert_eq!(
        resolve_plugin_package(dir.path()).unwrap().readiness,
        PackageReadiness::Incomplete
    );
}

#[test]
fn excessive_html_references_are_bounded_and_rejected_before_file_reads() {
    let html = "<script src='missing.js'></script>".repeat(10_000);
    assert_eq!(
        html_entry_references(&html).assets.len(),
        MAX_HTML_REFERENCES + 1
    );
    let dir = TempDir::new().unwrap();
    package(dir.path(), &html);
    let error = resolve_plugin_package(dir.path()).unwrap_err();
    assert!(format!("{error:#}").contains("asset references"));
}

#[test]
fn standalone_preload_utility_is_still_confined() {
    let dir = TempDir::new().unwrap();
    write(dir.path(), "preload.js", "// safe");
    assert_eq!(
        read_preload_js(dir.path(), "preload.js").unwrap(),
        "// safe"
    );
    for entry in ["../preload.js", "/tmp/preload.js"] {
        assert!(read_preload_js(dir.path(), entry).is_err());
    }
}

#[cfg(unix)]
#[test]
fn symlink_manifests_package_roots_and_assets_are_rejected_even_inside_source() {
    use std::os::unix::fs::symlink;
    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "actual.json",
        r#"{"name":"symlink","main":"index.html"}"#,
    );
    write(dir.path(), "index.html", "ready");
    symlink("actual.json", dir.path().join("plugin.json")).unwrap();
    assert!(resolve_plugin_package(dir.path()).is_err());
    fs::remove_file(dir.path().join("plugin.json")).unwrap();
    write(
        dir.path(),
        "published/plugin.json",
        r#"{"name":"symlink","main":"index.html"}"#,
    );
    write(dir.path(), "published/index.html", "ready");
    symlink("published", dir.path().join("dist")).unwrap();
    assert!(resolve_plugin_package(dir.path()).is_err());
    fs::remove_file(dir.path().join("dist")).unwrap();
    package(dir.path(), "<script src='linked.js'></script>");
    write(dir.path(), "real.js", "built");
    symlink("real.js", dir.path().join("linked.js")).unwrap();
    assert!(resolve_plugin_package(dir.path()).is_err());
}

#[cfg(unix)]
#[test]
fn special_file_assets_are_rejected_without_waiting_for_writer() {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let dir = TempDir::new().unwrap();
    package(dir.path(), "<script src='pipe.js'></script>");
    let pipe = CString::new(dir.path().join("pipe.js").as_os_str().as_bytes()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(pipe.as_ptr(), 0o600) }, 0);
    assert!(resolve_plugin_package(dir.path()).is_err());
}
