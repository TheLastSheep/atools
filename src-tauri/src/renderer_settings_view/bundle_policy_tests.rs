use super::*;
use serde_json::{json, Value};

fn manifest(policy: ResourceBudgetPolicy) -> Value {
    let mut value = json!({
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
        value["build"]["budgetMilestone"] = json!(milestone);
    }
    value
}

#[test]
fn selects_only_the_frozen_source_policies() {
    assert_eq!(
        select_source_policy(&manifest(ResourceBudgetPolicy::LEGACY)),
        Ok(ResourceBudgetPolicy::LEGACY)
    );
    assert_eq!(
        select_source_policy(&manifest(ResourceBudgetPolicy::DISABLED_COMMANDS)),
        Ok(ResourceBudgetPolicy::DISABLED_COMMANDS)
    );
    assert_eq!(
        select_source_policy(&manifest(ResourceBudgetPolicy::TRAY_VISIBILITY)),
        Ok(ResourceBudgetPolicy::TRAY_VISIBILITY)
    );
    assert_eq!(
        select_source_policy(&manifest(ResourceBudgetPolicy::MAIN_HOTKEY)),
        Ok(ResourceBudgetPolicy::MAIN_HOTKEY)
    );
    assert_eq!(
        select_source_policy(&manifest(ResourceBudgetPolicy::LAUNCH_AT_LOGIN)),
        Ok(ResourceBudgetPolicy::LAUNCH_AT_LOGIN)
    );
    assert_eq!(
        select_source_policy(&manifest(ResourceBudgetPolicy::ABOUT_UPDATE)),
        Ok(ResourceBudgetPolicy::ABOUT_UPDATE)
    );
    assert_eq!(
        select_source_policy(&manifest(ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS)),
        Ok(ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS)
    );
    assert_eq!(ResourceBudgetPolicy::LEGACY.max_total_bytes(), 779_885);
    assert_eq!(
        ResourceBudgetPolicy::DISABLED_COMMANDS.max_total_bytes(),
        783_560
    );
    assert_eq!(
        ResourceBudgetPolicy::TRAY_VISIBILITY.max_total_bytes(),
        784_380
    );
    assert_eq!(ResourceBudgetPolicy::MAIN_HOTKEY.max_total_bytes(), 786_363);
    assert_eq!(
        ResourceBudgetPolicy::LAUNCH_AT_LOGIN.max_total_bytes(),
        790_459
    );
    assert_eq!(
        ResourceBudgetPolicy::LAUNCH_AT_LOGIN.absolute_max_bytes,
        790_528
    );
    assert_eq!(
        ResourceBudgetPolicy::LAUNCH_AT_LOGIN.milestone,
        Some("original-vue-launch-at-login-2026-10-29")
    );
    for policy in [
        ResourceBudgetPolicy::LEGACY,
        ResourceBudgetPolicy::DISABLED_COMMANDS,
        ResourceBudgetPolicy::TRAY_VISIBILITY,
        ResourceBudgetPolicy::MAIN_HOTKEY,
    ] {
        assert_eq!(policy.absolute_max_bytes, 786_432);
    }
}

#[test]
fn settings_distribution_manifest_is_accepted_by_the_real_native_loader_policy() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../packages/ztools-settings/source-manifest.json");
    let actual: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let selected = select_source_policy(&actual).unwrap();
    assert_eq!(selected, ResourceBudgetPolicy::APP_GLOBAL_SHORTCUTS);
    assert_eq!(selected.max_total_bytes(), 822_755);
}

