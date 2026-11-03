use super::layout::{is_expected_panel_class, layout_is_safe};
use objc2::ClassType;

fn panel_layout(
    original_size: usize,
    panel_size: usize,
    ns_panel_size: usize,
    focusable_offset: usize,
    focusable_width: usize,
) -> bool {
    layout_is_safe(
        true,
        true,
        true,
        true,
        true,
        true,
        original_size,
        panel_size,
        ns_panel_size,
        focusable_offset,
        focusable_width,
    )
}

#[test]
fn accepts_panel_layout_before_tao_focusable_ivar() {
    assert!(panel_layout(512, 448, 448, 480, 1));
}

#[test]
fn rejects_panel_base_that_overlaps_focusable_ivar() {
    assert!(!panel_layout(512, 480, 488, 480, 1));
}

#[test]
fn rejects_target_that_grows_into_focusable_ivar() {
    assert!(!panel_layout(512, 481, 448, 480, 1));
}

#[test]
fn rejects_wrong_classes_or_missing_instance_getter_ownership() {
    assert!(!layout_is_safe(
        false, true, true, true, true, true, 512, 448, 448, 480, 1
    ));
    assert!(!layout_is_safe(
        true, false, true, true, true, true, 512, 448, 448, 480, 1
    ));
    assert!(!layout_is_safe(
        true, true, true, false, true, true, 512, 448, 448, 480, 1
    ));
    assert!(!layout_is_safe(
        true, true, true, true, false, true, 512, 448, 448, 480, 1
    ));
    assert!(!layout_is_safe(
        true, true, false, true, true, true, 512, 448, 448, 480, 1
    ));
}

#[test]
fn rejects_ns_panel_base_with_own_ivars() {
    assert!(!layout_is_safe(
        true, true, true, true, true, false, 512, 448, 448, 480, 1
    ));
}

#[test]
fn rejects_target_owned_ivars_and_offset_overflow() {
    assert!(!layout_is_safe(
        true, true, true, true, false, true, 512, 448, 448, 480, 1
    ));
    assert!(!panel_layout(512, 448, 448, usize::MAX, 1));
}

#[test]
fn pinned_panel_macro_runtime_class_name_matches_guard() {
    assert!(is_expected_panel_class(super::RawAToolsMainPanel::class()));
    assert!(!is_expected_panel_class(objc2_app_kit::NSPanel::class()));
}
