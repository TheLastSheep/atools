use super::*;
use std::io::Write;

fn package(name: &str) -> Vec<u8> {
    package_at_version(name, "same")
}

fn package_at_version(name: &str, version: &str) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, text) in [
        (
            "plugin.json",
            format!(r#"{{"name":"{name}","version":"{version}","main":"index.html"}}"#),
        ),
        ("index.html", "<p>inert</p>".into()),
    ] {
        archive
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(text.as_bytes()).unwrap();
    }
    archive.finish().unwrap().into_inner()
}

#[test]
fn preflight_rejects_changed_identity_without_persisting_or_removing_another_stage() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let neighbor = config
        .base_dir()
        .join("plugin-market-staging/other-operation");
    std::fs::create_dir_all(&neighbor).unwrap();
    std::fs::write(neighbor.join("keep"), "owned elsewhere").unwrap();
    assert!(prepare(
        &config,
        &package("after"),
        "https://example.invalid/package.zip",
        Some("before"),
        None
    )
    .is_err());
    assert_eq!(
        std::fs::read_dir(neighbor.parent().unwrap())
            .unwrap()
            .count(),
        1
    );
    assert!(neighbor.join("keep").is_file());
    assert!(!config.plugins_dir().exists());
}

#[test]
fn prepared_package_lifetime_owns_only_its_temporary_root() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let prepared = prepare(
        &config,
        &package("fixture"),
        "https://example.invalid/package.zip",
        Some("fixture"),
        None,
    )
    .unwrap();
    let root = prepared.root.clone();
    assert!(prepared.source.join("plugin.json").is_file());
    drop(prepared);
    assert!(!root.exists());
    assert!(!config.plugins_dir().exists());
}

#[test]
fn expected_version_is_validated_without_normalizing_opaque_bytes() {
    assert!(validate_expected_version(None).is_ok());
    assert!(validate_expected_version(Some("v1.0+build 7")).is_ok());
    assert!(validate_expected_version(Some("")).is_err());
    assert!(validate_expected_version(Some(&"x".repeat(129))).is_err());
    assert!(validate_expected_version(Some("v1\n0")).is_err());
}

#[test]
fn matching_confirmed_version_can_be_installed() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let db = Database::open(&scratch.path().join("atools.db")).unwrap();

    let installed = apply_archive_for_test_with_version(
        &db,
        &config,
        &package_at_version("confirmed-version", "1.0+build 7"),
        "https://example.invalid/package.zip",
        Some("confirmed-version"),
        Some("1.0+build 7"),
        false,
    )
    .unwrap();

    assert_eq!(installed.version, "1.0+build 7");
    assert!(!installed.enabled);
    assert!(Path::new(&installed.path).join("plugin.json").is_file());
}

#[test]
fn mismatched_confirmed_version_rejects_install_and_cleans_private_stage() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let db = Database::open(&scratch.path().join("atools.db")).unwrap();
    let staging_parent = config.base_dir().join("plugin-market-staging");

    let error = apply_archive_for_test_with_version(
        &db,
        &config,
        &package_at_version("version-install", "2.0"),
        "https://example.invalid/package.zip",
        Some("version-install"),
        Some("1.0"),
        false,
    )
    .unwrap_err();

    assert!(error.contains("version does not match"));
    assert!(db.get_plugin("version-install").is_err());
    assert!(!config.plugins_dir().join("version-install").exists());
    assert!(db.list_task_runs(100).unwrap().is_empty());
    assert_eq!(std::fs::read_dir(staging_parent).unwrap().count(), 0);
}

