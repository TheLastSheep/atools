use std::{collections::BTreeMap, str::FromStr};

use tauri_plugin_global_shortcut::Shortcut;

use super::super::app_shortcut_registry::OwnedShortcut;
use super::{parse_desired, OwnedAppShortcutRegistry, ShortcutPort};
use crate::commands::SyncAppShortcutPayload;

#[derive(Default)]
struct FakeShortcutPort {
    bindings: BTreeMap<u32, String>,
    calls: Vec<String>,
    fail_register: Vec<(u32, String)>,
    fail_unregister: Vec<u32>,
}

impl ShortcutPort for FakeShortcutPort {
    fn is_registered(&self, shortcut: Shortcut) -> Result<bool, String> {
        Ok(self.bindings.contains_key(&shortcut.id()))
    }

    fn register(&mut self, shortcut: Shortcut, target_code: &String) -> Result<(), String> {
        let id = shortcut.id();
        self.calls.push(format!("register:{id}:{target_code}"));
        if self
            .fail_register
            .iter()
            .any(|(failed_id, failed_target)| *failed_id == id && failed_target == target_code)
        {
            return Err("injected register failure".into());
        }
        if self.bindings.contains_key(&id) {
            return Err("shortcut already registered".into());
        }
        self.bindings.insert(id, target_code.to_owned());
        Ok(())
    }

    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
        let id = shortcut.id();
        self.calls.push(format!("unregister:{id}"));
        if self.fail_unregister.contains(&id) {
            return Err("injected unregister failure".into());
        }
        self.bindings
            .remove(&id)
            .map(|_| ())
            .ok_or_else(|| "shortcut was not registered".into())
    }
}

fn item(shortcut: &str, target_code: &str) -> SyncAppShortcutPayload {
    SyncAppShortcutPayload {
        id: format!("{shortcut}-{target_code}"),
        shortcut: shortcut.to_owned(),
        target_code: target_code.to_owned(),
        enabled: true,
    }
}

fn seed_owned(
    registry: &mut OwnedAppShortcutRegistry,
    port: &mut FakeShortcutPort,
    shortcut: &str,
    target: &str,
) {
    let parsed = Shortcut::from_str(shortcut).unwrap();
    let id = parsed.id();
    registry.entries.insert(
        id,
        OwnedShortcut {
            shortcut: shortcut.to_owned(),
            target_code: target.to_owned(),
        },
    );
    port.bindings.insert(id, target.to_owned());
}

#[test]
fn external_registration_conflict_is_rejected_before_mutation() {
    let mut registry = OwnedAppShortcutRegistry::default();
    let mut port = FakeShortcutPort::default();
    let external_id = Shortcut::from_str("Alt+1").unwrap().id();
    port.bindings.insert(external_id, "external-owner".into());
    let desired = parse_desired(&[item("Alt+1", "target")]).unwrap();

    let error = registry.replace_all(&mut port, desired).unwrap_err();

    assert!(error.contains("does not own"));
    assert!(port.calls.is_empty());
    assert_eq!(
        port.bindings.get(&external_id).map(String::as_str),
        Some("external-owner")
    );
    assert!(registry.entries.is_empty());
}

#[test]
fn partial_registration_failure_removes_new_bindings_and_restores_exact_old_set() {
    let mut registry = OwnedAppShortcutRegistry::default();
    let mut port = FakeShortcutPort::default();
    seed_owned(&mut registry, &mut port, "Alt+1", "old-target");

    let desired = parse_desired(&[
        item("Alt+1", "replacement-target"),
        item("Alt+2", "new-two"),
    ])
    .unwrap();
    let old_id = Shortcut::from_str("Alt+1").unwrap().id();
    let new_id = Shortcut::from_str("Alt+2").unwrap().id();
    port.fail_register
        .push((old_id, "replacement-target".into()));

    let error = registry.replace_all(&mut port, desired).unwrap_err();

    assert!(error.contains("prior owned shortcuts were restored"));
    assert_eq!(
        port.calls,
        vec![
            format!("register:{new_id}:new-two"),
            format!("unregister:{old_id}"),
            format!("register:{old_id}:replacement-target"),
            format!("unregister:{new_id}"),
            format!("register:{old_id}:old-target"),
        ]
    );
    assert_eq!(
        port.bindings,
        BTreeMap::from([(old_id, "old-target".into())])
    );
    assert_eq!(registry.entries.len(), 1);
    assert_eq!(registry.entries[&old_id].target_code, "old-target");
}

