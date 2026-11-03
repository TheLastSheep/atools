//! Fixed nested published-package selection tests; plugins are never executed.

use std::fs;
use std::path::{Path, PathBuf};

use atools_plugin::loader::read_preload_js;
use atools_plugin::package_resolution::{
    has_manifest_candidate, resolve_plugin_package, PackageReadiness, MANIFEST_CANDIDATES,
};
use serde_json::json;
use tempfile::TempDir;

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn manifest(name: &str, version: &str, main: &str, preload: Option<&str>) -> String {
    let mut value = json!({
        "name": name,
        "version": version,
        "platform": ["darwin"],
        "main": main
    });
    if let Some(preload) = preload {
        value["preload"] = preload.into();
    }
    value.to_string()
}

fn web_package(root: &Path, manifest_path: &str, name: &str, main_html: &str) {
    let base = manifest_path
        .strip_suffix("plugin.json")
        .expect("manifest path ends in plugin.json");
    write(
        root,
        manifest_path,
        &manifest(name, "1.2.0", "index.html", None),
    );
    write(root, &format!("{base}index.html"), main_html);
}

fn canonical(path: &Path) -> PathBuf {
    path.canonicalize().unwrap()
}

#[test]
fn nested_published_manifest_is_a_fixed_candidate_and_resolves_its_own_assets() {
    let dir = TempDir::new().unwrap();
    assert!(MANIFEST_CANDIDATES.contains(&"dist/ztools/plugin.json"));
    write(
        dir.path(),
        "dist/ztools/plugin.json",
        &manifest("nested", "1.2.0", "index.html", Some("preload.js")),
    );
    write(
        dir.path(),
        "dist/ztools/index.html",
        r#"<script src="assets/app.js"></script>"#,
    );
    write(dir.path(), "dist/ztools/assets/app.js", "// nested build");
    write(dir.path(), "dist/ztools/preload.js", "// nested preload");
    assert!(has_manifest_candidate(dir.path()));

    let package = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(
        package.manifest_path,
        canonical(&dir.path().join("dist/ztools/plugin.json"))
    );
    assert_eq!(
        package.package_root,
        canonical(&dir.path().join("dist/ztools"))
    );
    assert_eq!(package.readiness, PackageReadiness::Ready);
    assert_eq!(
        read_preload_js(dir.path(), "preload.js").unwrap(),
        "// nested preload"
    );
}

#[test]
fn ready_root_still_wins_without_parsing_either_published_manifest() {
    let dir = TempDir::new().unwrap();
    web_package(dir.path(), "plugin.json", "root", "<main>root ready</main>");
    write(dir.path(), "dist/plugin.json", "invalid primary JSON");
    write(dir.path(), "dist/ztools/plugin.json", "invalid nested JSON");

    let package = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(package.package_root, canonical(dir.path()));
    assert_eq!(package.readiness, PackageReadiness::Ready);
}

#[test]
fn ready_primary_dist_wins_and_nested_candidate_is_not_parsed() {
    let dir = TempDir::new().unwrap();
    web_package(
        dir.path(),
        "plugin.json",
        "demo",
        r#"<script type="module" src="src/main.ts"></script>"#,
    );
    web_package(
        dir.path(),
        "dist/plugin.json",
        "demo",
        "<main>primary ready</main>",
    );
    write(dir.path(), "dist/ztools/plugin.json", "invalid nested JSON");

    let package = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(package.package_root, canonical(&dir.path().join("dist")));
    assert_eq!(package.readiness, PackageReadiness::Ready);
}

#[test]
fn ready_primary_without_source_skips_different_or_invalid_nested_manifest() {
    let different_identity = manifest("other-plugin", "9.9.9", "index.html", None);
    for nested_manifest in [different_identity, "invalid nested JSON".to_owned()] {
        let dir = TempDir::new().unwrap();
        write(
            dir.path(),
            "dist/plugin.json",
            &manifest("primary-plugin", "1.2.0", "index.html", None),
        );
        write(dir.path(), "dist/index.html", "<main>primary ready</main>");
        write(dir.path(), "dist/ztools/plugin.json", &nested_manifest);
        write(
            dir.path(),
            "dist/ztools/index.html",
            "<main>nested must not be inspected</main>",
        );

        let package = resolve_plugin_package(dir.path()).unwrap();
        assert_eq!(package.package_root, canonical(&dir.path().join("dist")));
        assert_eq!(package.readiness, PackageReadiness::Ready);
    }
}