#[test]
fn mismatched_confirmed_version_rejects_update_without_changing_files_or_data() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let db = Database::open(&scratch.path().join("atools.db")).unwrap();
    let installed = apply_archive_for_test(
        &db,
        &config,
        &package_at_version("version-update", "1.0"),
        "https://example.invalid/package.zip",
        Some("version-update"),
        false,
    )
    .unwrap();
    let mut enabled = db.get_plugin(&installed.id).unwrap();
    enabled.enabled = true;
    db.save_plugin_with_features(&enabled, &enabled.manifest.features)
        .unwrap();
    let data = atools_core::Document {
        id: "preserve-me".into(),
        rev: None,
        data: serde_json::json!({"value": "original"}),
    };
    db.plugin_data_put(&installed.id, &data).unwrap();
    let plugin_dir = Path::new(&installed.path);
    let original_manifest = std::fs::read(plugin_dir.join("plugin.json")).unwrap();
    let original_entry = std::fs::read(plugin_dir.join("index.html")).unwrap();
    let original_plugin = db.get_plugin(&installed.id).unwrap();
    let original_features = db.features_by_plugin(&installed.id).unwrap();
    let staging_parent = config.base_dir().join("plugin-market-staging");

    let error = apply_archive_for_test_with_version(
        &db,
        &config,
        &package_at_version("version-update", "2.0"),
        "https://example.invalid/package.zip",
        Some("version-update"),
        Some("1.0"),
        true,
    )
    .unwrap_err();

    assert!(error.contains("version does not match"));
    let current_plugin = db.get_plugin(&installed.id).unwrap();
    assert_eq!(current_plugin.version, original_plugin.version);
    assert_eq!(current_plugin.path, original_plugin.path);
    assert_eq!(current_plugin.enabled, true);
    assert_eq!(
        db.features_by_plugin(&installed.id).unwrap().len(),
        original_features.len()
    );
    assert_eq!(
        db.plugin_data_get(&installed.id, "preserve-me")
            .unwrap()
            .unwrap()
            .data,
        data.data
    );
    assert!(db.list_task_runs(100).unwrap().is_empty());
    assert_eq!(
        std::fs::read(plugin_dir.join("plugin.json")).unwrap(),
        original_manifest
    );
    assert_eq!(
        std::fs::read(plugin_dir.join("index.html")).unwrap(),
        original_entry
    );
    assert_eq!(std::fs::read_dir(staging_parent).unwrap().count(), 0);
}

fn archive_with(entries: &[(&str, &[u8])], aliases: &[(&str, &str)]) -> Vec<u8> {
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in entries {
        archive
            .start_file(*path, zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    for (path, target) in aliases {
        archive
            .add_symlink(*path, *target, zip::write::SimpleFileOptions::default())
            .unwrap();
    }
    archive.finish().unwrap().into_inner()
}

#[test]
fn market_keeps_resolver_selection_for_source_dist_and_public_roots() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let source = br#"{"name":"resolver-choice","version":"1","main":"src/main.ts"}"#;
    let published = br#"{"name":"resolver-choice","version":"1","main":"index.html"}"#;
    let dist = archive_with(
        &[
            ("plugin.json", source),
            ("src/main.ts", b"export default 1"),
            ("dist/plugin.json", published),
            ("dist/index.html", b"<p>published</p>"),
            ("node_modules/pkg/source.js", b"source cli"),
        ],
        &[("node_modules/.bin/source-only", "../pkg/source.js")],
    );
    let prepared = prepare(
        &config,
        &dist,
        "https://example.invalid/package.zip",
        Some("resolver-choice"),
        None,
    )
    .unwrap();
    assert!(
        prepared.source.ends_with("dist"),
        "selected {:?}",
        prepared.source
    );
    drop(prepared);

    let public = archive_with(
        &[
            ("public/plugin.json", published),
            ("public/index.html", b"<p>public</p>"),
        ],
        &[],
    );
    let prepared = prepare(
        &config,
        &public,
        "https://example.invalid/package.zip",
        Some("resolver-choice"),
        None,
    )
    .unwrap();
    assert!(
        prepared.source.ends_with("public"),
        "selected {:?}",
        prepared.source
    );
    drop(prepared);

    let root = archive_with(
        &[
            ("plugin.json", published),
            ("index.html", b"<p>root</p>"),
            ("dist/plugin.json", source),
            ("dist/src/main.ts", b"export default 1"),
        ],
        &[],
    );
    let prepared = prepare(
        &config,
        &root,
        "https://example.invalid/package.zip",
        Some("resolver-choice"),
        None,
    )
    .unwrap();
    assert_eq!(
        prepared.source.canonicalize().unwrap(),
        prepared.root.canonicalize().unwrap()
    );
}

#[test]
fn materialized_bin_alias_can_satisfy_preload_and_keep_ready_root_selected() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let root = br#"{"name":"alias-preload","version":"1","main":"index.html","preload":"node_modules/.bin/cli"}"#;
    let published = br#"{"name":"alias-preload","version":"1","main":"index.html"}"#;
    let bytes = archive_with(
        &[
            ("plugin.json", root),
            ("index.html", b"<p>root</p>"),
            ("node_modules/pkg/cli.js", b"module.exports = {};"),
            ("dist/plugin.json", published),
            ("dist/index.html", b"<p>dist</p>"),
        ],
        &[("node_modules/.bin/cli", "../pkg/cli.js")],
    );
    let prepared = prepare(
        &config,
        &bytes,
        "https://example.invalid/package.zip",
        Some("alias-preload"),
        None,
    )
    .unwrap();
    assert_eq!(
        prepared.source.canonicalize().unwrap(),
        prepared.root.canonicalize().unwrap()
    );
    assert_eq!(
        std::fs::read(prepared.source.join("node_modules/.bin/cli")).unwrap(),
        b"module.exports = {};"
    );
}

