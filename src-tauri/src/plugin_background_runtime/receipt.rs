//! One-shot renderer receipts and pause-aware active execution deadline.
use super::{dto::Receipt, store::Intent};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const ACTIVE_DEADLINE: Duration = Duration::from_secs(5);
pub(super) const INTENT_TTL: Duration = Duration::from_secs(300);

#[derive(Default)]
pub(super) struct IntentState {
    pub run_id: Option<String>,
    pub flight: Option<Flight>,
    pub closed: bool,
}

pub(super) struct Flight {
    pub ticket: String,
    pub reply: Option<oneshot::Sender<Result<Receipt, String>>>,
    pub clock: Clock,
}

pub(super) struct Clock {
    spent: Duration,
    active_since: Option<Instant>,
}

impl Clock {
    fn new() -> Self {
        Self {
            spent: Duration::ZERO,
            active_since: Some(Instant::now()),
        }
    }

    fn waiting(&mut self, waiting: bool, now: Instant) {
        if waiting {
            if let Some(start) = self.active_since.take() {
                self.spent += now.saturating_duration_since(start);
            }
        } else if self.active_since.is_none() {
            self.active_since = Some(now);
        }
    }

    pub(super) fn remaining(&self, now: Instant) -> Option<Duration> {
        let remaining = ACTIVE_DEADLINE.saturating_sub(
            self.spent
                + self.active_since.map_or(Duration::ZERO, |started| {
                    now.saturating_duration_since(started)
                }),
        );
        if remaining.is_zero() {
            Some(Duration::ZERO)
        } else {
            self.active_since.map(|_| remaining)
        }
    }
}

impl Intent {
    pub async fn wait_until_expired(&self) -> bool {
        let expiry = self.created + INTENT_TTL;
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            if self.state.lock().closed {
                return false;
            }
            if self.created.elapsed() >= INTENT_TTL {
                return true;
            }
            tokio::select! {
                _ = tokio::time::sleep_until(expiry) => {
                    return !self.state.lock().closed && self.created.elapsed() >= INTENT_TTL;
                }
                _ = &mut changed => {}
            }
        }
    }

    pub fn is_live(&self) -> bool {
        let state = self.state.lock();
        !state.closed && (state.flight.is_some() || self.created.elapsed() < INTENT_TTL)
    }

    pub fn bind_run(&self, run_id: &str) -> Result<(), String> {
        let mut state = self.state.lock();
        if state.closed || self.created.elapsed() >= INTENT_TTL {
            return Err("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED".into());
        }
        if state
            .run_id
            .as_deref()
            .is_some_and(|current| current != run_id)
        {
            return Err("ERR_PLUGIN_BACKGROUND_RUN_BOUND".into());
        }
        state.run_id = Some(run_id.into());
        Ok(())
    }

    pub fn run_id(&self) -> Option<String> {
        self.state.lock().run_id.clone()
    }

    pub fn retire(&self) {
        self.state.lock().closed = true;
        self.changed.notify_one();
    }

    pub fn start(&self) -> Result<(String, oneshot::Receiver<Result<Receipt, String>>), String> {
        let mut state = self.state.lock();
        if state.closed
            || state.flight.is_some()
            || state.run_id.is_none()
            || self.created.elapsed() >= INTENT_TTL
        {
            return Err("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED".into());
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
        let mut state = self.state.lock();
        if state.closed || window != self.window {
            return Err("ERR_PLUGIN_BACKGROUND_RECEIPT_OWNER".into());
        }
        let flight = state
            .flight
            .as_mut()
            .ok_or("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED")?;
        receipt.validate(&self.request, &flight.ticket)?;
        if flight
            .clock
            .remaining(Instant::now())
            .is_some_and(|remaining| remaining.is_zero())
        {
            if let Some(reply) = flight.reply.take() {
                let _ = reply.send(Err("ERR_PLUGIN_BACKGROUND_DEADLINE".into()));
            }
            self.changed.notify_one();
            return Err("ERR_PLUGIN_BACKGROUND_DEADLINE".into());
        }
        let reply = flight
            .reply
            .take()
            .ok_or("ERR_PLUGIN_BACKGROUND_RECEIPT_USED")?;
        flight.clock.waiting(true, Instant::now());
        reply
            .send(Ok(receipt))
            .map_err(|_| "ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED".to_string())
    }

    pub fn waiting(&self, window: &str, ticket: &str, waiting: bool) -> Result<(), String> {
        let mut state = self.state.lock();
        if state.closed || window != self.window {
            return Err("ERR_PLUGIN_BACKGROUND_RECEIPT_OWNER".into());
        }
        let flight = state
            .flight
            .as_mut()
            .ok_or("ERR_PLUGIN_BACKGROUND_REQUEST_CLOSED")?;
        if flight.ticket != ticket || flight.reply.is_none() {
            return Err("ERR_PLUGIN_BACKGROUND_RECEIPT_OWNER".into());
        }
        if flight
            .clock
            .remaining(Instant::now())
            .is_some_and(|remaining| remaining.is_zero())
        {
            if let Some(reply) = flight.reply.take() {
                let _ = reply.send(Err("ERR_PLUGIN_BACKGROUND_DEADLINE".into()));
            }
            self.changed.notify_one();
            return Err("ERR_PLUGIN_BACKGROUND_DEADLINE".into());
        }
        flight.clock.waiting(waiting, Instant::now());
        drop(state);
        self.changed.notify_one();
        Ok(())
    }

    pub fn close(&self) -> Option<String> {
        let mut state = self.state.lock();
        state.closed = true;
        if let Some(mut flight) = state.flight.take() {
            if let Some(reply) = flight.reply.take() {
                let _ = reply.send(Err("ERR_PLUGIN_BACKGROUND_CANCELLED".into()));
            }
        }
        let run_id = state.run_id.clone();
        drop(state);
        self.changed.notify_one();
        run_id
    }
}
