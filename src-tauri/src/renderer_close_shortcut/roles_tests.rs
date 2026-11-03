use super::*;
struct Slots {
    main: bool,
    items: [Role; 2],
    unknown: bool,
    fail_once: Option<usize>,
    fail_always: bool,
    wrong_readback: bool,
    owned_instances: [usize; 2],
    observed_instances: [usize; 2],
    writes: usize,
}
impl Slots {
    fn new() -> Self {
        Self {
            main: true,
            items: [Role::Enabled; 2],
            unknown: false,
            fail_once: None,
            fail_always: false,
            wrong_readback: false,
            owned_instances: [10, 11],
            observed_instances: [10, 11],
            writes: 0,
        }
    }
}
impl Port for Slots {
    fn focused_main(&mut self) -> bool {
        self.main
    }
    fn select(&mut self, index: usize, role: Role) -> Result<Role, String> {
        if !super::super::instance_identity::accepts(
            Some(self.owned_instances[index]),
            self.observed_instances[index],
            false,
        ) {
            return Err(policy::RECOVERY.into());
        }
        if self.unknown {
            return Err(policy::RECOVERY.into());
        }
        if role == Role::Disabled && (self.fail_always || self.fail_once == Some(index)) {
            self.fail_once = None;
            return Err("injected native role insertion failure".into());
        }
        if self.fail_always {
            return Err("injected unconfirmed recovery".into());
        }
        if self.items[index] != role {
            self.writes += 1;
            self.observed_instances[index] += 100;
            self.owned_instances[index] = self.observed_instances[index];
        }
        self.items[index] = role;
        if self.wrong_readback && role == Role::Disabled {
            Ok(Role::Enabled)
        } else {
            Ok(self.items[index])
        }
    }
}
fn state(enabled: bool) -> Projection {
    Projection {
        snapshot: Snapshot {
            enabled,
            generation: 1,
        },
        known: true,
    }
}
#[test]
fn committed_false_cold_start_and_other_window_roundtrip_leave_no_native_close_fallback() {
    let mut port = Slots::new();
    port.items = [Role::Native; 2];
    let mut state = state(false);
    refresh(&mut port, &mut state).unwrap();
    assert_eq!(port.items, [Role::Disabled; 2]);
    port.main = false;
    refresh(&mut port, &mut state).unwrap();
    assert_eq!(port.items, [Role::Native; 2]);
    port.main = true;
    refresh(&mut port, &mut state).unwrap();
    assert_eq!(port.items, [Role::Disabled; 2]);
    assert!(!state.snapshot.enabled);
}
#[test]
fn second_slot_failure_compensates_first_and_never_reports_false_success() {
    let mut port = Slots::new();
    let mut state = state(true);
    port.fail_once = Some(1);
    assert_eq!(
        apply(&mut port, &mut state, false),
        Err(policy::REJECTED.into())
    );
    assert_eq!(port.items, [Role::Enabled; 2]);
    assert!(state.known);
    assert_eq!(state.snapshot.generation, 1);
}
#[test]
fn unknown_root_or_slot_is_not_overwritten_and_unknown_recovery_is_not_rejection() {
    let mut port = Slots::new();
    let mut state = state(true);
    port.unknown = true;
    assert_eq!(
        apply(&mut port, &mut state, false),
        Err(policy::RECOVERY.into())
    );
    assert_eq!(port.items, [Role::Enabled; 2]);
    assert!(!state.known);
}
#[test]
fn stale_restore_cannot_replace_a_new_policy() {
    let mut port = Slots::new();
    let mut state = state(true);
    let before = state.snapshot;
    let applied = apply(&mut port, &mut state, false).unwrap();
    apply(&mut port, &mut state, true).unwrap();
    assert_eq!(
        restore(&mut port, &mut state, before, applied),
        Err(policy::RECOVERY.into())
    );
    assert_eq!(port.items, [Role::Enabled; 2]);
}
#[test]
fn stale_native_w_from_none_setter_is_rejected_by_actual_readback_contract() {
    assert!(!matches_readback(
        Role::Disabled,
        Action::Custom,
        "w",
        Modifiers::Command
    ));
    assert!(!matches_readback(
        Role::Disabled,
        Action::Native,
        "",
        Modifiers::Empty
    ));
    assert!(matches_readback(
        Role::Disabled,
        Action::Custom,
        "",
        Modifiers::Empty
    ));
    let mut port = Slots::new();
    let mut state = state(true);
    port.wrong_readback = true;
    assert_eq!(
        apply(&mut port, &mut state, false),
        Err(policy::REJECTED.into())
    );
    assert_eq!(port.items, [Role::Enabled; 2]);
}

#[test]
fn same_id_same_action_key_and_modifiers_with_a_new_instance_is_never_removed() {
    let mut port = Slots::new();
    let mut state = state(true);
    port.observed_instances[0] = 77; // Everything except the retained native object identity is unchanged.
    assert!(matches_readback(
        Role::Enabled,
        Action::Custom,
        "w",
        Modifiers::Command
    ));
    assert_eq!(
        apply(&mut port, &mut state, false),
        Err(policy::RECOVERY.into())
    );
    assert_eq!(port.items, [Role::Enabled; 2]);
    assert_eq!(port.writes, 0);
    assert!(state.snapshot.enabled);
}
