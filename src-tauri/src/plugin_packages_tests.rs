use super::*;
use serde_json::json;
use std::fs;

fn fixture(root: &Path, version: &str, source: bool) {
    fs::create_dir_all(root).unwrap();
    fs::write(root.join("plugin.json"), serde_json::to_vec(&json!({"name":"selected-package","version":version,"title":"发布包",
        "main":"index.html","preload":"preload.cjs","features":[{"code":"selected","cmds":["selected"]}]})).unwrap()).unwrap();
    fs::write(
        root.join("index.html"),
        if source {
            "<script src='/src/main.ts'></script>"
        } else {
            "<p>published</p>"
        },
    )
    .unwrap();
    fs::write(
        root.join("preload.cjs"),
        "throw Error('metadata must not execute preload')",
    )
    .unwrap();
}

#[test]
fn directory_scan_import_update_and_activation_use_only_selected_dist() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source");
    fixture(&source, "1", true);
    fixture(&source.join("dist"), "1", false);
    fs::write(source.join("source-only-file"), "must not copy").unwrap();
    let candidates = crate::ztools_import::scan_ztools_plugin_candidates(&source).unwrap();
    assert_eq!(
        candidates.len(),
        1,
        "Source and dist must not produce duplicate candidates"
    );
    assert!(candidates[0]
        .package_path
        .as_deref()
        .unwrap()
        .ends_with("/dist"));
    assert!(candidates[0].errors.is_empty());
    let db = atools_core::Database::in_memory().unwrap();
    let config = atools_core::AppConfig::with_base_dir(scratch.path().join("data"));
    let report = crate::ztools_import::import_ztools_plugins(
        &db,
        &config.plugins_dir(),
        &[source.to_string_lossy().into()],
        true,
    )
    .unwrap();
    assert_eq!(report.imported, vec!["selected-package"]);
    let plugin = db.get_plugin("selected-package").unwrap();
    assert!(!Path::new(&plugin.path).join("source-only-file").exists());
    assert!(!Path::new(&plugin.path).join("dist").exists());
    let action = crate::commands::activate_feature_inner(&db, "selected", None).unwrap();
    assert_eq!(action.plugin_path, plugin.path);
    assert!(action.preload_path.unwrap().ends_with("/preload.cjs"));
    assert_eq!(action.plugin_name, "发布包");
    let mut disabled = plugin;
    disabled.enabled = false;
    db.save_plugin(&disabled).unwrap();
    fixture(&source, "2", true);
    fixture(&source.join("dist"), "2", false);
    let updated =
        crate::commands::plugin_update_from_path_inner(&db, &config, "selected-package", &source)
            .unwrap();
    assert_eq!(updated.version, "2");
    assert!(!updated.enabled, "An update must preserve disabled state");
    assert!(!Path::new(&updated.path).join("source-only-file").exists());
    let imported = crate::ztools_import::import_ztools_plugins(
        &db,
        &config.plugins_dir(),
        &[source.to_string_lossy().into()],
        true,
    )
    .unwrap();
    assert_eq!(imported.imported, vec!["selected-package"]);
    assert!(
        !db.get_plugin("selected-package").unwrap().enabled,
        "Bulk overwrite must preserve disabled state too"
    );
    let reinstalled =
        crate::commands::install_plugin_from_directory_inner(&db, &config, &source).unwrap();
    assert!(
        !reinstalled.enabled,
        "Local reinstall must preserve disabled state too"
    );
}

#[test]
fn stage_validation_failure_cleans_only_its_owned_stage_and_keeps_existing_install() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source");
    fixture(&source, "1", false);
    let expected = local_package(&source).unwrap().manifest;
    let staged = scratch.path().join("stage");
    fixture(&staged, "2", false);
    let existing = scratch.path().join("installed");
    fixture(&existing, "old", false);
    assert!(validate_staged(staged.clone(), &expected, None).is_err());
    assert!(!staged.exists());
    assert!(existing.join("plugin.json").is_file());
}

