use super::*;

fn key(modifier: Modifier, side: Side) -> PhysicalModifier {
    PhysicalModifier { modifier, side }
}

fn edge(detector: &mut DoubleTapDetector, input: InputEdge, ms: u64) -> Option<Modifier> {
    detector.observe(input, Duration::from_millis(ms))
}

fn tap(d: &mut DoubleTapDetector, key: PhysicalModifier, down: u64, up: u64) -> Option<Modifier> {
    assert_eq!(edge(d, InputEdge::ModifierDown(key), down), None);
    edge(d, InputEdge::ModifierUp(key), up)
}

#[test]
fn all_modifiers_normalize_left_and_right_and_fire_on_second_release_only() {
    for modifier in [
        Modifier::Command,
        Modifier::Control,
        Modifier::Alt,
        Modifier::Shift,
    ] {
        let mut d = DoubleTapDetector::new();
        assert_eq!(tap(&mut d, key(modifier, Side::Left), 0, 10), None);
        assert_eq!(
            edge(
                &mut d,
                InputEdge::ModifierDown(key(modifier, Side::Right)),
                20
            ),
            None
        );
        assert_eq!(
            edge(
                &mut d,
                InputEdge::ModifierUp(key(modifier, Side::Right)),
                30
            ),
            Some(modifier)
        );
        assert_eq!(tap(&mut d, key(modifier, Side::Left), 40, 50), None);
        assert_eq!(
            tap(&mut d, key(modifier, Side::Right), 60, 70),
            Some(modifier)
        );
    }
}

#[test]
fn hold_300_ms_is_a_tap_and_301_ms_breaks_the_pair() {
    let k = key(Modifier::Alt, Side::Left);
    let mut d = DoubleTapDetector::new();
    assert_eq!(tap(&mut d, k, 0, 300), None);
    assert_eq!(tap(&mut d, k, 301, 601), Some(Modifier::Alt));
    assert_eq!(tap(&mut d, k, 602, 903), None);
    assert_eq!(tap(&mut d, k, 904, 905), None);
    assert_eq!(tap(&mut d, k, 906, 907), Some(Modifier::Alt));
}

#[test]
fn interval_is_between_releases_and_strictly_less_than_400_ms() {
    let k = key(Modifier::Control, Side::Left);
    for (gap, expected) in [(399, Some(Modifier::Control)), (400, None)] {
        let mut d = DoubleTapDetector::new();
        assert_eq!(tap(&mut d, k, 0, 10), None);
        assert_eq!(tap(&mut d, k, 10 + gap - 20, 10 + gap), expected);
    }
}

#[test]
fn duplicate_down_keeps_the_original_hold_and_does_not_break_valid_history() {
    let k = key(Modifier::Command, Side::Left);
    let mut d = DoubleTapDetector::new();
    tap(&mut d, k, 0, 10);
    edge(&mut d, InputEdge::ModifierDown(k), 20);
    edge(&mut d, InputEdge::ModifierDown(k), 21);
    assert_eq!(
        edge(&mut d, InputEdge::ModifierUp(k), 22),
        Some(Modifier::Command)
    );
    assert_eq!(tap(&mut d, k, 23, 24), None);
    assert_eq!(tap(&mut d, k, 25, 26), Some(Modifier::Command));
}

#[test]
fn missing_or_duplicate_up_invalidates_history() {
    let k = key(Modifier::Shift, Side::Left);
    let mut d = DoubleTapDetector::new();
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 0), None);
    assert_eq!(tap(&mut d, k, 1, 2), None);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 3), None);
    assert_eq!(tap(&mut d, k, 4, 5), None);
    d.reset();
    edge(&mut d, InputEdge::ModifierDown(k), 6);
    edge(&mut d, InputEdge::ModifierDown(k), 7);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 8), None);
    assert_eq!(tap(&mut d, k, 9, 10), Some(Modifier::Shift));
}

#[test]
fn other_key_between_or_during_taps_invalidates_history() {
    let k = key(Modifier::Alt, Side::Left);
    let mut d = DoubleTapDetector::new();
    tap(&mut d, k, 0, 10);
    edge(&mut d, InputEdge::OtherKeyDown, 11);
    edge(&mut d, InputEdge::OtherKeyUp, 11);
    assert_eq!(tap(&mut d, k, 12, 13), None);
    edge(&mut d, InputEdge::ModifierDown(k), 14);
    edge(&mut d, InputEdge::OtherKeyDown, 15);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 16), None);
    assert_eq!(tap(&mut d, k, 17, 18), None);
    assert_eq!(tap(&mut d, k, 19, 20), Some(Modifier::Alt));
}

