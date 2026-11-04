use std::sync::atomic::{AtomicU64, Ordering};

use super::main_binding::{parse_main_binding, MainBinding};

pub(super) const HOTKEY_REJECTED: &str = "SETTINGS_HOTKEY_REJECTED";
pub(super) const HOTKEY_OUTCOME_UNKNOWN: &str = "SETTINGS_HOTKEY_OUTCOME_UNKNOWN";
const RECOVERY_FAILED: &str = "SETTINGS_NATIVE_RECOVERY_FAILED";
static NEXT_REGISTRY_ID: AtomicU64 = AtomicU64::new(1);

#[path = "parser.rs"]
mod parser;
pub(super) use parser::parse_main_hotkey;
pub(crate) use parser::validate_main_hotkey_label;

#[path = "owned_main_recovery.rs"]
mod recovery;

#[path = "owned_main_update.rs"]
mod update;

#[path = "owned_main_state.rs"]
mod state;
pub(crate) use state::OwnedMainHotkeyStateSnapshot;

#[path = "owned_main_tauri.rs"]
mod tauri_adapter;
pub(super) use tauri_adapter::{owned_registry_uses_shortcut, shutdown_locked};
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use tauri_adapter::{read_owned_main_hotkey, restore_owned_main_hotkey};
pub(crate) use tauri_adapter::{
    apply_owned_main_hotkey, mark_startup_attempted, read_owned_main_hotkey_state,
    release_owned_main_hotkey, restore_owned_main_hotkey_state, set_owned_main_hotkey,
    set_owned_main_hotkey_from, setup_owned_main_hotkey,
};

#[derive(Clone, Debug)]
pub(crate) struct OwnedMainHotkeySnapshot {
    label: String,
    binding: MainBinding,
    registry_id: u64,
    generation: u64,
    healthy: bool,
}

impl OwnedMainHotkeySnapshot {
    pub(crate) fn label(&self) -> &str {
        &self.label
    }

    #[cfg(test)]
    pub(crate) fn for_test(label: &str) -> Self {
        let binding = parse_main_binding(label).expect("test hotkey label must be valid");
        Self {
            label: label.to_owned(),
            binding,
            registry_id: 0,
            generation: 0,
            healthy: true,
        }
    }
}

pub(crate) struct OwnedMainHotkeyRegistry {
    registry_id: u64,
    generation: u64,
    startup_attempted: bool,
    outcome_unknown: bool,
    current: Option<OwnedMainHotkeySnapshot>,
    uncertain: Vec<OwnedMainHotkeySnapshot>,
}

impl Default for OwnedMainHotkeyRegistry {
    fn default() -> Self {
        Self {
            registry_id: NEXT_REGISTRY_ID.fetch_add(1, Ordering::Relaxed),
            generation: 0,
            startup_attempted: false,
            outcome_unknown: false,
            current: None,
            uncertain: Vec::new(),
        }
    }
}

trait ShortcutPort {
    fn is_registered(&self, binding: MainBinding) -> Result<bool, String>;
    fn is_healthy(&self, binding: MainBinding) -> Result<bool, String> {
        self.is_registered(binding)
    }
    fn recover(&mut self, binding: MainBinding) -> Result<(), String> {
        if self.is_healthy(binding)? {
            Ok(())
        } else {
            Err(HOTKEY_OUTCOME_UNKNOWN.into())
        }
    }
    fn suspend(&mut self, binding: MainBinding) -> Result<(), String> {
        if !self.is_healthy(binding)? {
            Ok(())
        } else {
            Err(RECOVERY_FAILED.into())
        }
    }
    fn register(&mut self, binding: MainBinding) -> Result<(), RegisterFailure>;
    fn unregister(&mut self, binding: MainBinding) -> Result<(), String>;
}

enum RegisterFailure {
    Rejected,
    RejectedCode(String),
    PartialOwned,
    #[allow(dead_code)]
    Unavailable(String),
}

impl OwnedMainHotkeyRegistry {
    fn snapshot(
        &self,
        label: &str,
        binding: MainBinding,
        generation: u64,
    ) -> OwnedMainHotkeySnapshot {
        OwnedMainHotkeySnapshot {
            label: label.to_owned(),
            binding,
            registry_id: self.registry_id,
            generation,
            healthy: true,
        }
    }

    pub(super) fn dispatch_owner(&self) -> Option<(MainBinding, u64)> {
        if self.ensure_usable().is_err() {
            return None;
        }
        self.current
            .as_ref()
            .filter(|current| current.healthy)
            .map(|current| (current.binding, current.generation))
    }

    fn next_generation(&self) -> Result<u64, String> {
        self.generation
            .checked_add(1)
            .ok_or_else(|| RECOVERY_FAILED.to_owned())
    }

