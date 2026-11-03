use std::collections::VecDeque;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_CANCELLED_PROBES: usize = 32;

#[derive(Debug, Eq, PartialEq)]
pub(super) enum BeginError {
    Finished,
    Busy,
    Exhausted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProbeIdentity {
    token: String,
    id: u64,
    operation: String,
    caller: String,
}

impl ProbeIdentity {
    fn matches(&self, token: &str, id: u64, operation: &str, caller: &str) -> bool {
        self.token == token && self.id == id && self.operation == operation && self.caller == caller
    }
}

struct Pending<T> {
    identity: ProbeIdentity,
    value: T,
}

#[derive(Debug, Eq, PartialEq)]
pub(super) enum ProbeReply<T> {
    Matched(T),
    Cancelled,
    Rejected,
}

pub(super) struct PendingProbes<T> {
    last_id: u64,
    finished: bool,
    pending: Option<Pending<T>>,
    cancelled: VecDeque<ProbeIdentity>,
}

impl<T> Default for PendingProbes<T> {
    fn default() -> Self {
        Self {
            last_id: 0,
            finished: false,
            pending: None,
            cancelled: VecDeque::new(),
        }
    }
}

impl<T> PendingProbes<T> {
    pub(super) fn begin(
        &mut self,
        token: &str,
        operation: &str,
        caller: &str,
        value: T,
    ) -> Result<u64, BeginError> {
        if self.finished {
            return Err(BeginError::Finished);
        }
        if self.pending.is_some() {
            return Err(BeginError::Busy);
        }
        let id = self
            .last_id
            .checked_add(1)
            .filter(|id| *id <= MAX_SAFE_INTEGER)
            .ok_or(BeginError::Exhausted)?;
        self.last_id = id;
        self.pending = Some(Pending {
            identity: ProbeIdentity {
                token: token.to_owned(),
                id,
                operation: operation.to_owned(),
                caller: caller.to_owned(),
            },
            value,
        });
        Ok(id)
    }

    pub(super) fn take_reply(
        &mut self,
        token: &str,
        id: u64,
        operation: &str,
        caller: &str,
    ) -> ProbeReply<T> {
        if self.finished {
            return ProbeReply::Rejected;
        }
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.identity.matches(token, id, operation, caller))
        {
            return self.pending.take().map_or(ProbeReply::Rejected, |pending| {
                ProbeReply::Matched(pending.value)
            });
        }
        if let Some(index) = self
            .cancelled
            .iter()
            .position(|identity| identity.matches(token, id, operation, caller))
        {
            self.cancelled.remove(index);
            return ProbeReply::Cancelled;
        }
        ProbeReply::Rejected
    }

    pub(super) fn discard_cancelled(
        &mut self,
        token: &str,
        id: u64,
        operation: &str,
        caller: &str,
    ) -> bool {
        if self.finished {
            return false;
        }
        let Some(index) = self
            .cancelled
            .iter()
            .position(|identity| identity.matches(token, id, operation, caller))
        else {
            return false;
        };
        self.cancelled.remove(index);
        true
    }

    pub(super) fn cancel(&mut self, id: u64) -> Option<T> {
        if self.finished || self.pending.as_ref()?.identity.id != id {
            return None;
        }
        self.pending.take().map(|pending| {
            self.cancelled.push_back(pending.identity);
            if self.cancelled.len() > MAX_CANCELLED_PROBES {
                self.cancelled.pop_front();
            }
            pending.value
        })
    }

    pub(super) fn finish(&mut self) -> Option<T> {
        self.finished = true;
        self.cancelled.clear();
        self.pending.take().map(|pending| pending.value)
    }

    pub(super) fn is_pending(&self) -> bool {
        self.pending.is_some()
    }
}

pub(super) fn valid_probe_id(operation: &str, id: u64) -> bool {
    if operation == "mainReady" {
        id == 0
    } else {
        id > 0 && id <= MAX_SAFE_INTEGER
    }
}

#[cfg(test)]
mod tests {
    use super::{
        valid_probe_id, BeginError, PendingProbes, ProbeReply, MAX_CANCELLED_PROBES,
        MAX_SAFE_INTEGER,
    };

    #[test]
    fn same_operation_requires_the_current_monotonic_id() {
        let mut pending = PendingProbes::default();
        let first = pending
            .begin("token", "mainInspect", "main", "first")
            .unwrap();
        assert_eq!(first, 1);
        assert!(matches!(
            pending.take_reply("token", first, "mainInspect", "main"),
            ProbeReply::Matched("first")
        ));
        assert!(matches!(
            pending.take_reply("token", first, "mainInspect", "main"),
            ProbeReply::Rejected
        ));

        let second = pending
            .begin("token", "mainInspect", "main", "second")
            .unwrap();
        assert_eq!(second, 2);
        assert_eq!(
            pending.take_reply("token", first, "mainInspect", "main"),
            ProbeReply::Rejected
        );
        assert!(pending.is_pending());
        assert!(matches!(
            pending.take_reply("token", second, "mainInspect", "main"),
            ProbeReply::Matched("second")
        ));
    }

    #[test]
    fn reply_must_match_token_operation_and_caller() {
        let mut pending = PendingProbes::default();
        let id = pending
            .begin("token", "childValue", "ztools-settings-a", ())
            .unwrap();
        assert!(matches!(
            pending.take_reply("wrong", id, "childValue", "ztools-settings-a"),
            ProbeReply::Rejected
        ));
        assert!(matches!(
            pending.take_reply("token", id, "childClear", "ztools-settings-a"),
            ProbeReply::Rejected
        ));
        assert!(matches!(
            pending.take_reply("token", id, "childValue", "ztools-settings-b"),
            ProbeReply::Rejected
        ));
        assert!(pending.is_pending());
        assert!(matches!(
            pending.take_reply("token", id, "childValue", "ztools-settings-a"),
            ProbeReply::Matched(())
        ));
    }

