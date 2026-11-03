//! Request fencing for concurrent detached-window opens and cancels.

use parking_lot::MutexGuard;

use super::PluginDetachRuntime;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OpenIntent {
    pub(super) request_id: String,
    epoch: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct CancelOpenMatch {
    pub(crate) latest_intent: bool,
    pub(crate) active_window: bool,
}

impl PluginDetachRuntime {
    pub(crate) fn reserve_open_intent(&self, request_id: &str) -> Result<OpenIntent, String> {
        if uuid::Uuid::parse_str(request_id).is_err() {
            return Err("PLUGIN_HANDOFF_INPUT_INVALID: invalid open request id".into());
        }
        let _commit = self.open_commit_gate.lock();
        let mut state = self.inner.lock();
        state.open_intent_epoch = state.open_intent_epoch.wrapping_add(1);
        let intent = OpenIntent {
            request_id: request_id.to_string(),
            epoch: state.open_intent_epoch,
        };
        state.latest_open = Some(intent.clone());
        Ok(intent)
    }

    pub(crate) fn ensure_latest_open_intent(&self, intent: &OpenIntent) -> Result<(), String> {
        if self.inner.lock().latest_open.as_ref() == Some(intent) {
            Ok(())
        } else {
            Err("PLUGIN_HANDOFF_SUPERSEDED: a newer plugin open was requested".into())
        }
    }

    /// Serializes the final no-await window commit against new intent/cancel RPCs.
    pub(crate) fn begin_open_commit<'a>(
        &'a self,
        intent: &OpenIntent,
    ) -> Result<MutexGuard<'a, ()>, String> {
        let commit = self.open_commit_gate.lock();
        self.ensure_latest_open_intent(intent)?;
        Ok(commit)
    }

    /// A request may cancel its pending intent or its own active window.
    /// The identities are independent so a later occupied open cannot strand
    /// an already-open window or cancel an unrelated pending request.
    pub(crate) fn cancel_open_request(&self, request_id: &str) -> CancelOpenMatch {
        let _commit = self.open_commit_gate.lock();
        let mut state = self.inner.lock();
        let latest_intent = state
            .latest_open
            .as_ref()
            .map(|intent| intent.request_id.as_str())
            == Some(request_id);
        let active_window = state.active_request_id.as_deref() == Some(request_id);
        if latest_intent {
            state.latest_open = None;
        }
        CancelOpenMatch {
            latest_intent,
            active_window,
        }
    }

    #[cfg(test)]
    pub(super) fn latest_request_matches(&self, request_id: &str) -> bool {
        self.inner
            .lock()
            .latest_open
            .as_ref()
            .is_some_and(|intent| intent.request_id == request_id)
    }
}
