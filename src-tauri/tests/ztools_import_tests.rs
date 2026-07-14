use std::fs;

use tempfile::TempDir;

fn write_plugin(root: &std::path::Path, name: &str) -> std::path::PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("index.html"), "<html></html>").unwrap();
    fs::write(dir.join("logo.svg"), "<svg></svg>").unwrap();
    fs::write(
        dir.join("plugin.json"),
        r#"{
          "name": "image-batch-studio",
          "title": "图片批处理",
          "version": "0.1.0",
          "main": "index.html",
          "logo": "logo.svg",
          "platform": ["darwin"],
          "features": [{
            "code": "image-batch",
            "explain": "图片批处理",
            "cmds": ["图片批处理", {"type": "files", "label": "批量处理图片"}]
          }]
        }"#,
    )
    .unwrap();
    dir
}

#[test]
fn scan_ztools_plugins_finds_valid_manifest() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "image-batch-studio");

    let candidates = atools_lib::ztools_import::scan_ztools_plugin_candidates(temp.path()).unwrap();

    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].path, plugin_dir.to_string_lossy());
    assert_eq!(candidates[0].name, "image-batch-studio");
    assert_eq!(candidates[0].title.as_deref(), Some("图片批处理"));
    assert!(candidates[0].main_exists);
    assert!(candidates[0].platform_supported);
    assert!(candidates[0].errors.is_empty());
}

#[test]
fn scan_ztools_plugins_reports_missing_main() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "broken-plugin");
    fs::remove_file(plugin_dir.join("index.html")).unwrap();

    let candidates = atools_lib::ztools_import::scan_ztools_plugin_candidates(temp.path()).unwrap();

    assert_eq!(candidates.len(), 1);
    assert!(!candidates[0].main_exists);
    assert!(candidates[0]
        .errors
        .iter()
        .any(|error| error.contains("main")));
}

#[test]
fn import_ztools_plugin_copies_directory_and_indexes_feature() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "image-batch-studio");
    let install_root = temp.path().join("atools-plugins");
    let db = atools_core::Database::in_memory().unwrap();

    let report = atools_lib::ztools_import::import_ztools_plugins(
        &db,
        &install_root,
        &[plugin_dir.to_string_lossy().to_string()],
        true,
    )
    .unwrap();

    assert_eq!(report.imported.len(), 1);
    assert!(install_root
        .join("image-batch-studio")
        .join("plugin.json")
        .is_file());
    let plugins = db.list_plugins().unwrap();
    let imported_plugin = plugins
        .iter()
        .find(|plugin| plugin.id == "image-batch-studio")
        .expect("imported ZTools plugin should be visible in plugin inventory");
    assert_eq!(imported_plugin.name, "image-batch-studio");
    assert_eq!(imported_plugin.version, "0.1.0");
    assert!(imported_plugin.enabled);
    assert_eq!(
        imported_plugin.path,
        install_root
            .join("image-batch-studio")
            .to_string_lossy()
            .to_string()
    );
    let features = db.all_features().unwrap();
    assert!(features.iter().any(|feature| feature.code == "image-batch"));

    let smoke_checklist = std::fs::read_to_string("../docs/macos-smoke-checklist.md").unwrap();
    assert!(
        smoke_checklist.contains("- [x] 导入后插件出现在插件管理列表。"),
        "macOS smoke checklist should mark imported ZTools plugin inventory visibility complete"
    );
}

#[test]
fn imported_ztools_plugin_feature_can_be_searched() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "image-batch-studio");
    let install_root = temp.path().join("atools-plugins");
    let db = atools_core::Database::in_memory().unwrap();

    atools_lib::ztools_import::import_ztools_plugins(
        &db,
        &install_root,
        &[plugin_dir.to_string_lossy().to_string()],
        true,
    )
    .unwrap();

    let features = db.all_features().unwrap();
    let search_results = atools_core::matcher::search_all(&features, "图片批处理");
    let matched_feature = search_results
        .iter()
        .find(|result| result.feature_code == "image-batch")
        .expect("imported ZTools feature should be searchable by its command text");
    assert_eq!(matched_feature.plugin_id, "image-batch-studio");
    assert_eq!(matched_feature.match_type, "exact");
    assert_eq!(matched_feature.score, atools_core::matcher::SCORE_EXACT);

    let smoke_checklist = std::fs::read_to_string("../docs/macos-smoke-checklist.md").unwrap();
    assert!(
        smoke_checklist.contains("- [x] 插件 feature 能被搜索。"),
        "macOS smoke checklist should mark imported ZTools feature searchability complete"
    );
}

