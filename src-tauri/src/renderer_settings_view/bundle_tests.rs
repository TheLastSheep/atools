//! Synthetic strict bundles exercise the loader contract only; they do not prove
//! the original settings GUI or its host bridge behavior.

use super::policy::{select_source_policy, RESOURCE_BUDGET_METRIC, SOURCE_COMMIT};
use super::*;
use serde_json::json;
use tempfile::TempDir;

#[test]
#[ignore = "requires the explicitly built pinned Settings distribution"]
fn current_strict_distribution_loads_in_the_native_bundle_reader() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/ztools-settings/dist")
        .canonicalize()
        .expect("current Settings dist must exist");
    let source_manifest: Value = serde_json::from_slice(
        &fs::read(root.join(SOURCE_MANIFEST_PATH)).expect("current source manifest must exist"),
    )
    .expect("current source manifest must be valid JSON");
    assert_eq!(
        select_source_policy(&source_manifest),
        Ok(ResourceBudgetPolicy::ABOUT_UPDATE)
    );
    let bundle =
        SettingsBundle::load(&root).expect("current Settings dist must pass the Native reader");
    assert!(bundle.total_bytes() > 0);
}

#[test]
fn runtime_resource_budget_matches_the_authoritative_settings_build_policy() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../../../packages/ztools-settings/source-manifest.json"
    ))
    .unwrap();
    let budget = &manifest["build"]["emittedResourceBudget"];
    assert_eq!(budget["metric"], RESOURCE_BUDGET_METRIC);
    assert_eq!(
        budget["baselineBytes"],
        ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS.baseline_bytes
    );
    assert_eq!(
        budget["maxIncreaseBytes"],
        ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS.max_increase_bytes
    );
    assert_eq!(
        budget["maxBytes"],
        ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS.absolute_max_bytes
    );
    assert_eq!(
        select_source_policy(&manifest),
        Ok(ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS)
    );
    assert_eq!(
        manifest["build"]["budgetMilestone"],
        ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS
            .milestone
            .unwrap()
    );
}

/// Explicit test-only identity for synthetic bundles; production always uses compiled metadata.
pub(super) fn load_fixture(root: &Path) -> Result<SettingsBundle, String> {
    let bytes = fs::read(root.join(PROVENANCE_PATH)).map_err(|e| e.to_string())?;
    SettingsBundle::load_with_expected_for_test(root, &sha256_hex(&bytes))
}

fn fixture() -> (TempDir, PathBuf, Value) {
    fixture_with_total(None)
}

fn fixture_at_total(target_total: usize) -> (TempDir, PathBuf, Value) {
    fixture_with_total(Some(target_total))
}

fn fixture_with_total(target_total: Option<usize>) -> (TempDir, PathBuf, Value) {
    fixture_with_policy(target_total, ResourceBudgetPolicy::LEGACY)
}

pub(super) fn fixture_with_policy(
    target_total: Option<usize>,
    budget_policy: ResourceBudgetPolicy,
) -> (TempDir, PathBuf, Value) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("dist");
    fs::create_dir_all(root.join("assets")).unwrap();
    let mut resources = vec![
        ("index.html", b"<!doctype html><html></html>".to_vec()),
        ("assets/app.js", b"globalThis.ready = true;".to_vec()),
        ("assets/app.css", b"body { color: black; }".to_vec()),
    ];
    if let Some(target_total) = target_total {
        let current_total: usize = resources.iter().map(|(_, bytes)| bytes.len()).sum();
        assert!(target_total >= current_total);
        let javascript_target = resources[1].1.len() + target_total - current_total;
        resources[1].1.resize(javascript_target, 0);
    }
    let mut entries = Vec::new();
    let mut total = 0usize;
    for (path, bytes) in &resources {
        let full_path = root.join(*path);
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(full_path, bytes).unwrap();
        total += bytes.len();
        entries.push(json!({
            "path": *path,
            "bytes": bytes.len(),
            "sha256": sha256_hex(bytes),
        }));
    }
    let provenance = json!({
        "schemaVersion": 1,
        "artifactOwner": ARTIFACT_OWNER,
        "status": "strict/typecheck-passed",
        "typecheckPassed": true,
        "source": {
            "commit": SOURCE_COMMIT,
            "workingTreeClean": true,
        },
        "build": { "typecheckPassed": true },
        "bundleBudget": {
            "metric": RESOURCE_BUDGET_METRIC,
            "actualBytes": total,
            "baselineBytes": budget_policy.baseline_bytes,
            "maxIncreaseBytes": budget_policy.max_increase_bytes,
            "maxBytes": budget_policy.absolute_max_bytes,
            "increaseBytes": total as i64 - budget_policy.baseline_bytes as i64,
            "passed": true,
        },
        "emittedResources": entries,
        "emittedResourceCount": resources.len(),
        "emittedResourceTotalBytes": total,
    });
    write_source_manifest(&root, &source_manifest(budget_policy));
    write_provenance(&root, &provenance);
    let root = root.canonicalize().unwrap();
    (temp, root, provenance)
}