#[test]
fn local_launch_and_native_drop_policies_do_not_rebase_or_mix_historical_limits() {
    for policy in [
        ResourceBudgetPolicy::LOCAL_LAUNCH,
        ResourceBudgetPolicy::NATIVE_LOCAL_DROP,
        ResourceBudgetPolicy::BUILTIN_SHORTCUTS,
    ] {
        assert_eq!(select_source_policy(&manifest(policy)), Ok(policy));
        for field in ["baselineBytes", "maxIncreaseBytes", "maxBytes"] {
            let mut raised = manifest(policy);
            let original = raised["build"]["emittedResourceBudget"][field]
                .as_u64()
                .unwrap();
            raised["build"]["emittedResourceBudget"][field] = json!(original + 1);
            assert!(select_source_policy(&raised).is_err());
        }
        for old in [
            ResourceBudgetPolicy::LEGACY,
            ResourceBudgetPolicy::LAUNCH_AT_LOGIN,
        ] {
            let mut mixed = manifest(policy);
            if let Some(id) = old.milestone {
                mixed["build"]["budgetMilestone"] = json!(id);
            } else {
                mixed["build"]
                    .as_object_mut()
                    .unwrap()
                    .remove("budgetMilestone");
            }
            assert!(select_source_policy(&mixed).is_err());
        }
    }
    let mut new_id_old_values = manifest(ResourceBudgetPolicy::LOCAL_LAUNCH);
    new_id_old_values["build"]["budgetMilestone"] = json!(NATIVE_LOCAL_DROP_BUDGET_MILESTONE);
    assert!(select_source_policy(&new_id_old_values).is_err());
    let mut old_id_new_values = manifest(ResourceBudgetPolicy::NATIVE_LOCAL_DROP);
    old_id_new_values["build"]["budgetMilestone"] = json!(LOCAL_LAUNCH_BUDGET_MILESTONE);
    assert!(select_source_policy(&old_id_new_values).is_err());
    let mut mixed = manifest(ResourceBudgetPolicy::NATIVE_LOCAL_DROP);
    mixed["build"]["budgetMilestone"] = json!(BUILTIN_SHORTCUTS_BUDGET_MILESTONE);
    assert!(select_source_policy(&mixed).is_err());
    let mut inverse = manifest(ResourceBudgetPolicy::BUILTIN_SHORTCUTS);
    inverse["build"]["budgetMilestone"] = json!(NATIVE_LOCAL_DROP_BUDGET_MILESTONE);
    assert!(select_source_policy(&inverse).is_err());
}

#[test]
fn rejects_unknown_milestones_and_mixed_or_tampered_policy_values() {
    let mut unknown = manifest(ResourceBudgetPolicy::DISABLED_COMMANDS);
    unknown["build"]["budgetMilestone"] = json!("future");
    assert!(select_source_policy(&unknown).is_err());

    let mut explicit_null = manifest(ResourceBudgetPolicy::LEGACY);
    explicit_null["build"]["budgetMilestone"] = Value::Null;
    assert!(select_source_policy(&explicit_null).is_err());

    for old_policy in [
        ResourceBudgetPolicy::DISABLED_COMMANDS,
        ResourceBudgetPolicy::TRAY_VISIBILITY,
        ResourceBudgetPolicy::MAIN_HOTKEY,
    ] {
        let mut old_id_new_values = manifest(ResourceBudgetPolicy::LAUNCH_AT_LOGIN);
        old_id_new_values["build"]["budgetMilestone"] = json!(old_policy.milestone.unwrap());
        assert!(select_source_policy(&old_id_new_values).is_err());
    }
    for old_policy in [
        ResourceBudgetPolicy::LEGACY,
        ResourceBudgetPolicy::DISABLED_COMMANDS,
        ResourceBudgetPolicy::TRAY_VISIBILITY,
        ResourceBudgetPolicy::MAIN_HOTKEY,
    ] {
        let mut new_id_old_values = manifest(old_policy);
        new_id_old_values["build"]["budgetMilestone"] =
            json!(ResourceBudgetPolicy::LAUNCH_AT_LOGIN.milestone.unwrap());
        assert!(select_source_policy(&new_id_old_values).is_err());
    }

    let mut raised_absolute = manifest(ResourceBudgetPolicy::LAUNCH_AT_LOGIN);
    raised_absolute["build"]["emittedResourceBudget"]["maxBytes"] = json!(790_529);
    assert!(select_source_policy(&raised_absolute).is_err());

    let mut raised_increment = manifest(ResourceBudgetPolicy::LAUNCH_AT_LOGIN);
    raised_increment["build"]["emittedResourceBudget"]["maxIncreaseBytes"] = json!(6_145);
    assert!(select_source_policy(&raised_increment).is_err());

    let mut altered_metric = manifest(ResourceBudgetPolicy::DISABLED_COMMANDS);
    altered_metric["build"]["emittedResourceBudget"]["metric"] = json!("other");
    assert!(select_source_policy(&altered_metric).is_err());
}

#[test]
fn requires_the_pinned_source_commit_and_manifest_schema() {
    let mut wrong_commit = manifest(ResourceBudgetPolicy::DISABLED_COMMANDS);
    wrong_commit["source"]["commit"] = json!("another-commit");
    assert!(select_source_policy(&wrong_commit).is_err());

    let mut wrong_schema = manifest(ResourceBudgetPolicy::DISABLED_COMMANDS);
    wrong_schema["schemaVersion"] = json!(2);
    assert!(select_source_policy(&wrong_schema).is_err());
}