#[test]
fn ztools_overwrite_preserves_created_at_documents_and_attachments() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "image-batch-studio");
    let install_root = temp.path().join("atools-plugins");
    let db = atools_core::Database::in_memory().unwrap();

    atools_lib::ztools_import::import_ztools_plugins(
        &db,
        &install_root,
        &[plugin_dir.to_string_lossy().to_string()],
        true,
    )
    .unwrap();
    let original_created_at = db.get_plugin("image-batch-studio").unwrap().created_at;
    db.plugin_data_put(
        "image-batch-studio",
        &atools_core::models::Document {
            id: "settings".to_string(),
            rev: None,
            data: serde_json::json!({ "quality": 90 }),
        },
    )
    .unwrap();
    db.put_attachment(
        "image-batch-studio",
        "settings",
        "preset.bin",
        b"preset-data",
        "application/octet-stream",
    )
    .unwrap();

    fs::write(
        plugin_dir.join("plugin.json"),
        r#"{
          "name": "image-batch-studio",
          "version": "0.2.0",
          "main": "index.html",
          "features": [{
            "code": "image-batch-v2",
            "explain": "图片批处理 v2",
            "cmds": ["图片批处理 v2"]
          }]
        }"#,
    )
    .unwrap();

    let report = atools_lib::ztools_import::import_ztools_plugins(
        &db,
        &install_root,
        &[plugin_dir.to_string_lossy().to_string()],
        true,
    )
    .unwrap();

    assert_eq!(report.imported, vec!["image-batch-studio"]);
    let saved = db.get_plugin("image-batch-studio").unwrap();
    assert_eq!(saved.version, "0.2.0");
    assert_eq!(saved.created_at, original_created_at);
    assert_eq!(
        db.plugin_data_get("image-batch-studio", "settings")
            .unwrap()
            .unwrap()
            .data,
        serde_json::json!({ "quality": 90 })
    );
    assert_eq!(
        db.get_attachment("image-batch-studio", "settings", "preset.bin")
            .unwrap()
            .unwrap(),
        (
            b"preset-data".to_vec(),
            "application/octet-stream".to_string()
        )
    );
    assert!(db.get_feature("image-batch").is_err());
    assert_eq!(
        db.get_feature("image-batch-v2").unwrap().plugin_id,
        "image-batch-studio"
    );
}

#[cfg(unix)]
#[test]
fn ztools_overwrite_failure_keeps_existing_plugin_bytes_intact() {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new().unwrap();
    let source_dir = write_plugin(temp.path(), "source-plugin");
    let install_root = temp.path().join("atools-plugins");
    let install_dir = install_root.join("image-batch-studio");
    fs::create_dir_all(&install_dir).unwrap();
    fs::write(install_dir.join("index.html"), "<main>old</main>").unwrap();
    symlink(
        source_dir.join("missing-target"),
        source_dir.join("broken-link"),
    )
    .unwrap();
    let db = atools_core::Database::in_memory().unwrap();

    let report = atools_lib::ztools_import::import_ztools_plugins(
        &db,
        &install_root,
        &[source_dir.to_string_lossy().to_string()],
        true,
    )
    .unwrap();

    assert_eq!(report.failed.len(), 1);
    assert!(report.failed[0]
        .error
        .to_ascii_lowercase()
        .contains("symlink"));
    assert_eq!(
        fs::read_to_string(install_dir.join("index.html")).unwrap(),
        "<main>old</main>",
        "failed ZTools overwrite must not replace or partially mutate live bytes"
    );
    assert!(!install_dir.join("plugin.json").exists());
}
