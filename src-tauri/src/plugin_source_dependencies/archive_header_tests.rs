use super::*;
use flate2::{write::GzEncoder, Compression};
use sha2::{Digest, Sha256, Sha512};
use std::fs;
use std::io::Write;
use tempfile::tempdir;

use super::super::tar_format::{header_path as parse_header_path, parse_header};

fn octal(field: &mut [u8], value: u64) {
    let text = format!("{:0width$o}\0", value, width = field.len() - 1);
    field.copy_from_slice(text.as_bytes());
}

fn base_header(name: &str, kind: u8, size: u64) -> [u8; BLOCK] {
    let mut block = [0u8; BLOCK];
    block[..name.len()].copy_from_slice(name.as_bytes());
    octal(&mut block[100..108], 0o644);
    octal(&mut block[108..116], 0);
    octal(&mut block[116..124], 0);
    octal(&mut block[124..136], size);
    octal(&mut block[136..148], 0);
    block[148..156].fill(b' ');
    block[156] = kind;
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    block
}

fn checksum(mut block: [u8; BLOCK]) -> [u8; BLOCK] {
    block[148..156].fill(b' ');
    let sum = block.iter().map(|byte| *byte as u64).sum::<u64>();
    octal(&mut block[148..156], sum);
    block
}

fn short_prefix_header(
    name: &str,
    prefix: &str,
    kind: u8,
    size: u64,
    atime: [u8; 12],
    ctime: [u8; 12],
) -> [u8; BLOCK] {
    assert!(prefix.len() <= 130);
    let mut block = base_header(name, kind, size);
    block[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    block[476..488].copy_from_slice(&atime);
    block[488..500].copy_from_slice(&ctime);
    checksum(block)
}

fn long_prefix_header(name: &str, prefix: &str, kind: u8, size: u64) -> [u8; BLOCK] {
    assert!(prefix.len() > 130 && prefix.len() <= 155);
    let mut block = base_header(name, kind, size);
    block[345..345 + prefix.len()].copy_from_slice(prefix.as_bytes());
    checksum(block)
}

fn archive(header: [u8; BLOCK], payload: &[u8]) -> Vec<u8> {
    let mut tar = Vec::new();
    tar.extend_from_slice(&header);
    tar.extend_from_slice(payload);
    let padding = (BLOCK - payload.len() % BLOCK) % BLOCK;
    tar.resize(tar.len() + padding, 0);
    tar.resize(tar.len() + BLOCK * 2, 0);
    let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
    gzip.write_all(&tar).unwrap();
    gzip.finish().unwrap()
}

fn field(value: &[u8]) -> [u8; 12] {
    assert_eq!(value.len(), 12);
    value.try_into().unwrap()
}

#[test]
fn parses_node_tar_short_prefix_with_bounded_octal_timestamps() {
    let header = short_prefix_header(
        "package.json",
        "react",
        b'0',
        0,
        field(b"15143065671\0"),
        [0; 12],
    );
    let parsed = parse_header(&header).unwrap();
    assert_eq!(parsed.path, "react/package.json");
    assert_eq!(
        parse_header_path(&parsed.path, parsed.kind, "react"),
        Ok(("react".to_owned(), "package.json".to_owned()))
    );

    // Matches the audited node-tar first-header shape: no prefix, a short
    // directory name, and NUL-terminated octal atime/ctime fields.
    let observed = short_prefix_header(
        "react/",
        "",
        b'5',
        0,
        field(b"15143065671\0"),
        field(b"15143065671\0"),
    );
    let parsed = parse_header(&observed).unwrap();
    assert_eq!(parsed.path, "react/");
    assert_eq!(
        parse_header_path(&parsed.path, parsed.kind, "react"),
        Ok(("react".to_owned(), String::new()))
    );

    let ordinary = short_prefix_header("file", "package", b'0', 0, [0; 12], [0; 12]);
    assert_eq!(parse_header(&ordinary).unwrap().path, "package/file");

    let boundary_prefix = "r".repeat(130);
    let boundary = short_prefix_header("file", &boundary_prefix, b'0', 0, [0; 12], [0; 12]);
    assert_eq!(
        parse_header(&boundary).unwrap().path,
        format!("{boundary_prefix}/file")
    );
}

#[test]
fn rejects_malformed_short_prefix_timestamp_fields() {
    for timestamp in [field(b"00000000001x"), [b' '; 12]] {
        let header = short_prefix_header("file", "react", b'0', 0, timestamp, [0; 12]);
        assert!(matches!(
            parse_header(&header),
            Err("dependency_archive_invalid")
        ));
    }
}

#[test]
fn preserves_full_long_prefix_and_rejects_hidden_or_traversal_suffixes() {
    let prefix = format!("react/{}", "x".repeat(149));
    assert_eq!(prefix.len(), 155);
    let parsed = parse_header(&long_prefix_header("file", &prefix, b'0', 0)).unwrap();
    assert_eq!(parsed.path, format!("{prefix}/file"));
    let (root, member) = parse_header_path(&parsed.path, parsed.kind, "react").unwrap();
    assert_eq!(root, "react");
    assert_eq!(member, format!("{}/file", "x".repeat(149)));

    let mut hidden = base_header("file", b'0', 0);
    hidden[345..350].copy_from_slice(b"react");
    hidden[475] = b'x';
    assert!(matches!(
        parse_header(&checksum(hidden)),
        Err("dependency_archive_invalid")
    ));

    let traversal_prefix = format!("react/{}/../outside", "x".repeat(124));
    assert!(traversal_prefix.len() > 130);
    let traversal = parse_header(&long_prefix_header("file", &traversal_prefix, b'0', 0)).unwrap();
    assert!(parse_header_path(&traversal.path, traversal.kind, "react").is_err());
}

#[test]
fn keeps_short_prefix_nul_and_utf8_validation_strict() {
    let mut nul_with_hidden_data = short_prefix_header("file", "r", b'0', 0, [0; 12], [0; 12]);
    nul_with_hidden_data[346] = 0;
    nul_with_hidden_data[347] = b'x';
    assert!(matches!(
        parse_header(&checksum(nul_with_hidden_data)),
        Err("dependency_archive_invalid")
    ));

    let mut invalid_utf8 = short_prefix_header("file", "react", b'0', 0, [0; 12], [0; 12]);
    invalid_utf8[345] = 0xff;
    assert!(matches!(
        parse_header(&checksum(invalid_utf8)),
        Err("dependency_archive_path_invalid")
    ));
}

#[test]
fn checksum_still_covers_short_prefix_timestamps() {
    let valid = short_prefix_header("file", "react", b'0', 0, field(b"15143065671\0"), [0; 12]);
    let mut changed = valid;
    changed[476] = b'2';
    assert!(matches!(
        parse_header(&changed),
        Err("dependency_archive_invalid")
    ));
}

#[test]
fn materializes_node_tar_root_into_locked_scoped_package_and_checks_identity() {
    let root = tempdir().unwrap();
    let cache = root.path().join("cache");
    let stage = root.path().join("stage");
    fs::create_dir(&cache).unwrap();
    fs::create_dir(&stage).unwrap();
    let manifest = br#"{"name":"@types/react","version":"19.0.0"}"#;
    let header = short_prefix_header(
        "package.json",
        "react",
        b'0',
        manifest.len() as u64,
        field(b"15143065671\0"),
        field(b"15143065671\0"),
    );
    let bytes = archive(header, manifest);
    let digest = Sha512::digest(&bytes);
    let digest_hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let archive_id = Sha256::digest(format!("sha512:{digest_hex}").as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    fs::write(cache.join(&archive_id), &bytes).unwrap();
    let package_path = "node_modules/@types/react";
    let spec = ArchiveSpec {
        package_path,
        archive_id_sha256: &archive_id,
        algorithm: "sha512",
        digest_hex: &digest_hex,
    };
    let deadline = Deadline::start();
    let mut totals = Totals::default();
    let mut ledger = DestinationLedger::default();
    materialize_package(&cache, &stage, &spec, &mut totals, &mut ledger, &deadline).unwrap();
    assert_eq!(
        fs::read(stage.join(package_path).join("package.json")).unwrap(),
        manifest
    );
    super::super::package_identity::validate_package_identity(
        &stage,
        package_path,
        "@types/react",
        "19.0.0",
        &deadline,
    )
    .unwrap();
}
