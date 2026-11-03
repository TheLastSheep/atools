use super::*;
use flate2::{write::GzEncoder, Compression};
use std::fs::File;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use tempfile::tempdir;

fn octal(field: &mut [u8], value: u64) {
    let text = format!("{:0width$o}\0", value, width = field.len() - 1);
    field.copy_from_slice(text.as_bytes());
}

fn header(path: &str, kind: u8, payload: &[u8], mode: u64) -> [u8; BLOCK] {
    let mut block = [0u8; BLOCK];
    let bytes = path.as_bytes();
    if bytes.len() <= 100 {
        block[..bytes.len()].copy_from_slice(bytes);
    } else {
        panic!("test path exceeds ustar name field");
    }
    octal(&mut block[100..108], mode);
    octal(&mut block[108..116], 0);
    octal(&mut block[116..124], 0);
    octal(&mut block[124..136], payload.len() as u64);
    octal(&mut block[136..148], 0);
    block[148..156].fill(b' ');
    block[156] = kind;
    block[257..263].copy_from_slice(b"ustar\0");
    block[263..265].copy_from_slice(b"00");
    let checksum = block.iter().map(|byte| *byte as u64).sum::<u64>();
    octal(&mut block[148..156], checksum);
    block
}

fn gzip_archive(entries: &[(&str, u8, &[u8], u64)]) -> Vec<u8> {
    let mut tar = Vec::new();
    for (path, kind, payload, mode) in entries {
        tar.extend_from_slice(&header(path, *kind, payload, *mode));
        tar.extend_from_slice(payload);
        let padding = (BLOCK - payload.len() % BLOCK) % BLOCK;
        tar.resize(tar.len() + padding, 0);
    }
    tar.resize(tar.len() + BLOCK * 2, 0);
    let mut gzip = GzEncoder::new(Vec::new(), Compression::fast());
    gzip.write_all(&tar).unwrap();
    gzip.finish().unwrap()
}

fn extract(bytes: &[u8], stage: &Path) -> Result<Totals, &'static str> {
    extract_to(bytes, stage, "node_modules/demo")
}

fn extract_to(bytes: &[u8], stage: &Path, package_path: &str) -> Result<Totals, &'static str> {
    let file = tempfile::NamedTempFile::new().unwrap();
    fs::write(file.path(), bytes).unwrap();
    let mut file = File::open(file.path()).unwrap();
    let deadline = Deadline::start();
    let mut totals = Totals::default();
    let mut ledger = DestinationLedger::default();
    extract_archive(
        &mut file,
        stage,
        package_path,
        &mut totals,
        &mut ledger,
        &deadline,
    )?;
    Ok(totals)
}

#[test]
fn extracts_regular_package_files_and_strips_privileged_mode_bits() {
    let stage = tempdir().unwrap();
    let archive = gzip_archive(&[
        ("package/", b'5', b"", 0o4777),
        ("package/bin/tool", b'0', b"#!/bin/sh\n", 0o4755),
        ("package/data.txt", b'0', b"hello", 0o0644),
    ]);
    let totals = extract(&archive, stage.path()).unwrap();
    assert_eq!(
        fs::read(stage.path().join("node_modules/demo/bin/tool")).unwrap(),
        b"#!/bin/sh\n"
    );
    assert_eq!(
        fs::read(stage.path().join("node_modules/demo/data.txt")).unwrap(),
        b"hello"
    );
    assert_eq!(
        fs::metadata(stage.path().join("node_modules/demo/bin/tool"))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777,
        0o755
    );
    assert_eq!(totals.file_count, 2);
    assert_eq!(totals.unpacked_bytes, 15);
}

#[test]
fn rejects_traversal_symlink_duplicate_and_extension_headers() {
    let cases = [
        gzip_archive(&[("package/../outside", b'0', b"x", 0o644)]),
        gzip_archive(&[("package/link", b'2', b"", 0o777)]),
        gzip_archive(&[
            ("package/file", b'0', b"one", 0o644),
            ("package/file", b'0', b"two", 0o644),
        ]),
        gzip_archive(&[("package/pax", b'x', b"path=../bad", 0o644)]),
    ];
    for bytes in cases {
        let stage = tempdir().unwrap();
        assert!(extract(&bytes, stage.path()).is_err());
        assert!(!stage.path().join("outside").exists());
    }
}

