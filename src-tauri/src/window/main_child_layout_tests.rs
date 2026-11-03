use super::{plan_layout, LayoutBounds, LayoutPlan, RegistrationState};
use tauri::PhysicalSize;

#[test]
fn fixed_header_is_rounded_to_physical_pixels_and_content_fills_bottom() {
    assert_eq!(
        plan_layout(PhysicalSize::new(1200, 1000), 2.0, 64),
        Ok(LayoutPlan::Visible(LayoutBounds {
            y: 128,
            width: 1200,
            height: 872,
        }))
    );
    assert_eq!(
        plan_layout(PhysicalSize::new(1200, 1000), 1.5, 65),
        Ok(LayoutPlan::Visible(LayoutBounds {
            y: 98,
            width: 1200,
            height: 902,
        }))
    );
}

#[test]
fn collapsed_parent_hides_and_real_one_pixel_remainder_is_preserved() {
    assert_eq!(
        plan_layout(PhysicalSize::new(1200, 128), 2.0, 64),
        Ok(LayoutPlan::Hidden)
    );
    assert_eq!(
        plan_layout(PhysicalSize::new(1200, 127), 2.0, 64),
        Ok(LayoutPlan::Hidden)
    );
    assert_eq!(
        plan_layout(PhysicalSize::new(1200, 129), 2.0, 64),
        Ok(LayoutPlan::Visible(LayoutBounds {
            y: 128,
            width: 1200,
            height: 1,
        }))
    );
    assert_eq!(
        plan_layout(PhysicalSize::new(0, 900), 2.0, 64),
        Ok(LayoutPlan::Hidden)
    );
}

#[test]
fn zero_header_and_invalid_scale_factors_are_rejected() {
    assert!(plan_layout(PhysicalSize::new(1200, 900), 2.0, 0).is_err());
    for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert!(plan_layout(PhysicalSize::new(1200, 900), scale, 64).is_err());
    }
}

#[test]
fn dropping_old_registration_cannot_clear_a_new_owner() {
    let mut state = RegistrationState::default();
    let old_id = state.reserve("old-child".into(), 64).unwrap();
    assert!(state.release(old_id));
    let new_id = state.reserve("new-child".into(), 64).unwrap();
    assert_ne!(old_id, new_id);
    assert!(!state.release(old_id));
    assert_eq!(state.active.as_ref().map(|active| active.id), Some(new_id));
}

#[cfg(feature = "ztools-multiwebview")]
#[test]
fn layout_hide_revokes_visibility_and_cancels_before_native_hide_even_on_error() {
    use super::{hide_layout, set_visible, MainChildLayoutRegistry};
    let registry = MainChildLayoutRegistry::default();
    let id = registry
        .state
        .lock()
        .unwrap()
        .reserve("settings".into(), 64)
        .unwrap();
    set_visible(&registry, id, true);
    let cancelled = std::cell::Cell::new(false);
    let result = hide_layout(
        &registry,
        id,
        || cancelled.set(true),
        || {
            assert!(cancelled.get());
            assert!(
                !registry
                    .state
                    .lock()
                    .unwrap()
                    .active
                    .as_ref()
                    .unwrap()
                    .visible
            );
            Err("native hide failed".into())
        },
    );
    assert!(result.is_err());
    set_visible(&registry, id, true);
    assert!(
        registry
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .visible
    );
    set_visible(&registry, id + 1, false);
    assert!(
        registry
            .state
            .lock()
            .unwrap()
            .active
            .as_ref()
            .unwrap()
            .visible
    );
}