#[test]
fn selected_root_allows_nested_self_contained_alias_but_rejects_cross_package_targets() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let root_manifest = br#"{"name":"nested-alias-scope","version":"1","main":"index.html"}"#;
    let nested_manifest = br#"{"name":"nested","version":"1","main":"index.html"}"#;
    let valid_nested = archive_with(
        &[
            ("plugin.json", root_manifest),
            ("index.html", b"<p>root</p>"),
            ("nested/plugin.json", nested_manifest),
            ("nested/index.html", b"<p>nested</p>"),
            ("nested/node_modules/pkg/cli.js", b"nested cli"),
        ],
        &[("nested/node_modules/.bin/cli", "../pkg/cli.js")],
    );
    let prepared = prepare(
        &config,
        &valid_nested,
        "https://example.invalid/package.zip",
        Some("nested-alias-scope"),
        None,
    )
    .unwrap();
    assert_eq!(
        prepared.source.canonicalize().unwrap(),
        prepared.root.canonicalize().unwrap()
    );
    assert_eq!(
        std::fs::read(prepared.root.join("nested/node_modules/.bin/cli")).unwrap(),
        b"nested cli"
    );
    drop(prepared);

    let root_to_nested = archive_with(
        &[
            ("plugin.json", root_manifest),
            ("index.html", b"<p>root</p>"),
            ("nested/plugin.json", nested_manifest),
            ("nested/cli.js", b"nested cli"),
        ],
        &[("node_modules/.bin/cli", "../../nested/cli.js")],
    );
    assert!(prepare(
        &config,
        &root_to_nested,
        "https://example.invalid/package.zip",
        Some("nested-alias-scope"),
        None,
    )
    .is_err());
    let staging_parent = config.base_dir().join("plugin-market-staging");
    assert_eq!(std::fs::read_dir(&staging_parent).unwrap().count(), 0);

    let nested_to_root = archive_with(
        &[
            ("plugin.json", root_manifest),
            ("index.html", b"<p>root</p>"),
            ("node_modules/pkg/cli.js", b"root cli"),
            ("nested/plugin.json", nested_manifest),
        ],
        &[(
            "nested/node_modules/.bin/cli",
            "../../../node_modules/pkg/cli.js",
        )],
    );
    assert!(prepare(
        &config,
        &nested_to_root,
        "https://example.invalid/package.zip",
        Some("nested-alias-scope"),
        None,
    )
    .is_err());
    assert_eq!(std::fs::read_dir(&staging_parent).unwrap().count(), 0);
}

#[test]
fn selected_market_alias_cannot_escape_or_cross_nested_manifest_and_failure_cleans_stage() {
    let scratch = tempfile::tempdir().unwrap();
    let config = AppConfig::with_base_dir(scratch.path().join("data"));
    let source = br#"{"name":"bounded-market","version":"1","main":"src/main.ts"}"#;
    let published = br#"{"name":"bounded-market","version":"1","main":"index.html"}"#;
    let outside = archive_with(
        &[
            ("plugin.json", source),
            ("src/main.ts", b"export default 1"),
            ("node_modules/pkg/cli.js", b"outside target"),
            ("dist/plugin.json", published),
            ("dist/index.html", b"<p>dist</p>"),
        ],
        &[(
            "dist/node_modules/.bin/cli",
            "../../../node_modules/pkg/cli.js",
        )],
    );
    let error = match prepare(
        &config,
        &outside,
        "https://example.invalid/package.zip",
        Some("bounded-market"),
        None,
    ) {
        Ok(prepared) => {
            drop(prepared);
            panic!("selected dist alias escaped its package root");
        }
        Err(error) => error,
    };
    assert!(error.contains("target escapes selected package"), "{error}");
    let staging_parent = config.base_dir().join("plugin-market-staging");
    assert_eq!(std::fs::read_dir(&staging_parent).unwrap().count(), 0);

    let nested = archive_with(
        &[
            ("plugin.json", published),
            ("index.html", b"<p>root</p>"),
            ("nested/plugin.json", br#"{"name":"nested","version":"1"}"#),
            ("nested/cli.js", b"nested target"),
        ],
        &[("node_modules/.bin/cli", "../../nested/cli.js")],
    );
    assert!(prepare(
        &config,
        &nested,
        "https://example.invalid/package.zip",
        Some("bounded-market"),
        None
    )
    .is_err());
    assert_eq!(std::fs::read_dir(&staging_parent).unwrap().count(), 0);
}
