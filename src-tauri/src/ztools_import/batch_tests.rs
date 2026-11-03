//! Inert package discovery/conflict coverage; importing never executes fixture code.
use super::*;
use serde_json::json;
use std::io::Write;

fn directory(root: &Path, name: &str, version: &str) -> PathBuf {
    fs::create_dir_all(root).unwrap();
    fs::write(
        root.join("plugin.json"),
        serde_json::to_vec(&json!({
            "name":name,"version":version,"main":"index.html",
            "features":[{"code":format!("{name}-open"),"cmds":[name]}]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(root.join("index.html"), format!("<main>{version}</main>")).unwrap();
    root.to_path_buf()
}

fn zip(root: &Path, source: &Path) -> PathBuf {
    let mut writer = ::zip::ZipWriter::new(fs::File::create(root).unwrap());
    for file in ["plugin.json", "index.html"] {
        writer
            .start_file(file, ::zip::write::SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(&fs::read(source.join(file)).unwrap())
            .unwrap();
    }
    writer.finish().unwrap();
    root.to_path_buf()
}

fn asar(source: &Path) -> Vec<u8> {
    let mut content = Vec::new();
    let mut files = serde_json::Map::new();
    for name in ["plugin.json", "index.html"] {
        let bytes = fs::read(source.join(name)).unwrap();
        files.insert(
            name.into(),
            json!({"size":bytes.len(),"offset":content.len().to_string()}),
        );
        content.extend(bytes);
    }
    let header = serde_json::to_vec(&json!({"files":files})).unwrap();
    let aligned = (header.len() + 3) & !3;
    let mut result = Vec::new();
    for value in [4, aligned + 8, aligned + 4, header.len()] {
        result.extend((value as u32).to_le_bytes());
    }
    result.extend(header);
    result.resize(16 + aligned, 0);
    result.extend(content);
    result
}

fn paths(items: &[&Path]) -> Vec<String> {
    items
        .iter()
        .map(|path| path.to_string_lossy().into())
        .collect()
}

#[test]
fn package_boundary_keeps_directory_and_direct_zip_zpx_asar_only() {
    let temp = tempfile::tempdir().unwrap();
    let root = directory(&temp.path().join("source"), "root.plugin", "1.0.0");
    let fixture = directory(&temp.path().join("fixture"), "archive-plugin", "1.0.0");
    zip(&root.join("direct.ZIP"), &fixture);
    fs::write(root.join("direct.asar"), asar(&fixture)).unwrap();
    let mut compressed = Vec::new();
    {
        let mut encoder = brotli::CompressorWriter::new(&mut compressed, 4096, 5, 22);
        encoder.write_all(&asar(&fixture)).unwrap();
    }
    fs::write(root.join("direct.zpx"), compressed).unwrap();
    for name in ["nested", "dist", "node_modules"] {
        let nested = directory(&root.join(name), "hidden-plugin", "1.0.0");
        zip(&nested.join("hidden.zip"), &fixture);
    }
    let candidates = scan_ztools_plugin_candidates(&root).unwrap();
    assert_eq!(candidates.len(), 4);
    let types: std::collections::BTreeSet<_> = candidates
        .iter()
        .map(|item| item.source_type.as_str())
        .collect();
    assert_eq!(
        types,
        ["directory", "zip", "zpx", "asar"].into_iter().collect()
    );
    assert!(candidates.iter().all(|item| item.errors.is_empty()));
    assert_eq!(
        candidates
            .iter()
            .find(|item| item.source_type == "directory")
            .unwrap()
            .installation_id
            .as_deref(),
        Some("root-plugin")
    );
    assert!(candidates
        .iter()
        .filter(|item| item.source_type != "directory")
        .all(|item| item.installation_id.as_deref() == Some("archive-plugin")));
}

#[test]
fn stable_installation_identity_matches_existing_ascii_rules_without_random_fallback() {
    for name in [
        "Hello World!",
        "plugin@1.0.0",
        "a.b.c",
        "MY-plugin",
        "工具-abc",
    ] {
        assert_eq!(
            inspection::stable_installation_id(name).unwrap(),
            atools_core::utils::sanitize_id(name)
        );
    }
    let temp = tempfile::tempdir().unwrap();
    let oversized = "a".repeat(257);
    for (slot, name) in [
        ("punctuation", "!!!"),
        ("chinese", "工具"),
        ("oversized", oversized.as_str()),
    ] {
        let source = directory(&temp.path().join(slot), name, "1");
        let candidate = scan_ztools_plugin_candidates(&source)
            .unwrap()
            .pop()
            .unwrap();
        assert!(candidate.installation_id.is_none());
        assert!(candidate.installation_key.is_none());
        let dto = serde_json::to_value(&candidate).unwrap();
        assert!(dto["installation_id"].is_null() && dto["installation_key"].is_null());
        assert!(candidate.errors.iter().any(|error| error.contains("稳定")));
        let db = atools_core::Database::in_memory().unwrap();
        let report = import_ztools_plugins(
            &db,
            &temp.path().join("installed"),
            &paths(&[&source]),
            true,
        )
        .unwrap();
        assert!(report.imported.is_empty());
        assert_eq!(report.skipped.len(), 1);
        assert!(db.list_plugins().unwrap().is_empty());
    }
}

#[test]
fn platform_conflict_key_keeps_original_ids_and_conservatively_rejects_case_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let upper = directory(&temp.path().join("upper"), "CasePlugin", "upper");
    let lower = directory(&temp.path().join("lower"), "caseplugin", "lower");
    let first = scan_ztools_plugin_candidates(&upper)
        .unwrap()
        .pop()
        .unwrap();
    let second = scan_ztools_plugin_candidates(&lower)
        .unwrap()
        .pop()
        .unwrap();
    assert_eq!(first.installation_id.as_deref(), Some("CasePlugin"));
    assert_eq!(second.installation_id.as_deref(), Some("caseplugin"));
    let insensitive = cfg!(any(target_os = "macos", target_os = "windows"));
    assert_eq!(
        first.installation_key.as_deref(),
        Some(if insensitive {
            "caseplugin"
        } else {
            "CasePlugin"
        })
    );
    assert_eq!(second.installation_key.as_deref(), Some("caseplugin"));
    let selected = paths(&[&upper, &lower]);
    let planned = plan_import_batch(&selected).unwrap();
    if insensitive {
        assert!(planned.ready.is_empty());
        assert_eq!(planned.report.failed.len(), 2);
        assert!(planned
            .report
            .failed
            .iter()
            .all(|failure| failure.error.contains("大小写别名")));
        let old = directory(&temp.path().join("old"), "CasePlugin", "old");
        let safe = directory(&temp.path().join("safe"), "safe", "1");
        let db = atools_core::Database::in_memory().unwrap();
        let installed = temp.path().join("installed");
        import_ztools_plugins(&db, &installed, &paths(&[&old]), true).unwrap();
        let report =
            import_ztools_plugins(&db, &installed, &paths(&[&upper, &lower, &safe]), true).unwrap();
        assert_eq!(report.imported, ["safe"]);
        assert_eq!(report.failed.len(), 2);
        assert_eq!(db.get_plugin("CasePlugin").unwrap().version, "old");
        assert!(db.get_plugin("caseplugin").is_err());
        assert_eq!(
            fs::read_to_string(installed.join("CasePlugin/index.html")).unwrap(),
            "<main>old</main>"
        );
    } else {
        assert_eq!(planned.ready.len(), 2);
        assert!(planned.report.failed.is_empty());
    }
}

#[test]
fn batch_source_and_submitted_path_limits_fail_before_any_import() {
    let temp = tempfile::tempdir().unwrap();
    let selected: Vec<_> = (0..=discovery::MAX_CANDIDATES)
        .map(|index| {
            directory(
                &temp.path().join(index.to_string()),
                &format!("plugin{index}"),
                "1",
            )
            .to_string_lossy()
            .into_owned()
        })
        .collect();
    let db = atools_core::Database::in_memory().unwrap();
    let install = temp.path().join("installed");
    assert!(import_ztools_plugins(&db, &install, &selected, true)
        .unwrap_err()
        .contains("256"));
    assert!(db.list_plugins().unwrap().is_empty());
    assert!(!install.exists());
    let repeated = vec![selected[0].clone(); discovery::MAX_ENTRIES + 1];
    assert!(plan_import_batch(&repeated).err().unwrap().contains("8192"));
}

#[test]
fn batch_compressed_byte_limit_precedes_archive_decoding_and_mutation() {
    let temp = tempfile::tempdir().unwrap();
    let mut selected = Vec::new();
    // Sparse inert files need no valid archive bodies: aggregate metadata is
    // rejected before inspection can read or decompress any of these sources.
    for index in 0..5 {
        let path = temp.path().join(format!("{index}.zpx"));
        fs::File::create(&path)
            .unwrap()
            .set_len(if index < 4 { MAX_ARCHIVE_BYTES } else { 1 })
            .unwrap();
        selected.push(path.to_string_lossy().into_owned());
    }
    let db = atools_core::Database::in_memory().unwrap();
    let install = temp.path().join("installed");
    assert!(import_ztools_plugins(&db, &install, &selected, true)
        .unwrap_err()
        .contains("256 MiB"));
    assert!(db.list_plugins().unwrap().is_empty());
    assert!(!install.exists());
}

#[test]
fn both_colliding_sources_fail_before_mutation_and_unrelated_source_continues() {
    let temp = tempfile::tempdir().unwrap();
    let installed = temp.path().join("installed");
    let old = directory(&temp.path().join("old"), "same.plugin", "old");
    let first = directory(&temp.path().join("first"), "same.plugin", "first");
    let second = directory(&temp.path().join("second"), "same-plugin", "second");
    let archive = zip(&temp.path().join("second.zip"), &second);
    let safe = directory(&temp.path().join("safe"), "unrelated", "safe");
    let db = atools_core::Database::in_memory().unwrap();
    import_ztools_plugins(&db, &installed, &paths(&[&old]), true).unwrap();
    let mut previous = db.get_plugin("same-plugin").unwrap();
    previous.enabled = false;
    db.save_plugin_with_features(&previous, &previous.manifest.features)
        .unwrap();
    let selected = paths(&[&first, &archive, &safe]);
    let planned = plan_import_batch(&selected).unwrap();
    assert_eq!(planned.ready.len(), 1);
    assert_eq!(planned.ready[0].id(), "unrelated");
    assert_eq!(planned.report.failed.len(), 2);
    assert_eq!(db.get_plugin("same-plugin").unwrap().version, "old");
    let report = import_ztools_plugins(&db, &installed, &selected, true).unwrap();
    assert_eq!(report.imported, ["unrelated"]);
    assert_eq!(report.failed.len(), 2);
    assert!(report.failed.iter().all(
        |failure| failure.error.contains("same-plugin") && failure.error.contains("只选择一个")
    ));
    let untouched = db.get_plugin("same-plugin").unwrap();
    assert_eq!(untouched.version, "old");
    assert!(!untouched.enabled);
    assert_eq!(untouched.created_at, previous.created_at);
    assert_eq!(
        fs::read_to_string(installed.join("same-plugin/index.html")).unwrap(),
        "<main>old</main>"
    );
}

#[test]
fn incomplete_directory_still_conflicts_with_ready_archive_of_same_identity() {
    let temp = tempfile::tempdir().unwrap();
    let source = directory(&temp.path().join("source"), "same", "1");
    let archive = zip(&temp.path().join("same.zip"), &source);
    fs::write(
        source.join("index.html"),
        "<script type=module src=/src/main.ts></script>",
    )
    .unwrap();
    let plan = plan_import_batch(&paths(&[&source, &archive])).unwrap();
    assert!(plan.ready.is_empty());
    assert_eq!(plan.report.failed.len(), 2);
    assert!(plan.report.skipped.is_empty());
}

#[test]
fn duplicate_paths_are_imported_once_including_canonical_aliases() {
    let temp = tempfile::tempdir().unwrap();
    let source = directory(&temp.path().join("source"), "one", "1");
    let alias = source.join(".");
    let db = atools_core::Database::in_memory().unwrap();
    let report = import_ztools_plugins(
        &db,
        &temp.path().join("installed"),
        &paths(&[&source, &source, &alias]),
        true,
    )
    .unwrap();
    assert_eq!(report.imported, ["one"]);
    assert!(report.skipped.is_empty() && report.failed.is_empty());
    let missing = temp.path().join("missing");
    let plan = plan_import_batch(&paths(&[&missing, &missing])).unwrap();
    assert_eq!(plan.report.failed.len(), 1);
}

#[test]
fn prepared_source_identity_change_cannot_escape_its_mutation_gate() {
    let temp = tempfile::tempdir().unwrap();
    let source = directory(&temp.path().join("source"), "before", "1");
    let prepared = plan_import_batch(&paths(&[&source]))
        .unwrap()
        .ready
        .pop()
        .unwrap();
    directory(&source, "after", "1");
    let db = atools_core::Database::in_memory().unwrap();
    assert!(execute_prepared(&db, &temp.path().join("installed"), prepared, true).is_err());
    assert!(db.list_plugins().unwrap().is_empty());
    assert!(!temp.path().join("installed/before").exists());
    assert!(!temp.path().join("installed/after").exists());
}

#[test]
fn overwrite_false_skips_and_overwrite_true_preserves_disabled_state() {
    let temp = tempfile::tempdir().unwrap();
    let source = directory(&temp.path().join("source"), "one", "1");
    let installed = temp.path().join("installed");
    let db = atools_core::Database::in_memory().unwrap();
    import_ztools_plugins(&db, &installed, &paths(&[&source]), true).unwrap();
    let mut previous = db.get_plugin("one").unwrap();
    previous.enabled = false;
    db.save_plugin_with_features(&previous, &previous.manifest.features)
        .unwrap();
    directory(&source, "one", "2");
    let skipped = import_ztools_plugins(&db, &installed, &paths(&[&source]), false).unwrap();
    assert_eq!(skipped.skipped.len(), 1);
    assert!(skipped.imported.is_empty());
    assert_eq!(db.get_plugin("one").unwrap().version, "1");
    assert!(!db.get_plugin("one").unwrap().enabled);
    let replaced = import_ztools_plugins(&db, &installed, &paths(&[&source]), true).unwrap();
    assert_eq!(replaced.imported, ["one"]);
    assert_eq!(db.get_plugin("one").unwrap().version, "2");
    assert!(!db.get_plugin("one").unwrap().enabled);
}

#[cfg(unix)]
#[test]
fn discovered_and_explicit_symlinks_are_not_followed_or_canonicalized_into_valid_sources() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let source = directory(&temp.path().join("source"), "one", "1");
    let archive = zip(&temp.path().join("one.zip"), &source);
    let scan = temp.path().join("scan");
    fs::create_dir(&scan).unwrap();
    let file_link = scan.join("linked.zip");
    symlink(&archive, &file_link).unwrap();
    symlink(&source, scan.join("linked-directory")).unwrap();
    assert!(scan_ztools_plugin_candidates(&scan).unwrap().is_empty());
    assert!(scan_ztools_plugin_candidates(&file_link).is_err());
    let db = atools_core::Database::in_memory().unwrap();
    let report = import_ztools_plugins(
        &db,
        &temp.path().join("installed"),
        &paths(&[&file_link, &archive]),
        true,
    )
    .unwrap();
    assert_eq!(report.failed.len(), 1);
    assert!(report.failed[0].error.contains("符号链接"));
    assert_eq!(report.imported, ["one"]);
}
