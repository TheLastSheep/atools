use crate::hotkey::main_binding::{MainBinding, parse_main_binding};
use std::{cell::Cell, collections::HashSet, str::FromStr};

use tauri_plugin_global_shortcut::Shortcut;

use super::super::{OwnedMainHotkeyRegistry, RegisterFailure, ShortcutPort};
use super::OwnedMainHotkeyStateSnapshot;

#[derive(Default)]
struct FakePort {
    registered: HashSet<u32>,
    rejected: HashSet<u32>,
    unavailable: HashSet<u32>,
    partial_owned: HashSet<u32>,
    unregister_failure_once: HashSet<u32>,
    is_registered_calls: Cell<usize>,
    operations: Vec<(&'static str, u32)>,
}

fn shortcut(label: &str) -> MainBinding {
    parse_main_binding(label).expect("test shortcut must parse")
}

impl ShortcutPort for FakePort {
    fn is_registered(&self, shortcut: MainBinding) -> Result<bool, String> {
        self.is_registered_calls
            .set(self.is_registered_calls.get() + 1);
        Ok(self.registered.contains(&shortcut.id()))
    }

    fn register(&mut self, shortcut: MainBinding) -> Result<(), RegisterFailure> {
        self.operations.push(("register", shortcut.id()));
        if self.rejected.contains(&shortcut.id()) {
            return Err(RegisterFailure::Rejected);
        }
        self.registered.insert(shortcut.id());
        if self.partial_owned.contains(&shortcut.id()) {
            return Err(RegisterFailure::PartialOwned);
        }
        if self.unavailable.contains(&shortcut.id()) {
            return Err(RegisterFailure::Unavailable("ambiguous result".into()));
        }
        Ok(())
    }

    fn unregister(&mut self, shortcut: MainBinding) -> Result<(), String> {
        self.operations.push(("unregister", shortcut.id()));
        if self.unregister_failure_once.remove(&shortcut.id()) {
            return Err("injected one-time unregister failure".into());
        }
        self.registered.remove(&shortcut.id());
        Ok(())
    }
}

#[test]
fn unregistered_snapshot_distinguishes_unattempted_from_startup_recovery() {
    fn assert_send<T: Send>() {}
    assert_send::<OwnedMainHotkeyStateSnapshot>();

    let registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    let before = registry.read_state(&port).unwrap();
    assert_eq!(before.label(), None);
    assert!(!before.startup_attempted());

    let mut registry = registry;
    registry.mark_startup_attempted().unwrap();
    let after = registry.read_state(&port).unwrap();
    assert_eq!(after.label(), None);
    assert!(after.startup_attempted());
}

#[test]
fn apply_from_no_owner_registers_and_same_value_keeps_the_checkpoint_current() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    let before = registry.read_state(&port).unwrap();

    registry.apply_state(&mut port, "Alt+Z").unwrap();
    let registered = registry.read_state(&port).unwrap();
    assert_eq!(registered.label(), Some("Alt+Z"));
    registry.apply_state(&mut port, "Alt+Z").unwrap();
    assert_eq!(
        registry.read_state(&port).unwrap().generation,
        registered.generation
    );
    assert!(before.generation.checked_add(1) == Some(registered.generation));
}

#[test]
fn rollback_from_no_owner_releases_only_the_owned_candidate_and_preserves_foreign_keys() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    let foreign = shortcut("Command+Shift+F12");
    port.registered.insert(foreign.id());
    let checkpoint = registry.read_state(&port).unwrap();

    registry
        .apply_state(&mut port, "Command+Shift+F10")
        .unwrap();
    registry.restore_state(&mut port, &checkpoint).unwrap();

    let restored = registry.read_state(&port).unwrap();
    assert_eq!(restored.label(), None);
    assert!(port.registered.contains(&foreign.id()));
    assert!(!port
        .registered
        .contains(&shortcut("Command+Shift+F10").id()));
    assert!(!port
        .operations
        .iter()
        .any(|(op, id)| *op == "unregister" && *id == foreign.id()));
}

