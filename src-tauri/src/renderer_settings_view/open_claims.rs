//! Settings-open ownership. All methods are synchronous and must run under
//! `SettingsViewRuntime::inner`; native work is performed after releasing it.
use std::collections::{BTreeMap, BTreeSet};

const MAX_CLAIMS: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct MainKey {
    pub(crate) window_instance: u64,
    pub(crate) document_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionKey {
    pub(crate) id: String,
    pub(crate) revoked_identity: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Ord, PartialOrd)]
pub(crate) struct ClaimId(pub(crate) u64);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ClaimKind {
    General,
    AppIntent,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Adoption {
    GeneralReplyConsumed,
    IntentAckAccepted,
}

#[derive(Clone, Debug)]
struct Claim {
    main: MainKey,
    kind: ClaimKind,
    sequence: Option<u64>,
    session: Option<SessionKey>,
}

#[derive(Debug)]
struct Slot {
    key: SessionKey,
    claims: BTreeSet<ClaimId>,
    constructing: bool,
    active_stages: usize,
    adopted: bool,
    closing: bool,
    invalidated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ClosingTicket(pub(crate) SessionKey);

#[derive(Clone, Debug)]
pub(crate) struct CommitToken {
    main: MainKey,
    session: SessionKey,
}

#[derive(Default)]
pub(crate) struct OpenClaims {
    next_instance: u64,
    registered_instance: Option<u64>,
    next_claim: u64,
    next_intent: u64,
    main: Option<(MainKey, bool)>,
    latest_intent: Option<u64>,
    claims: BTreeMap<ClaimId, Claim>,
    slot: Option<Slot>,
}

impl OpenClaims {
    pub(crate) fn register_main_instance(&mut self) -> Result<(u64, Vec<ClosingTicket>), String> {
        let instance = self
            .next_instance
            .checked_add(1)
            .ok_or("Main instance sequence exhausted")?;
        let tickets = self.revoke_all();
        self.next_instance = instance;
        self.registered_instance = Some(instance);
        self.main = None;
        Ok((instance, tickets))
    }

    pub(crate) fn note_main_started(
        &mut self,
        instance: u64,
    ) -> Result<(MainKey, Vec<ClosingTicket>), String> {
        if self.registered_instance != Some(instance) {
            return Err("Main window is no longer current".into());
        }
        let epoch = match self.main {
            Some((key, _)) if key.window_instance == instance => key.document_epoch.checked_add(1),
            _ => Some(1),
        }
        .ok_or_else(|| "Main document epoch exhausted".to_owned())?;
        let tickets = self.revoke_all();
        let key = MainKey {
            window_instance: instance,
            document_epoch: epoch,
        };
        self.main = Some((key, false));
        Ok((key, tickets))
    }

    pub(crate) fn note_main_finished(&mut self, key: MainKey) -> Result<(), String> {
        match self.main.as_mut() {
            Some((current, ready)) if *current == key => {
                *ready = true;
                Ok(())
            }
            _ => Err("Main document is no longer current".into()),
        }
    }

    pub(crate) fn note_main_destroyed(&mut self, instance: u64) -> Vec<ClosingTicket> {
        if self.registered_instance == Some(instance) {
            self.main = None;
            self.registered_instance = None;
            self.revoke_all()
        } else {
            Vec::new()
        }
    }

    pub(crate) fn current_key(&self) -> Option<MainKey> {
        self.main.map(|(key, _)| key)
    }

    pub(crate) fn registered_instance_is(&self, instance: u64) -> bool {
        self.registered_instance == Some(instance)
    }

    pub(crate) fn finished_main(&self) -> Option<MainKey> {
        self.main.and_then(|(key, ready)| ready.then_some(key))
    }

    pub(crate) fn current_main(&self, key: MainKey) -> bool {
        self.main == Some((key, true))
    }

