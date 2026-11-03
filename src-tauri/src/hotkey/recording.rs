//! Fixed-key, session-scoped recording ownership. No UI or OS calls live here.
#[cfg(test)]
#[path = "recording_tests.rs"]
mod tests;

pub(crate) const MAX_GENERATION: u64 = 9_007_199_254_740_991;
pub(crate) const UNAVAILABLE: &str = "SETTINGS_HOTKEY_RECORDING_UNAVAILABLE";
pub(crate) const STALE: &str = "SETTINGS_HOTKEY_RECORDING_STALE";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Target {
    pub session_id: String,
    pub label: String,
    pub origin: String,
    pub bundle_revision: String,
    pub visibility_epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Mode {
    BorrowedMain,
    Temporary,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Outcome {
    Recorded,
    Stopped(&'static str),
}

#[derive(Clone, Debug)]
pub(crate) struct Notice {
    pub target: Target,
    pub generation: u64,
    pub outcome: Outcome,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Ack {
    pub version: u8,
    pub session_id: String,
    pub generation: u64,
    pub active: bool,
    pub mode: Option<Mode>,
}

pub(crate) trait Port {
    fn is_registered(&self) -> Result<bool, String>;
    fn register(&mut self) -> Result<(), String>;
    fn unregister(&mut self) -> Result<(), String>;
}

struct Lease {
    target: Target,
    generation: u64,
    mode: Mode,
    active: bool,
    stop_reason: Option<&'static str>,
}

#[derive(Default)]
pub(crate) struct Registry {
    session: Option<String>,
    high_water: u64,
    lease: Option<Lease>,
}

impl Registry {
    pub fn preflight(&self, target: &Target, generation: u64) -> Result<bool, String> {
        valid_generation(generation)?;
        if self.session.as_deref() == Some(&target.session_id) && generation <= self.high_water {
            if self.matches_active(&target.session_id, generation) {
                return Ok(false);
            }
            return Err(STALE.into());
        }
        Ok(true)
    }
    pub fn start(
        &mut self,
        target: Target,
        generation: u64,
        borrowed: bool,
        port: &mut impl Port,
    ) -> Result<(Ack, Option<Notice>, bool), String> {
        valid_generation(generation)?;
        if self.session.as_deref() == Some(&target.session_id) && generation <= self.high_water {
            if self.lease.as_ref().is_some_and(|lease| {
                lease.target == target && lease.generation == generation && lease.active
            }) {
                return Ok((self.ack(&target.session_id, generation), None, false));
            }
            return Err(STALE.into());
        }
        let stopped = self.cancel(port, "cancelled")?;
        self.session = Some(target.session_id.clone());
        self.high_water = generation;
        let mode = if borrowed {
            Mode::BorrowedMain
        } else {
            if port.is_registered()? {
                return Err(UNAVAILABLE.into());
            }
            port.register()?;
            Mode::Temporary
        };
        self.lease = Some(Lease {
            target: target.clone(),
            generation,
            mode,
            active: true,
            stop_reason: None,
        });
        Ok((self.ack(&target.session_id, generation), stopped, true))
    }

    pub fn remember_stop(&mut self, session_id: &str, generation: u64) -> Result<(), String> {
        valid_generation(generation)?;
        if self.session.as_deref() != Some(session_id) {
            if self.lease.is_some() {
                return Err(STALE.into());
            }
            self.session = Some(session_id.to_owned());
            self.high_water = generation;
        } else {
            self.high_water = self.high_water.max(generation);
        }
        Ok(())
    }
    pub fn stop(
        &mut self,
        session_id: &str,
        generation: u64,
        port: &mut impl Port,
    ) -> Result<(Ack, Option<Notice>), String> {
        self.remember_stop(session_id, generation)?;
        let notice = if self
            .lease
            .as_ref()
            .is_some_and(|lease| lease.generation <= generation)
        {
            self.cancel(port, "cancelled")?
        } else {
            None
        };
        Ok((self.ack(session_id, generation), notice))
    }

    pub fn capture(
        &mut self,
        session_id: &str,
        generation: u64,
        port: &mut impl Port,
    ) -> Result<Option<Notice>, String> {
        if !self.matches_active(session_id, generation) {
            return Ok(None);
        }
        let lease = self.lease.as_mut().unwrap();
        lease.active = false;
        let notice = Notice {
            target: lease.target.clone(),
            generation,
            outcome: Outcome::Recorded,
        };
        if lease.mode == Mode::Temporary {
            port.unregister()?;
        }
        self.lease = None;
        Ok(Some(notice))
    }

    pub fn cancel(
        &mut self,
        port: &mut impl Port,
        reason: &'static str,
    ) -> Result<Option<Notice>, String> {
        let Some(lease) = self.lease.as_mut() else {
            return Ok(None);
        };
        lease.active = false;
        let notice = Notice {
            target: lease.target.clone(),
            generation: lease.generation,
            outcome: Outcome::Stopped(reason),
        };
        if lease.mode == Mode::Temporary {
            port.unregister()?;
        }
        self.lease = None;
        Ok(Some(notice))
    }

    pub fn defer_cancel(&mut self, reason: &'static str) {
        if let Some(lease) = self.lease.as_mut() {
            lease.active = false;
            lease.stop_reason = Some(reason);
        }
    }
    pub fn stop_reason(&self) -> &'static str {
        self.lease
            .as_ref()
            .and_then(|lease| lease.stop_reason)
            .unwrap_or("cancelled")
    }
    pub fn matches_active(&self, session_id: &str, generation: u64) -> bool {
        self.lease.as_ref().is_some_and(|lease| {
            lease.active && lease.target.session_id == session_id && lease.generation == generation
        })
    }
    pub fn pending_target(&self) -> Option<(Target, u64)> {
        self.lease
            .as_ref()
            .map(|lease| (lease.target.clone(), lease.generation))
    }
    pub fn owns_temporary(&self) -> bool {
        self.lease
            .as_ref()
            .is_some_and(|lease| lease.mode == Mode::Temporary)
    }
    fn ack(&self, session_id: &str, generation: u64) -> Ack {
        let mode = self
            .lease
            .as_ref()
            .filter(|lease| {
                lease.active
                    && lease.target.session_id == session_id
                    && lease.generation == generation
            })
            .map(|lease| lease.mode);
        Ack {
            version: 1,
            session_id: session_id.to_owned(),
            generation,
            active: mode.is_some(),
            mode,
        }
    }
}

pub(crate) fn valid_generation(generation: u64) -> Result<(), String> {
    if generation == 0 || generation > MAX_GENERATION {
        Err(STALE.into())
    } else {
        Ok(())
    }
}
