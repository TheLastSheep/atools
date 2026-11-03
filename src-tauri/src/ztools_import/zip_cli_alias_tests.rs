use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{fs, io::Write, path::Path};

fn symlink(zip: &mut ::zip::ZipWriter<fs::File>, path: &str, target: &str) {
    zip.add_symlink(path, target, ::zip::write::SimpleFileOptions::default())
        .unwrap();
}

fn start_zip(path: &Path) -> ::zip::ZipWriter<fs::File> {
    ::zip::ZipWriter::new(fs::File::create(path).unwrap())
}

fn add_file(zip: &mut ::zip::ZipWriter<fs::File>, path: &str, bytes: &[u8]) {
    zip.start_file(path, ::zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(bytes).unwrap();
}

fn clear_central_external_attributes(path: &Path, entry_names: &[&str]) {
    let mut bytes = fs::read(path).unwrap();
    let mut cleared = vec![false; entry_names.len()];
    let mut offset = 0;
    while offset + 46 <= bytes.len() {
        if &bytes[offset..offset + 4] != b"PK\x01\x02" {
            offset += 1;
            continue;
        }
        let name_len = u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[offset + 30], bytes[offset + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[offset + 32], bytes[offset + 33]]) as usize;
        let header_end = offset + 46 + name_len + extra_len + comment_len;
        if header_end > bytes.len() {
            break;
        }
        let matches: Vec<_> = entry_names
            .iter()
            .map(|expected| &bytes[offset + 46..offset + 46 + name_len] == expected.as_bytes())
            .collect();
        for (index, matches_entry) in matches.into_iter().enumerate() {
            if matches_entry {
                bytes[offset + 38..offset + 42].fill(0);
                cleared[index] = true;
            }
        }
        offset = header_end;
    }
    assert!(cleared.iter().all(|was_cleared| *was_cleared));
    fs::write(path, bytes).unwrap();
}

const MANIFEST: &[u8] = br#"{"name":"cli-alias","title":"CLI alias","version":"1","main":"index.html","preload":"preload/node_modules/.bin/cli","features":[{"code":"cli","cmds":["cli"]}]}"#;

#[test]
fn single_npm_cli_alias_is_inspected_and_materialized_as_target_bytes() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("cli.zip");
    let mut zip = start_zip(&source);
    add_file(&mut zip, "plugin.json", MANIFEST);
    add_file(&mut zip, "index.html", b"<p>ready</p>");
    zip.start_file(
        "preload/node_modules/pkg/cli.js",
        ::zip::write::SimpleFileOptions::default().unix_permissions(0o751),
    )
    .unwrap();
    zip.write_all(b"#!/usr/bin/env node\nconsole.log('ok')")
        .unwrap();
    symlink(&mut zip, "preload/node_modules/.bin/cli", "../pkg/cli.js");
    zip.finish().unwrap();

    let mut package = Package::open(&source).unwrap();
    assert!(package.exists("preload/node_modules/.bin/cli"));
    assert_eq!(
        package
            .read("preload/node_modules/.bin/cli", MAX_ENTRY_BYTES)
            .unwrap(),
        b"#!/usr/bin/env node\nconsole.log('ok')"
    );
    let ready = candidate(&source).unwrap();
    assert!(ready.errors.is_empty(), "{:?}", ready.errors);

    let destination = scratch.path().join("unpacked");
    extract(&source, &destination).unwrap();
    let alias = destination.join("preload/node_modules/.bin/cli");
    assert!(!fs::symlink_metadata(&alias)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(
        fs::read(&alias).unwrap(),
        fs::read(destination.join("preload/node_modules/pkg/cli.js")).unwrap()
    );
    #[cfg(unix)]
    assert_eq!(
        fs::metadata(alias).unwrap().permissions().mode() & 0o777,
        0o751
    );
}

#[test]
fn missing_unix_modes_keep_regular_files_and_materialized_aliases_readable() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("mode-less.zip");
    let mut zip = start_zip(&source);
    add_file(&mut zip, "plugin.json", MANIFEST);
    add_file(&mut zip, "index.html", b"<p>mode-less page</p>");
    add_file(
        &mut zip,
        "preload/node_modules/pkg/cli.js",
        b"#!/usr/bin/env node\nconsole.log('mode-less')",
    );
    symlink(&mut zip, "preload/node_modules/.bin/cli", "../pkg/cli.js");
    zip.finish().unwrap();
    clear_central_external_attributes(&source, &["index.html", "preload/node_modules/pkg/cli.js"]);
    let package = Package::open(&source).unwrap();
    assert_eq!(package.regular_file("index.html").unwrap().mode, None);
    assert_eq!(
        package
            .regular_file("preload/node_modules/pkg/cli.js")
            .unwrap()
            .mode,
        None
    );

    let destination = scratch.path().join("unpacked");
    extract(&source, &destination).unwrap();
    let index = destination.join("index.html");
    let target = destination.join("preload/node_modules/pkg/cli.js");
    let alias = destination.join("preload/node_modules/.bin/cli");
    assert_eq!(fs::read(index).unwrap(), b"<p>mode-less page</p>");
    assert_eq!(
        fs::read(&alias).unwrap(),
        b"#!/usr/bin/env node\nconsole.log('mode-less')"
    );
    assert_eq!(fs::read(&target).unwrap(), fs::read(&alias).unwrap());
    #[cfg(unix)]
    for path in [target, alias, destination.join("index.html")] {
        assert_ne!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0);
    }
}

