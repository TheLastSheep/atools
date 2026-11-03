use super::*;

#[test]
fn owned_settings_keeps_requested_child_height_when_parent_is_clipped_and_dpi_changes() {
    for scale in [1.0, 1.5, 2.0] {
        let size = PhysicalSize::new(1000, 600);
        let LayoutPlan::Visible(bounds) = plan_owned_layout(size, scale, 58, Some(2001.5)).unwrap()
        else {
            panic!()
        };
        let expected = if cfg!(target_os = "macos") {
            (((2001.5 * scale).round() / scale).round() * scale).round()
        } else {
            (2001.5 * scale).round()
        };
        assert_eq!(bounds.height, expected as u32);
        assert_eq!(bounds.y, (58.0 * scale).round() as u32);
        assert_eq!(
            plan_owned_layout(size, scale, 58, None),
            plan_layout(size, scale, 58)
        );
    }
    assert!(plan_owned_layout(
        PhysicalSize::new(1000, 600),
        2.0,
        58,
        Some(f64::from(i32::MAX))
    )
    .is_err());
}

#[test]
fn registration_publishes_requested_policy_atomically_and_old_release_cannot_remove_new_owner() {
    let mut registry = RegistrationState::default();
    let old = registry
        .reserve_requested("old".into(), 58, Some(2001.5))
        .unwrap();
    assert_eq!(
        registry.active.as_ref().unwrap().requested_content,
        Some(2001.5)
    );
    assert!(registry.release(old));
    let new = registry
        .reserve_requested("new".into(), 58, Some(200.5))
        .unwrap();
    assert!(!registry.release(old));
    assert_eq!(registry.active.as_ref().unwrap().id, new);
    assert_eq!(
        registry.active.as_ref().unwrap().requested_content,
        Some(200.5)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn creation_reflow_and_real_parent_request_share_the_projection_without_mutating_registration_intent(
) {
    let size = PhysicalSize::new(1600, 518);
    let (_, created) = super::super::content_height::create_settings_child(
        size,
        2.0,
        58,
        200.5,
        |position, size| Ok((position, size)),
    )
    .unwrap();
    let LayoutPlan::Visible(reflow) = plan_owned_layout(size, 2.0, 58, Some(200.5)).unwrap() else {
        panic!()
    };
    assert_eq!(created.height, 402);
    assert_eq!(reflow.height, 402);
    assert_eq!(
        super::super::HeightRequest::SettingsContent(200.5)
            .resolve(2.0)
            .unwrap(),
        259.0
    );
    assert_eq!(
        super::super::HeightRequest::Total(258.5)
            .resolve(2.0)
            .unwrap(),
        258.5
    );
    let mut registry = RegistrationState::default();
    registry
        .reserve_requested("owned".into(), 58, Some(200.5))
        .unwrap();
    assert_eq!(registry.active.unwrap().requested_content, Some(200.5));
    assert_eq!(
        plan_owned_layout(size, 2.0, 58, None),
        plan_layout(size, 2.0, 58)
    );
}