    pub(crate) fn admit_request(
        &mut self,
        main: MainKey,
        kind: ClaimKind,
    ) -> Result<(ClaimId, Option<u64>, Vec<ClosingTicket>), String> {
        if !self.current_main(main) {
            return Err("Main document is no longer current".into());
        }
        if self.claims.len() >= MAX_CLAIMS {
            return Err("Too many Settings open requests".into());
        }
        let id = ClaimId(
            self.next_claim
                .checked_add(1)
                .ok_or("Settings claim sequence exhausted")?,
        );
        let sequence = if kind == ClaimKind::AppIntent {
            Some(
                self.next_intent
                    .checked_add(1)
                    .filter(|value| *value <= 9_007_199_254_740_991)
                    .ok_or("Settings intent sequence exhausted")?,
            )
        } else {
            None
        };
        // Reserve interest in the current slot before superseding the old
        // intent, so its removal cannot close a session the new request needs.
        let session = if sequence.is_some() {
            self.slot
                .as_mut()
                .filter(|slot| !slot.closing && !slot.invalidated)
                .map(|slot| {
                    slot.claims.insert(id);
                    slot.key.clone()
                })
        } else {
            None
        };
        self.next_claim = id.0;
        self.claims.insert(
            id,
            Claim {
                main,
                kind,
                sequence,
                session,
            },
        );
        let mut tickets = Vec::new();
        if let Some(sequence) = sequence {
            self.next_intent = sequence;
            self.latest_intent = Some(sequence);
            let old: Vec<_> = self
                .claims
                .iter()
                .filter_map(|(old, claim)| {
                    (*old != id && claim.kind == ClaimKind::AppIntent).then_some(*old)
                })
                .collect();
            for old in old {
                if let Some(ticket) = self.abandon(old) {
                    tickets.push(ticket);
                }
            }
        }
        Ok((id, sequence, tickets))
    }

    pub(crate) fn is_live(&self, id: ClaimId) -> bool {
        self.claims.get(&id).is_some_and(|claim| {
            self.current_main(claim.main)
                && (claim.kind != ClaimKind::AppIntent || claim.sequence == self.latest_intent)
        })
    }

    pub(crate) fn matches_intent(
        &self,
        id: ClaimId,
        main: MainKey,
        sequence: u64,
        session: &SessionKey,
    ) -> bool {
        self.is_live(id)
            && self.claims.get(&id).is_some_and(|claim| {
                claim.kind == ClaimKind::AppIntent
                    && claim.main == main
                    && claim.sequence == Some(sequence)
                    && claim.session.as_ref() == Some(session)
            })
            && self
                .slot
                .as_ref()
                .is_some_and(|slot| !slot.closing && !slot.invalidated && &slot.key == session)
    }

    /// The supplied key is a fresh reservation; a live slot wins over it.
    pub(crate) fn join_or_start(
        &mut self,
        id: ClaimId,
        fresh: SessionKey,
    ) -> Result<(SessionKey, bool), String> {
        if !self.is_live(id) {
            return Err("Settings open request is no longer current".into());
        }
        let start = self.slot.is_none();
        if start {
            self.slot = Some(Slot {
                key: fresh,
                claims: BTreeSet::new(),
                constructing: true,
                active_stages: 0,
                adopted: false,
                closing: false,
                invalidated: false,
            });
        }
        let slot = self.slot.as_mut().expect("slot inserted");
        if slot.closing || slot.invalidated {
            return Err("Settings view is closing".into());
        }
        slot.claims.insert(id);
        let key = slot.key.clone();
        self.claims.get_mut(&id).expect("live claim").session = Some(key.clone());
        Ok((key, start))
    }

    pub(crate) fn admit_stage(
        &self,
        main: MainKey,
        session: &SessionKey,
    ) -> Result<CommitToken, String> {
        if !self.current_main(main)
            || !self.slot.as_ref().is_some_and(|slot| {
                &slot.key == session
                    && !slot.closing
                    && !slot.invalidated
                    && (slot.adopted || !slot.claims.is_empty())
            })
        {
            return Err("Settings open stage is no longer authorized".into());
        }
        Ok(CommitToken {
            main,
            session: session.clone(),
        })
    }

    pub(crate) fn begin_stage(
        &mut self,
        main: MainKey,
        key: &SessionKey,
    ) -> Result<CommitToken, String> {
        let token = self.admit_stage(main, key)?;
        let slot = self.slot.as_mut().expect("admitted slot");
        slot.active_stages = slot
            .active_stages
            .checked_add(1)
            .ok_or("Settings stage count exhausted")?;
        Ok(token)
    }

    pub(crate) fn end_stage(&mut self, key: &SessionKey) -> Option<ClosingTicket> {
        let slot = self.slot.as_mut().filter(|slot| &slot.key == key)?;
        if slot.active_stages == 0 {
            return None;
        }
        slot.active_stages -= 1;
        if slot.active_stages == 0 && !slot.constructing && slot.closing {
            return Some(ClosingTicket(key.clone()));
        }
        self.reserve_closing()
    }

    pub(crate) fn finish_stage(&self, token: &CommitToken) -> Result<(), String> {
        self.admit_stage(token.main, &token.session).map(|_| ())
    }

