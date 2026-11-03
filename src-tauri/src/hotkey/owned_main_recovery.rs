//! Owned-resource recovery verifies the checkpoint's health, not merely retained identity.
use super::*;
impl OwnedMainHotkeyRegistry {
    pub(super) fn restore_snapshot(
        &self,
        snapshot: &OwnedMainHotkeySnapshot,
        generation: u64,
    ) -> OwnedMainHotkeySnapshot {
        OwnedMainHotkeySnapshot {
            generation,
            registry_id: self.registry_id,
            ..snapshot.clone()
        }
    }
    pub(super) fn restore_health<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        snapshot: &OwnedMainHotkeySnapshot,
    ) -> bool {
        let result = if snapshot.healthy {
            port.recover(snapshot.binding)
        } else {
            port.suspend(snapshot.binding)
        };
        result.is_ok() && port.is_healthy(snapshot.binding) == Ok(snapshot.healthy)
    }
    pub(super) fn restore_registration<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        snapshot: &OwnedMainHotkeySnapshot,
    ) -> bool {
        match port.is_registered(snapshot.binding) {
            Ok(true) => self.restore_health(port, snapshot),
            Ok(false) => match port.register(snapshot.binding) {
                Ok(()) => {
                    port.is_registered(snapshot.binding) == Ok(true)
                        && self.restore_health(port, snapshot)
                }
                Err(RegisterFailure::PartialOwned) => {
                    let registered = port.is_registered(snapshot.binding) == Ok(true);
                    if !registered {
                        self.remember_uncertain(snapshot);
                    }
                    registered && self.restore_health(port, snapshot)
                }
                Err(RegisterFailure::Rejected | RegisterFailure::RejectedCode(_)) => false,
                Err(RegisterFailure::Unavailable(_)) => {
                    self.outcome_unknown = true;
                    false
                }
            },
            Err(_) => false,
        }
    }

    pub(super) fn ensure_registered<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        snapshot: &OwnedMainHotkeySnapshot,
    ) -> bool {
        match port.is_registered(snapshot.binding) {
            Ok(true) => self.restore_health(port, snapshot),
            Ok(false) => self.restore_registration(port, snapshot),
            Err(_) => false,
        }
    }

    pub(super) fn clean_uncertain<P: ShortcutPort>(&mut self, port: &mut P) -> bool {
        let uncertain = std::mem::take(&mut self.uncertain);
        for candidate in uncertain {
            let _ = self.discard_candidate(port, &candidate);
        }
        self.uncertain.is_empty()
    }

    pub(super) fn adopt_uncertain_target(&mut self, snapshot: &OwnedMainHotkeySnapshot) -> bool {
        let Some(index) = self
            .uncertain
            .iter()
            .position(|owned| owned.binding == snapshot.binding)
        else {
            return false;
        };
        self.uncertain.remove(index);
        true
    }

    pub(super) fn remember_uncertain(&mut self, snapshot: &OwnedMainHotkeySnapshot) {
        if !self
            .uncertain
            .iter()
            .any(|owned| owned.binding == snapshot.binding)
        {
            self.uncertain.push(snapshot.clone());
        }
    }
}
