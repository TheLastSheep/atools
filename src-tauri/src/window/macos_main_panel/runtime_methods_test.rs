use std::collections::BTreeMap;

use super::TextInputMethodSnapshot;

fn snapshot(entries: &[(usize, bool)]) -> TextInputMethodSnapshot {
    TextInputMethodSnapshot {
        class_methods: entries.iter().copied().collect::<BTreeMap<_, _>>(),
    }
}

#[test]
fn reports_new_window_level_method_without_exposing_runtime_identity() {
    let before = snapshot(&[(11, false), (12, true)]);
    let after = snapshot(&[(11, true), (12, true)]);
    assert_eq!(super::added_since(Some(&before), Some(&after)), Some(true));
}

#[test]
fn reports_known_unchanged_method_set_as_no_addition() {
    let before = snapshot(&[(11, false), (12, true)]);
    let after = snapshot(&[(11, false), (12, true)]);
    assert_eq!(super::added_since(Some(&before), Some(&after)), Some(false));
}

#[test]
fn preserves_unknown_when_candidate_set_or_method_state_changes_unexpectedly() {
    let before = snapshot(&[(11, false)]);
    let different_class = snapshot(&[(12, true)]);
    let method_disappeared = snapshot(&[(11, false)]);
    let had_method = snapshot(&[(11, true)]);

    assert_eq!(
        super::added_since(Some(&before), Some(&different_class)),
        None
    );
    assert_eq!(
        super::added_since(Some(&had_method), Some(&method_disappeared)),
        None
    );
    assert_eq!(super::added_since(Some(&before), None), None);
    assert_eq!(super::added_since(None, Some(&before)), None);
}
