use super::*;
use atools_plugin::package_resolution::html::MAX_HTML_REFERENCES;
use std::{fs, io::Write};

fn write_zip(path: &Path, entries: &[(&str, &[u8])]) {
    let mut archive = ::zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in entries {
        archive
            .start_file(*name, ::zip::write::SimpleFileOptions::default())
            .unwrap();
        archive.write_all(bytes).unwrap();
    }
    archive.finish().unwrap();
}
const MANIFEST: &[u8] = br#"{"name":"zip-fixture","title":"ZIP Fixture","version":"1","main":"index.html","preload":"preload.cjs","features":[{"code":"zip","cmds":["zip"]}]}"#;

#[test]
fn zip_scan_import_and_activation_use_the_same_published_package_without_execution() {
    for prefix in ["", "published/"] {
        let scratch = tempfile::tempdir().unwrap();
        let source = scratch.path().join("fixture.zip");
        let files = [
            (format!("{prefix}plugin.json"), MANIFEST),
            (
                format!("{prefix}index.html"),
                b"<script src='assets/main.js'></script>".as_slice(),
            ),
            (
                format!("{prefix}assets/main.js"),
                b"document.body.textContent='ready'".as_slice(),
            ),
            (
                format!("{prefix}preload.cjs"),
                b"throw Error('Import must never execute me')".as_slice(),
            ),
        ];
        write_zip(
            &source,
            &files
                .iter()
                .map(|(name, bytes)| (name.as_str(), *bytes))
                .collect::<Vec<_>>(),
        );
        let found = candidate(&source).unwrap();
        assert_eq!(found.entry_readiness.as_deref(), Some("ready"));
        assert!(found.errors.is_empty());
        assert_eq!(found.source_type, "zip");
        let db = atools_core::Database::in_memory().unwrap();
        let report = super::super::import_ztools_plugins(
            &db,
            &scratch.path().join("installed"),
            &[source.to_string_lossy().into()],
            true,
        )
        .unwrap();
        assert_eq!(report.imported, vec!["zip-fixture"]);
        let plugin = db.get_plugin("zip-fixture").unwrap();
        assert!(Path::new(&plugin.path).join("assets/main.js").is_file());
        assert!(!Path::new(&plugin.path).join("published").exists());
        let action = crate::commands::activate_feature_inner(&db, "zip", None).unwrap();
        assert_eq!(action.plugin_path, plugin.path);
        assert_eq!(action.main_url, "index.html");
        assert_eq!(
            action.preload_path.unwrap(),
            Path::new(&plugin.path)
                .join("preload.cjs")
                .to_string_lossy()
        );
    }
}

#[test]
fn source_missing_assets_and_missing_preloads_are_not_installable() {
    let scratch = tempfile::tempdir().unwrap();
    for (name, html, preload) in [
        ("source", "<script src='/src/main.ts'></script>", true),
        ("missing", "<script src='missing.js'></script>", true),
        ("no-preload", "<p>ok</p>", false),
        ("empty", " ", true),
    ] {
        let source = scratch.path().join(format!("{name}.zip"));
        let mut entries = vec![("plugin.json", MANIFEST), ("index.html", html.as_bytes())];
        if preload {
            entries.push(("preload.cjs", b"window.services={}"));
        }
        write_zip(&source, &entries);
        let found = candidate(&source).unwrap();
        assert!(!found.errors.is_empty(), "{name} unexpectedly ready");
    }
}

#[test]
fn zip_scan_ignores_script_strings_and_supports_confined_nested_assets_and_headless() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("nested.zip");
    let manifest = br#"{"name":"nested","main":"pages/index.html"}"#;
    write_zip(&source, &[("plugin.json", manifest), ("pages/index.html", b"<!--<script src='x.ts'>--><script>const text=\"<script src='x.ts'>\"</script><script src='../assets/main.js?v=1'></script>"), ("assets/main.js", b"// compiled")]);
    assert!(candidate(&source).unwrap().errors.is_empty());
    write_zip(
        &source,
        &[
            (
                "plugin.json",
                br#"{"name":"headless","preload":"preload.cjs"}"#,
            ),
            ("preload.cjs", b"window.services={}"),
        ],
    );
    let headless = candidate(&source).unwrap();
    assert!(headless.headless && !headless.main_exists && headless.errors.is_empty());
}

#[test]
fn zip_paths_and_reference_budgets_fail_closed() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("unsafe.zip");
    for name in ["../escape", "/escape", "a\\..\\escape", "a:stream"] {
        write_zip(&source, &[("plugin.json", MANIFEST), (name, b"bad")]);
        assert!(Package::open(&source).is_err(), "{name}");
    }
    write_zip(
        &source,
        &[("plugin.json", MANIFEST), ("Plugin.json", MANIFEST)],
    );
    assert!(Package::open(&source).is_err());
    for html in [
        "<script src='%2e%2e/escape.js'></script>".to_string(),
        "<script src='main.js'></script>".repeat(MAX_HTML_REFERENCES + 1),
    ] {
        write_zip(
            &source,
            &[
                ("plugin.json", MANIFEST),
                ("index.html", html.as_bytes()),
                ("preload.cjs", b""),
                ("main.js", b"compiled"),
            ],
        );
        assert!(candidate(&source).is_err());
    }
    let mut archive = ::zip::ZipWriter::new(fs::File::create(&source).unwrap());
    archive
        .add_symlink(
            "link",
            "outside",
            ::zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    archive.finish().unwrap();
    assert!(Package::open(&source).is_err());
}
