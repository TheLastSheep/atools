use std::{collections::BTreeMap, str::FromStr};

use serde::Serialize;
use tauri_plugin_global_shortcut::Shortcut;

use crate::commands::SyncAppShortcutPayload;

const MAX_INPUT_ROWS: usize = 256;
const MAX_OWNED_SHORTCUTS: usize = 128;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const MAX_SHORTCUT_BYTES: usize = 256;
const MAX_TARGET_CODE_BYTES: usize = 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutInputBudget<'a> {
    id: &'a str,
    shortcut: &'a str,
    target_code: &'a str,
    enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OwnedShortcut<T = String> {
    pub(crate) shortcut: String,
    pub(crate) target_code: T,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct OwnedAppShortcutSnapshot<T = String> {
    entries: BTreeMap<u32, OwnedShortcut<T>>,
}

pub(crate) struct OwnedAppShortcutRegistry<T = String> {
    pub(crate) entries: BTreeMap<u32, OwnedShortcut<T>>,
}

#[derive(Clone, Debug)]
pub(crate) struct DesiredShortcut<T = String> {
    pub(crate) id: u32,
    pub(crate) parsed: Shortcut,
    pub(crate) shortcut: String,
    pub(crate) target_code: T,
}

pub(crate) trait ShortcutPort<T = String> {
    fn is_registered(&self, shortcut: Shortcut) -> Result<bool, String>;
    fn register(&mut self, shortcut: Shortcut, target_code: &T) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
}

impl<T> Default for OwnedAppShortcutRegistry<T> {
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
        }
    }
}

impl<T: Clone + Eq> OwnedAppShortcutRegistry<T> {
    pub(crate) fn register_one<P: ShortcutPort<T>>(
        &mut self,
        port: &mut P,
        desired: DesiredShortcut<T>,
    ) -> Result<(), String> {
        let previous = self.active_owned(port)?;
        if let Some(owned) = previous.get(&desired.id) {
            if owned.target_code == desired.target_code {
                self.entries = previous;
                return Ok(());
            }
            return Err("App shortcut is already owned by a different target".into());
        }
        if port.is_registered(desired.parsed)? {
            return Err(
                "App shortcut conflicts with a registration this runtime does not own".into(),
            );
        }

        let mut wanted = BTreeMap::new();
        for (id, owned) in &previous {
            let existing = parse_shortcut(&owned.shortcut)?;
            wanted.insert(
                *id,
                DesiredShortcut {
                    id: *id,
                    parsed: existing,
                    shortcut: owned.shortcut.clone(),
                    target_code: owned.target_code.clone(),
                },
            );
        }
        wanted.insert(desired.id, desired);
        let _ = self.replace_all(port, wanted)?;
        Ok(())
    }

    pub(crate) fn replace_all<P: ShortcutPort<T>>(
        &mut self,
        port: &mut P,
        desired: BTreeMap<u32, DesiredShortcut<T>>,
    ) -> Result<OwnedAppShortcutSnapshot<T>, String> {
        if desired.len() > MAX_OWNED_SHORTCUTS {
            return Err("App shortcut set exceeds the 128 owned shortcut limit".into());
        }

        let previous = self.active_owned(port)?;
        for (id, item) in &desired {
            if !previous.contains_key(id) && port.is_registered(item.parsed)? {
                return Err(
                    "App shortcut conflicts with a registration this runtime does not own".into(),
                );
            }
        }

        let snapshot = OwnedAppShortcutSnapshot {
            entries: previous.clone(),
        };
        let removals = previous
            .iter()
            .filter(|(id, old)| {
                desired
                    .get(id)
                    .is_none_or(|new| new.target_code != old.target_code)
            })
            .map(|(id, old)| (*id, old.clone()))
            .collect::<Vec<_>>();
        let additions = desired
            .values()
            .filter(|new| {
                previous
                    .get(&new.id)
                    .is_none_or(|old| old.target_code != new.target_code)
            })
            .cloned()
            .collect::<Vec<_>>();

        let mut removed = Vec::new();
        let mut added = Vec::new();

        // Probe new keys first so an OS-level conflict leaves the old set intact.
        for item in additions
            .iter()
            .filter(|item| !previous.contains_key(&item.id))
        {
            self.register_candidate(port, item, &previous, &removed, &mut added)?;
        }

        for (id, old) in &removals {
            let parsed = parse_shortcut(&old.shortcut)?;
            match port.is_registered(parsed) {
                Ok(false) => removed.push(*id),
                Ok(true) => match port.unregister(parsed) {
                    Ok(()) => removed.push(*id),
                    Err(primary) => {
                        match port.is_registered(parsed) {
                            Ok(false) => removed.push(*id),
                            Ok(true) => {}
                            Err(error) => {
                                let mut recovery = recover(port, &previous, &removed, &added);
                                recovery.failures.push(format!(
                                    "could not inspect failed unregister state: {error}"
                                ));
                                self.entries = recovery.owned;
                                return Err(recovery_error(
                                    format!(
                                        "Failed to unregister an owned app shortcut: {primary}"
                                    ),
                                    recovery.failures,
                                ));
                            }
                        }
                        let recovery = recover(port, &previous, &removed, &added);
                        self.entries = recovery.owned;
                        return Err(recovery_error(
                            format!("Failed to unregister an owned app shortcut: {primary}"),
                            recovery.failures,
                        ));
                    }
                },
                Err(primary) => {
                    let recovery = recover(port, &previous, &removed, &added);
                    self.entries = recovery.owned;
                    return Err(recovery_error(
                        format!("Could not inspect an owned app shortcut: {primary}"),
                        recovery.failures,
                    ));
                }
            }
        }

        // Same-key target replacements can only register after the owned old handler is removed.
        for item in additions
            .iter()
            .filter(|item| previous.contains_key(&item.id))
        {
            self.register_candidate(port, item, &previous, &removed, &mut added)?;
        }

        self.entries = desired
            .into_iter()
            .map(|(id, item)| {
                (
                    id,
                    OwnedShortcut {
                        shortcut: item.shortcut,
                        target_code: item.target_code,
                    },
                )
            })
            .collect();
        Ok(snapshot)
    }

