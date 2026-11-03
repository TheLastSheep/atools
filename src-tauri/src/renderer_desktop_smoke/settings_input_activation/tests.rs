use super::{snapshot, ActivationState};

#[test]
fn snapshot_keeps_unreadable_facts_unknown_and_has_exact_shape() {
    let state = ActivationState::default();
    let value = snapshot(&state, None, None);
    let object = value.as_object().expect("snapshot object");
    assert_eq!(object.len(), 8);
    assert_eq!(value["installed"], false);
    assert_eq!(value["registered"], 0);
    assert_eq!(value["removed"], 0);
    assert!(value["appActive"].is_null());
    assert!(value["frontmostIsSelf"].is_null());
    assert_eq!(value["known"], false);
}

#[test]
fn known_requires_both_native_facts_to_be_readable() {
    let state = ActivationState::default();
    assert_eq!(snapshot(&state, Some(false), None)["known"], false);
    assert_eq!(snapshot(&state, None, Some(false))["known"], false);
    assert_eq!(snapshot(&state, Some(false), Some(false))["known"], true);
}

#[test]
fn observer_counts_remain_available_after_uninstall() {
    let state = ActivationState::default();
    state.mark_installed();
    state.record_app_activation();
    state.record_main_key();
    state.mark_removed(2);

    let value = snapshot(&state, Some(false), Some(false));
    assert_eq!(value["installed"], false);
    assert_eq!(value["registered"], 2);
    assert_eq!(value["removed"], 2);
    assert_eq!(value["appActivationEvents"], 1);
    assert_eq!(value["mainKeyEvents"], 1);
}
