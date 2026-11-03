use super::*;
use std::{fs, io::Write, path::Path};

fn archive(entries: &[(&str, &[u8])], aliases: &[(&str, &str)]) -> Vec<u8> {
    let mut zip = ::zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, bytes) in entries {
        zip.start_file(*name, ::zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    for (name, target) in aliases {
        zip.add_symlink(*name, *target, ::zip::write::SimpleFileOptions::default())
            .unwrap();
    }
    zip.finish().unwrap().into_inner()
}

fn clear_external_attributes(path: &Path, names: &[&str]) {
    let mut bytes = fs::read(path).unwrap();
    let mut seen = vec![false; names.len()];
    let mut offset = 0;
    while offset + 46 <= bytes.len() {
        if &bytes[offset..offset + 4] != b"PK\x01\x02" {
            offset += 1;
            continue;
        }
        let name_len = u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[offset + 30], bytes[offset + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[offset + 32], bytes[offset + 33]]) as usize;
        let end = offset + 46 + name_len + extra_len + comment_len;
        if end > bytes.len() {
            break;
        }
        for (i, name) in names.iter().enumerate() {
            if &bytes[offset + 46..offset + 46 + name_len] == name.as_bytes() {
                bytes[offset + 38..offset + 42].fill(0);
                seen[i] = true;
            }
        }
        offset = end;
    }
    assert!(seen.iter().all(|seen| *seen));
    fs::write(path, bytes).unwrap();
}

#[cfg(unix)]
fn set_central_unix_mode(path: &Path, name: &str, mode: u32) {
    let mut bytes = fs::read(path).unwrap();
    let mut found = false;
    let mut offset = 0;
    while offset + 46 <= bytes.len() {
        if &bytes[offset..offset + 4] != b"PK\x01\x02" {
            offset += 1;
            continue;
        }
        let name_len = u16::from_le_bytes([bytes[offset + 28], bytes[offset + 29]]) as usize;
        let extra_len = u16::from_le_bytes([bytes[offset + 30], bytes[offset + 31]]) as usize;
        let comment_len = u16::from_le_bytes([bytes[offset + 32], bytes[offset + 33]]) as usize;
        let end = offset + 46 + name_len + extra_len + comment_len;
        if end > bytes.len() {
            break;
        }
        if &bytes[offset + 46..offset + 46 + name_len] == name.as_bytes() {
            bytes[offset + 5] = 3; // Unix host OS in "version made by".
            bytes[offset + 38..offset + 42].copy_from_slice(&(mode << 16).to_le_bytes());
            found = true;
        }
        offset = end;
    }
    assert!(found);
    fs::write(path, bytes).unwrap();
}

const MANIFEST: &[u8] = br#"{"name":"shared-zip","version":"1","main":"index.html"}"#;

#[test]
fn local_and_market_routes_materialize_alias_as_same_regular_bytes_and_mode() {
    let root = tempfile::tempdir().unwrap();
    let target_bytes = b"#!/usr/bin/env node\ncli";
    let mut zip = ::zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, bytes) in [
        ("plugin.json", MANIFEST),
        ("index.html", b"<p>ok</p>"),
        ("node_modules/pkg/cli.js", target_bytes),
    ] {
        let options = if path.ends_with("cli.js") {
            ::zip::write::SimpleFileOptions::default().unix_permissions(0o751)
        } else {
            ::zip::write::SimpleFileOptions::default()
        };
        zip.start_file(path, options).unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.add_symlink(
        "node_modules/.bin/cli",
        "../pkg/cli.js",
        ::zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let mut local = ZipArchiveIndex::open(bytes.clone(), ZipLimits::LOCAL).unwrap();
    let prefix = local.select_local_prefix().unwrap();
    local.validate_scope(&prefix, true).unwrap();
    let local_dir = root.path().join("local");
    fs::create_dir(&local_dir).unwrap();
    local.materialize_scope(&local_dir, &prefix).unwrap();
    let market_dir = root.path().join("market");
    fs::create_dir(&market_dir).unwrap();
    let market = stage_market_archive(&bytes, &market_dir, "fixture").unwrap();
    market
        .validate_market_scope(&market_dir, &market_dir)
        .unwrap();
    let local_alias = local_dir.join("node_modules/.bin/cli");
    let market_alias = market_dir.join("node_modules/.bin/cli");
    assert_eq!(fs::read(&local_alias).unwrap(), target_bytes);
    assert_eq!(fs::read(&market_alias).unwrap(), target_bytes);
    assert!(!fs::symlink_metadata(&local_alias)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(!fs::symlink_metadata(&market_alias)
        .unwrap()
        .file_type()
        .is_symlink());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(local_alias).unwrap().permissions().mode() & 0o777,
            0o751
        );
        assert_eq!(
            fs::metadata(market_alias).unwrap().permissions().mode() & 0o777,
            0o751
        );
    }
}

