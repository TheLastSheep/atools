//! Pure scheduling policy: preference commits supersede startup reads and queued ticks.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct Policy {
    pub generation: u64,
    pub initialized: bool,
    pub enabled: bool,
    pub stopped: bool,
}
impl Policy {
    pub fn apply(&mut self, enabled: bool) -> Option<Self> {
        if self.stopped {
            return None;
        }
        if self.initialized && self.enabled == enabled {
            return Some(*self);
        }
        self.generation = self.generation.checked_add(1)?;
        self.initialized = true;
        self.enabled = enabled;
        Some(*self)
    }
    pub fn startup(&mut self, observed: u64, enabled: bool) -> Option<Self> {
        if self.initialized || self.generation != observed {
            return None;
        }
        self.apply(enabled)
    }
    pub fn stop(&mut self) {
        self.stopped = true;
        self.enabled = false;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_startup_and_duplicate_enable_do_not_replace_commits() {
        let mut p = Policy::default();
        let disabled = p.apply(false).unwrap();
        assert!(p.startup(0, true).is_none());
        assert_eq!(p.apply(false), Some(disabled));
        assert!(p.apply(true).unwrap().generation > disabled.generation);
    }
    #[test]
    fn stop_fences_every_future_preference_or_startup() {
        let mut p = Policy::default();
        p.apply(true);
        p.stop();
        assert!(p.apply(true).is_none());
        assert!(p.startup(0, true).is_none());
        assert!(!p.enabled);
    }
}