    fn register_candidate<P: ShortcutPort<T>>(
        &mut self,
        port: &mut P,
        item: &DesiredShortcut<T>,
        previous: &BTreeMap<u32, OwnedShortcut<T>>,
        removed: &[u32],
        added: &mut Vec<DesiredShortcut<T>>,
    ) -> Result<(), String> {
        match port.is_registered(item.parsed) {
            Ok(false) => {}
            Ok(true) => {
                let recovery = recover(port, previous, removed, added);
                self.entries = recovery.owned;
                return Err(recovery_error(
                    "App shortcut became registered by another owner before replacement".into(),
                    recovery.failures,
                ));
            }
            Err(primary) => {
                let recovery = recover(port, previous, removed, added);
                self.entries = recovery.owned;
                return Err(recovery_error(
                    format!("Could not inspect an app shortcut before registration: {primary}"),
                    recovery.failures,
                ));
            }
        }
        if let Err(primary) = port.register(item.parsed, &item.target_code) {
            let recovery = recover(port, previous, removed, added);
            self.entries = recovery.owned;
            return Err(recovery_error(
                format!("Failed to register an app shortcut: {primary}"),
                recovery.failures,
            ));
        }
        added.push(item.clone());
        Ok(())
    }

    fn active_owned<P: ShortcutPort<T>>(
        &self,
        port: &P,
    ) -> Result<BTreeMap<u32, OwnedShortcut<T>>, String> {
        let mut active = BTreeMap::new();
        for (id, owned) in &self.entries {
            if port.is_registered(parse_shortcut(&owned.shortcut)?)? {
                active.insert(*id, owned.clone());
            }
        }
        Ok(active)
    }

    pub(crate) fn restore_snapshot<P: ShortcutPort<T>>(
        &mut self,
        port: &mut P,
        snapshot: OwnedAppShortcutSnapshot<T>,
    ) -> Result<(), String> {
        let mut desired = BTreeMap::new();
        for (id, owned) in snapshot.entries {
            let parsed = parse_shortcut(&owned.shortcut)?;
            if parsed.id() != id {
                return Err("Owned app shortcut snapshot is inconsistent".into());
            }
            desired.insert(
                id,
                DesiredShortcut {
                    id,
                    parsed,
                    shortcut: owned.shortcut,
                    target_code: owned.target_code,
                },
            );
        }
        let _ = self.replace_all(port, desired)?;
        Ok(())
    }
}

#[cfg(any(test, feature = "legacy-node-smoke"))]
impl OwnedAppShortcutRegistry<String> {
    pub(crate) fn register_single<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        shortcut: &str,
        target_code: &str,
    ) -> Result<(), String> {
        let desired = parse_single(shortcut, target_code)?;
        self.register_one(port, desired)
    }
}

struct Recovery<T> {
    owned: BTreeMap<u32, OwnedShortcut<T>>,
    failures: Vec<String>,
}