#[test]
fn a_different_modifier_starts_a_new_pair() {
    let a = key(Modifier::Alt, Side::Left);
    let c = key(Modifier::Control, Side::Left);
    let mut d = DoubleTapDetector::new();
    assert_eq!(tap(&mut d, a, 0, 10), None);
    assert_eq!(tap(&mut d, c, 11, 12), None);
    assert_eq!(tap(&mut d, c, 13, 14), Some(Modifier::Control));
}

#[test]
fn fully_observed_overlapping_sides_form_a_pair_but_different_modifiers_do_not() {
    let a = key(Modifier::Alt, Side::Left);
    for b in [
        key(Modifier::Alt, Side::Right),
        key(Modifier::Shift, Side::Right),
    ] {
        let mut d = DoubleTapDetector::new();
        edge(&mut d, InputEdge::ModifierDown(a), 11);
        edge(&mut d, InputEdge::ModifierDown(b), 12);
        assert_eq!(edge(&mut d, InputEdge::ModifierUp(a), 13), None);
        assert_eq!(
            edge(&mut d, InputEdge::ModifierUp(b), 14),
            if a.modifier == b.modifier {
                Some(Modifier::Alt)
            } else {
                None
            }
        );
        assert_eq!(tap(&mut d, a, 15, 16), None);
    }
}

#[test]
fn wrong_side_release_does_not_complete_a_tap() {
    let l = key(Modifier::Command, Side::Left);
    let r = key(Modifier::Command, Side::Right);
    let mut d = DoubleTapDetector::new();
    edge(&mut d, InputEdge::ModifierDown(l), 0);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(r), 1), None);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(l), 2), None);
    assert_eq!(tap(&mut d, l, 3, 4), None);
}

#[test]
fn reset_clears_partial_down_and_previous_tap_before_owner_reuse() {
    let k = key(Modifier::Control, Side::Right);
    let mut d = DoubleTapDetector::new();
    tap(&mut d, k, 0, 10);
    edge(&mut d, InputEdge::ModifierDown(k), 11);
    edge(&mut d, InputEdge::Reset, 12);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 13), None);
    assert_eq!(tap(&mut d, k, 14, 15), None);
    d.reset(); // Stop/restart may also establish a new monotonic epoch.
    assert_eq!(tap(&mut d, k, 0, 1), None);
    assert_eq!(tap(&mut d, k, 2, 3), Some(Modifier::Control));
}

#[test]
fn time_rollback_discards_the_edge_and_requires_two_new_complete_taps() {
    let k = key(Modifier::Alt, Side::Left);
    let mut d = DoubleTapDetector::new();
    tap(&mut d, k, 100, 110);
    edge(&mut d, InputEdge::ModifierDown(k), 90);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 91), None);
    assert_eq!(tap(&mut d, k, 92, 93), None);
    assert_eq!(tap(&mut d, k, 94, 95), Some(Modifier::Alt));
}

#[test]
fn pinned_upstream_shared_clock_allows_long_second_side_after_first_release() {
    let l = key(Modifier::Command, Side::Left);
    let r = key(Modifier::Command, Side::Right);
    let mut d = DoubleTapDetector::new();
    edge(&mut d, InputEdge::ModifierDown(l), 1000);
    edge(&mut d, InputEdge::ModifierDown(r), 1001);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(l), 1010), None);
    // Upstream clears its one shared clock on the first release. The second
    // physical hold is 399ms, but the release gap is 390ms: preserve this boundary.
    assert_eq!(
        edge(&mut d, InputEdge::ModifierUp(r), 1400),
        Some(Modifier::Command)
    );
}

#[test]
fn pinned_upstream_nonmodifier_up_clears_shared_clock_without_cancelling_observed_down() {
    let k = key(Modifier::Command, Side::Left);
    let mut d = DoubleTapDetector::new();
    edge(&mut d, InputEdge::OtherKeyDown, 1000);
    edge(&mut d, InputEdge::ModifierDown(k), 1010);
    edge(&mut d, InputEdge::OtherKeyUp, 1020);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 1350), None);
    assert_eq!(tap(&mut d, k, 1360, 1370), Some(Modifier::Command));
}

#[test]
fn repeated_down_does_not_shorten_a_long_hold_into_a_tap() {
    let k = key(Modifier::Command, Side::Left);
    let mut d = DoubleTapDetector::new();
    tap(&mut d, k, 1000, 1010);
    edge(&mut d, InputEdge::ModifierDown(k), 1020);
    edge(&mut d, InputEdge::ModifierDown(k), 1300);
    assert_eq!(edge(&mut d, InputEdge::ModifierUp(k), 1321), None);
    assert_eq!(tap(&mut d, k, 1330, 1340), None);
}
