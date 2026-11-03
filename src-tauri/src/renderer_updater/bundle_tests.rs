//! Actual updater source-role loader, including its emitted resource bytes.
use super::*;
#[test]
fn current_formal_updater_role_loads_exact_emitted_budget_and_rejects_asset_tampering() {
    let formal = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-ztools-updater");
    let bundle = Bundle::load(&formal).unwrap();
    assert_eq!(bundle.assets.len(), 4);
    let js: usize = bundle
        .assets
        .iter()
        .filter(|(name, _)| name.ends_with(".js"))
        .map(|(_, (bytes, _))| bytes.len())
        .sum();
    let total: usize = bundle.assets.values().map(|(bytes, _)| bytes.len()).sum();
    assert!(js <= 120714 && total <= 300982);
    assert!(js > 104330 && total > 284598);
    let root = std::env::temp_dir().join(format!(
        "atools-updater-role-test-{}",
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir(&root).unwrap();
    struct Owned(std::path::PathBuf);
    impl Drop for Owned {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _owned = Owned(root.clone());
    for name in ["build-provenance.json", "source-manifest.json"] {
        fs::copy(formal.join(name), root.join(name)).unwrap();
    }
    for (name, (bytes, _)) in &bundle.assets {
        let dest = root.join(name);
        fs::create_dir_all(dest.parent().unwrap()).unwrap();
        fs::write(dest, bytes.as_ref()).unwrap();
    }
    assert!(Bundle::load(&root).is_ok());
    let name = bundle
        .assets
        .keys()
        .find(|name| name.ends_with(".js"))
        .unwrap();
    let dest = root.join(name);
    let mut bytes = fs::read(&dest).unwrap();
    bytes[0] ^= 1;
    fs::write(dest, bytes).unwrap();
    let error = match Bundle::load(&root) {
        Ok(_) => panic!("tampered resource accepted"),
        Err(error) => error,
    };
    assert!(error.contains("hash"));
}
