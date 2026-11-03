use super::super::{SettingsBundle, PROVENANCE_PATH};
use std::{fs, path::Path};

fn current_dist() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/ztools-settings/dist")
        .canonicalize()
        .expect("formal Settings distribution required")
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir_all(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        assert!(!kind.is_symlink());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target.join(entry.file_name()));
        } else {
            assert!(kind.is_file());
            fs::copy(entry.path(), target.join(entry.file_name())).unwrap();
        }
    }
}

#[test]
fn actual_formal_bundle_loads_with_compiled_revision() {
    let root = current_dist();
    let compiled = super::compiled_revision().unwrap();
    let actual = fs::read(root.join(PROVENANCE_PATH)).unwrap();
    assert_eq!(compiled, super::super::sha256_hex(&actual));
    let bundle = SettingsBundle::load(&root).expect("actual formal bundle must load");
    assert_eq!(bundle.revision(), compiled);
    assert!(bundle.resource_count() > 0);
}

#[test]
fn changed_current_provenance_is_rejected_through_production_loader() {
    let source = current_dist();
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("dist");
    copy_tree(&source, &root);
    let root = root.canonicalize().unwrap();
    let provenance = root.join(PROVENANCE_PATH);
    let mut bytes = fs::read(&provenance).unwrap();
    bytes.push(b' '); // Still valid JSON and unchanged resource inventory.
    assert!(serde_json::from_slice::<serde_json::Value>(&bytes).is_ok());
    fs::write(provenance, bytes).unwrap();
    assert_eq!(
        SettingsBundle::load(&root).err().as_deref(),
        Some("Settings provenance differs from compiled artifact")
    );
}

#[test]
fn empty_or_wrong_expected_is_rejected_without_weakening_test_seam() {
    let root = current_dist();
    assert!(SettingsBundle::load_with_expected_for_test(&root, "").is_err());
    assert!(SettingsBundle::load_with_expected_for_test(&root, &"0".repeat(64)).is_err());
    assert!(super::verify(b"", &"0".repeat(64)).is_err());
}
