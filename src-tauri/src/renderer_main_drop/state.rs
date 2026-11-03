//! One owned target, one actual worker and one replaceable pending batch.
use super::protocol::{self, Payload, Rect, MAX_SAFE, REJECTED};
use serde_json::Value;
#[derive(Clone)]
pub(super) struct Lease {
    pub id: String,
    pub rect: Rect,
}
#[derive(Clone)]
pub(super) struct Job {
    pub id: u64,
    pub context: String,
    pub lease: String,
    pub paths: Vec<String>,
}
pub(super) struct State {
    pub context: String,
    pub binding: String,
    pub lease: Option<Lease>,
    pub suspended: bool,
    pub stopped: bool,
    pub document_live: bool,
    pub opening: u64,
    pub running: bool,
    pub accepted: u64,
    pub metadata_files: usize,
    pub pending: Option<Job>,
    pub latest: u64,
    hover: bool,
    sequence: u64,
}
impl Default for State {
    fn default() -> Self {
        Self {
            context: uuid::Uuid::new_v4().simple().to_string(),
            binding: String::new(),
            lease: None,
            suspended: false,
            stopped: false,
            document_live: false,
            opening: 0,
            running: false,
            accepted: 0,
            metadata_files: 0,
            pending: None,
            latest: 0,
            hover: false,
            sequence: 0,
        }
    }
}
impl State {
    pub fn enabled(&self) -> bool {
        !self.stopped
            && !self.suspended
            && self.document_live
            && self.opening == 0
            && self.lease.is_some()
    }
    pub fn set(
        &mut self,
        context: &str,
        lease: Option<&str>,
        target: Option<Rect>,
    ) -> Result<Option<String>, &'static str> {
        if self.stopped || context != self.context {
            return Err(REJECTED);
        }
        if self.lease.as_ref().map(|l| l.id.as_str()) != lease {
            return Err(REJECTED);
        }
        match target {
            None => {
                self.cancel();
                self.lease = None;
                self.hover = false;
                Ok(None)
            }
            Some(rect) => {
                if !rect.valid() {
                    return Err(REJECTED);
                }
                let id = lease
                    .map(str::to_owned)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
                self.lease = Some(Lease {
                    id: id.clone(),
                    rect,
                });
                Ok(Some(id))
            }
        }
    }
    pub fn cancel(&mut self) {
        self.latest = self.latest.saturating_add(1);
        self.pending = None;
        self.hover = false;
    }
    pub fn rotate(&mut self) {
        self.cancel();
        self.context = uuid::Uuid::new_v4().simple().to_string();
        self.lease = None;
        self.sequence = 0;
    }
    pub fn suspend(&mut self) {
        self.cancel();
        self.suspended = true;
    }
    pub fn resume(&mut self) {
        if !self.stopped {
            self.suspended = false;
        }
    }
    pub fn hover(&mut self, inside: bool) -> Option<Value> {
        if self.hover == inside {
            return None;
        }
        self.hover = inside;
        self.notice(Payload::Hover(inside))
    }
    pub fn notice(&mut self, payload: Payload) -> Option<Value> {
        let lease = self.lease.as_ref()?.id.clone();
        self.sequence = self.sequence.checked_add(1).filter(|n| *n <= MAX_SAFE)?;
        Some(protocol::notice(&lease, self.sequence, payload))
    }
    pub fn accept(&mut self, paths: Vec<String>) -> Option<Job> {
        self.latest = self.latest.checked_add(1).filter(|n| *n <= MAX_SAFE)?;
        self.accepted = self.accepted.saturating_add(1);
        let job = Job {
            id: self.latest,
            context: self.context.clone(),
            lease: self.lease.as_ref()?.id.clone(),
            paths,
        };
        if self.running {
            self.pending = Some(job);
            None
        } else {
            self.running = true;
            Some(job)
        }
    }
    pub fn matches(&self, job: &Job) -> bool {
        self.enabled()
            && self.context == job.context
            && self.latest == job.id
            && self.lease.as_ref().is_some_and(|l| l.id == job.lease)
    }
    pub fn finished(&mut self) -> Option<Job> {
        self.running = false;
        let job = self.pending.take()?;
        if !self.matches(&job) {
            return None;
        }
        self.running = true;
        Some(job)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn live() -> State {
        let mut s = State::default();
        s.document_live = true;
        let c = s.context.clone();
        s.set(
            &c,
            None,
            Some(Rect {
                x: 0.,
                y: 0.,
                width: 100.,
                height: 50.,
            }),
        )
        .unwrap();
        s
    }
    #[test]
    fn actual_work_is_not_released_by_cancel_and_only_latest_pending_survives() {
        let mut s = live();
        let first = s.accept(vec!["first".into()]).unwrap();
        assert!(s.accept(vec!["second".into()]).is_none());
        assert!(s.accept(vec!["third".into()]).is_none());
        assert!(!s.matches(&first));
        assert!(s.running);
        let next = s.finished().unwrap();
        assert_eq!(next.paths, ["third"]);
        s.suspend();
        assert!(s.running);
        assert!(!s.matches(&next));
        assert!(s.finished().is_none());
        assert!(!s.running);
    }
    #[test]
    fn hide_suspend_retains_owner_but_late_registration_ack_does_not_resume() {
        let mut s = live();
        let id = s.lease.as_ref().unwrap().id.clone();
        let c = s.context.clone();
        s.suspend();
        s.set(
            &c,
            Some(&id),
            Some(Rect {
                x: 1.,
                y: 0.,
                width: 100.,
                height: 50.,
            }),
        )
        .unwrap();
        assert!(!s.enabled());
        s.resume();
        assert!(s.enabled());
        s.rotate();
        assert!(s.set(&c, Some(&id), None).is_err());
    }
    #[test]
    fn leave_does_not_cancel_accepted_result_or_reset_future_hover() {
        let mut s = live();
        s.hover(true);
        s.hover(false);
        let job = s.accept(vec!["one".into()]).unwrap();
        s.hover(true);
        assert!(s.matches(&job));
        let notice = s.notice(Payload::Drop(vec![])).unwrap();
        assert_eq!(notice["phase"], "drop");
        assert!(s.hover);
    }
}