    fn ensure_usable(&self) -> Result<(), String> {
        if self.outcome_unknown {
            Err(HOTKEY_OUTCOME_UNKNOWN.into())
        } else if self.uncertain.is_empty() {
            Ok(())
        } else {
            Err(RECOVERY_FAILED.into())
        }
    }

    fn verify_current<P: ShortcutPort>(
        &self,
        port: &P,
    ) -> Result<&OwnedMainHotkeySnapshot, String> {
        self.ensure_usable()?;
        let current = self
            .current
            .as_ref()
            .ok_or_else(|| "Owned main hotkey is not initialized".to_owned())?;
        if !port.is_registered(current.binding)? {
            return Err("Owned main hotkey is missing from the application manager".into());
        }
        Ok(current)
    }

    fn setup<P: ShortcutPort>(&mut self, port: &mut P, label: &str) -> Result<(), String> {
        self.ensure_usable()?;
        let binding = parse_main_binding(label)?;
        if let Some(current) = self.current.clone() {
            self.verify_current(port)?;
            if current.binding != binding {
                return Err(HOTKEY_REJECTED.into());
            }
            port.recover(binding)?;
            if current.label != label {
                let generation = self.next_generation()?;
                self.generation = generation;
                self.current = Some(self.snapshot(label, binding, generation));
            }
            return Ok(());
        }

        let generation = self.next_generation()?;
        let candidate = self.snapshot(label, binding, generation);
        self.acquire_candidate(port, &candidate)?;
        self.generation = generation;
        self.current = Some(candidate);
        Ok(())
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    fn read<P: ShortcutPort>(&self, port: &P) -> Result<OwnedMainHotkeySnapshot, String> {
        let current = self.verify_current(port)?;
        if !port.is_healthy(current.binding)? {
            return Err("SETTINGS_HOTKEY_LISTENER_INACTIVE".into());
        }
        Ok(current.clone())
    }

    fn uses<P: ShortcutPort>(&self, port: &P, binding: MainBinding) -> Result<bool, String> {
        self.ensure_usable()?;
        let Some(current) = self.current.as_ref() else {
            return Ok(false);
        };
        if !port.is_registered(current.binding)? {
            return Err("Owned main hotkey is missing from the application manager".into());
        }
        Ok(current.binding == binding)
    }

    fn set<P: ShortcutPort>(&mut self, port: &mut P, label: &str) -> Result<(), String> {
        self.ensure_usable()?;
        let binding = parse_main_binding(label)?;
        let mut current = self.verify_current(port)?.clone();
        current.healthy = port.is_healthy(current.binding)?;
        let generation = self.next_generation()?;
        let candidate = self.snapshot(label, binding, generation);

        if current.binding == binding {
            port.recover(binding)?;
            if current.label != label || !current.healthy {
                self.generation = generation;
                self.current = Some(candidate);
            }
            return Ok(());
        }
        self.acquire_candidate(port, &candidate)?;

        let release_result = port.unregister(current.binding);
        let old_registered = port.is_registered(current.binding);
        if release_result.is_ok() && old_registered == Ok(false) {
            self.generation = generation;
            self.current = Some(candidate);
            return Ok(());
        }

        let old_restored = match old_registered {
            Ok(true) => self.restore_health(port, &current),
            Ok(false) => self.restore_registration(port, &current),
            Err(_) => false,
        };
        let candidate_removed = self.discard_candidate(port, &candidate);
        self.current = Some(current.clone());
        if !old_restored {
            self.remember_uncertain(&current);
        }
        if old_restored && candidate_removed {
            Err(HOTKEY_REJECTED.into())
        } else {
            Err(RECOVERY_FAILED.into())
        }
    }

    fn restore<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        snapshot: &OwnedMainHotkeySnapshot,
    ) -> Result<(), String> {
        if self.outcome_unknown {
            return Err(HOTKEY_OUTCOME_UNKNOWN.into());
        }
        if snapshot.registry_id != self.registry_id {
            return Err("Owned main hotkey snapshot belongs to another registry".into());
        }
        let mut residue_clean = self.clean_uncertain(port);
        let current = self.current.clone();
        let same_state = snapshot.generation == self.generation;
        let one_change = snapshot.generation.checked_add(1) == Some(self.generation);
        if !same_state && !one_change {
            return Err(RECOVERY_FAILED.into());
        }

        if current
            .as_ref()
            .is_some_and(|owned| owned.binding == snapshot.binding)
        {
            if !self.ensure_registered(port, snapshot) {
                self.remember_uncertain(snapshot);
                return Err(RECOVERY_FAILED.into());
            }
            if one_change {
                let generation = self.next_generation()?;
                self.generation = generation;
                self.current = Some(self.restore_snapshot(snapshot, generation));
            } else {
                self.current = Some(self.restore_snapshot(snapshot, snapshot.generation));
            }
            return if residue_clean {
                Ok(())
            } else {
                Err(RECOVERY_FAILED.into())
            };
        }

        if !one_change {
            return Err(RECOVERY_FAILED.into());
        }
        if !self.adopt_uncertain_target(snapshot) {
            match port.is_registered(snapshot.binding) {
                Ok(false) => {
                    if self.acquire_candidate(port, snapshot).is_err() {
                        return Err(RECOVERY_FAILED.into());
                    }
                }
                Ok(true) => return Err(RECOVERY_FAILED.into()),
                Err(_) => return Err(RECOVERY_FAILED.into()),
            }
        } else {
            residue_clean = self.uncertain.is_empty();
        }

        if !self.restore_health(port, snapshot) {
            let _ = self.discard_candidate(port, snapshot);
            self.remember_uncertain(snapshot);
            return Err(RECOVERY_FAILED.into());
        }

        if let Some(old) = current.as_ref() {
            if port.is_registered(old.binding) != Ok(false) {
                let removed = match port.is_registered(old.binding) {
                    Ok(true) => {
                        let _ = port.unregister(old.binding);
                        port.is_registered(old.binding) == Ok(false)
                    }
                    _ => false,
                };
                if !removed {
                    let _ = self.discard_candidate(port, snapshot);
                    return Err(RECOVERY_FAILED.into());
                }
            }
        }

        let generation = self.next_generation()?;
        self.generation = generation;
        self.current = Some(self.restore_snapshot(snapshot, generation));
        if residue_clean {
            Ok(())
        } else {
            Err(RECOVERY_FAILED.into())
        }
    }