    #[test]
    fn cancellation_cannot_clear_a_new_request_and_finish_closes_the_slot() {
        let mut pending = PendingProbes::default();
        let cancelled_id = pending
            .begin("token", "mainInspect", "main", "cancelled")
            .unwrap();
        assert_eq!(pending.cancel(cancelled_id), Some("cancelled"));
        let current_id = pending
            .begin("token", "mainInspect", "main", "current")
            .unwrap();
        assert_eq!(
            pending.take_reply("token", cancelled_id, "mainInspect", "main"),
            ProbeReply::Cancelled
        );
        assert!(pending.is_pending());
        assert_eq!(pending.finish(), Some("current"));
        assert_eq!(
            pending.take_reply("token", current_id, "mainInspect", "main"),
            ProbeReply::Rejected
        );
        assert_eq!(
            pending.take_reply("token", cancelled_id, "mainInspect", "main"),
            ProbeReply::Rejected
        );
        assert!(!pending.is_pending());
        assert_eq!(
            pending.begin("token", "mainInspect", "main", "late"),
            Err(BeginError::Finished)
        );
    }

    #[test]
    fn ready_reserves_zero_and_new_requests_are_safe_integers() {
        assert!(valid_probe_id("mainReady", 0));
        assert!(!valid_probe_id("mainReady", 1));
        assert!(!valid_probe_id("mainInspect", 0));
        assert!(valid_probe_id("mainInspect", 1));
        assert!(!valid_probe_id("mainInspect", MAX_SAFE_INTEGER + 1));

        let mut pending = PendingProbes::default();
        pending.last_id = MAX_SAFE_INTEGER;
        assert_eq!(
            pending.begin("token", "mainInspect", "main", ()),
            Err(BeginError::Exhausted)
        );
    }

    #[test]
    fn a_busy_or_cancelled_slot_cannot_clear_a_new_pending_request() {
        let mut pending = PendingProbes::default();
        let first = pending.begin("token", "mainInspect", "main", 1).unwrap();
        assert_eq!(
            pending.begin("token", "mainInspect", "main", 2),
            Err(BeginError::Busy)
        );
        assert_eq!(pending.cancel(first + 1), None);
        assert!(pending.is_pending());
        assert_eq!(pending.cancel(first), Some(1));
        let second = pending.begin("token", "mainInspect", "main", 3).unwrap();
        assert_eq!(pending.cancel(first), None);
        assert!(matches!(
            pending.take_reply("token", second, "mainInspect", "main"),
            ProbeReply::Matched(3)
        ));
    }

    #[test]
    fn cancelled_reply_requires_full_identity_is_consumed_once_and_preserves_current_pending() {
        let mut pending = PendingProbes::default();
        let cancelled_id = pending
            .begin("token", "childValue", "ztools-settings-a", 1)
            .unwrap();
        assert_eq!(pending.cancel(cancelled_id), Some(1));
        let current_id = pending
            .begin("token", "childClear", "ztools-settings-b", 2)
            .unwrap();

        assert_eq!(
            pending.take_reply("wrong", cancelled_id, "childValue", "ztools-settings-a"),
            ProbeReply::Rejected
        );
        assert_eq!(
            pending.take_reply("token", cancelled_id, "childClear", "ztools-settings-a"),
            ProbeReply::Rejected
        );
        assert_eq!(
            pending.take_reply("token", cancelled_id, "childValue", "ztools-settings-b"),
            ProbeReply::Rejected
        );
        assert!(pending.is_pending());
        assert_eq!(
            pending.take_reply("token", cancelled_id, "childValue", "ztools-settings-a"),
            ProbeReply::Cancelled
        );
        assert_eq!(
            pending.take_reply("token", cancelled_id, "childValue", "ztools-settings-a"),
            ProbeReply::Rejected
        );
        assert!(pending.is_pending());
        assert!(matches!(
            pending.take_reply("token", current_id, "childClear", "ztools-settings-b"),
            ProbeReply::Matched(2)
        ));
    }

    #[test]
    fn cancellation_ledger_is_bounded_and_evicts_oldest_identity() {
        let mut pending = PendingProbes::default();
        let mut ids = Vec::new();
        for _ in 0..=MAX_CANCELLED_PROBES {
            let id = pending.begin("token", "mainInspect", "main", ()).unwrap();
            ids.push(id);
            assert_eq!(pending.cancel(id), Some(()));
        }
        assert_eq!(pending.cancelled.len(), MAX_CANCELLED_PROBES);
        assert_eq!(
            pending.take_reply("token", ids[0], "mainInspect", "main"),
            ProbeReply::Rejected
        );
        assert_eq!(
            pending.take_reply("token", ids[1], "mainInspect", "main"),
            ProbeReply::Cancelled
        );
    }

    #[test]
    fn finish_rejects_and_clears_all_cancelled_reply_tombstones() {
        let mut pending = PendingProbes::default();
        let id = pending.begin("token", "mainInspect", "main", ()).unwrap();
        assert_eq!(pending.cancel(id), Some(()));
        assert!(pending.discard_cancelled("token", id, "mainInspect", "main"));

        let id = pending.begin("token", "mainInspect", "main", ()).unwrap();
        assert_eq!(pending.cancel(id), Some(()));
        assert_eq!(pending.finish(), None);
        assert!(!pending.discard_cancelled("token", id, "mainInspect", "main"));
        assert_eq!(
            pending.take_reply("token", id, "mainInspect", "main"),
            ProbeReply::Rejected
        );
    }
}
