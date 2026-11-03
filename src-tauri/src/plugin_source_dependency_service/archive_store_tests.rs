use super::*;
use atools_plugin::source_build::{LockedPackageV1, PackageIntegrityV1};
use sha2::{Digest, Sha256, Sha512};
use std::{fs, io::Write};

fn package(bytes: &[u8]) -> LockedPackageV1 {
    LockedPackageV1 {
        package_path: "node_modules/example".into(),
        name: "example".into(),
        version: "1.0.0".into(),
        resolved_url: "https://registry.npmjs.org/example/-/example-1.0.0.tgz".into(),
        integrity: PackageIntegrityV1 {
            algorithm: "sha512".into(),
            digest_hex: super::super::identity::hex(&Sha512::digest(bytes)),
        },
        archive_id_sha256: super::super::identity::hex(&Sha256::digest(b"fixed archive key")),
        lifecycle_scripts_skipped: false,
    }
}

fn fixture_store() -> (super::ArchiveStore, super::super::super::staging::Workspace) {
    let workspace = super::super::super::staging::Workspace::create().unwrap();
    let store = ArchiveStore::open_for_write(&workspace.root).unwrap();
    (store, workspace)
}

fn seed_archive(store: &ArchiveStore, package: &LockedPackageV1, bytes: &[u8]) {
    let mut file = store
        .archives
        .create_file_exclusive(OsStr::new(&package.archive_id_sha256), 0o600)
        .unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
}

fn seed_temp(store: &ArchiveStore, bytes: &[u8]) -> String {
    let (name, mut file, _) = store.create_archive_temp().unwrap();
    file.write_all(bytes).unwrap();
    file.sync_all().unwrap();
    name
}

#[test]
fn fresh_archive_publication_survives_rename_ctime_change_and_verifies_content() {
    let (store, workspace) = fixture_store();
    let bytes = b"verified archive bytes";
    let package = package(bytes);
    let temporary = seed_temp(&store, bytes);

    store
        .publish_archive(&temporary, &package.archive_id_sha256)
        .unwrap();

    assert_eq!(
        store.inspect_archive(&package).unwrap(),
        CachedArchive::Verified {
            bytes: bytes.len() as u64
        }
    );
    assert_eq!(store.read_archive(&package).unwrap(), bytes);
    drop(store);
    drop(workspace);
}

#[test]
fn fresh_archive_publication_never_replaces_an_existing_digest_entry() {
    let (store, workspace) = fixture_store();
    let bytes = b"verified archive bytes";
    let package = package(bytes);
    let existing = b"preexisting cache entry";
    seed_archive(&store, &package, existing);
    let temporary = seed_temp(&store, bytes);

    assert_eq!(
        store
            .publish_archive(&temporary, &package.archive_id_sha256)
            .unwrap_err(),
        "SourceBuildDestinationExists"
    );
    assert_eq!(
        fs::read(store.archive_path.join(&package.archive_id_sha256)).unwrap(),
        existing
    );
    store.remove_archive_temp(&temporary).unwrap();
    drop(store);
    drop(workspace);
}

#[test]
fn corrupt_cached_archive_is_reported_and_repaired_only_after_fresh_integrity_verification() {
    let (store, workspace) = fixture_store();
    let good = b"verified tarball bytes";
    let package = package(good);
    seed_archive(&store, &package, b"corrupt cached bytes");
    let corrupt = match store.inspect_archive(&package).unwrap() {
        CachedArchive::Corrupt(observed) => observed,
        other => panic!("expected actionable corrupt cache state, got {other:?}"),
    };
    let temporary = seed_temp(&store, good);
    assert!(atools_plugin::source_build::verify_archive_integrity(
        &package, good
    ));
    store
        .publish_repaired_archive(&temporary, &package, &corrupt)
        .unwrap();
    assert_eq!(
        store.inspect_archive(&package).unwrap(),
        CachedArchive::Verified {
            bytes: good.len() as u64
        }
    );
    assert_eq!(store.read_archive(&package).unwrap(), good);
    drop(store);
    drop(workspace);
}

