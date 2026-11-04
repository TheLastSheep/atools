use crate::hotkey::main_binding::{parse_main_binding, MainBinding};
use std::collections::HashSet;

use super::{
    validate_main_hotkey_label, OwnedMainHotkeyRegistry, RegisterFailure, ShortcutPort,
    HOTKEY_OUTCOME_UNKNOWN, HOTKEY_REJECTED, RECOVERY_FAILED,
};

#[derive(Default)]
struct FakeShortcutPort {
    registered: HashSet<u32>,
    register_failures: HashSet<u32>,
    unavailable_register_foreign: HashSet<u32>,
    partial_register_failures: HashSet<u32>,
    rejected_register_foreign: HashSet<u32>,
    unregister_failures: HashSet<u32>,
    operations: Vec<(String, u32)>,
}

impl FakeShortcutPort {
    fn id(label: &str) -> u32 {
        parse_main_binding(label)
            .expect("test shortcut is valid")
            .id()
    }

    fn contains(&self, label: &str) -> bool {
        self.registered.contains(&Self::id(label))
    }

    fn initialized() -> (OwnedMainHotkeyRegistry, Self) {
        let mut port = Self::default();
        let mut registry = OwnedMainHotkeyRegistry::default();
        registry
            .setup(&mut port, "Alt+Z")
            .expect("owned main shortcut should register");
        port.operations.clear();
        (registry, port)
    }
}

impl ShortcutPort for FakeShortcutPort {
    fn is_registered(&self, shortcut: MainBinding) -> Result<bool, String> {
        Ok(self.registered.contains(&shortcut.id()))
    }

    fn register(&mut self, shortcut: MainBinding) -> Result<(), RegisterFailure> {
        self.operations.push(("register".into(), shortcut.id()));
        if self.unavailable_register_foreign.contains(&shortcut.id()) {
            self.registered.insert(shortcut.id());
            return Err(RegisterFailure::Unavailable(
                "SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into(),
            ));
        }
        if self.partial_register_failures.contains(&shortcut.id()) {
            self.registered.insert(shortcut.id());
            return Err(RegisterFailure::PartialOwned);
        }
        if self.rejected_register_foreign.contains(&shortcut.id()) {
            self.registered.insert(shortcut.id());
            return Err(RegisterFailure::Rejected);
        }
        if self.register_failures.contains(&shortcut.id()) {
            return Err(RegisterFailure::Rejected);
        }
        self.registered.insert(shortcut.id());
        Ok(())
    }

    fn unregister(&mut self, shortcut: MainBinding) -> Result<(), String> {
        self.operations.push(("unregister".into(), shortcut.id()));
        if self.unregister_failures.contains(&shortcut.id()) {
            return Err("unregistration failed".into());
        }
        self.registered.remove(&shortcut.id());
        Ok(())
    }
}