#[test]
fn hotkey_recording_budget_is_exact_and_cannot_change_prior_policies() {
    let policy = ResourceBudgetPolicy::HOTKEY_RECORDING;
    assert_eq!(select_source_policy(&manifest(policy)), Ok(policy));
    assert_eq!(policy.max_total_bytes(), 801_964);
    assert_eq!(policy.baseline_bytes, 798_892);
    assert_eq!(policy.max_increase_bytes, 3_072);
    assert_eq!(
        ResourceBudgetPolicy::BUILTIN_SHORTCUTS.max_total_bytes(),
        800_742
    );
    for field in ["baselineBytes", "maxIncreaseBytes", "maxBytes"] {
        let mut raised = manifest(policy);
        raised["build"]["emittedResourceBudget"][field] = json!(
            raised["build"]["emittedResourceBudget"][field]
                .as_u64()
                .unwrap()
                + 1
        );
        assert!(select_source_policy(&raised).is_err());
    }
    let mut mixed = manifest(policy);
    mixed["build"]["budgetMilestone"] = json!(BUILTIN_SHORTCUTS_BUDGET_MILESTONE);
    assert!(select_source_policy(&mixed).is_err());
    let mut unknown = manifest(policy);
    unknown["build"]["budgetMilestone"] = json!("hotkey-recording-unapproved");
    assert!(select_source_policy(&unknown).is_err());
}

#[test]
fn hotkey_recording_resource_ceiling_is_enforced_by_the_real_reader() {
    use super::super::tests::{fixture_with_policy, load_fixture};
    let cap = ResourceBudgetPolicy::HOTKEY_RECORDING.max_total_bytes();
    let (_accepted, accepted, _) =
        fixture_with_policy(Some(cap), ResourceBudgetPolicy::HOTKEY_RECORDING);
    assert!(load_fixture(&accepted).is_ok());
    let (_over, over, _) =
        fixture_with_policy(Some(cap + 1), ResourceBudgetPolicy::HOTKEY_RECORDING);
    assert!(load_fixture(&over).is_err());
}

#[test]
fn double_modifier_budget_is_frozen_and_rejects_a_raised_cap() {
    let policy = ResourceBudgetPolicy::DOUBLE_MODIFIER;
    assert_eq!(policy.max_total_bytes(), 802_953);
    assert_eq!(select_source_policy(&manifest(policy)), Ok(policy));
    let mut raised = manifest(policy);
    raised["build"]["emittedResourceBudget"]["maxBytes"] = json!(802954);
    assert!(select_source_policy(&raised).is_err());
}

#[test]
fn default_height_budget_is_exact_and_preserves_historical_policies() {
    let policy = ResourceBudgetPolicy::DEFAULT_HEIGHT;
    assert_eq!(select_source_policy(&manifest(policy)), Ok(policy));
    assert_eq!(policy.baseline_bytes, 802_653);
    assert_eq!(policy.max_increase_bytes, 1_536);
    assert_eq!(policy.max_total_bytes(), 804_189);
    assert_eq!(
        ResourceBudgetPolicy::DOUBLE_MODIFIER.max_total_bytes(),
        802_953
    );
    for field in ["baselineBytes", "maxIncreaseBytes", "maxBytes"] {
        let mut raised = manifest(policy);
        let old = raised["build"]["emittedResourceBudget"][field]
            .as_u64()
            .unwrap();
        raised["build"]["emittedResourceBudget"][field] = json!(old + 1);
        assert!(select_source_policy(&raised).is_err());
    }
    let mut mixed = manifest(policy);
    mixed["build"]["budgetMilestone"] = json!(DOUBLE_MODIFIER_BUDGET_MILESTONE);
    assert!(select_source_policy(&mixed).is_err());
    use super::super::tests::{fixture_with_policy, load_fixture};
    let (_ok, accepted, _) = fixture_with_policy(Some(policy.max_total_bytes()), policy);
    assert!(load_fixture(&accepted).is_ok());
    let (_bad, rejected, _) = fixture_with_policy(Some(policy.max_total_bytes() + 1), policy);
    assert!(load_fixture(&rejected).is_err());
}

#[test]
fn about_update_exact_policy_is_additive_and_cannot_borrow_another_milestone_budget() {
    let policy = ResourceBudgetPolicy::ABOUT_UPDATE;
    assert_eq!(select_source_policy(&manifest(policy)), Ok(policy));
    assert_eq!(policy.max_total_bytes(), 812_049);
    let mut forged = manifest(policy);
    forged["build"]["emittedResourceBudget"]["baselineBytes"] = json!(802_653);
    assert!(select_source_policy(&forged).is_err());
    forged = manifest(ResourceBudgetPolicy::DEFAULT_HEIGHT);
    forged["build"]["emittedResourceBudget"] =
        manifest(policy)["build"]["emittedResourceBudget"].clone();
    assert!(select_source_policy(&forged).is_err());
}