#[test]
fn registered_checkpoint_restores_the_owned_shortcut_after_one_change() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    registry
        .apply_state(&mut port, "Command+Shift+F10")
        .unwrap();
    let checkpoint = registry.read_state(&port).unwrap();

    registry
        .apply_state(&mut port, "Command+Shift+F11")
        .unwrap();
    registry.restore_state(&mut port, &checkpoint).unwrap();

    assert_eq!(
        registry.read_state(&port).unwrap().label(),
        Some("Command+Shift+F10")
    );
    assert!(port
        .registered
        .contains(&shortcut("Command+Shift+F10").id()));
    assert!(!port
        .registered
        .contains(&shortcut("Command+Shift+F11").id()));
}

#[test]
fn restore_unregistered_checkpoint_cleans_known_partial_candidate_and_preserves_foreign() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    let foreign = shortcut("Command+Shift+F12");
    port.registered.insert(foreign.id());
    let checkpoint = registry.read_state(&port).unwrap();
    let candidate = shortcut("Command+Shift+F10");
    port.partial_owned.insert(candidate.id());
    port.unregister_failure_once.insert(candidate.id());

    assert_eq!(
        registry
            .apply_state(&mut port, "Command+Shift+F10")
            .unwrap_err(),
        super::super::RECOVERY_FAILED
    );
    assert!(port.registered.contains(&candidate.id()));

    registry.restore_state(&mut port, &checkpoint).unwrap();

    assert_eq!(registry.read_state(&port).unwrap().label(), None);
    assert!(!port.registered.contains(&candidate.id()));
    assert!(port.registered.contains(&foreign.id()));
    assert!(!port
        .operations
        .iter()
        .any(|(operation, id)| *operation == "unregister" && *id == foreign.id()));
}

#[test]
fn restore_registered_checkpoint_cleans_known_partial_candidate_and_keeps_owner() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    registry
        .apply_state(&mut port, "Command+Shift+F11")
        .unwrap();
    let checkpoint = registry.read_state(&port).unwrap();
    let foreign = shortcut("Command+Shift+F12");
    port.registered.insert(foreign.id());
    let candidate = shortcut("Command+Shift+F10");
    port.partial_owned.insert(candidate.id());
    port.unregister_failure_once.insert(candidate.id());

    assert_eq!(
        registry
            .apply_state(&mut port, "Command+Shift+F10")
            .unwrap_err(),
        super::super::RECOVERY_FAILED
    );
    assert!(port.registered.contains(&candidate.id()));

    registry.restore_state(&mut port, &checkpoint).unwrap();

    assert_eq!(
        registry.read_state(&port).unwrap().label(),
        Some("Command+Shift+F11")
    );
    assert!(port
        .registered
        .contains(&shortcut("Command+Shift+F11").id()));
    assert!(!port.registered.contains(&candidate.id()));
    assert!(port.registered.contains(&foreign.id()));
    assert!(!port
        .operations
        .iter()
        .any(|(operation, id)| *operation == "unregister" && *id == foreign.id()));
}