fn source_manifest(policy: ResourceBudgetPolicy) -> serde_json::Value {
    let mut manifest = json!({
        "schemaVersion": 1,
        "source": { "commit": SOURCE_COMMIT },
        "build": {
            "emittedResourceBudget": {
                "metric": RESOURCE_BUDGET_METRIC,
                "baselineBytes": policy.baseline_bytes,
                "maxIncreaseBytes": policy.max_increase_bytes,
                "maxBytes": policy.absolute_max_bytes,
            }
        }
    });
    if let Some(milestone) = policy.milestone {
        manifest["build"]["budgetMilestone"] = json!(milestone);
    }
    manifest
}

fn write_source_manifest(root: &Path, manifest: &serde_json::Value) {
    fs::write(
        root.join(SOURCE_MANIFEST_PATH),
        serde_json::to_vec(manifest).unwrap(),
    )
    .unwrap();
}

fn write_provenance(root: &Path, provenance: &Value) {
    fs::write(
        root.join(PROVENANCE_PATH),
        serde_json::to_vec(provenance).unwrap(),
    )
    .unwrap();
}

fn assert_rejected(mutate: impl FnOnce(&mut Value)) {
    let (_temp, root, mut provenance) = fixture();
    mutate(&mut provenance);
    write_provenance(&root, &provenance);
    assert!(load_fixture(&root).is_err());
}

#[test]
fn synthetic_strict_bundle_loads_into_an_immutable_memory_snapshot() {
    let (_temp, root, provenance) = fixture();
    let bundle = load_fixture(&root).unwrap();

    assert_eq!(bundle.resource_count(), 3);
    assert_eq!(
        bundle.total_bytes(),
        provenance["emittedResourceTotalBytes"].as_u64().unwrap() as usize
    );
    assert_eq!(
        bundle.revision(),
        sha256_hex(&serde_json::to_vec(&provenance).unwrap())
    );
    assert_eq!(
        bundle.asset("index.html").unwrap().mime,
        "text/html; charset=utf-8"
    );
    let js = bundle.asset("assets/app.js").unwrap();
    assert_eq!(&*js.bytes, b"globalThis.ready = true;");

    fs::write(root.join("assets/app.js"), b"changed on disk").unwrap();
    assert_eq!(
        &*bundle.asset("assets/app.js").unwrap().bytes,
        b"globalThis.ready = true;"
    );
    assert!(bundle.asset("/assets/app.js").is_none());
}

#[test]
fn rejects_review_builds_unknown_owners_and_unapproved_sources() {
    let mutations: [fn(&mut Value); 7] = [
        |value| value["status"] = json!("review-only"),
        |value| value["artifactOwner"] = json!("unknown-owner"),
        |value| value["typecheckPassed"] = json!(false),
        |value| value["build"]["typecheckPassed"] = json!(false),
        |value| value["source"]["commit"] = json!("another-commit"),
        |value| value["source"]["workingTreeClean"] = json!(false),
        |value| value["reviewOnly"] = json!(true),
    ];
    for mutate in mutations {
        assert_rejected(mutate);
    }
}

