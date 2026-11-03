use super::super::{local_package, stage_directory, validate_staged};
use std::{fs, io::Write, path::Path};

const MANIFEST: &str = r#"{
  "name":"runtime-preflight-fixture",
  "title":"Runtime preflight fixture",
  "version":"1",
  "main":"index.html",
  "preload":"preload/index.cjs",
  "features":[{"code":"fixture","cmds":["fixture"]}]
}"#;

fn fixture(root: &Path, version: &str, preload: &str, with_module: bool) {
    fs::create_dir_all(root.join("preload")).unwrap();
    let mut manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
    manifest["version"] = version.into();
    fs::write(
        root.join("plugin.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    fs::write(
        root.join("index.html"),
        "<script>require('frontend-only-string')</script>",
    )
    .unwrap();
    fs::write(root.join("preload/index.cjs"), preload).unwrap();
    if with_module {
        let module = root.join("preload/node_modules/fixture-module");
        fs::create_dir_all(&module).unwrap();
        fs::write(module.join("package.json"), r#"{"main":"index.cjs"}"#).unwrap();
        fs::write(module.join("index.cjs"), "module.exports = {};").unwrap();
    }
}

fn archive(root: &Path, version: &str, preload: &str) -> std::path::PathBuf {
    let target = root.join("fixture.zip");
    let file = fs::File::create(&target).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let mut manifest: serde_json::Value = serde_json::from_str(MANIFEST).unwrap();
    manifest["version"] = version.into();
    for (path, contents) in [
        ("plugin.json", serde_json::to_string(&manifest).unwrap()),
        ("index.html", "<main>fixture</main>".to_string()),
        ("preload/index.cjs", preload.to_string()),
    ] {
        writer
            .start_file(path, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents.as_bytes()).unwrap();
    }
    writer.finish().unwrap();
    target
}

#[test]
fn local_package_and_directory_install_block_only_complete_known_missing_graphs() {
    let scratch = tempfile::tempdir().unwrap();
    let missing = scratch.path().join("missing");
    fixture(&missing, "1", "require('fixture-missing');", false);
    let error = local_package(&missing).unwrap_err();
    assert!(error.contains("PLUGIN_RUNTIME_DEPENDENCY_MISSING"));
    assert!(error.contains("fixture-missing"));
    assert!(error.contains("包含运行依赖的发布包"));
    assert!(error.len() <= 1100);

    let db = atools_core::Database::in_memory().unwrap();
    let config = atools_core::AppConfig::with_base_dir(scratch.path().join("data"));
    let error =
        crate::commands::install_plugin_from_directory_inner(&db, &config, &missing).unwrap_err();
    assert!(error.contains("PLUGIN_RUNTIME_DEPENDENCY_MISSING"));
    assert!(db.get_plugin("runtime-preflight-fixture").is_err());
    assert!(!config
        .plugins_dir()
        .join("runtime-preflight-fixture")
        .exists());

    let valid = scratch.path().join("valid");
    fixture(&valid, "1", "require('fixture-module');", true);
    let installed =
        crate::commands::install_plugin_from_directory_inner(&db, &config, &valid).unwrap();
    assert_eq!(installed.version, "1");
    assert!(Path::new(&installed.path)
        .join("preload/node_modules/fixture-module/index.cjs")
        .is_file());
}

#[test]
fn update_and_bulk_zip_import_use_the_same_gate_before_mutating_database_or_install() {
    let scratch = tempfile::tempdir().unwrap();
    let db = atools_core::Database::in_memory().unwrap();
    let config = atools_core::AppConfig::with_base_dir(scratch.path().join("data"));
    let source = scratch.path().join("source");
    fixture(&source, "1", "require('fixture-module');", true);
    crate::commands::install_plugin_from_directory_inner(&db, &config, &source).unwrap();
    let installed_before = db.get_plugin("runtime-preflight-fixture").unwrap();

    fixture(&source, "2", "require('fixture-missing');", false);
    let error = crate::commands::plugin_update_from_path_inner(
        &db,
        &config,
        "runtime-preflight-fixture",
        &source,
    )
    .unwrap_err();
    assert!(error.contains("PLUGIN_RUNTIME_DEPENDENCY_MISSING"));
    let installed_after = db.get_plugin("runtime-preflight-fixture").unwrap();
    assert_eq!(installed_after.version, installed_before.version);
    assert!(Path::new(&installed_after.path)
        .join("preload/node_modules/fixture-module/index.cjs")
        .is_file());

    let zip = archive(scratch.path(), "3", "require('fixture-missing');");
    let zip_report = crate::ztools_import::import_ztools_plugins(
        &db,
        &scratch.path().join("bulk-install"),
        &[zip.to_string_lossy().into_owned()],
        true,
    )
    .unwrap();
    assert!(zip_report.imported.is_empty());
    assert_eq!(zip_report.failed.len(), 1);
    assert!(zip_report.failed[0]
        .error
        .contains("PLUGIN_RUNTIME_DEPENDENCY_MISSING"));
    assert!(db.get_plugin("runtime-preflight-fixture").is_ok());
}

#[test]
fn incomplete_dynamic_scan_can_install_and_frontend_only_strings_do_not_block() {
    let scratch = tempfile::tempdir().unwrap();
    let dynamic = scratch.path().join("dynamic");
    fixture(
        &dynamic,
        "1",
        "const id = getRuntimeId(); require(id); require('maybe-missing');",
        false,
    );
    let package = local_package(&dynamic).unwrap();
    assert!(package
        .diagnostics
        .iter()
        .any(|item| item.code == "PLUGIN_RUNTIME_DEPENDENCY_PREFLIGHT_INCOMPLETE"));
    let db = atools_core::Database::in_memory().unwrap();
    let config = atools_core::AppConfig::with_base_dir(scratch.path().join("data"));
    let installed = crate::commands::install_plugin_from_directory_inner(&db, &config, &dynamic)
        .expect("unknown dynamic edges must not reject an install");
    let stored = db.get_plugin("runtime-preflight-fixture").unwrap();
    assert_eq!(stored.path, installed.path);
    assert_eq!(stored.version, "1");
    assert!(Path::new(&stored.path).join("plugin.json").is_file());
    assert!(Path::new(&stored.path).join("preload/index.cjs").is_file());

    let frontend_only = scratch.path().join("frontend-only");
    fixture(&frontend_only, "1", "module.exports = {};", false);
    assert!(local_package(&frontend_only).is_ok());
    assert!(!local_package(&frontend_only)
        .unwrap()
        .diagnostics
        .iter()
        .any(|item| item.code == "PLUGIN_RUNTIME_DEPENDENCY_MISSING"));
}

#[test]
fn staged_copy_rechecks_dependency_tree_and_cleans_only_its_stage() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source");
    fixture(&source, "1", "require('fixture-module');", true);
    let package = local_package(&source).unwrap();
    let install_root = scratch.path().join("plugins");
    fs::create_dir_all(&install_root).unwrap();
    let neighbor = install_root.join("keep");
    fs::create_dir_all(&neighbor).unwrap();
    fs::write(neighbor.join("owned-by-other-install"), "keep").unwrap();

    let staged = stage_directory(&package, &install_root.join("fixture"))
        .expect("complete dependency tree stages");
    let staged_path = staged.path.clone();
    fs::remove_dir_all(staged_path.join("preload/node_modules/fixture-module")).unwrap();
    let error = validate_staged(
        staged_path.clone(),
        &package.manifest,
        Some(&package.raw_manifest),
    );
    let error = match error {
        Ok(_) => panic!("staged copy without its dependency must fail validation"),
        Err(error) => error,
    };
    assert!(error.contains("PLUGIN_RUNTIME_DEPENDENCY_MISSING"));
    assert!(!staged_path.exists());
    assert!(neighbor.join("owned-by-other-install").is_file());
    assert!(!install_root.join("fixture").exists());
}