#[test]
fn unavailable_registration_fences_reads_mutations_and_checkpoint_restore() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    let checkpoint = registry.read_state(&port).unwrap();
    let candidate = shortcut("Command+Shift+F10");
    port.unavailable.insert(candidate.id());

    assert_eq!(
        registry
            .apply_state(&mut port, "Command+Shift+F10")
            .unwrap_err(),
        super::super::HOTKEY_OUTCOME_UNKNOWN
    );
    assert!(port.registered.contains(&candidate.id()));
    let operations = port.operations.clone();
    let registration_checks = port.is_registered_calls.get();

    assert_eq!(
        registry.read_state(&port).err().as_deref(),
        Some(super::super::HOTKEY_OUTCOME_UNKNOWN)
    );
    assert_eq!(
        registry
            .apply_state(&mut port, "not-a-shortcut")
            .unwrap_err(),
        super::super::HOTKEY_OUTCOME_UNKNOWN
    );
    assert_eq!(
        registry.setup(&mut port, "not-a-shortcut").unwrap_err(),
        super::super::HOTKEY_OUTCOME_UNKNOWN
    );
    assert_eq!(
        registry.restore_state(&mut port, &checkpoint).unwrap_err(),
        super::super::HOTKEY_OUTCOME_UNKNOWN
    );
    assert_eq!(
        registry.mark_startup_attempted().unwrap_err(),
        super::super::HOTKEY_OUTCOME_UNKNOWN
    );
    assert_eq!(
        registry.release(&mut port).unwrap_err(),
        super::super::HOTKEY_OUTCOME_UNKNOWN
    );

    assert_eq!(port.operations, operations);
    assert_eq!(port.is_registered_calls.get(), registration_checks);
    assert!(port.registered.contains(&candidate.id()));
    assert!(!port
        .operations
        .iter()
        .any(|(operation, _)| *operation == "unregister"));
}

#[test]
fn stale_cross_registry_and_foreign_snapshots_fail_without_unregistering_foreign_keys() {
    let mut registry = OwnedMainHotkeyRegistry::default();
    let mut port = FakePort::default();
    let checkpoint = registry.read_state(&port).unwrap();
    registry
        .apply_state(&mut port, "Command+Shift+F10")
        .unwrap();
    registry
        .apply_state(&mut port, "Command+Shift+F11")
        .unwrap();
    assert_eq!(
        registry.restore_state(&mut port, &checkpoint).unwrap_err(),
        super::super::RECOVERY_FAILED
    );
    assert!(port
        .registered
        .contains(&shortcut("Command+Shift+F11").id()));

    let other_registry = OwnedMainHotkeyRegistry::default();
    let foreign_checkpoint = other_registry.read_state(&FakePort::default()).unwrap();
    assert_eq!(
        registry
            .restore_state(&mut port, &foreign_checkpoint)
            .unwrap_err(),
        super::super::RECOVERY_FAILED
    );

    let mut foreign_registry = OwnedMainHotkeyRegistry::default();
    let mut foreign_port = FakePort::default();
    let foreign = shortcut("Command+Shift+F12");
    foreign_port.registered.insert(foreign.id());
    foreign_port.rejected.insert(foreign.id());
    assert_eq!(
        foreign_registry
            .apply_state(&mut foreign_port, "Command+Shift+F12")
            .unwrap_err(),
        super::super::HOTKEY_REJECTED
    );
    assert_eq!(
        foreign_registry.read_state(&foreign_port).unwrap().label(),
        None
    );
    assert!(foreign_port.registered.contains(&foreign.id()));
    assert!(!foreign_port
        .operations
        .iter()
        .any(|(op, id)| *op == "unregister" && *id == foreign.id()));
}

#[test]
fn test_snapshots_cover_registered_and_unregistered_state_shapes() {
    assert_eq!(
        OwnedMainHotkeyStateSnapshot::for_test_registered("Alt+Z").label(),
        Some("Alt+Z")
    );
    assert_eq!(
        OwnedMainHotkeyStateSnapshot::for_test_unregistered().label(),
        None
    );
    assert!(
        !OwnedMainHotkeyStateSnapshot::for_test_unregistered_with_startup(false)
            .startup_attempted()
    );
    assert!(
        OwnedMainHotkeyStateSnapshot::for_test_unregistered_with_startup(true).startup_attempted()
    );
}

trait BindingTestId { fn id(self) -> u32; }
impl BindingTestId for MainBinding {
    fn id(self) -> u32 { match self { MainBinding::Accelerator(key) => key.id(), MainBinding::DoubleTap(modifier) => 0xffff_ff00 + modifier as u32 } }
}