#[test]
fn rejects_hash_size_count_total_and_budget_forgery() {
    let mutations: [fn(&mut Value); 9] = [
        |value| value["emittedResources"][0]["sha256"] = json!("0".repeat(64)),
        |value| value["emittedResources"][0]["bytes"] = json!(999),
        |value| value["emittedResourceCount"] = json!(4),
        |value| value["emittedResourceTotalBytes"] = json!(1),
        |value| value["bundleBudget"]["metric"] = json!("different_metric"),
        |value| value["bundleBudget"]["maxBytes"] = json!(999_999),
        |value| value["bundleBudget"]["increaseBytes"] = json!(1),
        |value| value["bundleBudget"]["passed"] = json!(false),
        |value| {
            let old = value["emittedResources"][0]["bytes"].as_u64().unwrap() as usize;
            let new = ResourceBudgetPolicy::LEGACY.max_total_bytes() + 1;
            value["emittedResources"][0]["bytes"] = json!(new);
            let total = value["emittedResourceTotalBytes"].as_u64().unwrap() as usize;
            value["emittedResourceTotalBytes"] = json!(total - old + new);
            value["bundleBudget"]["passed"] = json!(true);
        },
    ];
    for mutate in mutations {
        assert_rejected(mutate);
    }
}

#[test]
fn legacy_and_all_current_resource_budget_boundaries_and_provenance_are_enforced() {
    let (_current_temp, current_root, current_provenance) = fixture_at_total(778_122);
    assert!(load_fixture(&current_root).is_ok());
    assert_eq!(current_provenance["bundleBudget"]["baselineBytes"], 771_693);
    assert_eq!(
        current_provenance["bundleBudget"]["maxIncreaseBytes"],
        8_192
    );

    let (_boundary_temp, boundary_root, boundary_provenance) = fixture_at_total(779_885);
    assert!(load_fixture(&boundary_root).is_ok());
    assert_eq!(boundary_provenance["emittedResourceTotalBytes"], 779_885);

    let (_over_temp, over_root, over_provenance) = fixture_at_total(779_886);
    assert_eq!(over_provenance["bundleBudget"]["passed"], true);
    assert_eq!(over_provenance["bundleBudget"]["actualBytes"], 779_886);
    assert!(load_fixture(&over_root).is_err());

    let (_new_boundary_temp, new_boundary_root, new_boundary_provenance) =
        fixture_with_policy(Some(783_560), ResourceBudgetPolicy::DISABLED_COMMANDS);
    assert!(load_fixture(&new_boundary_root).is_ok());
    assert_eq!(
        new_boundary_provenance["emittedResourceTotalBytes"],
        783_560
    );
    assert_eq!(
        new_boundary_provenance["bundleBudget"]["baselineBytes"],
        779_464
    );
    assert_eq!(
        new_boundary_provenance["bundleBudget"]["maxIncreaseBytes"],
        4_096
    );

    let (_tray_boundary_temp, tray_boundary_root, tray_boundary_provenance) =
        fixture_with_policy(Some(784_380), ResourceBudgetPolicy::TRAY_VISIBILITY);
    assert!(load_fixture(&tray_boundary_root).is_ok());
    assert_eq!(
        tray_boundary_provenance["emittedResourceTotalBytes"],
        784_380
    );
    assert_eq!(
        tray_boundary_provenance["bundleBudget"]["baselineBytes"],
        783_356
    );
    assert_eq!(
        tray_boundary_provenance["bundleBudget"]["maxIncreaseBytes"],
        1_024
    );

    let (_tray_over_temp, tray_over_root, tray_over_provenance) =
        fixture_with_policy(Some(784_381), ResourceBudgetPolicy::TRAY_VISIBILITY);
    assert_eq!(tray_over_provenance["bundleBudget"]["passed"], true);
    assert_eq!(tray_over_provenance["bundleBudget"]["actualBytes"], 784_381);
    assert!(load_fixture(&tray_over_root).is_err());

    let hotkey_cap = ResourceBudgetPolicy::MAIN_HOTKEY.max_total_bytes();
    let (_hotkey_boundary_temp, hotkey_boundary_root, hotkey_boundary_provenance) =
        fixture_with_policy(Some(hotkey_cap), ResourceBudgetPolicy::MAIN_HOTKEY);
    assert!(load_fixture(&hotkey_boundary_root).is_ok());
    assert_eq!(
        hotkey_boundary_provenance["emittedResourceTotalBytes"],
        786_363
    );
    assert_eq!(
        hotkey_boundary_provenance["bundleBudget"]["baselineBytes"],
        784_315
    );
    assert_eq!(
        hotkey_boundary_provenance["bundleBudget"]["maxIncreaseBytes"],
        2_048
    );

    let (_hotkey_over_temp, hotkey_over_root, hotkey_over_provenance) =
        fixture_with_policy(Some(hotkey_cap + 1), ResourceBudgetPolicy::MAIN_HOTKEY);
    assert_eq!(hotkey_over_provenance["bundleBudget"]["passed"], true);
    assert!(load_fixture(&hotkey_over_root).is_err());

    let login_cap = ResourceBudgetPolicy::LAUNCH_AT_LOGIN.max_total_bytes();
    let (_login_boundary_temp, login_boundary_root, login_boundary_provenance) =
        fixture_with_policy(Some(login_cap), ResourceBudgetPolicy::LAUNCH_AT_LOGIN);
    assert!(load_fixture(&login_boundary_root).is_ok());
    assert_eq!(
        login_boundary_provenance["emittedResourceTotalBytes"],
        790_459
    );
    assert_eq!(
        login_boundary_provenance["bundleBudget"]["baselineBytes"],
        784_315
    );
    assert_eq!(
        login_boundary_provenance["bundleBudget"]["maxIncreaseBytes"],
        6_144
    );
    assert_eq!(
        login_boundary_provenance["bundleBudget"]["maxBytes"],
        790_528
    );

    let (_login_over_temp, login_over_root, login_over_provenance) =
        fixture_with_policy(Some(login_cap + 1), ResourceBudgetPolicy::LAUNCH_AT_LOGIN);
    assert_eq!(login_over_provenance["bundleBudget"]["passed"], true);
    assert_eq!(
        login_over_provenance["bundleBudget"]["actualBytes"],
        790_460
    );
    assert!(load_fixture(&login_over_root).is_err());

    let (_new_over_temp, new_over_root, new_over_provenance) =
        fixture_with_policy(Some(783_561), ResourceBudgetPolicy::DISABLED_COMMANDS);
    assert_eq!(new_over_provenance["bundleBudget"]["passed"], true);
    assert_eq!(new_over_provenance["bundleBudget"]["actualBytes"], 783_561);
    assert!(load_fixture(&new_over_root).is_err());

    assert_rejected(|value| {
        let actual = value["bundleBudget"]["actualBytes"].as_i64().unwrap();
        value["bundleBudget"]["baselineBytes"] = json!(749_106);
        value["bundleBudget"]["increaseBytes"] = json!(actual - 749_106);
    });
    assert_rejected(|value| value["bundleBudget"]["maxIncreaseBytes"] = json!(16_384));
    assert_rejected(|value| value["bundleBudget"]["actualBytes"] = json!(999_999));
}

