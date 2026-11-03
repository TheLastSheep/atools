//! Passive fixture-only observations; never input synthesis or GUI acceptance.
use super::Session;
use crate::hotkey::recording::{Ack, Notice, Outcome};
use parking_lot::Mutex;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

const CAPACITY: usize = 32;
#[derive(Default)]
pub(super) struct Witness {
    entries: Mutex<Vec<Value>>,
    overflow: std::sync::atomic::AtomicUsize,
}
impl Witness {
    fn push(&self, entry: Value) {
        let mut entries = self.entries.lock();
        if entries.len() < CAPACITY {
            entries.push(entry);
        } else {
            self.overflow
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
    }
    pub(super) fn snapshot(&self) -> Value {
        json!({"capacity":CAPACITY,"entries":self.entries.lock().clone(),
            "overflow":self.overflow.load(std::sync::atomic::Ordering::Relaxed),
            "frontendReceipt":"unverified"})
    }
}
pub(crate) fn ack(app: &AppHandle, ack: &Ack) {
    if let Some(session) = app.try_state::<Session>() {
        session.witness.push(
            json!({"sessionId":ack.session_id,"generation":ack.generation,
            "mode":ack.mode,"terminalStatus":if ack.active {"ack-active"} else {"ack-inactive"}}),
        );
    }
}
pub(crate) fn notice_submitted(app: &AppHandle, notice: &Notice, eval_ok: bool) {
    if let Some(session) = app.try_state::<Session>() {
        let status = match notice.outcome {
            Outcome::Recorded => "recorded",
            Outcome::Stopped(reason) => reason,
        };
        session
            .witness
            .push(json!({"sessionId":notice.target.session_id,
            "generation":notice.generation,"mode":null,"terminalStatus":status,
            "evalSubmission":if eval_ok {"accepted"} else {"failed"}}));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn witness_is_bounded_and_reports_every_overflow() {
        let witness = Witness::default();
        for generation in 0..35 {
            witness.push(json!({"generation":generation}));
        }
        let value = witness.snapshot();
        assert_eq!(value["entries"].as_array().unwrap().len(), 32);
        assert_eq!(value["overflow"], 3);
        assert_eq!(value["frontendReceipt"], "unverified");
    }
}