#[test]
fn incomplete_primary_dist_falls_back_to_matching_nested_package_and_preload() {
    let dir = TempDir::new().unwrap();
    web_package(
        dir.path(),
        "plugin.json",
        "demo",
        r#"<script type="module" src="src/main.ts"></script>"#,
    );
    write(
        dir.path(),
        "dist/plugin.json",
        &manifest("demo", "1.2.0", "missing.html", None),
    );
    write(
        dir.path(),
        "dist/ztools/plugin.json",
        &manifest("demo", "1.2.0", "index.html", Some("preload.js")),
    );
    write(
        dir.path(),
        "dist/ztools/index.html",
        r#"<script src="assets/app.js"></script>"#,
    );
    write(dir.path(), "dist/ztools/assets/app.js", "// nested build");
    write(dir.path(), "dist/ztools/preload.js", "// nested preload");

    let package = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(
        package.package_root,
        canonical(&dir.path().join("dist/ztools"))
    );
    assert_eq!(package.readiness, PackageReadiness::Ready);
    assert_eq!(
        read_preload_js(dir.path(), "preload.js").unwrap(),
        "// nested preload"
    );
}

#[test]
fn nonready_primary_and_nested_with_different_identities_are_rejected_without_source() {
    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "dist/plugin.json",
        &manifest("primary", "1.2.0", "missing.html", None),
    );
    write(
        dir.path(),
        "dist/ztools/plugin.json",
        &manifest("nested", "1.2.0", "index.html", None),
    );
    write(dir.path(), "dist/ztools/index.html", "<main>nested</main>");

    let error = resolve_plugin_package(dir.path()).unwrap_err();
    assert!(format!("{error:#}").contains("identity/version mismatch"));
}

#[test]
fn nested_identity_and_version_mismatches_against_source_are_rejected() {
    for (name, version) in [("other", "1.2.0"), ("demo", "1.1.9")] {
        let dir = TempDir::new().unwrap();
        web_package(
            dir.path(),
            "plugin.json",
            "demo",
            r#"<script type="module" src="src/main.ts"></script>"#,
        );
        write(
            dir.path(),
            "dist/plugin.json",
            &manifest("demo", "1.2.0", "missing.html", None),
        );
        write(
            dir.path(),
            "dist/ztools/plugin.json",
            &manifest(name, version, "index.html", None),
        );
        write(dir.path(), "dist/ztools/index.html", "<main>nested</main>");

        let error = resolve_plugin_package(dir.path()).unwrap_err();
        assert!(format!("{error:#}").contains("identity/version mismatch"));
    }
}

#[test]
fn incomplete_nested_package_cannot_borrow_assets_from_the_source_directory() {
    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "dist/ztools/plugin.json",
        &manifest("nested", "1.2.0", "index.html", Some("preload.js")),
    );
    write(
        dir.path(),
        "dist/ztools/index.html",
        r#"<script src="assets/app.js"></script>"#,
    );
    write(dir.path(), "assets/app.js", "// source-only asset");
    write(dir.path(), "preload.js", "// source-only preload");

    let package = resolve_plugin_package(dir.path()).unwrap();
    assert_eq!(
        package.package_root,
        canonical(&dir.path().join("dist/ztools"))
    );
    assert_eq!(package.readiness, PackageReadiness::Incomplete);
    assert!(read_preload_js(dir.path(), "preload.js").is_err());
}

#[cfg(unix)]
#[test]
fn nested_manifest_symlink_and_parent_traversal_are_rejected() {
    use std::os::unix::fs::symlink;

    let dir = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    write(
        outside.path(),
        "plugin.json",
        &manifest("outside", "1.2.0", "index.html", None),
    );
    write(outside.path(), "index.html", "<main>outside</main>");
    fs::create_dir_all(dir.path().join("dist/ztools")).unwrap();
    symlink(
        outside.path().join("plugin.json"),
        dir.path().join("dist/ztools/plugin.json"),
    )
    .unwrap();
    assert!(resolve_plugin_package(dir.path()).is_err());

    let dir = TempDir::new().unwrap();
    write(
        dir.path(),
        "dist/ztools/plugin.json",
        &manifest("nested", "1.2.0", "../../outside.html", None),
    );
    write(dir.path(), "outside.html", "must not be read");
    assert!(resolve_plugin_package(dir.path()).is_err());
}