#[test]
fn rejects_absolute_backslash_and_wrong_prefix_paths() {
    for path in ["/package/file", "package\\file", "other/file"] {
        let archive = gzip_archive(&[(path, b'0', b"x", 0o644)]);
        let stage = tempdir().unwrap();
        assert!(extract(&archive, stage.path()).is_err(), "{path}");
    }
}

#[test]
fn extracts_locked_package_basename_roots_with_identity_validation() {
    let cases = [
        ("react", "node_modules/@types/react", "@types/react"),
        (
            "react-dom",
            "node_modules/@types/react-dom",
            "@types/react-dom",
        ),
        (
            "babel__traverse",
            "node_modules/@types/babel__traverse",
            "@types/babel__traverse",
        ),
        (
            "babel__core",
            "node_modules/@types/babel__core",
            "@types/babel__core",
        ),
        ("estree", "node_modules/@types/estree", "@types/estree"),
        (
            "babel__template",
            "node_modules/@types/babel__template",
            "@types/babel__template",
        ),
        (
            "babel__generator",
            "node_modules/@types/babel__generator",
            "@types/babel__generator",
        ),
    ];
    for (archive_root, package_path, package_name) in cases {
        assert_eq!(
            verify_identity_from_named_root(archive_root, package_path, package_name),
            Ok(()),
            "root {archive_root} should map only to {package_path}"
        );
    }
}

#[test]
fn rejects_mixed_roots_and_invalid_alternate_root_components() {
    let stage = tempdir().unwrap();
    let mixed = gzip_archive(&[
        ("react/", b'5', b"", 0o755),
        ("react/file.js", b'0', b"first", 0o644),
        ("package/other.js", b'0', b"second", 0o644),
    ]);
    assert_eq!(
        extract_to(&mixed, stage.path(), "node_modules/@types/react"),
        Err("dependency_archive_path_invalid")
    );

    for path in [
        "react/../outside",
        "/react/file",
        "react\\file",
        "react//file",
        "react/./file",
    ] {
        let archive = gzip_archive(&[(path, b'0', b"x", 0o644)]);
        let stage = tempdir().unwrap();
        assert!(
            extract_to(&archive, stage.path(), "node_modules/@types/react").is_err(),
            "{path}"
        );
        assert!(!stage.path().join("outside").exists());
    }
}

#[test]
fn rejects_nonzero_tar_trailer_and_non_gzip_bytes() {
    let mut archive = gzip_archive(&[("package/file", b'0', b"x", 0o644)]);
    let final_byte = archive.len() - 1;
    archive[final_byte] ^= 0x01;
    let stage = tempdir().unwrap();
    assert!(extract(&archive, stage.path()).is_err());
    let stage = tempdir().unwrap();
    assert!(extract(b"not gzip", stage.path()).is_err());
}

#[test]
fn rejects_noncanonical_package_paths() {
    for path in [
        "node_modules/../outside",
        "node_modules/a/./b",
        "node_modules/a//b",
        "node_modules/a\\b",
        "node_modules//a",
        "node_modules/a/",
    ] {
        assert!(package_components(path).is_err(), "{path}");
    }
    assert!(package_components("node_modules/@scope/name").is_ok());
    assert!(package_components("node_modules/a/node_modules/b").is_ok());
}

fn verify_identity_from_digest_valid_archive(manifest: Option<&[u8]>) -> Result<(), &'static str> {
    use sha2::{Digest, Sha256, Sha512};
    use std::path::Path;

    let root = tempdir().unwrap();
    let cache = root.path().join("cache");
    let stage = root.path().join("stage");
    fs::create_dir(&cache).unwrap();
    fs::create_dir(&stage).unwrap();
    let entries: Vec<(&str, u8, &[u8], u64)> = match manifest {
        Some(bytes) => vec![("package/package.json", b'0', bytes, 0o644)],
        None => vec![("package/other.txt", b'0', b"metadata absent", 0o644)],
    };
    let archive = gzip_archive(&entries);
    let digest = Sha512::digest(&archive);
    let digest_hex = hex_lower(&digest[..]);
    let id_digest = Sha256::digest(format!("sha512:{digest_hex}").as_bytes());
    let archive_id = hex_lower(&id_digest[..]);
    fs::write(cache.join(&archive_id), &archive).unwrap();
    let spec = ArchiveSpec {
        package_path: "node_modules/demo-fixture",
        archive_id_sha256: &archive_id,
        algorithm: "sha512",
        digest_hex: &digest_hex,
    };
    let deadline = Deadline::start();
    let mut totals = Totals::default();
    let mut ledger = DestinationLedger::default();
    materialize_package(&cache, &stage, &spec, &mut totals, &mut ledger, &deadline)?;
    super::super::package_identity::validate_package_identity(
        Path::new(&stage),
        "node_modules/demo-fixture",
        "demo-fixture",
        "1.0.0",
        &deadline,
    )
}