#[test]
fn cache_repair_rejects_a_replaced_digest_entry_without_overwriting_it() {
    let (store, workspace) = fixture_store();
    let good = b"verified tarball bytes";
    let package = package(good);
    seed_archive(&store, &package, b"corrupt cached bytes");
    let corrupt = match store.inspect_archive(&package).unwrap() {
        CachedArchive::Corrupt(observed) => observed,
        other => panic!("expected corrupt cache state, got {other:?}"),
    };

    let digest_name = OsStr::new(&package.archive_id_sha256);
    let held_name = format!(".tmp-{}", uuid::Uuid::new_v4());
    store
        .archives
        .rename_child(digest_name, OsStr::new(&held_name))
        .unwrap();
    let replacement = b"concurrent unknown replacement";
    seed_archive(&store, &package, replacement);
    let temporary = seed_temp(&store, good);

    assert_eq!(
        store
            .publish_repaired_archive(&temporary, &package, &corrupt)
            .unwrap_err(),
        "SOURCE_DEPENDENCY_CACHE_CHANGED"
    );
    assert_eq!(
        fs::read(store.archive_path.join(&package.archive_id_sha256)).unwrap(),
        replacement
    );
    store.remove_archive_temp(&temporary).unwrap();
    let held = store
        .archives
        .child_metadata(OsStr::new(&held_name))
        .unwrap();
    store
        .archives
        .unlink(OsStr::new(&held_name), false, Some(&held))
        .unwrap();
    drop(store);
    drop(workspace);
}

#[test]
fn cache_repair_rejects_in_place_mutation_after_corruption_was_observed() {
    let (store, workspace) = fixture_store();
    let good = b"verified tarball bytes";
    let package = package(good);
    let initial_corrupt = b"corrupt cached bytes";
    seed_archive(&store, &package, initial_corrupt);
    let corrupt = match store.inspect_archive(&package).unwrap() {
        CachedArchive::Corrupt(observed) => observed,
        other => panic!("expected corrupt cache state, got {other:?}"),
    };

    let target_path = store.archive_path.join(&package.archive_id_sha256);
    let mut changed = fs::OpenOptions::new()
        .write(true)
        .open(&target_path)
        .unwrap();
    changed.write_all(b"changed cached bytes").unwrap();
    changed.sync_all().unwrap();
    drop(changed);
    let temporary = seed_temp(&store, good);

    assert_eq!(
        store
            .publish_repaired_archive(&temporary, &package, &corrupt)
            .unwrap_err(),
        "SOURCE_DEPENDENCY_CACHE_CHANGED"
    );
    assert_eq!(fs::read(&target_path).unwrap(), b"changed cached bytes");
    store.remove_archive_temp(&temporary).unwrap();
    drop(store);
    drop(workspace);
}

#[test]
fn temp_cleanup_never_unlinks_a_replacement_inode() {
    let (store, workspace) = fixture_store();
    let (name, file, identity) = store.create_archive_temp().unwrap();
    drop(file);
    let held_name = format!(".tmp-{}", uuid::Uuid::new_v4());
    store
        .archives
        .rename_child(OsStr::new(&name), OsStr::new(&held_name))
        .unwrap();
    let mut replacement = store
        .archives
        .create_file_exclusive(OsStr::new(&name), 0o600)
        .unwrap();
    replacement.write_all(b"unknown replacement").unwrap();
    replacement.sync_all().unwrap();
    drop(replacement);

    assert_eq!(
        store
            .remove_archive_temp_if_identity(&name, &identity)
            .unwrap_err(),
        "SOURCE_DEPENDENCY_CACHE_CHANGED"
    );
    assert_eq!(
        fs::read(store.archive_path.join(&name)).unwrap(),
        b"unknown replacement"
    );
    let held = store
        .archives
        .child_metadata(OsStr::new(&held_name))
        .unwrap();
    store
        .archives
        .unlink(OsStr::new(&held_name), false, Some(&held))
        .unwrap();
    let replacement = store.archives.child_metadata(OsStr::new(&name)).unwrap();
    store
        .archives
        .unlink(OsStr::new(&name), false, Some(&replacement))
        .unwrap();
    drop(store);
    drop(workspace);
}
