use std::collections::BTreeSet;

#[cfg(test)]
#[path = "policy_tests.rs"]
mod tests;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum ThemePreference {
    System,
    Light,
    Dark,
}

impl ThemePreference {
    pub(super) fn from_general_json(raw: Option<&str>) -> Self {
        let Some(theme) = raw
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
            .and_then(|value| {
                value
                    .get("theme")
                    .and_then(serde_json::Value::as_str)
                    .map(str::to_owned)
            })
        else {
            return Self::System;
        };

        match theme.as_str() {
            "light" => Self::Light,
            "dark" => Self::Dark,
            "system" => Self::System,
            _ => Self::System,
        }
    }
}

#[derive(Debug)]
pub(super) struct Ownership {
    main_owner: bool,
    settings_leases: BTreeSet<u64>,
    next_lease_id: Option<u64>,
    effect_owned: bool,
    cleanup_pending: bool,
    stopped: bool,
}

impl Default for Ownership {
    fn default() -> Self {
        Self {
            main_owner: false,
            settings_leases: BTreeSet::new(),
            next_lease_id: Some(1),
            effect_owned: false,
            cleanup_pending: false,
            stopped: false,
        }
    }
}

impl Ownership {
    pub(super) fn main_owner(&self) -> bool {
        self.main_owner
    }

    pub(super) fn settings_lease_count(&self) -> u64 {
        self.settings_leases.len() as u64
    }

    pub(super) fn total_owners(&self) -> u64 {
        self.settings_lease_count() + u64::from(self.main_owner)
    }

    pub(super) fn effect_owned(&self) -> bool {
        self.effect_owned
    }

    pub(super) fn cleanup_pending(&self) -> bool {
        self.cleanup_pending
    }

    pub(super) fn ensure_open(&self) -> Result<(), String> {
        if self.stopped {
            Err("Native window material manager is closed".into())
        } else {
            Ok(())
        }
    }

    pub(super) fn reserve_lease_id(&mut self) -> Result<u64, String> {
        self.ensure_open()?;
        let id = self
            .next_lease_id
            .ok_or_else(|| "Settings material lease ids are exhausted".to_owned())?;
        self.next_lease_id = id.checked_add(1);
        Ok(id)
    }

    pub(super) fn add_main_owner(&mut self) -> Result<(), String> {
        self.ensure_open()?;
        self.main_owner = true;
        Ok(())
    }

    pub(super) fn add_settings_lease(&mut self, lease_id: u64) -> Result<(), String> {
        self.ensure_open()?;
        if lease_id == 0 || !self.settings_leases.insert(lease_id) {
            return Err("Settings material lease is invalid or already active".into());
        }
        Ok(())
    }

    pub(super) fn remove_settings_lease(&mut self, lease_id: u64) -> bool {
        self.settings_leases.remove(&lease_id)
    }

    pub(super) fn remove_main_owner(&mut self) {
        self.main_owner = false;
    }

    pub(super) fn mark_effect_owned(&mut self) {
        self.effect_owned = true;
        self.cleanup_pending = false;
    }

    pub(super) fn install_effect(
        &mut self,
        apply: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if self.effect_owned {
            return Ok(());
        }
        apply()?;
        self.mark_effect_owned();
        Ok(())
    }

    pub(super) fn mark_cleanup_pending(&mut self) {
        self.effect_owned = true;
        self.cleanup_pending = true;
    }

    pub(super) fn mark_effect_cleared(&mut self) {
        self.effect_owned = false;
        self.cleanup_pending = false;
    }

    pub(super) fn should_clear_effect(&self) -> bool {
        self.total_owners() == 0 && self.effect_owned
    }

    pub(super) fn clear_effect(
        &mut self,
        clear: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        if !self.should_clear_effect() {
            return Ok(());
        }
        match clear() {
            Ok(()) => {
                self.mark_effect_cleared();
                Ok(())
            }
            Err(error) => {
                self.mark_cleanup_pending();
                Err(error)
            }
        }
    }

    pub(super) fn forget_destroyed_window(&mut self) {
        self.stopped = true;
        self.main_owner = false;
        self.settings_leases.clear();
        self.mark_effect_cleared();
    }

    pub(super) fn begin_stop(&mut self) -> bool {
        self.stopped = true;
        self.main_owner = false;
        self.settings_leases.clear();
        self.should_clear_effect()
    }
}