fn verify_identity_from_named_root(
    archive_root: &str,
    package_path: &str,
    package_name: &str,
) -> Result<(), &'static str> {
    use sha2::{Digest, Sha256, Sha512};
    use std::path::Path;

    let root = tempdir().unwrap();
    let cache = root.path().join("cache");
    let stage = root.path().join("stage");
    fs::create_dir(&cache).unwrap();
    fs::create_dir(&stage).unwrap();
    let root_entry = format!("{archive_root}/");
    let manifest_path = format!("{archive_root}/package.json");
    let manifest = format!(r#"{{"name":"{package_name}","version":"1.0.0"}}"#);
    let entries = [
        (root_entry.as_str(), b'5', &[][..], 0o755),
        (manifest_path.as_str(), b'0', manifest.as_bytes(), 0o644),
    ];
    let archive = gzip_archive(&entries);
    let digest = Sha512::digest(&archive);
    let digest_hex = hex_lower(&digest[..]);
    let id_digest = Sha256::digest(format!("sha512:{digest_hex}").as_bytes());
    let archive_id = hex_lower(&id_digest[..]);
    fs::write(cache.join(&archive_id), &archive).unwrap();
    let spec = ArchiveSpec {
        package_path,
        archive_id_sha256: &archive_id,
        algorithm: "sha512",
        digest_hex: &digest_hex,
    };
    let deadline = Deadline::start();
    let mut totals = Totals::default();
    let mut ledger = DestinationLedger::default();
    materialize_package(&cache, &stage, &spec, &mut totals, &mut ledger, &deadline)?;
    super::super::package_identity::validate_package_identity(
        Path::new(&stage),
        package_path,
        package_name,
        "1.0.0",
        &deadline,
    )
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn validates_identity_from_digest_valid_archives_without_rejecting_other_fields() {
    let valid = br#"{"name":"demo-fixture","version":"1.0.0","scripts":{"preinstall":"node -e process.exit(99)"},"exports":{".":"./index.js"}}"#;
    assert_eq!(
        verify_identity_from_digest_valid_archive(Some(valid)),
        Ok(())
    );
    assert_eq!(
        verify_identity_from_digest_valid_archive(Some(
            br#"{"name":"other-package","version":"1.0.0"}"#
        )),
        Err("dependency_package_identity_mismatch")
    );
    assert_eq!(
        verify_identity_from_digest_valid_archive(Some(
            br#"{"name":"demo-fixture","version":"2.0.0"}"#
        )),
        Err("dependency_package_identity_mismatch")
    );
    assert_eq!(
        verify_identity_from_digest_valid_archive(Some(br#"{"version":"1.0.0"}"#)),
        Err("dependency_package_identity_invalid")
    );
    assert_eq!(
        verify_identity_from_digest_valid_archive(Some(
            br#"{"name":"demo-fixture","name":"attacker","version":"1.0.0"}"#
        )),
        Err("dependency_package_identity_invalid")
    );
    assert_eq!(
        verify_identity_from_digest_valid_archive(Some(
            br#"{"name":"demo-fixture","version":"1.0.0","version":"2.0.0"}"#
        )),
        Err("dependency_package_identity_invalid")
    );
    assert_eq!(
        verify_identity_from_digest_valid_archive(None),
        Err("dependency_package_metadata_missing")
    );
}

#[test]
fn rejects_duplicate_package_root_entries() {
    let archive = gzip_archive(&[
        ("package/", b'5', b"", 0o755),
        ("package/", b'5', b"", 0o755),
    ]);
    let stage = tempdir().unwrap();
    assert_eq!(
        extract(&archive, stage.path()),
        Err("dependency_archive_duplicate")
    );
}