#[test]
fn missing_external_attributes_do_not_chmod_regular_files_or_aliases_to_zero() {
    let temp = tempfile::tempdir().unwrap();
    let zip_path = temp.path().join("mode-less.zip");
    let bytes = archive(
        &[
            ("plugin.json", MANIFEST),
            ("index.html", b"<p>ok</p>"),
            ("node_modules/pkg/cli.js", b"cli"),
        ],
        &[("node_modules/.bin/cli", "../pkg/cli.js")],
    );
    fs::write(&zip_path, bytes).unwrap();
    clear_external_attributes(&zip_path, &["index.html", "node_modules/pkg/cli.js"]);
    let mut index = ZipArchiveIndex::open(fs::read(&zip_path).unwrap(), ZipLimits::LOCAL).unwrap();
    assert_eq!(index.file_entry("index.html").unwrap().mode, None);
    assert_eq!(
        index.file_entry("node_modules/.bin/cli").unwrap().mode,
        None
    );
    let out = temp.path().join("out");
    fs::create_dir(&out).unwrap();
    index.materialize_all(&out).unwrap();
    assert_eq!(fs::read(out.join("node_modules/.bin/cli")).unwrap(), b"cli");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [
            out.join("index.html"),
            out.join("node_modules/pkg/cli.js"),
            out.join("node_modules/.bin/cli"),
        ] {
            assert_ne!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0);
        }
    }
}

#[test]
fn market_expansion_policy_remains_independently_smaller_than_local() {
    assert_eq!(ZipLimits::LOCAL.compressed_bytes, 64 * 1024 * 1024);
    assert_eq!(ZipLimits::LOCAL.projected_bytes, 128 * 1024 * 1024);
    assert_eq!(ZipLimits::MARKET.compressed_bytes, 50 * 1024 * 1024);
    assert_eq!(ZipLimits::MARKET.projected_bytes, 64 * 1024 * 1024);
    assert_eq!(ZipLimits::MARKET.entries, 4096);
    assert_eq!(ZipLimits::MARKET.entry_bytes, 32 * 1024 * 1024);
    assert_eq!(ZipLimits::MARKET.path_depth, 32);
    let bytes = archive(&[("file", b"1234567890")], &[]);
    assert!(
        ZipArchiveIndex::open(bytes.clone(), ZipLimits::LOCAL.with_expansion_limit(16)).is_ok()
    );
    assert!(ZipArchiveIndex::open(bytes, ZipLimits::MARKET.with_expansion_limit(8)).is_err());
}

