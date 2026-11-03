//! Build-time test boundary, not the generic runtime Main 2MiB safety cap.
use serde_json::Value;
use std::{fs, path::Path};
#[test]
fn actual_formal_main_has_r78_declared_budget_and_matching_emitted_javascript() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let manifest: Value = serde_json::from_slice(
        &fs::read(repo.join("packages/ztools-renderer/source-manifest.json")).unwrap(),
    )
    .unwrap();
    let build = &manifest["build"];
    let (baseline, increment, descriptor, after) = match build["budgetMilestone"].as_str().unwrap()
    {
        "original-vue-main-updater-2026-11-02" => (
            609908,
            4096,
            "builtin-shortcuts-live-and-startup-generation",
            "f402deff8ae1389f2f77486c8445807f9faa714b5262ae75147e12e4887bda80",
        ),
        "original-vue-main-about-update-2026-11-02" => (
            611758,
            2246,
            "builtin-shortcuts-and-auto-update-startup-generation",
            "54790416e8b0acf1b1a80e14432caf81aae363e54a10c7eef41de4b443b39837",
        ),
        _ => panic!("unapproved Main milestone"),
    };
    assert_eq!(build["previousTotalJavaScriptBytes"], baseline);
    assert_eq!(build["maxIncrementalJavaScriptBytes"], increment);
    assert_eq!(build["totalJavaScriptBudgetBytes"], 614004);
    let dist = repo.join("packages/ztools-renderer/dist");
    let provenance: Value =
        serde_json::from_slice(&fs::read(dist.join("build-provenance.json")).unwrap()).unwrap();
    let patches = provenance["upstreamCompatibilityPatches"]
        .as_array()
        .unwrap();
    let patch = patches
        .iter()
        .find(|p| p["path"] == "src/renderer/src/stores/windowStore.ts")
        .unwrap();
    assert_eq!(patch["id"], descriptor);
    assert_eq!(patch["afterSha256"], after);
    assert_eq!(
        provenance["sourceCommit"],
        "9b15fb1a2a9f3ec886016632761c7bb21e39557a"
    );
    let mut bytes = 0u64;
    for entry in fs::read_dir(dist.join("assets")).unwrap() {
        let entry = entry.unwrap();
        assert!(!entry.file_type().unwrap().is_symlink());
        if entry.path().extension().is_some_and(|e| e == "js") {
            bytes = bytes
                .checked_add(fs::read(entry.path()).unwrap().len() as u64)
                .unwrap();
        }
    }
    assert_eq!(provenance["bundle"]["totalJavaScriptBytes"], bytes);
    assert!(bytes <= 614004);
    // The distinct updater role has its own strict production reader in bundle.rs.
    let updater = repo.join("dist-ztools-updater");
    super::bundle::Bundle::load(&updater).unwrap();
}
