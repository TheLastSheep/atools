use super::{
    tests::{fixture_with_policy, load_fixture},
    ResourceBudgetPolicy,
};

#[test]
fn builtin_shortcuts_milestone_accepts_only_its_exact_resource_ceiling() {
    let cap = ResourceBudgetPolicy::BUILTIN_SHORTCUTS.max_total_bytes();
    assert_eq!(cap, 800_742);
    let (_valid_temp, valid_root, _) =
        fixture_with_policy(Some(cap), ResourceBudgetPolicy::BUILTIN_SHORTCUTS);
    assert!(load_fixture(&valid_root).is_ok());
    let (_over_temp, over_root, _) =
        fixture_with_policy(Some(cap + 1), ResourceBudgetPolicy::BUILTIN_SHORTCUTS);
    assert!(load_fixture(&over_root).is_err());
    assert_eq!(
        ResourceBudgetPolicy::NATIVE_LOCAL_DROP.max_total_bytes(),
        798_151
    );
}
