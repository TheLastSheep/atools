use super::{
    active_observation_valid, compute_passed, expected_child, push_stage,
    released_observation_valid, snapshot_readiness_settled, unverified_snapshot,
    unverified_snapshot_with_readiness, valid_snapshot_readiness,
};
use serde_json::json;

fn observation(child: bool) -> serde_json::Value {
    let leases = u64::from(child);
    json!({
        "supported": true,
        "installed": true,
        "mainOwner": true,
        "settingsLeaseCount": leases,
        "totalOwners": 1 + leases,
        "cleanupPending": false,
        "effectCount": 1,
        "tag": 91_376_254,
        "material": 15,
        "blendingMode": 0,
        "state": 0,
        "effectiveAppearance": "dark"
    })
}

#[test]
fn active_material_requires_exact_original_effect_and_child_owner_count() {
    assert!(active_observation_valid(&observation(false), false));
    assert!(active_observation_valid(&observation(true), true));
    let mut wrong = observation(true);
    wrong["tag"] = json!(91_376_255);
    assert!(!active_observation_valid(&wrong, true));
    let mut wrong = observation(true);
    wrong["settingsLeaseCount"] = json!(0);
    assert!(!active_observation_valid(&wrong, true));
    let mut stale = observation(true);
    stale["requestedTheme"] = json!("dark");
    assert!(!active_observation_valid(&stale, true));
}

#[test]
fn final_observation_requires_zero_owners_and_cleared_effect_facts() {
    let released = json!({
        "supported": true,
        "installed": true,
        "mainOwner": false,
        "settingsLeaseCount": 0,
        "totalOwners": 0,
        "cleanupPending": false,
        "effectCount": 0,
        "tag": null,
        "material": null,
        "blendingMode": null,
        "state": null,
        "effectiveAppearance": "light"
    });
    assert!(released_observation_valid(&released));
    let mut leaking = released.clone();
    leaking["totalOwners"] = json!(1);
    assert!(!released_observation_valid(&leaking));
    let mut uncleared = released;
    uncleared["effectCount"] = json!(1);
    assert!(!released_observation_valid(&uncleared));
}

#[test]
fn expected_child_counts_match_the_existing_twelve_stage_lifecycle() {
    assert!(!expected_child("startup"));
    assert!(expected_child("openAllCommands"));
    assert!(expected_child("unpinSearch"));
    assert!(!expected_child("closeCleanup"));
    assert!(!expected_child("finalCleanup"));
}

#[test]
fn missing_or_unobserved_material_evidence_cannot_pass() {
    assert!(!compute_passed(&json!({
        "stages": [],
        "theme": { "passed": true },
        "cleanup": { "passed": true, "stopAcknowledged": true, "actual": null },
        "errors": []
    })));
}

#[test]
fn material_stage_keeps_the_observed_zero_elapsed_value() {
    let mut report = json!({"stages": [], "errors": []});
    push_stage(&mut report, "startup", 0, Some(observation(false)), None);
    assert_eq!(report["stages"][0]["elapsedMs"], 0);
    assert!(report["stages"][0]["childDrawsBackground"].is_null());
}

#[test]
fn active_child_requires_a_real_transparent_webview_observation() {
    let mut report = json!({"stages": [], "errors": []});
    push_stage(
        &mut report,
        "openAllCommands",
        10,
        Some(observation(true)),
        Some(false),
    );
    assert_eq!(report["stages"][0]["passed"], true);
    assert_eq!(report["stages"][0]["childDrawsBackground"], false);

    for actual in [Some(true), None] {
        let mut report = json!({"stages": [], "errors": []});
        push_stage(
            &mut report,
            "openAllCommands",
            10,
            Some(observation(true)),
            actual,
        );
        assert_eq!(report["stages"][0]["passed"], false);
        assert!(report["errors"]
            .as_array()
            .unwrap()
            .contains(&json!("settings-input-material-observation-invalid")));
    }

    let mut report = json!({"stages": [], "errors": []});
    push_stage(
        &mut report,
        "startup",
        10,
        Some(observation(false)),
        Some(false),
    );
    assert_eq!(report["stages"][0]["passed"], false);
}

#[test]
fn material_report_cannot_pass_if_an_active_child_background_is_missing() {
    let mut report = json!({
        "stages": [],
        "theme": { "passed": true },
        "cleanup": {
            "passed": true,
            "stopAcknowledged": true,
            "actual": {
                "supported": true,
                "installed": true,
                "mainOwner": false,
                "settingsLeaseCount": 0,
                "totalOwners": 0,
                "cleanupPending": false,
                "effectCount": 0,
                "tag": null,
                "material": null,
                "blendingMode": null,
                "state": null,
                "effectiveAppearance": "dark"
            }
        },
        "errors": []
    });
    for key in super::STAGE_KEYS {
        let child = expected_child(key);
        push_stage(
            &mut report,
            key,
            10,
            Some(observation(child)),
            if child { Some(false) } else { None },
        );
    }
    assert!(compute_passed(&report));
    report["stages"][1]["childDrawsBackground"] = serde_json::Value::Null;
    assert!(!compute_passed(&report));
}

#[test]
fn unsettled_snapshot_preserves_exact_readiness_without_claiming_capture() {
    let mut readiness = json!({
        "routeGeneral": true,
        "mediaMatches": true,
        "menusAbsent": false,
        "rootTextMatches": true,
        "sidebarTextMatches": true,
        "labelTextMatches": true,
        "framesObserved": true,
        "settled": false,
    });
    assert!(valid_snapshot_readiness(&readiness));
    assert!(!snapshot_readiness_settled(&readiness));
    let snapshot = unverified_snapshot_with_readiness(
        "settings-input-material-snapshot-unsettled",
        Some(readiness.clone()),
    );
    assert_eq!(snapshot["state"], "unverified");
    assert_eq!(snapshot["readiness"], readiness);
    let mut keys = snapshot
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect::<Vec<_>>();
    keys.sort_unstable();
    assert_eq!(
        keys,
        vec!["evidence", "filename", "readiness", "reason", "state"]
    );
    assert!(
        unverified_snapshot("settings-input-material-snapshot-not-attempted")["readiness"]
            .is_null()
    );
    readiness["settled"] = json!(true);
    assert!(!valid_snapshot_readiness(&readiness));
    readiness["extra"] = json!(false);
    assert!(!valid_snapshot_readiness(&readiness));
}
