use super::*;
use serde_json::json;

fn profile() -> Value {
    json!({"caseId":CASE_ID,"id":"image-stitch","version":"1.0.0","featureCode":"image-stitch-files",
        "runtime":"web","dataAccess":true,"dialogAccess":"open_and_save","pathAccess":"none",
        "verifyDataPersistence":false,"sourceKind":"local_full_directory",
        "sourceCommit":"2d47bd91011b6be872eef1d7c56b4c6b57a93b3d",
        "sourceTree":"629b6c70b86f28d8f775ced7202bfc2de9b244d5",
        "directorySha256":"16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee","fileCount":5})
}

#[test]
fn fixed_ordered_pair_decodes_all_distinct_pixels_and_reports_run_bound_hashes() {
    let temp = tempfile::tempdir().unwrap();
    prepare(&profile(), temp.path()).unwrap();
    let report = evidence(
        &profile(),
        temp.path(),
        "4be0643f-1d98-4f20-a423-70a0a8a8c144",
    )
    .unwrap();
    assert_eq!(
        report["orderedPaths"][0],
        temp.path().join(TOP_NAME).to_string_lossy().as_ref()
    );
    assert_eq!(
        report["orderedPaths"][1],
        temp.path().join(BOTTOM_NAME).to_string_lossy().as_ref()
    );
    assert_eq!(report["files"][0]["fileName"], TOP_NAME);
    assert_eq!(report["files"][1]["fileName"], BOTTOM_NAME);
    assert_eq!(report["files"][0]["width"], 2);
    assert_eq!(report["files"][0]["height"], 2);
    assert_eq!(report["files"][1]["width"], 2);
    assert_eq!(report["files"][1]["height"], 2);
    assert_eq!(
        report["files"][0]["pixels"],
        json!([
            [255, 0, 0, 255],
            [0, 255, 0, 255],
            [0, 0, 255, 255],
            [255, 255, 255, 255]
        ])
    );
    assert_eq!(
        report["files"][1]["pixels"],
        json!([
            [0, 255, 255, 255],
            [255, 0, 255, 255],
            [255, 255, 0, 255],
            [0, 0, 0, 255]
        ])
    );
    assert_eq!(report["pathAccess"], "none");
    assert!(report["totalBytes"].as_u64().unwrap() <= MAX_TOTAL_BYTES);
    assert!(!report.to_string().contains("genericRead"));
}

#[test]
fn wrong_profile_and_non_uuid_run_are_rejected() {
    let temp = tempfile::tempdir().unwrap();
    let mut wrong = profile();
    wrong["pathAccess"] = json!("standard");
    assert!(!profile_matches(&wrong));
    assert!(prepare(&wrong, temp.path()).is_err());
    assert!(evidence(&profile(), temp.path(), "not-a-run-id").is_err());
}

#[test]
fn existing_fixture_is_never_overwritten() {
    let temp = tempfile::tempdir().unwrap();
    let existing = temp.path().join(TOP_NAME);
    std::fs::write(&existing, b"caller data").unwrap();
    assert!(prepare(&profile(), temp.path()).is_err());
    assert_eq!(std::fs::read(existing).unwrap(), b"caller data");
}

#[cfg(unix)]
#[test]
fn symlink_fixture_is_rejected_without_following_or_modifying_target() {
    use std::os::unix::fs::symlink;
    let temp = tempfile::tempdir().unwrap();
    let target = temp.path().join("target.png");
    std::fs::write(&target, b"keep").unwrap();
    symlink(&target, temp.path().join(TOP_NAME)).unwrap();
    assert!(evidence(
        &profile(),
        temp.path(),
        "4be0643f-1d98-4f20-a423-70a0a8a8c144"
    )
    .is_err());
    assert_eq!(std::fs::read(target).unwrap(), b"keep");
}