#[test]
fn unsupported_alias_locations_targets_and_targets_fail_closed() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("invalid.zip");
    let invalid = [
        ("elsewhere/cli", "../pkg/cli.js", false),
        ("node_modules/.bin/sub/cli", "../../pkg/cli.js", false),
        ("node_modules/.bin/cli", "/pkg/cli.js", false),
        ("node_modules/.bin/cli", "C:/pkg/cli.js", false),
        ("node_modules/.bin/cli", "..\\pkg\\cli.js", false),
        ("node_modules/.bin/cli", "../pkg/\0cli.js", false),
        ("node_modules/.bin/cli", "../../../../outside.js", false),
        ("node_modules/.bin/cli", "../missing.js", false),
        ("node_modules/.bin/cli", "../pkg", true),
        ("node_modules/.bin/second", "first", false),
    ];
    for (link_path, target, target_is_dir) in invalid {
        let mut zip = start_zip(&source);
        add_file(&mut zip, "plugin.json", MANIFEST);
        add_file(&mut zip, "index.html", b"<p>ready</p>");
        if target_is_dir {
            zip.add_directory(
                "node_modules/pkg/",
                ::zip::write::SimpleFileOptions::default(),
            )
            .unwrap();
        } else if target == "first" {
            symlink(&mut zip, "node_modules/.bin/first", "../pkg/cli.js");
        } else {
            add_file(&mut zip, "node_modules/pkg/cli.js", b"cli");
        }
        symlink(&mut zip, link_path, target);
        zip.finish().unwrap();
        assert!(Package::open(&source).is_err(), "{link_path} -> {target}");
    }

    let mut zip = start_zip(&source);
    add_file(&mut zip, "plugin.json", MANIFEST);
    add_file(&mut zip, "index.html", b"<p>ready</p>");
    add_file(&mut zip, "node_modules/pkg/cli.js", b"cli");
    symlink(&mut zip, "node_modules/.bin/cli", "../pkg/cli.js");
    symlink(&mut zip, "node_modules/.bin/CLI", "../pkg/cli.js");
    zip.finish().unwrap();
    assert!(
        Package::open(&source).is_err(),
        "case-only duplicate must fail"
    );

    let mut zip = start_zip(&source);
    add_file(&mut zip, "plugin.json", MANIFEST);
    add_file(&mut zip, "index.html", b"<p>ready</p>");
    symlink(
        &mut zip,
        "node_modules/.bin/cli",
        &"x".repeat(cli_alias::MAX_ALIAS_TARGET_BYTES + 1),
    );
    zip.finish().unwrap();
    assert!(
        Package::open(&source).is_err(),
        "oversized target must fail"
    );
}

#[test]
fn aliases_cannot_cross_from_root_manifest_into_nested_plugin_package() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("cross-package.zip");
    let mut zip = start_zip(&source);
    add_file(&mut zip, "plugin.json", MANIFEST);
    add_file(&mut zip, "index.html", b"<p>ready</p>");
    add_file(&mut zip, "other/plugin.json", br#"{"name":"other"}"#);
    add_file(&mut zip, "other/cli.js", b"other cli");
    symlink(&mut zip, "node_modules/.bin/cli", "../../other/cli.js");
    zip.finish().unwrap();
    assert!(Package::open(&source).is_err());
}

#[test]
fn alias_materialization_is_included_in_projected_expansion_budget() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("quota.zip");
    let mut zip = start_zip(&source);
    add_file(&mut zip, "plugin.json", MANIFEST);
    add_file(&mut zip, "index.html", b"<p>ready</p>");
    let large = vec![0; MAX_ENTRY_BYTES];
    add_file(&mut zip, "node_modules/pkg/cli.js", &large);
    for index in 0..4 {
        symlink(
            &mut zip,
            &format!("node_modules/.bin/cli-{index}"),
            "../pkg/cli.js",
        );
    }
    zip.finish().unwrap();
    assert!(Package::open(&source).is_err());
}

#[test]
fn invalid_alias_does_not_change_existing_destination_files() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("invalid.zip");
    let mut zip = start_zip(&source);
    add_file(&mut zip, "plugin.json", MANIFEST);
    add_file(&mut zip, "index.html", b"<p>ready</p>");
    symlink(&mut zip, "outside-link", "../outside");
    zip.finish().unwrap();
    let destination = scratch.path().join("existing");
    fs::create_dir_all(&destination).unwrap();
    fs::write(destination.join("sentinel"), b"unchanged").unwrap();
    assert!(extract(&source, &destination).is_err());
    assert_eq!(
        fs::read(destination.join("sentinel")).unwrap(),
        b"unchanged"
    );
    assert_eq!(fs::read_dir(destination).unwrap().count(), 1);
}

#[test]
fn local_selected_prefix_still_rejects_aliases_outside_the_imported_package() {
    let scratch = tempfile::tempdir().unwrap();
    let source = scratch.path().join("prefix-alias.zip");
    let mut zip = start_zip(&source);
    add_file(&mut zip, "published/plugin.json", MANIFEST);
    add_file(&mut zip, "published/index.html", b"<p>ready</p>");
    add_file(&mut zip, "node_modules/pkg/cli.js", b"unselected cli");
    symlink(&mut zip, "node_modules/.bin/cli", "../pkg/cli.js");
    zip.finish().unwrap();
    assert!(Package::open(&source).is_err());
}