#[test]
fn commit_failure_restores_the_actual_owned_snapshot_not_old_database_values() {
    let mut registry = OwnedAppShortcutRegistry::default();
    let mut port = FakeShortcutPort::default();
    seed_owned(&mut registry, &mut port, "Alt+7", "actual-owned-target");
    let actual_id = Shortcut::from_str("Alt+7").unwrap().id();
    let snapshot = registry
        .replace_all(
            &mut port,
            parse_desired(&[item("Alt+2", "candidate")]).unwrap(),
        )
        .unwrap();

    registry.restore_snapshot(&mut port, snapshot).unwrap();

    assert_eq!(
        port.bindings,
        BTreeMap::from([(actual_id, "actual-owned-target".into())])
    );
    assert_eq!(registry.entries.len(), 1);
    assert_eq!(
        registry.entries[&actual_id].target_code,
        "actual-owned-target"
    );
}

#[test]
fn failed_compensation_is_reported_and_kept_in_the_owned_registry() {
    let mut registry = OwnedAppShortcutRegistry::default();
    let mut port = FakeShortcutPort::default();
    seed_owned(&mut registry, &mut port, "Alt+1", "old-target");

    let desired = parse_desired(&[
        item("Alt+1", "replacement-target"),
        item("Alt+2", "new-two"),
    ])
    .unwrap();
    let old_id = Shortcut::from_str("Alt+1").unwrap().id();
    let new_id = Shortcut::from_str("Alt+2").unwrap().id();
    port.fail_register
        .push((old_id, "replacement-target".into()));
    port.fail_unregister.push(new_id);

    let error = registry.replace_all(&mut port, desired).unwrap_err();

    assert!(error.contains("shortcut compensation incomplete"));
    assert!(error.contains("remove newly registered shortcut"));
    assert_eq!(
        port.bindings.get(&new_id).map(String::as_str),
        Some("new-two")
    );
    assert_eq!(
        port.bindings.get(&old_id).map(String::as_str),
        Some("old-target")
    );
    assert_eq!(
        registry
            .entries
            .get(&new_id)
            .map(|entry| entry.target_code.as_str()),
        Some("new-two")
    );
    assert_eq!(
        registry
            .entries
            .get(&old_id)
            .map(|entry| entry.target_code.as_str()),
        Some("old-target")
    );
}

#[test]
fn exact_duplicate_rows_dedupe_but_conflicting_duplicate_targets_reject() {
    let same = parse_desired(&[item("Option+1", "target"), item("Alt+1", "target")]);
    assert_eq!(same.unwrap().len(), 1);

    let conflict = parse_desired(&[item("Option+1", "target-a"), item("Alt+1", "target-b")]);
    assert!(conflict.unwrap_err().contains("conflicting duplicate"));
}

#[test]
fn paste_stack_shortcut_is_reserved_from_app_shortcut_ownership() {
    let mut registry = OwnedAppShortcutRegistry::default();
    let mut port = FakeShortcutPort::default();
    seed_owned(&mut registry, &mut port, "Alt+1", "existing-target");
    let previous_entries = registry.entries.clone();
    let previous_bindings = port.bindings.clone();

    let bulk_error = parse_desired(&[item("Cmd+V", "target")]).unwrap_err();
    assert!(bulk_error.contains("Paste Stack"), "{bulk_error}");

    let single_error = registry
        .register_single(&mut port, "Command+V", "target")
        .unwrap_err();
    assert!(single_error.contains("Paste Stack"), "{single_error}");
    assert!(port.calls.is_empty());
    assert_eq!(registry.entries, previous_entries);
    assert_eq!(port.bindings, previous_bindings);
}