#[test]
fn same_version_manifest_change_and_source_destination_overlap_are_rejected() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("source");
    fixture(&source, "1", false);
    let package = local_package(&source).unwrap();
    let nested = source.join("installed/selected-package");
    assert!(stage_directory(&package, &nested).is_err());
    assert!(!source.join("installed").exists());
    let db = atools_core::Database::in_memory().unwrap();
    let import = crate::ztools_import::import_ztools_plugins(
        &db,
        &source.join("new/deep"),
        &[source.to_string_lossy().into()],
        true,
    )
    .unwrap();
    assert!(import.imported.is_empty());
    assert_eq!(import.failed.len(), 1);
    assert!(
        !source.join("new").exists(),
        "Rejected import must not create an install root in the source"
    );
    let stage = scratch.path().join("stage");
    fixture(&stage, "1", false);
    let mut changed: serde_json::Value =
        serde_json::from_slice(&fs::read(stage.join("plugin.json")).unwrap()).unwrap();
    changed["main"] = json!("changed.html");
    changed["permissions"] = json!(["shell"]);
    fs::write(stage.join("changed.html"), "<p>changed</p>").unwrap();
    fs::write(
        stage.join("plugin.json"),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    assert!(validate_staged(
        stage.clone(),
        &package.manifest,
        Some(&package.raw_manifest)
    )
    .is_err());
    assert!(!stage.exists());
    let stage = scratch.path().join("raw-stage");
    fixture(&stage, "1", false);
    let mut changed = package.raw_manifest.clone();
    changed["unknownPolicyMetadata"] = json!("changed");
    fs::write(
        stage.join("plugin.json"),
        serde_json::to_vec(&changed).unwrap(),
    )
    .unwrap();
    assert!(validate_staged(
        stage.clone(),
        &package.manifest,
        Some(&package.raw_manifest)
    )
    .is_err());
    assert!(!stage.exists());
}

#[test]
#[ignore = "Reads local optional build artifacts only; no original plugin is executed"]
fn local_dist_and_release_zip_import_without_original_execution() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let scratch_path = scratch.path().to_path_buf();
    let mut results = Vec::new();
    for name in ["application-uninstaller", "lan-device-discovery"] {
        let source = root.join("ZTools-plugins/plugins").join(name);
        let selected = local_package(&source).unwrap();
        assert_eq!(
            selected.package_root,
            source.join("dist").canonicalize().unwrap()
        );
        let db = atools_core::Database::in_memory().unwrap();
        let install_root = scratch.path().join(name);
        let report = crate::ztools_import::import_ztools_plugins(
            &db,
            &install_root,
            &[source.to_string_lossy().into()],
            true,
        )
        .unwrap();
        assert_eq!(report.imported.len(), 1, "{report:?}");
        let plugin = db.get_plugin(&report.imported[0]).unwrap();
        assert_eq!(
            fs::read(Path::new(&plugin.path).join("plugin.json")).unwrap(),
            fs::read(selected.manifest_path).unwrap()
        );
        assert!(!Path::new(&plugin.path).join("dist").exists());
        let archive = fs::read_dir(source.join("release"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|item| item.path())
            .find(|item| {
                if item.extension().and_then(|extension| extension.to_str()) != Some("zip") {
                    return false;
                }
                crate::ztools_import::scan_ztools_plugin_candidates(item)
                    .ok()
                    .and_then(|items| items.into_iter().next())
                    .is_some_and(|candidate| {
                        candidate.errors.is_empty()
                            && candidate.name == plugin.name
                            && candidate.version == plugin.version
                    })
            })
            .expect("Matching local published ZIP");
        let zipped = crate::ztools_import::import_ztools_plugins(
            &db,
            &install_root,
            &[archive.to_string_lossy().into()],
            true,
        )
        .unwrap();
        assert_eq!(zipped.imported, report.imported);
        results.push(json!({"name":name,"version":plugin.version,"selectedPackage":"dist","directoryImport":true,"zipImport":true,
            "codeExecution":"not invoked; metadata/copy/SQLite only","remotePublication":"not verified; artifacts are local untracked/ignored files"}));
    }
    drop(scratch);
    assert!(!scratch_path.exists());
    if let Some(output) = std::env::var_os("ATOOLS_PACKAGE_EVIDENCE_OUTPUT") {
        fs::write(output, serde_json::to_vec_pretty(&json!({"passed":true,"scope":"Actual local directory and ZIP import only, no original preload/UI execution", "temporaryDataRemoved":true,"packages":results})).unwrap()).unwrap();
    }
}