    pub(crate) fn adopt(&mut self, id: ClaimId, reason: Adoption) -> Result<(), String> {
        if !self.is_live(id) {
            return Err("Settings open request is no longer current".into());
        }
        let claim = self.claims.get(&id).expect("live claim");
        if !matches!(
            (claim.kind, reason),
            (ClaimKind::General, Adoption::GeneralReplyConsumed)
                | (ClaimKind::AppIntent, Adoption::IntentAckAccepted)
        ) {
            return Err("Settings open adoption does not match request".into());
        }
        let key = claim
            .session
            .as_ref()
            .ok_or("Settings request has no session")?;
        let slot = self
            .slot
            .as_mut()
            .filter(|slot| !slot.closing && !slot.invalidated && &slot.key == key)
            .ok_or("Settings session is no longer current")?;
        slot.adopted = true;
        slot.claims.remove(&id);
        self.claims.remove(&id);
        Ok(())
    }

    pub(crate) fn abandon(&mut self, id: ClaimId) -> Option<ClosingTicket> {
        let claim = self.claims.remove(&id)?;
        if let Some(slot) = self.slot.as_mut() {
            if claim.session.as_ref() == Some(&slot.key) {
                slot.claims.remove(&id);
            }
        }
        self.reserve_closing()
    }

    pub(crate) fn fail_constructor(&mut self, key: &SessionKey) -> Option<ClosingTicket> {
        let slot = self.slot.as_mut().filter(|slot| &slot.key == key)?;
        if slot.closing {
            slot.constructing = false;
            return (slot.active_stages == 0).then(|| ClosingTicket(key.clone()));
        }
        slot.invalidated = true;
        slot.closing = true;
        slot.constructing = false;
        slot.claims.clear();
        self.claims
            .retain(|_, claim| claim.session.as_ref() != Some(key));
        (slot.active_stages == 0).then(|| ClosingTicket(key.clone()))
    }

    pub(crate) fn finish_constructor(&mut self, key: &SessionKey) -> Option<ClosingTicket> {
        if let Some(slot) = self.slot.as_mut().filter(|slot| &slot.key == key) {
            slot.constructing = false;
            if slot.closing {
                return (slot.active_stages == 0).then(|| ClosingTicket(key.clone()));
            }
        }
        self.reserve_closing()
    }

    /// Fence an externally initiated close under the same lock as admission.
    pub(crate) fn invalidate_session(&mut self, key: &SessionKey) {
        if let Some(slot) = self.slot.as_mut().filter(|slot| &slot.key == key) {
            slot.invalidated = true;
            slot.closing = true;
            slot.claims.clear();
            self.claims
                .retain(|_, claim| claim.session.as_ref() != Some(key));
        }
    }

    pub(crate) fn busy(&self, key: &SessionKey) -> bool {
        self.slot
            .as_ref()
            .is_some_and(|slot| &slot.key == key && (slot.constructing || slot.active_stages != 0))
    }

    pub(crate) fn constructor_running(&self, key: &SessionKey) -> bool {
        self.slot
            .as_ref()
            .is_some_and(|slot| &slot.key == key && slot.constructing)
    }

    pub(crate) fn has_slot(&self, key: &SessionKey) -> bool {
        self.slot.as_ref().is_some_and(|slot| &slot.key == key)
    }

    pub(crate) fn retire(&mut self, key: &SessionKey) {
        if self
            .slot
            .as_ref()
            .is_some_and(|slot| &slot.key == key && !slot.constructing && slot.active_stages == 0)
        {
            self.claims
                .retain(|_, claim| claim.session.as_ref() != Some(key));
            self.slot = None;
        }
    }

    fn reserve_closing(&mut self) -> Option<ClosingTicket> {
        let slot = self.slot.as_mut()?;
        if !slot.closing && !slot.adopted && slot.claims.is_empty() && !slot.constructing {
            slot.closing = true;
            (slot.active_stages == 0).then(|| ClosingTicket(slot.key.clone()))
        } else {
            None
        }
    }

    fn revoke_all(&mut self) -> Vec<ClosingTicket> {
        if let Some(slot) = self.slot.as_mut() {
            slot.invalidated = true;
            slot.adopted = false;
        }
        let ids: Vec<_> = self.claims.keys().copied().collect();
        let mut tickets: Vec<_> = ids.into_iter().filter_map(|id| self.abandon(id)).collect();
        if let Some(ticket) = self.reserve_closing() {
            tickets.push(ticket);
        }
        tickets
    }
}