    fn release<P: ShortcutPort>(&mut self, port: &mut P) -> Result<(), String> {
        if self.outcome_unknown {
            return Err(HOTKEY_OUTCOME_UNKNOWN.into());
        }
        let mut owned = std::mem::take(&mut self.uncertain);
        if let Some(current) = self.current.take() {
            if !owned
                .iter()
                .any(|candidate| candidate.binding == current.binding)
            {
                owned.push(current);
            }
        }
        let mut remaining = Vec::new();
        for shortcut in owned {
            let registered = match port.is_registered(shortcut.binding) {
                Ok(registered) => registered,
                Err(_) => {
                    remaining.push(shortcut);
                    continue;
                }
            };
            if registered {
                let _ = port.unregister(shortcut.binding);
                if port.is_registered(shortcut.binding) != Ok(false) {
                    remaining.push(shortcut);
                }
            }
        }
        if remaining.is_empty() {
            self.uncertain.clear();
            self.generation = self.next_generation()?;
            Ok(())
        } else {
            self.uncertain = remaining;
            Err(RECOVERY_FAILED.into())
        }
    }

    fn acquire_candidate<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        candidate: &OwnedMainHotkeySnapshot,
    ) -> Result<(), String> {
        match port.is_registered(candidate.binding)? {
            true => return Err(HOTKEY_REJECTED.into()),
            false => {}
        }
        match port.register(candidate.binding) {
            Ok(()) if port.is_healthy(candidate.binding) == Ok(true) => Ok(()),
            Ok(()) => {
                if self.discard_candidate(port, candidate) {
                    Err(HOTKEY_REJECTED.into())
                } else {
                    Err(RECOVERY_FAILED.into())
                }
            }
            Err(RegisterFailure::Rejected) => Err(HOTKEY_REJECTED.into()),
            Err(RegisterFailure::RejectedCode(code)) => Err(code),
            Err(RegisterFailure::Unavailable(_)) => {
                self.outcome_unknown = true;
                Err(HOTKEY_OUTCOME_UNKNOWN.into())
            }
            Err(RegisterFailure::PartialOwned) => {
                if self.discard_candidate(port, candidate) {
                    Err(HOTKEY_REJECTED.into())
                } else {
                    Err(RECOVERY_FAILED.into())
                }
            }
        }
    }

    fn discard_candidate<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        candidate: &OwnedMainHotkeySnapshot,
    ) -> bool {
        if port.is_registered(candidate.binding) == Ok(false) {
            return true;
        }
        let _ = port.unregister(candidate.binding);
        if port.is_registered(candidate.binding) == Ok(false) {
            true
        } else {
            self.remember_uncertain(candidate);
            false
        }
    }
}

#[cfg(test)]
#[path = "owned_main_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "owned_main_double_tests.rs"]
mod double_tests;
