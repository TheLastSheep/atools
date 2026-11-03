use super::{OwnedMainHotkeyRegistry, OwnedMainHotkeySnapshot, ShortcutPort, RECOVERY_FAILED};

#[derive(Clone)]
pub(crate) struct OwnedMainHotkeyStateSnapshot {
    registry_id: u64,
    generation: u64,
    registered: Option<OwnedMainHotkeySnapshot>,
    startup_attempted: bool,
    healthy: bool,
}

impl OwnedMainHotkeyStateSnapshot {
    pub(crate) fn label(&self) -> Option<&str> {
        self.registered.as_ref().map(OwnedMainHotkeySnapshot::label)
    }

    pub(crate) fn active_label(&self) -> Option<&str> {
        self.label().filter(|_| self.healthy)
    }

    pub(crate) fn healthy(&self) -> bool {
        self.healthy
    }

    pub(crate) fn startup_attempted(&self) -> bool {
        self.startup_attempted
    }

    #[cfg(test)]
    pub(crate) fn for_test_registered(label: &str) -> Self {
        Self {
            registry_id: 0,
            generation: 0,
            registered: Some(OwnedMainHotkeySnapshot::for_test(label)),
            startup_attempted: false,
            healthy: true,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test_inactive(label: &str) -> Self {
        let mut state = Self::for_test_registered(label);
        state.healthy = false;
        state.registered.as_mut().unwrap().healthy = false;
        state
    }

    #[cfg(test)]
    pub(crate) fn for_test_unregistered() -> Self {
        Self {
            registry_id: 0,
            generation: 0,
            registered: None,
            startup_attempted: false,
            healthy: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test_unregistered_with_startup(startup_attempted: bool) -> Self {
        let mut snapshot = Self::for_test_unregistered();
        snapshot.startup_attempted = startup_attempted;
        snapshot
    }
}

impl OwnedMainHotkeyRegistry {
    pub(super) fn read_state<P: ShortcutPort>(
        &self,
        port: &P,
    ) -> Result<OwnedMainHotkeyStateSnapshot, String> {
        self.ensure_usable()?;
        let healthy = self
            .current
            .as_ref()
            .map(|current| port.is_healthy(current.binding))
            .transpose()?
            .unwrap_or(false);
        let mut registered = match self.current.as_ref() {
            Some(_) => Some(self.verify_current(port)?.clone()),
            None => None,
        };
        if let Some(snapshot) = registered.as_mut() {
            snapshot.healthy = healthy;
        }
        Ok(OwnedMainHotkeyStateSnapshot {
            registry_id: self.registry_id,
            generation: self.generation,
            registered,
            startup_attempted: self.startup_attempted,
            healthy,
        })
    }

    pub(super) fn apply_state<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        label: &str,
    ) -> Result<(), String> {
        self.ensure_usable()?;
        if self.current.is_some() {
            self.set(port, label)
        } else {
            self.setup(port, label)
        }
    }

    pub(super) fn restore_state<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        checkpoint: &OwnedMainHotkeyStateSnapshot,
    ) -> Result<(), String> {
        if self.outcome_unknown {
            return Err(super::HOTKEY_OUTCOME_UNKNOWN.into());
        }
        if checkpoint.registry_id != self.registry_id {
            return Err(RECOVERY_FAILED.into());
        }
        let same_state = checkpoint.generation == self.generation;
        let one_change = checkpoint.generation.checked_add(1) == Some(self.generation);
        if !same_state && !one_change {
            return Err(RECOVERY_FAILED.into());
        }

        if let Some(registered) = checkpoint.registered.as_ref() {
            self.restore(port, registered)?;
        } else {
            let owns_registered_state = self.current.is_some();
            let owns_uncertain_state = !self.uncertain.is_empty();
            if owns_registered_state && !one_change {
                return Err(RECOVERY_FAILED.into());
            }
            if owns_registered_state || owns_uncertain_state {
                self.release(port)?;
            } else if one_change {
                self.generation = self.next_generation()?;
            }
            if self.current.is_some() || !self.uncertain.is_empty() {
                return Err(RECOVERY_FAILED.into());
            }
        }
        self.startup_attempted = checkpoint.startup_attempted;
        Ok(())
    }

    pub(super) fn mark_startup_attempted(&mut self) -> Result<(), String> {
        self.ensure_usable()?;
        if self.startup_attempted {
            return Ok(());
        }
        let generation = self.next_generation()?;
        if let Some(current) = self.current.clone() {
            self.current = Some(self.restore_snapshot(&current, generation));
        }
        self.generation = generation;
        self.startup_attempted = true;
        Ok(())
    }
}

#[cfg(test)]
#[path = "owned_main_state_tests.rs"]
mod tests;
