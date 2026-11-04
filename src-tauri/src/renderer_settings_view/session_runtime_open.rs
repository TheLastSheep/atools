use super::super::super::bundle::SettingsBundle;
use super::super::super::open_claims::{
    Adoption, ClaimId, ClaimKind, ClosingTicket, MainKey, SessionKey,
};
use super::SettingsViewRuntime;
use std::sync::{atomic::Ordering, Arc};

impl SettingsViewRuntime {
    pub(crate) fn begin_bundle_load(&self) -> bool {
        self.bundle_load_active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    pub(crate) fn end_bundle_load(&self) {
        self.bundle_load_active.store(false, Ordering::Release);
    }

    pub(crate) fn cached_bundle(&self) -> Result<Option<Arc<SettingsBundle>>, String> {
        self.inner
            .lock()
            .map(|inner| inner.cached_bundle.clone())
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())
    }

    pub(crate) fn register_main_instance(&self) -> Result<(u64, Vec<ClosingTicket>), String> {
        let (result, pending) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
            let result = inner.open_claims.register_main_instance()?;
            inner.main_binding = None;
            let pending = super::intent::cancel_invalid_intent(&mut inner);
            (result, pending)
        };
        drop(pending);
        Ok(result)
    }

    pub(crate) fn note_main_started(
        &self,
        instance: u64,
    ) -> Result<(MainKey, Vec<ClosingTicket>), String> {
        let (result, pending) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
            let result = inner.open_claims.note_main_started(instance)?;
            inner.main_binding = None;
            let pending = super::intent::cancel_invalid_intent(&mut inner);
            (result, pending)
        };
        drop(pending);
        Ok(result)
    }

    #[cfg(test)]
    pub(crate) fn finished_main(&self) -> Option<MainKey> {
        self.inner.lock().ok()?.open_claims.finished_main()
    }

    pub(crate) fn current_main_key(&self) -> Option<MainKey> {
        self.inner.lock().ok()?.open_claims.current_key()
    }

    pub(crate) fn note_main_finished(&self, key: MainKey) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?
            .open_claims
            .note_main_finished(key)
    }

    pub(crate) fn note_main_destroyed(&self, instance: u64) -> Result<Vec<ClosingTicket>, String> {
        let (tickets, pending) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
            let matched = inner.open_claims.registered_instance_is(instance);
            let tickets = inner.open_claims.note_main_destroyed(instance);
            if matched {
                inner.main_binding = None;
            }
            let pending = super::intent::cancel_invalid_intent(&mut inner);
            (tickets, pending)
        };
        drop(pending);
        Ok(tickets)
    }

    pub(crate) fn admit_request(
        &self,
        main: MainKey,
        kind: ClaimKind,
    ) -> Result<(ClaimId, Option<u64>, Vec<ClosingTicket>), String> {
        let (result, pending) = {
            let mut inner = self
                .inner
                .lock()
                .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
            let result = inner.open_claims.admit_request(main, kind)?;
            let pending = super::intent::cancel_invalid_intent(&mut inner);
            (result, pending)
        };
        drop(pending);
        Ok(result)
    }

    pub(crate) fn open_claim_live(&self, id: ClaimId) -> bool {
        self.inner
            .lock()
            .is_ok_and(|inner| inner.open_claims.is_live(id))
    }

    #[cfg(test)]
    pub(crate) fn join_or_start(
        &self,
        id: ClaimId,
        fresh: SessionKey,
    ) -> Result<(SessionKey, bool), String> {
        self.inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?
            .open_claims
            .join_or_start(id, fresh)
    }

    pub(crate) fn join_open_flight(
        &self,
        id: ClaimId,
        main: super::super::super::main_authority::CapturedMain,
    ) -> Result<
        (
            super::super::super::open_claims::SessionKey,
            Arc<std::sync::atomic::AtomicBool>,
            tokio::sync::watch::Receiver<Option<Result<serde_json::Value, String>>>,
            bool,
        ),
        String,
    > {
        use super::super::super::open_service::OpenFlight;
        let mut inner = self
            .inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?;
        let revoked = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let fresh = SessionKey {
            id: uuid::Uuid::new_v4().simple().to_string(),
            revoked_identity: Arc::as_ptr(&revoked) as usize,
        };
        let (key, start) = inner.open_claims.join_or_start(id, fresh)?;
        if start {
            let (result, _) = tokio::sync::watch::channel(None);
            let (activity, _) = tokio::sync::watch::channel(0);
            inner.open_flight = Some(OpenFlight {
                key: key.clone(),
                revoked,
                result,
                activity,
                main,
            });
        }
        let flight = inner
            .open_flight
            .as_ref()
            .filter(|flight| flight.key == key)
            .ok_or("Settings open reservation is unavailable")?;
        Ok((
            key,
            Arc::clone(&flight.revoked),
            flight.result.subscribe(),
            start,
        ))
    }

    pub(crate) fn finish_open_flight(
        &self,
        key: &SessionKey,
        result: Result<serde_json::Value, String>,
    ) -> Option<ClosingTicket> {
        let failed = result.is_err();
        let (sender, activity, ticket, pending) = {
            let mut inner = self.inner.lock().ok()?;
            let sender = inner
                .open_flight
                .as_ref()
                .filter(|flight| &flight.key == key)
                .map(|flight| flight.result.clone());
            let activity = inner
                .open_flight
                .as_ref()
                .filter(|flight| &flight.key == key)
                .map(|flight| flight.activity.clone());
            let ticket = if failed {
                inner.open_claims.fail_constructor(key)
            } else {
                inner.open_claims.finish_constructor(key)
            };
            let pending = super::intent::cancel_invalid_intent(&mut inner);
            (sender, activity, ticket, pending)
        };
        drop(pending);
        if let Some(activity) = activity {
            activity.send_modify(|value| *value = value.wrapping_add(1));
        }
        if let Some(sender) = sender {
            sender.send_replace(Some(result));
        }
        ticket
    }

    pub(crate) fn begin_owned_stage(
        &self,
        main: MainKey,
        key: &SessionKey,
    ) -> Result<super::super::super::open_claims::CommitToken, String> {
        self.inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?
            .open_claims
            .begin_stage(main, key)
    }

    pub(crate) fn end_owned_stage(&self, key: &SessionKey) -> Option<ClosingTicket> {
        let (ticket, activity) = {
            let mut inner = self.inner.lock().ok()?;
            let ticket = inner.open_claims.end_stage(key);
            let activity = inner
                .open_flight
                .as_ref()
                .filter(|flight| &flight.key == key)
                .map(|flight| flight.activity.clone());
            (ticket, activity)
        };
        if let Some(activity) = activity {
            activity.send_modify(|value| *value = value.wrapping_add(1));
        }
        ticket
    }

    pub(crate) fn admit_open_stage(
        &self,
        main: MainKey,
        key: &SessionKey,
    ) -> Result<super::super::super::open_claims::CommitToken, String> {
        self.inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?
            .open_claims
            .admit_stage(main, key)
    }

    pub(crate) fn finish_open_stage(
        &self,
        token: &super::super::super::open_claims::CommitToken,
    ) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?
            .open_claims
            .finish_stage(token)
    }

    pub(crate) fn adopt_open(&self, id: ClaimId, reason: Adoption) -> Result<(), String> {
        self.inner
            .lock()
            .map_err(|_| "Settings view runtime state is unavailable".to_owned())?
            .open_claims
            .adopt(id, reason)
    }

    pub(crate) fn abandon_open(&self, id: ClaimId) -> Option<ClosingTicket> {
        let (ticket, pending) = {
            let mut inner = self.inner.lock().ok()?;
            let ticket = inner.open_claims.abandon(id);
            let pending = super::intent::cancel_invalid_intent(&mut inner);
            (ticket, pending)
        };
        drop(pending);
        ticket
    }

    #[cfg(test)]
    pub(crate) fn finish_open_constructor(&self, key: &SessionKey) -> Option<ClosingTicket> {
        self.inner.lock().ok()?.open_claims.finish_constructor(key)
    }

    pub(crate) fn open_activity_signal(
        &self,
        key: &SessionKey,
    ) -> Option<tokio::sync::watch::Receiver<u64>> {
        let inner = self.inner.lock().ok()?;
        inner
            .open_flight
            .as_ref()
            .filter(|flight| &flight.key == key)
            .map(|flight| flight.activity.subscribe())
    }

    pub(crate) fn open_busy(&self, key: &SessionKey) -> bool {
        self.inner
            .lock()
            .map_or(true, |inner| inner.open_claims.busy(key))
    }

    pub(crate) fn open_main(
        &self,
        key: &SessionKey,
    ) -> Option<super::super::super::main_authority::CapturedMain> {
        let inner = self.inner.lock().ok()?;
        inner
            .open_flight
            .as_ref()
            .filter(|flight| &flight.key == key)
            .map(|flight| flight.main.clone())
    }

    pub(crate) fn retire_open(&self, key: &SessionKey) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.open_claims.retire(key);
            if !inner.open_claims.has_slot(key)
                && inner
                    .open_flight
                    .as_ref()
                    .is_some_and(|flight| &flight.key == key)
            {
                inner.open_flight = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn main(runtime: &SettingsViewRuntime) -> MainKey {
        let (instance, _) = runtime.register_main_instance().unwrap();
        let (key, _) = runtime.note_main_started(instance).unwrap();
        runtime.note_main_finished(key).unwrap();
        key
    }

    fn key(id: &str) -> SessionKey {
        SessionKey {
            id: id.into(),
            revoked_identity: 7,
        }
    }

    #[test]
    fn caller_adoption_and_constructor_lifetime_are_arbitrated_under_runtime() {
        let runtime = SettingsViewRuntime::default();
        let main = main(&runtime);
        let (a, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
        let (b, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
        let (session, started) = runtime.join_or_start(a, key("one")).unwrap();
        assert!(started);
        assert_eq!(
            runtime.join_or_start(b, key("two")).unwrap(),
            (session.clone(), false)
        );
        assert!(runtime.abandon_open(a).is_none());
        runtime
            .adopt_open(b, Adoption::GeneralReplyConsumed)
            .unwrap();
        assert!(runtime.finish_open_constructor(&session).is_none());
    }

    #[test]
    fn last_abandon_waits_for_constructor_and_reserves_exact_slot() {
        let runtime = SettingsViewRuntime::default();
        let main = main(&runtime);
        let (id, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
        let (session, _) = runtime.join_or_start(id, key("one")).unwrap();
        assert!(runtime.abandon_open(id).is_none());
        assert_eq!(
            runtime.finish_open_constructor(&session).unwrap().0,
            session
        );
        let (next, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
        assert!(runtime.join_or_start(next, key("two")).is_err());
        runtime.retire_open(&session);
        assert!(runtime.join_or_start(next, key("two")).unwrap().1);
    }

    #[test]
    fn reload_and_old_window_events_cannot_authorize_claims() {
        let runtime = SettingsViewRuntime::default();
        let first = main(&runtime);
        let (claim, _, _) = runtime.admit_request(first, ClaimKind::General).unwrap();
        let (second, _) = runtime.note_main_started(first.window_instance).unwrap();
        assert!(!runtime.open_claim_live(claim));
        assert!(runtime.admit_request(second, ClaimKind::General).is_err());
        runtime.note_main_finished(second).unwrap();
        let (new_instance, _) = runtime.register_main_instance().unwrap();
        assert!(runtime.note_main_started(first.window_instance).is_err());
        runtime.note_main_destroyed(first.window_instance).unwrap();
        assert!(runtime.note_main_started(new_instance).is_ok());
    }
    #[test]
    fn newer_intent_supersedes_old_without_closing_its_slot() {
        let runtime = SettingsViewRuntime::default();
        let main = main(&runtime);
        let (old, old_seq, _) = runtime.admit_request(main, ClaimKind::AppIntent).unwrap();
        let (session, _) = runtime.join_or_start(old, key("one")).unwrap();
        assert!(runtime.finish_open_constructor(&session).is_none());
        let (new, seq, tickets) = runtime.admit_request(main, ClaimKind::AppIntent).unwrap();
        assert!(seq > old_seq);
        assert!(tickets.is_empty());
        assert!(!runtime.open_claim_live(old));
        assert_eq!(
            runtime.join_or_start(new, key("two")).unwrap(),
            (session, false)
        );
    }

    #[test]
    fn claim_quota_is_bounded() {
        let runtime = SettingsViewRuntime::default();
        let main = main(&runtime);
        for _ in 0..32 {
            runtime.admit_request(main, ClaimKind::General).unwrap();
        }
        assert!(runtime.admit_request(main, ClaimKind::General).is_err());
    }
    #[test]
    fn reload_closes_adopted_session_and_fences_preparing_slot() {
        let runtime = SettingsViewRuntime::default();
        let first = main(&runtime);
        let (claim, _, _) = runtime.admit_request(first, ClaimKind::General).unwrap();
        let (session, _) = runtime.join_or_start(claim, key("adopted")).unwrap();
        runtime
            .adopt_open(claim, Adoption::GeneralReplyConsumed)
            .unwrap();
        runtime.finish_open_constructor(&session);
        let (second, tickets) = runtime.note_main_started(first.window_instance).unwrap();
        assert_eq!(tickets, vec![ClosingTicket(session.clone())]);
        runtime.note_main_finished(second).unwrap();
        let (next, _, _) = runtime.admit_request(second, ClaimKind::General).unwrap();
        assert!(runtime.join_or_start(next, key("other")).is_err());
        runtime.retire_open(&session);
        let (preparing, _) = runtime.join_or_start(next, key("preparing")).unwrap();
        let (third, tickets) = runtime.note_main_started(second.window_instance).unwrap();
        assert!(tickets.is_empty());
        runtime.note_main_finished(third).unwrap();
        let (latest, _, _) = runtime.admit_request(third, ClaimKind::General).unwrap();
        assert!(runtime.join_or_start(latest, key("new")).is_err());
        assert_eq!(
            runtime.finish_open_constructor(&preparing),
            Some(ClosingTicket(preparing))
        );
    }
    #[test]
    fn stage_cannot_continue_after_last_interest_or_main_revoke() {
        let runtime = SettingsViewRuntime::default();
        let main = main(&runtime);
        let (claim, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
        let (session, _) = runtime.join_or_start(claim, key("one")).unwrap();
        let token = runtime.admit_open_stage(main, &session).unwrap();
        assert!(runtime.abandon_open(claim).is_none());
        assert!(runtime.finish_open_stage(&token).is_err());
        let (_, _) = runtime.note_main_started(main.window_instance).unwrap();
        assert!(runtime.finish_open_stage(&token).is_err());
        assert_eq!(
            runtime.finish_open_constructor(&session),
            Some(ClosingTicket(session))
        );
    }

    #[test]
    fn externally_closing_constructor_keeps_slot_until_owner_exits() {
        let runtime = SettingsViewRuntime::default();
        let main = main(&runtime);
        let (claim, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
        let (session, _) = runtime.join_or_start(claim, key("old")).unwrap();
        {
            let mut inner = runtime.inner.lock().unwrap();
            inner.open_claims.invalidate_session(&session);
        }
        runtime.retire_open(&session);
        let (new, _, _) = runtime.admit_request(main, ClaimKind::General).unwrap();
        assert!(runtime.join_or_start(new, key("new")).is_err());
        assert_eq!(
            runtime.finish_open_constructor(&session),
            Some(ClosingTicket(session.clone()))
        );
        runtime.retire_open(&session);
        assert!(runtime.join_or_start(new, key("new")).unwrap().1);
    }
}
