use super::{activation, deactivation, Activation, Deactivation};

#[test]
fn primary_collision_is_not_treated_as_an_owned_paste_stack_registration() {
    assert!(activation(false, true, true).is_err());
}

#[test]
fn unrelated_manager_registration_is_not_treated_as_paste_stack_ownership() {
    assert!(activation(false, true, false).is_err());
    assert!(deactivation(false, true).is_err());
}

#[test]
fn paste_stack_ownership_requires_registration_and_survives_missing_readback() {
    assert!(matches!(
        activation(false, false, false),
        Ok(Activation::Register)
    ));
    assert!(matches!(
        activation(true, true, false),
        Ok(Activation::AlreadyOwned)
    ));
    assert!(activation(true, false, false).is_err());
    assert!(matches!(
        deactivation(true, true),
        Ok(Deactivation::Unregister)
    ));
    assert!(matches!(
        deactivation(false, false),
        Ok(Deactivation::AlreadyInactive)
    ));
    assert!(deactivation(true, false).is_err());
}
