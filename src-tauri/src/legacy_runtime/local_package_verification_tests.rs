use super::*;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

fn read_registry() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/local-original-plugin-cases.json"
    ))
    .unwrap()
}

fn profile<'a>(registry: &'a Value, case_id: &str) -> &'a Value {
    registry["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["caseId"] == case_id)
        .unwrap()
}

fn snapshot<'a>(registry: &'a Value, case_id: &str) -> &'a Value {
    &registry["snapshots"][case_id]
}

fn source_root(case: &Value) -> PathBuf {
    fs::canonicalize(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(case["sourcePath"].as_str().unwrap()),
    )
    .unwrap()
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    #[cfg(unix)]
    fs::set_permissions(target, fs::Permissions::from_mode(0o700)).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let to = target.join(entry.file_name());
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            copy_tree(&entry.path(), &to);
        } else {
            fs::copy(entry.path(), to).unwrap();
            #[cfg(unix)]
            fs::set_permissions(
                target.join(entry.file_name()),
                fs::Permissions::from_mode(0o600),
            )
            .unwrap();
        }
    }
}

fn fixture_root(scratch: &tempfile::TempDir) -> PathBuf {
    let owned = scratch.path().join("atools-local-plugin-fixture-test");
    fs::create_dir(&owned).unwrap();
    #[cfg(unix)]
    fs::set_permissions(&owned, fs::Permissions::from_mode(0o700)).unwrap();
    owned.join("plugin")
}

fn review_for(case: &Value, witness: &Value, root: &Path) -> Value {
    json!({
        "schemaVersion":1,
        "sourceKind":"local_full_directory",
        "status":case["sourceReviewStatus"],
        "profile":{
            "caseId":case["caseId"],"id":case["id"],"version":case["version"],
            "sourceKind":case["sourceKind"],"directorySha256":case["directorySha256"],"fileCount":case["fileCount"]
        },
        "fixture":{
            "id":case["id"],"version":case["version"],"sourceKind":"local_full_directory",
            "directorySha256":witness["directorySha256"],"fileCount":witness["fileCount"],
            "pluginRoot":root.to_string_lossy(),"files":witness["files"],"directories":witness["directories"]
        }
    })
}

#[test]
fn local_original_directory_digest_matches_pinned_complete_source_and_manifest() {
    let registry = read_registry();
    for case in registry["cases"].as_array().unwrap() {
        let root = source_root(case);
        let (files, dirs) = scan_tree(&root).unwrap();
        let (digest, file_witness) = digest_tree(&files, &dirs).unwrap();
        let pinned = snapshot(&registry, case["caseId"].as_str().unwrap());
        assert_eq!(witness_json(&file_witness), pinned["files"]);
        assert_eq!(digest, case["directorySha256"]);
        assert_eq!(witness_json(&file_witness), pinned["files"]);
        assert_eq!(
            json!(dirs.iter().collect::<Vec<_>>()),
            pinned["directories"]
        );
        verify_manifest(&root, case).unwrap();
    }
}