#[test]
fn unsafe_links_case_collisions_and_alias_target_kinds_fail_closed() {
    let invalid = [
        archive(
            &[("node_modules/pkg/cli.js", b"x")],
            &[("outside/link", "../node_modules/pkg/cli.js")],
        ),
        archive(
            &[("node_modules/pkg/cli.js", b"x")],
            &[("node_modules/.bin/sub/cli", "../../pkg/cli.js")],
        ),
        archive(
            &[("node_modules/pkg/cli.js", b"x")],
            &[("node_modules/.bin/cli", "/pkg/cli.js")],
        ),
        archive(
            &[("node_modules/pkg/cli.js", b"x")],
            &[("node_modules/.bin/cli", "C:/pkg/cli.js")],
        ),
        archive(
            &[("node_modules/pkg/cli.js", b"x")],
            &[("node_modules/.bin/cli", "../../../escape")],
        ),
        archive(&[], &[("node_modules/.bin/cli", "../missing.js")]),
        archive(
            &[("node_modules/pkg/cli.js", b"x")],
            &[
                ("node_modules/.bin/first", "../pkg/cli.js"),
                ("node_modules/.bin/second", "first"),
            ],
        ),
    ];
    for bytes in invalid {
        assert!(ZipArchiveIndex::open(bytes, ZipLimits::LOCAL).is_err());
    }

    let temp = tempfile::tempdir().unwrap();
    let mut dir_zip = ::zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    dir_zip
        .add_directory(
            "node_modules/pkg/",
            ::zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    dir_zip
        .add_symlink(
            "node_modules/.bin/cli",
            "../pkg",
            ::zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    assert!(
        ZipArchiveIndex::open(dir_zip.finish().unwrap().into_inner(), ZipLimits::LOCAL).is_err()
    );

    let path = temp.path().join("case.zip");
    let mut zip = ::zip::ZipWriter::new(fs::File::create(&path).unwrap());
    for name in ["node_modules/.bin/cli", "node_modules/.bin/CLI"] {
        zip.add_symlink(
            name,
            "../pkg/cli.js",
            ::zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    }
    zip.finish().unwrap();
    assert!(ZipArchiveIndex::open(fs::read(path).unwrap(), ZipLimits::LOCAL).is_err());

    #[cfg(unix)]
    {
        let special_dir = tempfile::tempdir().unwrap();
        let special_path = special_dir.path().join("special.zip");
        let mut zip = ::zip::ZipWriter::new(fs::File::create(&special_path).unwrap());
        zip.start_file("fifo", ::zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(b"special").unwrap();
        zip.finish().unwrap();
        set_central_unix_mode(&special_path, "fifo", 0o010600);
        assert!(ZipArchiveIndex::open(fs::read(special_path).unwrap(), ZipLimits::LOCAL).is_err());
    }

    let mut zip = ::zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.add_symlink(
        "elsewhere/link",
        "target",
        ::zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    let special = zip.finish().unwrap().into_inner();
    assert!(ZipArchiveIndex::open(special, ZipLimits::LOCAL).is_err());
}

#[test]
fn selected_scope_allows_unselected_market_aliases_but_rejects_selected_cross_root_and_nested() {
    let bytes = archive(
        &[
            ("plugin.json", MANIFEST),
            ("dist/plugin.json", MANIFEST),
            ("dist/index.html", b"dist"),
            ("node_modules/pkg/source.js", b"source"),
            ("dist/node_modules/pkg/cli.js", b"dist cli"),
        ],
        &[
            ("node_modules/.bin/source", "../pkg/source.js"),
            ("dist/node_modules/.bin/dist", "../pkg/cli.js"),
        ],
    );
    let index = ZipArchiveIndex::open(bytes, ZipLimits::MARKET).unwrap();
    index.validate_scope("dist", false).unwrap();
    assert!(index.validate_scope("dist", true).is_err());

    let cross = archive(
        &[
            ("dist/plugin.json", MANIFEST),
            ("dist/index.html", b"dist"),
            ("node_modules/pkg/cli.js", b"root target"),
        ],
        &[(
            "dist/node_modules/.bin/cli",
            "../../../node_modules/pkg/cli.js",
        )],
    );
    let index = ZipArchiveIndex::open(cross, ZipLimits::MARKET).unwrap();
    assert!(index.validate_scope("dist", false).is_err());

    let nested = archive(
        &[
            ("plugin.json", MANIFEST),
            ("index.html", b"root"),
            ("nested/plugin.json", br#"{"name":"nested"}"#),
            ("nested/cli.js", b"nested"),
        ],
        &[("node_modules/.bin/cli", "../../nested/cli.js")],
    );
    let index = ZipArchiveIndex::open(nested, ZipLimits::MARKET).unwrap();
    assert!(index.validate_scope("", false).is_err());
}

#[test]
fn alias_count_amplification_fails_projected_quota() {
    let mut zip = ::zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file("x", ::zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(b"12345678").unwrap();
    for index in 0..4 {
        zip.add_symlink(
            format!("node_modules/.bin/alias-{index}"),
            "../../x",
            ::zip::write::SimpleFileOptions::default(),
        )
        .unwrap();
    }
    let bytes = zip.finish().unwrap().into_inner();
    // Declared entries total 28 bytes; materialized regular+aliases total 40.
    let limits = ZipLimits::LOCAL.with_expansion_limit(32);
    assert!(ZipArchiveIndex::open(bytes, limits).is_err());
}