#[test]
fn parser_accepts_distinct_modifiers_and_rejects_duplicate_or_double_tap_forms() {
    assert!(validate_main_hotkey_label("Command+Ctrl+Option+Shift+F10").is_ok());
    assert!(validate_main_hotkey_label("F1").is_ok());
    assert!(validate_main_hotkey_label("F12").is_ok());
    assert_eq!(
        validate_main_hotkey_label("A").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert_eq!(
        validate_main_hotkey_label("Space").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert_eq!(
        validate_main_hotkey_label("Ctrl+Control+K").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert_eq!(
        validate_main_hotkey_label("Option+Alt+K").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert_eq!(
        validate_main_hotkey_label("Shift").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert_eq!(
        validate_main_hotkey_label(" Alt+K").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert_eq!(
        validate_main_hotkey_label(&format!("Alt+{}", "K".repeat(257))).unwrap_err(),
        HOTKEY_REJECTED
    );
}

#[test]
fn test_snapshot_keeps_label_without_serde_or_runtime_registration() {
    let snapshot = super::OwnedMainHotkeySnapshot::for_test("Command+Shift+F10");
    assert_eq!(snapshot.label(), "Command+Shift+F10");
}

#[test]
fn replacement_registers_candidate_before_releasing_only_owned_shortcut() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();

    registry
        .set(&mut port, "Alt+X")
        .expect("new primary should register");

    assert_eq!(
        port.operations,
        vec![
            ("register".into(), FakeShortcutPort::id("Alt+X")),
            ("unregister".into(), FakeShortcutPort::id("Alt+Z"))
        ]
    );
    assert!(!port.contains("Alt+Z"));
    assert!(port.contains("Alt+X"));
    assert_eq!(registry.read(&port).unwrap().label(), "Alt+X");
}

#[test]
fn foreign_registered_shortcut_is_rejected_without_unregistering_it() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    port.registered.insert(FakeShortcutPort::id("Alt+X"));
    port.operations.clear();

    assert_eq!(
        registry.set(&mut port, "Alt+X").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert_eq!(port.operations, Vec::<(String, u32)>::new());
    assert!(port.contains("Alt+Z"));
    assert!(port.contains("Alt+X"));
}

#[test]
fn failed_candidate_registration_keeps_current_owned_shortcut() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    port.register_failures.insert(FakeShortcutPort::id("Alt+X"));

    assert_eq!(
        registry.set(&mut port, "Alt+X").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert!(port.contains("Alt+Z"));
    assert!(!port.contains("Alt+X"));
    assert_eq!(registry.read(&port).unwrap().label(), "Alt+Z");
}

#[test]
fn rejected_registration_never_unregisters_a_foreign_candidate() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    let candidate = FakeShortcutPort::id("Alt+X");
    port.rejected_register_foreign.insert(candidate);

    assert_eq!(
        registry.set(&mut port, "Alt+X").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert!(port.contains("Alt+Z"));
    assert!(port.contains("Alt+X"));
    assert_eq!(
        port.operations,
        vec![("register".into(), candidate)],
        "a rejected registration does not establish ownership"
    );
}

#[test]
fn unavailable_registration_keeps_candidate_and_does_not_become_safe_rejection() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    let candidate = FakeShortcutPort::id("Alt+X");
    port.unavailable_register_foreign.insert(candidate);

    assert_eq!(
        registry.set(&mut port, "Alt+X").unwrap_err(),
        "SETTINGS_HOTKEY_OUTCOME_UNKNOWN"
    );
    assert!(port.contains("Alt+Z"));
    assert!(port.contains("Alt+X"));
    assert_eq!(
        port.operations,
        vec![("register".into(), candidate)],
        "an unavailable outcome must not unregister a possibly foreign shortcut"
    );
    assert_eq!(registry.read(&port).unwrap_err(), HOTKEY_OUTCOME_UNKNOWN);
}

#[test]
fn old_release_failure_compensates_candidate_and_preserves_old_key() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    port.unregister_failures
        .insert(FakeShortcutPort::id("Alt+Z"));

    assert_eq!(
        registry.set(&mut port, "Alt+X").unwrap_err(),
        HOTKEY_REJECTED
    );
    assert!(port.contains("Alt+Z"));
    assert!(!port.contains("Alt+X"));
    assert_eq!(registry.read(&port).unwrap().label(), "Alt+Z");
}

#[test]
fn failed_candidate_compensation_is_tracked_and_release_retries_only_owned_keys() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    let candidate = FakeShortcutPort::id("Alt+X");
    port.partial_register_failures.insert(candidate);
    port.unregister_failures.insert(candidate);

    assert_eq!(
        registry.set(&mut port, "Alt+X").unwrap_err(),
        RECOVERY_FAILED
    );
    assert!(port.contains("Alt+Z"));
    assert!(port.contains("Alt+X"));
    assert_eq!(registry.read(&port).unwrap_err(), RECOVERY_FAILED);

    port.unregister_failures.remove(&candidate);
    registry
        .release(&mut port)
        .expect("owned residue should release");
    assert!(!port.contains("Alt+Z"));
    assert!(!port.contains("Alt+X"));
}

#[test]
fn snapshot_restores_a_successful_replacement_and_is_registry_bound() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    let snapshot = registry.read(&port).unwrap();
    registry.set(&mut port, "Alt+X").unwrap();

    registry.restore(&mut port, &snapshot).unwrap();
    assert!(port.contains("Alt+Z"));
    assert!(!port.contains("Alt+X"));
    assert_eq!(registry.read(&port).unwrap().label(), "Alt+Z");

    let other = OwnedMainHotkeyRegistry::default();
    assert_eq!(
        registry
            .restore(
                &mut port,
                &other.snapshot("Alt+Z", parse_main_binding("Alt+Z").unwrap(), 0)
            )
            .unwrap_err(),
        "Owned main hotkey snapshot belongs to another registry"
    );
}

#[test]
fn canonical_same_key_updates_label_without_touching_manager_registration() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();

    registry
        .set(&mut port, "Option+Z")
        .expect("same canonical shortcut should update its label");

    assert!(port.operations.is_empty());
    assert!(port.contains("Alt+Z"));
    assert_eq!(registry.read(&port).unwrap().label(), "Option+Z");
}

#[test]
fn release_never_unregisters_foreign_shortcuts() {
    let (mut registry, mut port) = FakeShortcutPort::initialized();
    port.registered.insert(FakeShortcutPort::id("Alt+X"));

    registry.release(&mut port).unwrap();

    assert!(!port.contains("Alt+Z"));
    assert!(port.contains("Alt+X"));
    assert_eq!(port.operations.len(), 1);
}

trait BindingTestId {
    fn id(self) -> u32;
}
impl BindingTestId for MainBinding {
    fn id(self) -> u32 {
        match self {
            MainBinding::Accelerator(key) => key.id(),
            MainBinding::DoubleTap(modifier) => 0xffff_ff00 + modifier as u32,
        }
    }
}