fn recover<T: Clone + Eq, P: ShortcutPort<T>>(
    port: &mut P,
    previous: &BTreeMap<u32, OwnedShortcut<T>>,
    removed: &[u32],
    added: &[DesiredShortcut<T>],
) -> Recovery<T> {
    let removed_ids = removed
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let mut owned = previous
        .iter()
        .filter(|(id, _)| !removed_ids.contains(id))
        .map(|(id, value)| (*id, value.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut failures = Vec::new();

    for item in added.iter().rev() {
        match port.is_registered(item.parsed) {
            Ok(false) => {}
            Ok(true) => match port.unregister(item.parsed) {
                Ok(()) => {}
                Err(error) => {
                    failures.push(format!("remove newly registered shortcut: {error}"));
                    match port.is_registered(item.parsed) {
                        Ok(true) | Err(_) => {
                            owned.insert(
                                item.id,
                                OwnedShortcut {
                                    shortcut: item.shortcut.clone(),
                                    target_code: item.target_code.clone(),
                                },
                            );
                        }
                        Ok(false) => {}
                    }
                }
            },
            Err(error) => {
                failures.push(format!("inspect newly registered shortcut: {error}"));
                owned.insert(
                    item.id,
                    OwnedShortcut {
                        shortcut: item.shortcut.clone(),
                        target_code: item.target_code.clone(),
                    },
                );
            }
        }
    }

    for id in removed.iter().rev() {
        let Some(old) = previous.get(id) else {
            continue;
        };
        if let Some(current) = owned.get(id) {
            if current != old {
                failures.push("restore old app shortcut: replacement is still registered".into());
            }
            continue;
        }
        let parsed = match parse_shortcut(&old.shortcut) {
            Ok(parsed) => parsed,
            Err(error) => {
                failures.push(format!("parse old app shortcut: {error}"));
                continue;
            }
        };
        match port.is_registered(parsed) {
            Ok(true) => failures.push(
                "restore old app shortcut: key is now registered by a non-owned source".into(),
            ),
            Ok(false) => match port.register(parsed, &old.target_code) {
                Ok(()) => {
                    owned.insert(*id, old.clone());
                }
                Err(error) => failures.push(format!("restore old app shortcut: {error}")),
            },
            Err(error) => failures.push(format!("inspect old app shortcut: {error}")),
        }
    }

    Recovery { owned, failures }
}

fn recovery_error(primary: String, failures: Vec<String>) -> String {
    if failures.is_empty() {
        format!("{primary}; prior owned shortcuts were restored")
    } else {
        format!(
            "{primary}; shortcut compensation incomplete: {}",
            failures.join("; ")
        )
    }
}

pub(crate) fn parse_shortcut(value: &str) -> Result<Shortcut, String> {
    let normalized = crate::hotkey::normalize_shortcut(value);
    Shortcut::from_str(&normalized).map_err(|_| "Invalid app shortcut syntax".to_owned())
}

pub(crate) fn parse_single(shortcut: &str, target_code: &str) -> Result<DesiredShortcut, String> {
    if shortcut.len() > MAX_SHORTCUT_BYTES
        || target_code.len() > MAX_TARGET_CODE_BYTES
        || shortcut.trim().is_empty()
        || target_code.trim().is_empty()
    {
        return Err("App shortcut has an invalid or oversized field".into());
    }
    let normalized = crate::hotkey::normalize_shortcut(shortcut);
    let parsed =
        Shortcut::from_str(&normalized).map_err(|_| "App shortcut syntax is invalid".to_owned())?;
    let paste_stack = parse_shortcut(crate::hotkey::PASTE_STACK_SHORTCUT)?;
    if parsed.id() == paste_stack.id() {
        return Err("Cmd+V is reserved for Paste Stack".into());
    }
    Ok(DesiredShortcut {
        id: parsed.id(),
        parsed,
        shortcut: normalized,
        target_code: target_code.to_owned(),
    })
}

pub(crate) fn parse_desired(
    shortcuts: &[SyncAppShortcutPayload],
) -> Result<BTreeMap<u32, DesiredShortcut>, String> {
    if shortcuts.len() > MAX_INPUT_ROWS {
        return Err("App shortcut input exceeds the 256 row limit".into());
    }
    let wire_budget = shortcuts
        .iter()
        .map(|item| ShortcutInputBudget {
            id: &item.id,
            shortcut: &item.shortcut,
            target_code: &item.target_code,
            enabled: item.enabled,
        })
        .collect::<Vec<_>>();
    let encoded = serde_json::to_vec(&wire_budget)
        .map_err(|_| "App shortcut input could not be serialized".to_owned())?;
    if encoded.len() > MAX_INPUT_BYTES {
        return Err("App shortcut input exceeds the 64 KiB serialized budget".into());
    }

    let mut input_bytes = 0usize;
    let mut desired: BTreeMap<u32, DesiredShortcut> = BTreeMap::new();
    for item in shortcuts {
        input_bytes = input_bytes
            .checked_add(item.id.len())
            .and_then(|size| size.checked_add(item.shortcut.len()))
            .and_then(|size| size.checked_add(item.target_code.len()))
            .ok_or_else(|| "App shortcut input size overflowed".to_owned())?;
        if input_bytes > MAX_INPUT_BYTES {
            return Err("App shortcut input exceeds the 64 KiB budget".into());
        }
        if !item.enabled {
            continue;
        }
        let desired_item = parse_single(&item.shortcut, &item.target_code)?;
        match desired.get(&desired_item.id) {
            Some(existing) if existing.target_code == desired_item.target_code => continue,
            Some(_) => return Err("Enabled app shortcuts contain a conflicting duplicate".into()),
            None => {
                desired.insert(desired_item.id, desired_item);
            }
        }
        if desired.len() > MAX_OWNED_SHORTCUTS {
            return Err("App shortcut set exceeds the 128 owned shortcut limit".into());
        }
    }
    Ok(desired)
}