#[test]
fn local_original_verifier_accepts_a_byte_exact_owned_copy() {
    let registry = read_registry();
    let case = profile(&registry, "local-content-workbench");
    let witness = snapshot(&registry, "local-content-workbench");
    let scratch = tempfile::tempdir().unwrap();
    let root = fixture_root(&scratch);
    copy_tree(&source_root(case), &root);
    let root = fs::canonicalize(root).unwrap();
    let review = review_for(case, witness, &root);
    let result = verify_reviewed_local_package(
        &review,
        case,
        &root,
        case["directorySha256"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(result["sourceBytesUnchanged"], true);
    assert_eq!(result["fixtureBytesMatchRegisteredSource"], true);
    assert_eq!(result["pluginCodeExecutedByVerification"], false);
    assert_eq!(result["unchangedFileCount"], 8);
}

#[test]
fn local_original_verifier_accepts_registered_node_profile_with_preload_only() {
    let registry = read_registry();
    let case = profile(&registry, "local-json-editor");
    let witness = snapshot(&registry, "local-json-editor");
    let scratch = tempfile::tempdir().unwrap();
    let root = fixture_root(&scratch);
    copy_tree(&source_root(case), &root);
    let root = fs::canonicalize(root).unwrap();
    let review = review_for(case, witness, &root);
    let result = verify_reviewed_local_package(
        &review,
        case,
        &root,
        case["directorySha256"].as_str().unwrap(),
    )
    .unwrap();
    assert_eq!(case["runtime"], "node");
    assert_eq!(result["fixtureBytesMatchRegisteredSource"], true);
    assert_eq!(result["pluginCodeExecutedByVerification"], false);

    let mut unknown_runtime = case.clone();
    unknown_runtime["runtime"] = json!("wasm");
    assert!(verify_reviewed_local_package(
        &review,
        &unknown_runtime,
        &root,
        case["directorySha256"].as_str().unwrap(),
    )
    .unwrap_err()
    .contains("Unsupported local original fixture runtime"));
}

#[test]
fn local_original_verifier_rejects_a_tampered_file_and_extra_directory() {
    let registry = read_registry();
    let case = profile(&registry, "local-developer-codec-tools");
    let witness = snapshot(&registry, "local-developer-codec-tools");
    let scratch = tempfile::tempdir().unwrap();
    let root = fixture_root(&scratch);
    copy_tree(&source_root(case), &root);
    let root = fs::canonicalize(root).unwrap();
    let review = review_for(case, witness, &root);
    fs::write(root.join("codec.js"), b"modified").unwrap();
    assert!(verify_reviewed_local_package(
        &review,
        case,
        &root,
        case["directorySha256"].as_str().unwrap()
    )
    .is_err());
    fs::write(
        root.join("codec.js"),
        fs::read(source_root(case).join("codec.js")).unwrap(),
    )
    .unwrap();
    fs::create_dir(root.join("extra")).unwrap();
    assert!(verify_reviewed_local_package(
        &review,
        case,
        &root,
        case["directorySha256"].as_str().unwrap()
    )
    .is_err());
}

#[cfg(unix)]
#[test]
fn local_original_verifier_rejects_symlinks_and_wrong_profile_before_traversal() {
    use std::os::unix::fs::symlink;
    let registry = read_registry();
    let case = profile(&registry, "local-cron");
    let witness = snapshot(&registry, "local-cron");
    let scratch = tempfile::tempdir().unwrap();
    let root = fixture_root(&scratch);
    copy_tree(&source_root(case), &root);
    let root = fs::canonicalize(root).unwrap();
    let review = review_for(case, witness, &root);
    let index = root.join("index.html");
    let saved = scratch.path().join("index.original");
    fs::rename(&index, &saved).unwrap();
    symlink(saved, &index).unwrap();
    assert!(verify_reviewed_local_package(
        &review,
        case,
        &root,
        case["directorySha256"].as_str().unwrap()
    )
    .unwrap_err()
    .contains("symlink"));

    let mut forged = case.clone();
    forged["title"] = json!("forged");
    assert!(verify_reviewed_local_package(
        &review,
        &forged,
        &root,
        case["directorySha256"].as_str().unwrap()
    )
    .unwrap_err()
    .contains("Modified"));
}

#[test]
fn local_original_verifier_enforces_pinned_manifest_and_digest() {
    let registry = read_registry();
    let case = profile(&registry, "local-calculation-paper");
    let witness = snapshot(&registry, "local-calculation-paper");
    let scratch = tempfile::tempdir().unwrap();
    let root = fixture_root(&scratch);
    copy_tree(&source_root(case), &root);
    let root = fs::canonicalize(root).unwrap();
    let review = review_for(case, witness, &root);
    assert!(verify_reviewed_local_package(&review, case, &root, "0".repeat(64).as_str()).is_err());
    let mut forged = review;
    forged["fixture"]["id"] = json!("other-plugin");
    assert!(verify_reviewed_local_package(
        &forged,
        case,
        &root,
        case["directorySha256"].as_str().unwrap()
    )
    .is_err());
}
