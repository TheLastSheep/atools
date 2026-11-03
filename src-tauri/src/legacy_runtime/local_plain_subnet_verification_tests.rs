//! Full-tree evidence tests only. Never executes plugin or native code.
use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
fn copy(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    #[cfg(unix)]
    fs::set_permissions(target, fs::Permissions::from_mode(0o700)).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let to = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &to)
        } else {
            fs::copy(entry.path(), &to).unwrap();
            #[cfg(unix)]
            fs::set_permissions(to, fs::Permissions::from_mode(0o600)).unwrap();
        }
    }
}
#[test]
fn original_plain_and_subnet_complete_directory_copies_match_independent_pins_and_only_registered_paths(
) {
    for source in [
        include_str!("../../../tests/fixtures/local-plain-text-cases.json"),
        include_str!("../../../tests/fixtures/local-subnet-calculator-cases.json"),
    ] {
        let registry: Value = serde_json::from_str(source).unwrap();
        let case = &registry["cases"][0];
        let id = case["caseId"].as_str().unwrap();
        let witness = &registry["snapshots"][id];
        let source = fs::canonicalize(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join(case["sourcePath"].as_str().unwrap()),
        )
        .unwrap();
        let scratch = tempfile::tempdir().unwrap();
        let owned = scratch.path().join("atools-local-plugin-fixture-test");
        fs::create_dir(&owned).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&owned, fs::Permissions::from_mode(0o700)).unwrap();
        let root = owned.join("plugin");
        copy(&source, &root);
        let root = fs::canonicalize(root).unwrap();
        let review = json!({"schemaVersion":1,"sourceKind":"local_full_directory","status":case["sourceReviewStatus"],
            "profile":{"caseId":case["caseId"],"id":case["id"],"version":case["version"],"sourceKind":case["sourceKind"],"directorySha256":case["directorySha256"],"fileCount":case["fileCount"]},
            "fixture":{"id":case["id"],"version":case["version"],"sourceKind":"local_full_directory","directorySha256":witness["directorySha256"],"fileCount":witness["fileCount"],"pluginRoot":root.to_string_lossy(),"files":witness["files"],"directories":witness["directories"]}});
        let digest = case["directorySha256"].as_str().unwrap();
        let value = verify_reviewed_local_package(&review, case, &root, digest).unwrap();
        assert_eq!(value["fixtureBytesMatchRegisteredSource"], true);
        assert_eq!(value["pluginCodeExecutedByVerification"], false);
        assert_eq!(
            value["expandedBytes"],
            if id == "local-plain-text" {
                928976
            } else {
                17973
            }
        );
        let mut changed = case.clone();
        changed["pathAccess"] = json!(if id == "local-plain-text" {
            "none"
        } else {
            "standard"
        });
        assert!(
            verify_reviewed_local_package(&review, &changed, &root, digest)
                .unwrap_err()
                .contains("Modified")
        );
        fs::write(root.join("plugin.json"), b"{}").unwrap();
        assert!(verify_reviewed_local_package(&review, case, &root, digest).is_err());
    }
}