#[test]
fn rejects_unknown_or_forged_source_manifest_policies_and_mismatched_provenance() {
    let (_temp, root, _) = fixture();
    let mut manifest: Value =
        serde_json::from_slice(&fs::read(root.join(SOURCE_MANIFEST_PATH)).unwrap()).unwrap();
    manifest["build"]["budgetMilestone"] = json!("not-approved");
    write_source_manifest(&root, &manifest);
    assert!(load_fixture(&root).is_err());

    let (_temp, root, _) = fixture();
    let current_manifest = source_manifest(ResourceBudgetPolicy::DISABLED_COMMANDS);
    write_source_manifest(&root, &current_manifest);
    // The provenance still declares the legacy policy and must not override the manifest.
    assert!(load_fixture(&root).is_err());

    let (_temp, root, _) = fixture();
    let mut launch_policy_id_old_budget = source_manifest(ResourceBudgetPolicy::MAIN_HOTKEY);
    launch_policy_id_old_budget["build"]["budgetMilestone"] =
        json!(ResourceBudgetPolicy::LAUNCH_AT_LOGIN.milestone.unwrap());
    write_source_manifest(&root, &launch_policy_id_old_budget);
    assert!(load_fixture(&root).is_err());

    let (_temp, root, _) = fixture_with_policy(None, ResourceBudgetPolicy::LAUNCH_AT_LOGIN);
    let mut old_policy_id_new_budget: Value =
        serde_json::from_slice(&fs::read(root.join(SOURCE_MANIFEST_PATH)).unwrap()).unwrap();
    old_policy_id_new_budget["build"]["budgetMilestone"] =
        json!(ResourceBudgetPolicy::MAIN_HOTKEY.milestone.unwrap());
    write_source_manifest(&root, &old_policy_id_new_budget);
    assert!(load_fixture(&root).is_err());

    let (_temp, root, _) = fixture();
    let mut manifest = source_manifest(ResourceBudgetPolicy::DISABLED_COMMANDS);
    manifest["source"]["commit"] = json!("another-commit");
    write_source_manifest(&root, &manifest);
    assert!(load_fixture(&root).is_err());

    let (_temp, root, _) = fixture();
    let mut manifest = source_manifest(ResourceBudgetPolicy::LEGACY);
    manifest["build"]["emittedResourceBudget"]["baselineBytes"] = json!(779_464);
    manifest["build"]["emittedResourceBudget"]["maxIncreaseBytes"] = json!(4_096);
    write_source_manifest(&root, &manifest);
    assert!(load_fixture(&root).is_err());

    let (_temp, root, _) =
        fixture_with_policy(Some(778_122), ResourceBudgetPolicy::DISABLED_COMMANDS);
    let mut provenance: Value =
        serde_json::from_slice(&fs::read(root.join(PROVENANCE_PATH)).unwrap()).unwrap();
    provenance["source"]["commit"] = json!("another-commit");
    write_provenance(&root, &provenance);
    assert!(load_fixture(&root).is_err());
}

