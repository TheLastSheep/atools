use super::*;
use crate::hotkey::double_tap::Modifier;
#[derive(Default)]
struct Port {
    owned: Vec<MainBinding>,
    inactive: Vec<MainBinding>,
    fail_release: Option<MainBinding>,
    denial: Option<String>,
    dead: Vec<MainBinding>,
    release_steps: Vec<&'static str>,
}
impl ShortcutPort for Port {
    fn is_registered(&self, b: MainBinding) -> Result<bool, String> {
        Ok(self.owned.contains(&b))
    }
    fn is_healthy(&self, b: MainBinding) -> Result<bool, String> {
        Ok(self.owned.contains(&b) && !self.inactive.contains(&b))
    }
    fn recover(&mut self, b: MainBinding) -> Result<(), String> {
        if self.dead.contains(&b) {
            return Err(RECOVERY_FAILED.into());
        }
        self.inactive.retain(|key| *key != b);
        Ok(())
    }
    fn suspend(&mut self, b: MainBinding) -> Result<(), String> {
        if self.dead.contains(&b) {
            return Err(RECOVERY_FAILED.into());
        }
        if !self.inactive.contains(&b) {
            self.inactive.push(b);
        }
        Ok(())
    }
    fn register(&mut self, b: MainBinding) -> Result<(), RegisterFailure> {
        if let Some(code) = self.denial.take() {
            return Err(RegisterFailure::RejectedCode(code));
        }
        self.owned.push(b);
        Ok(())
    }
    fn unregister(&mut self, b: MainBinding) -> Result<(), String> {
        if self.fail_release == Some(b) {
            self.release_steps
                .extend(["disable", "invalidate", "remove-source-failed"]);
            self.inactive.push(b);
            self.dead.push(b);
            return Err("retained owned lease".into());
        }
        self.dead.retain(|key| *key != b);
        self.owned.retain(|key| *key != b);
        self.inactive.retain(|key| *key != b);
        Ok(())
    }
}
#[test]
fn ordinary_double_switch_rollback_and_exact_recording_borrow_share_one_owner() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = Port::default();
    registry.setup(&mut port, "Option+Space").unwrap();
    let before = registry.read_state(&port).unwrap();
    let option = parse_main_binding("Option+Space").unwrap();
    assert!(registry.uses(&port, option).unwrap());
    registry.set(&mut port, "Command+Command").unwrap();
    assert!(!registry.uses(&port, option).unwrap());
    assert_eq!(port.owned, [MainBinding::DoubleTap(Modifier::Command)]);
    registry.restore_state(&mut port, &before).unwrap();
    assert!(registry.uses(&port, option).unwrap());
    registry.release(&mut port).unwrap();
    assert!(port.owned.is_empty());
    assert!(registry.dispatch_owner().is_none());
}
#[test]
fn inactive_owned_listener_can_retry_same_binding_or_switch_back_to_accelerator() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = Port::default();
    let double = MainBinding::DoubleTap(Modifier::Alt);
    registry.setup(&mut port, "Option+Option").unwrap();
    port.inactive.push(double);
    let state = registry.read_state(&port).unwrap();
    assert_eq!(state.label(), Some("Option+Option"));
    assert_eq!(state.active_label(), None);
    registry.apply_state(&mut port, "Option+Option").unwrap();
    assert!(registry.read_state(&port).unwrap().healthy());
    port.inactive.push(double);
    registry.apply_state(&mut port, "Option+Space").unwrap();
    assert_eq!(port.owned, [parse_main_binding("Option+Space").unwrap()]);
}
#[test]
fn failed_old_listener_cleanup_preserves_identity_and_can_retry() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = Port::default();
    let double = MainBinding::DoubleTap(Modifier::Command);
    registry.setup(&mut port, "Command+Command").unwrap();
    port.fail_release = Some(double);
    assert!(registry.set(&mut port, "Option+Space").is_err());
    assert_eq!(port.owned, [double]);
    assert!(registry.read_state(&port).is_err());
    port.fail_release = None;
    registry.release(&mut port).unwrap();
    registry.setup(&mut port, "Option+Space").unwrap();
    assert!(!port.owned.contains(&double));
}
#[test]
fn permission_or_platform_preflight_rejection_keeps_existing_owned_key() {
    for code in [
        "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED",
        "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED",
    ] {
        let mut registry = OwnedMainHotkeyRegistry::default();
        let mut port = Port::default();
        registry.setup(&mut port, "Alt+Z").unwrap();
        port.denial = Some(code.into());
        assert_eq!(registry.set(&mut port, "Command+Command"), Err(code.into()));
        assert_eq!(
            registry.read_state(&port).unwrap().active_label(),
            Some("Alt+Z")
        );
        assert_eq!(port.owned.len(), 1);
    }
}

#[test]
fn r73_partial_release_of_healthy_tap_must_not_report_known_no_change() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = Port::default();
    let double = MainBinding::DoubleTap(Modifier::Command);
    registry.setup(&mut port, "Command+Command").unwrap();
    port.fail_release = Some(double);
    let error = registry.set(&mut port, "Option+Space").unwrap_err();
    assert_eq!(
        port.release_steps,
        ["disable", "invalidate", "remove-source-failed"]
    );
    assert_eq!(error, RECOVERY_FAILED);
    assert!(port.owned.contains(&double));
    assert!(registry.dispatch_owner().is_none());
}
#[test]
fn r73_previous_cas_can_repair_inactive_owned_main_but_wrong_previous_is_unchanged() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = Port::default();
    let double = MainBinding::DoubleTap(Modifier::Alt);
    registry.setup(&mut port, "Option+Option").unwrap();
    port.inactive.push(double);
    assert!(registry
        .set_from(
            &mut port,
            parse_main_binding("Alt+Z").unwrap(),
            "Option+Space"
        )
        .is_err());
    assert_eq!(port.owned, [double]);
    registry
        .set_from(&mut port, double, "Option+Space")
        .unwrap();
    assert_eq!(port.owned, [parse_main_binding("Option+Space").unwrap()]);
}

#[test]
fn r73_inactive_checkpoint_restore_retains_inactive_owned_state_without_false_dispatch() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = Port::default();
    let double = MainBinding::DoubleTap(Modifier::Alt);
    registry.setup(&mut port, "Option+Option").unwrap();
    port.inactive.push(double);
    let before = registry.read_state(&port).unwrap();
    registry.set(&mut port, "Option+Space").unwrap();
    registry.restore_state(&mut port, &before).unwrap();
    let after = registry.read_state(&port).unwrap();
    assert_eq!(after.label(), Some("Option+Option"));
    assert!(!after.healthy());
    assert!(registry.dispatch_owner().is_none());
    assert_eq!(port.owned, [double]);
    registry
        .set_from(&mut port, double, "Option+Option")
        .unwrap();
    assert!(registry.read_state(&port).unwrap().healthy());
}
