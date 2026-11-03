//! Bounded, window-owned one-shot intents and callback receipts. No input content.
use super::{
    admission::Admission,
    dto::{Identity, Operation, Receipt, Request},
};
use parking_lot::Mutex;
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, Notify};

pub(super) const MAX_GLOBAL: usize = 32;
const MAX_WINDOW: usize = 8;
const APPROVAL_TTL: Duration = Duration::from_secs(300);
#[derive(Default)]
pub(super) struct Runtime(pub Mutex<Store>);
#[derive(Default)]
pub(super) struct Store {
    pub intents: HashMap<String, Arc<Intent>>,
    pub admissions: HashMap<(String, String), Admission>,
}
#[derive(Default)]
pub(super) struct Closed {
    pub intents: Vec<Arc<Intent>>,
    pub prepares: Vec<String>,
}
pub(super) struct Intent {
    pub window: String,
    pub request: Request,
    pub created: Instant,
    pub prepared_by: Option<String>,
    pub state: Mutex<State>,
    pub changed: Notify,
}
#[derive(Default)]
pub(super) struct State {
    pub run: Option<String>,
    pub flight: Option<Flight>,
    pub closed: bool,
}
pub(super) struct Flight {
    pub ticket: String,
    pub reply: Option<oneshot::Sender<Result<Receipt, String>>>,
    pub clock: Clock,
}
pub(super) struct Clock {
    used: Duration,
    active_since: Option<Instant>,
}
impl Clock {
    #[cfg(test)]
    pub(super) fn age_active(&mut self, duration: Duration) {
        self.used = Duration::ZERO;
        self.active_since = Some(Instant::now() - duration);
    }
    fn new() -> Self {
        Self {
            used: Duration::ZERO,
            active_since: Some(Instant::now()),
        }
    }
    pub fn waiting(&mut self, waiting: bool, now: Instant) {
        if waiting {
            if let Some(start) = self.active_since.take() {
                self.used += now.saturating_duration_since(start);
            }
        } else if self.active_since.is_none() {
            self.active_since = Some(now);
        }
    }
    pub fn remaining(&self, budget: Duration, now: Instant) -> Option<Duration> {
        let remaining = budget.saturating_sub(
            self.used
                + self
                    .active_since
                    .map_or(Duration::ZERO, |since| now.saturating_duration_since(since)),
        );
        if remaining.is_zero() {
            Some(Duration::ZERO)
        } else {
            self.active_since.map(|_| remaining)
        }
    }
}
impl Intent {
    pub fn live(&self) -> bool {
        let state = self.state.lock();
        !state.closed && (state.flight.is_some() || self.created.elapsed() < APPROVAL_TTL)
    }
    pub fn start(&self) -> Result<(String, oneshot::Receiver<Result<Receipt, String>>), String> {
        let mut state = self.state.lock();
        if state.closed || state.flight.is_some() || self.created.elapsed() >= APPROVAL_TTL {
            return Err("ERR_MAIN_PUSH_REQUEST_CLOSED".into());
        }
        let (tx, rx) = oneshot::channel();
        let ticket = uuid::Uuid::new_v4().to_string();
        state.flight = Some(Flight {
            ticket: ticket.clone(),
            reply: Some(tx),
            clock: Clock::new(),
        });
        Ok((ticket, rx))
    }
    pub fn complete(&self, window: &str, receipt: Receipt) -> Result<(), String> {
        receipt.validate(self.request.operation)?;
        let mut state = self.state.lock();
        if state.closed || window != self.window || receipt.request_id != self.request.request_id {
            return Err("ERR_MAIN_PUSH_RECEIPT_OWNER".into());
        }
        let flight = state
            .flight
            .as_mut()
            .ok_or("ERR_MAIN_PUSH_REQUEST_CLOSED")?;
        if flight.ticket != receipt.ticket {
            return Err("ERR_MAIN_PUSH_RECEIPT_OWNER".into());
        }
        let now = Instant::now();
        if flight
            .clock
            .remaining(self.request.operation.deadline(), now)
            .is_some_and(|left| left.is_zero())
        {
            if let Some(reply) = flight.reply.take() {
                let _ = reply.send(Err("ERR_MAIN_PUSH_DEADLINE".into()));
            }
            self.changed.notify_one();
            return Err("ERR_MAIN_PUSH_DEADLINE".into());
        }
        let reply = flight.reply.take().ok_or("ERR_MAIN_PUSH_RECEIPT_USED")?;
        // Stop the execution clock at receipt acceptance, not at a later waiter poll.
        flight.clock.waiting(true, now);
        reply
            .send(Ok(receipt))
            .map_err(|_| "ERR_MAIN_PUSH_REQUEST_CLOSED".to_string())
    }
    pub fn waiting(&self, window: &str, ticket: &str, waiting: bool) -> Result<(), String> {
        let mut state = self.state.lock();
        if state.closed || window != self.window {
            return Err("ERR_MAIN_PUSH_RECEIPT_OWNER".into());
        }
        let flight = state
            .flight
            .as_mut()
            .ok_or("ERR_MAIN_PUSH_REQUEST_CLOSED")?;
        if flight.ticket != ticket || flight.reply.is_none() {
            return Err("ERR_MAIN_PUSH_RECEIPT_OWNER".into());
        }
        let now = Instant::now();
        if flight
            .clock
            .remaining(self.request.operation.deadline(), now)
            .is_some_and(|left| left.is_zero())
        {
            if let Some(reply) = flight.reply.take() {
                let _ = reply.send(Err("ERR_MAIN_PUSH_DEADLINE".into()));
            }
            self.changed.notify_one();
            return Err("ERR_MAIN_PUSH_DEADLINE".into());
        }
        flight.clock.waiting(waiting, now);
        drop(state);
        self.changed.notify_one();
        Ok(())
    }
    pub fn close(&self) -> Option<String> {
        let mut state = self.state.lock();
        state.closed = true;
        if let Some(mut flight) = state.flight.take() {
            if let Some(reply) = flight.reply.take() {
                let _ = reply.send(Err("ERR_MAIN_PUSH_CANCELLED".into()));
            }
        }
        let run = state.run.clone();
        drop(state);
        self.changed.notify_one();
        run
    }
}
impl Runtime {
    // Revoke only the admission that authorized this failed Select. A late old
    // lease cannot close a newly prepared instance reusing a renderer runner id.
    pub(super) fn finish(&self, intent: &Arc<Intent>, success: bool) -> Closed {
        let mut store = self.0.lock();
        if store
            .intents
            .get(&intent.request.request_id)
            .is_some_and(|current| Arc::ptr_eq(current, intent))
        {
            store.intents.remove(&intent.request.request_id);
        }
        let Some(prepared) = intent
            .prepared_by
            .as_deref()
            .filter(|_| intent.request.operation == Operation::Select && !success)
        else {
            return Closed::default();
        };
        let key = (intent.window.clone(), intent.request.runner_id.clone());
        let prepares = if store
            .admissions
            .get(&key)
            .is_some_and(|a| a.run == prepared)
        {
            store
                .admissions
                .remove(&key)
                .map(|a| a.run)
                .into_iter()
                .collect()
        } else {
            Vec::new()
        };
        let ids = store
            .intents
            .iter()
            .filter(|(_, other)| {
                other.window == intent.window
                    && other.request.runner_id == intent.request.runner_id
                    && other.prepared_by.as_deref() == Some(prepared)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        Closed {
            intents: ids
                .into_iter()
                .filter_map(|id| store.intents.remove(&id))
                .collect(),
            prepares,
        }
    }
    pub fn begin(&self, window: String, request: Request) -> Result<Arc<Intent>, String> {
        request.validate()?;
        if window.is_empty() || window.len() > 128 || window.chars().any(char::is_control) {
            return Err("ERR_MAIN_PUSH_UI_REQUIRED".into());
        }
        let mut store = self.0.lock();
        if let Some(admission) = store
            .admissions
            .get(&(window.clone(), request.runner_id.clone()))
        {
            if !admission.identity.same_code(&request.identity)
                || request.operation == Operation::Prepare
            {
                return Err("ERR_MAIN_PUSH_RUNNER_CHANGED".into());
            }
        }
        let prepared_by = store
            .admissions
            .get(&(window.clone(), request.runner_id.clone()))
            .map(|a| a.run.clone());
        let items = &mut store.intents;
        if items.contains_key(&request.request_id) {
            return Err("ERR_MAIN_PUSH_DUPLICATE_REQUEST".into());
        }
        let owned = items
            .values()
            .filter(|i| i.window == window)
            .cloned()
            .collect::<Vec<_>>();
        let mut runners = owned
            .iter()
            .map(|i| i.request.runner_id.clone())
            .collect::<HashSet<_>>();
        runners.extend(
            store
                .admissions
                .values()
                .filter(|a| a.window == window)
                .map(|a| a.runner.clone()),
        );
        let items = &mut store.intents;
        if items.len() >= MAX_GLOBAL
            || owned.len() >= MAX_WINDOW
            || (!runners.contains(&request.runner_id) && runners.len() >= 2)
            || owned.iter().any(|i| {
                i.request.runner_id == request.runner_id && i.request.operation == request.operation
            })
        {
            return Err("ERR_MAIN_PUSH_CAPACITY".into());
        }
        let intent = Arc::new(Intent {
            window,
            request,
            created: Instant::now(),
            prepared_by,
            state: Mutex::new(State::default()),
            changed: Notify::new(),
        });
        items.insert(intent.request.request_id.clone(), intent.clone());
        Ok(intent)
    }
    pub fn get(&self, request: &str) -> Result<Arc<Intent>, String> {
        self.0
            .lock()
            .intents
            .get(request)
            .filter(|i| i.live())
            .cloned()
            .ok_or_else(|| "ERR_MAIN_PUSH_REQUEST_CLOSED".into())
    }
    pub fn remove(&self, request: &str, window: Option<&str>) -> Option<Arc<Intent>> {
        let mut store = self.0.lock();
        let items = &mut store.intents;
        if items
            .get(request)
            .is_some_and(|i| window.is_none_or(|w| i.window == w))
        {
            items.remove(request)
        } else {
            None
        }
    }
    pub fn close(
        &self,
        window: Option<&str>,
        plugin: Option<&str>,
        runner: Option<&str>,
        expired: bool,
    ) -> Closed {
        let mut store = self.0.lock();
        let ids = store
            .intents
            .iter()
            .filter(|(_, i)| {
                window.is_none_or(|w| i.window == w)
                    && plugin.is_none_or(|p| i.request.identity.plugin_id == p)
                    && runner.is_none_or(|r| i.request.runner_id == r)
                    && (!expired || !i.live())
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let admissions = store
            .admissions
            .iter()
            .filter(|(_, a)| {
                window.is_none_or(|w| a.window == w)
                    && plugin.is_none_or(|p| a.identity.plugin_id == p)
                    && runner.is_none_or(|r| a.runner == r)
                    && (!expired || a.used.elapsed() >= super::admission::TTL)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        Closed {
            intents: ids
                .into_iter()
                .filter_map(|id| store.intents.remove(&id))
                .collect(),
            prepares: admissions
                .into_iter()
                .filter_map(|id| store.admissions.remove(&id).map(|a| a.run))
                .collect(),
        }
    }
    #[cfg(test)]
    pub fn take(
        &self,
        window: Option<&str>,
        plugin: Option<&str>,
        expired: bool,
    ) -> Vec<Arc<Intent>> {
        self.close(window, plugin, None, expired).intents
    }
    pub fn ready(&self, intent: &Arc<Intent>) -> Result<(), String> {
        if intent.request.operation != Operation::Prepare {
            return Err("ERR_MAIN_PUSH_PREPARE_REQUIRED".into());
        }
        let mut store = self.0.lock();
        if !store
            .intents
            .get(&intent.request.request_id)
            .is_some_and(|current| Arc::ptr_eq(current, intent))
        {
            return Err("ERR_MAIN_PUSH_CANCELLED".into());
        }
        let state = intent.state.lock();
        if state.closed {
            return Err("ERR_MAIN_PUSH_CANCELLED".into());
        }
        let run = state.run.clone().ok_or("ERR_MAIN_PUSH_PREPARE_REQUIRED")?;
        let key = (intent.window.clone(), intent.request.runner_id.clone());
        if store.admissions.len() >= MAX_GLOBAL && !store.admissions.contains_key(&key) {
            return Err("ERR_MAIN_PUSH_CAPACITY".into());
        }
        store.admissions.insert(
            key,
            Admission {
                window: intent.window.clone(),
                runner: intent.request.runner_id.clone(),
                identity: intent.request.identity.clone(),
                request: intent.request.request_id.clone(),
                run,
                used: Instant::now(),
            },
        );
        Ok(())
    }
    pub fn admission(
        &self,
        window: &str,
        runner: &str,
        identity: &Identity,
    ) -> Result<Admission, String> {
        let store = self.0.lock();
        let admission = store
            .admissions
            .get(&(window.into(), runner.into()))
            .ok_or("ERR_MAIN_PUSH_PREPARE_REQUIRED")?;
        if !admission.identity.same_code(identity)
            || admission.used.elapsed() >= super::admission::TTL
        {
            return Err("ERR_MAIN_PUSH_PREPARE_EXPIRED".into());
        }
        Ok(admission.clone())
    }
    pub fn touch(&self, admission: &Admission) -> Result<(), String> {
        let mut store = self.0.lock();
        let current = store
            .admissions
            .get_mut(&(admission.window.clone(), admission.runner.clone()))
            .ok_or("ERR_MAIN_PUSH_PREPARE_REQUIRED")?;
        if current.run != admission.run || current.identity != admission.identity {
            return Err("ERR_MAIN_PUSH_RUNNER_CHANGED".into());
        }
        current.used = Instant::now();
        Ok(())
    }
    pub fn preparation_runner(&self, window: &str, request: &str) -> Option<String> {
        self.0
            .lock()
            .admissions
            .values()
            .find(|a| a.window == window && a.request == request)
            .map(|a| a.runner.clone())
    }
}