#[test]
fn rejects_missing_or_oversized_source_manifest() {
    let (_missing_temp, missing_root, _) = fixture();
    fs::remove_file(missing_root.join(SOURCE_MANIFEST_PATH)).unwrap();
    assert!(load_fixture(&missing_root).is_err());

    let (_oversized_temp, oversized_root, _) = fixture();
    fs::write(
        oversized_root.join(SOURCE_MANIFEST_PATH),
        vec![b' '; MAX_SOURCE_MANIFEST_BYTES + 1],
    )
    .unwrap();
    assert!(load_fixture(&oversized_root).is_err());
}

#[test]
fn rejects_duplicate_and_unsafe_resource_paths() {
    assert_rejected(|value| value["emittedResources"][1]["path"] = json!("index.html"));
    for invalid in [
        "/index.html",
        "../index.html",
        "assets/./app.js",
        "assets//app.js",
        "assets\\app.js",
        "assets/%2e/app.js",
        "assets/app.js?mode=1",
        "assets/app.js#part",
    ] {
        assert_rejected(|value| value["emittedResources"][0]["path"] = json!(invalid));
    }
}

#[test]
fn rejects_unlisted_runtime_files() {
    let (_temp, root, _) = fixture();
    fs::write(root.join("assets/extra.js"), b"extra runtime").unwrap();
    assert!(load_fixture(&root).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_symlink_roots_and_entries_without_exposing_paths() {
    use std::os::unix::fs::symlink;

    let (temp, root, _) = fixture();
    let alias = temp.path().join("bundle-link");
    symlink(&root, &alias).unwrap();
    let error = load_fixture(&alias).err().unwrap();
    assert!(!error.contains(alias.to_str().unwrap()));

    let outside = temp.path().join("outside.js");
    fs::write(&outside, b"outside").unwrap();
    symlink(outside, root.join("assets/extra.js")).unwrap();
    assert!(load_fixture(&root).is_err());
}
