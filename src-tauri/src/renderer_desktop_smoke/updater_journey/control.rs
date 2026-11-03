//! Fixture work is finite and never produces an archive or system effect.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc,
};
use tokio::sync::Notify;

#[derive(Default)]
pub(crate) struct Control {
    pub(crate) checks: AtomicU64,
    pub(crate) downloads: AtomicU64,
    pub(crate) installs: AtomicU64,
    pub(crate) applies: AtomicU64,
    pub(crate) restarts: AtomicU64,
    active: AtomicU64,
    released: AtomicBool,
    changed: Notify,
}
impl Control {
    pub(crate) fn begin(self: &Arc<Self>) -> Active {
        self.downloads.fetch_add(1, Ordering::AcqRel);
        self.active.fetch_add(1, Ordering::AcqRel);
        Active(self.clone())
    }
    pub(crate) async fn wait_release(&self) {
        loop {
            let notified = self.changed.notified();
            if self.released.load(Ordering::Acquire) {
                return;
            }
            notified.await;
        }
    }
    pub(super) fn release(&self) {
        self.released.store(true, Ordering::Release);
        self.changed.notify_waiters();
    }
    #[cfg(test)]
    pub(crate) fn release_for_test(&self) {
        self.release();
    }
    pub(super) fn active(&self) -> u64 {
        self.active.load(Ordering::Acquire)
    }
    pub(super) fn snapshot(&self) -> serde_json::Value {
        serde_json::json!({"checkCalls":self.checks.load(Ordering::Acquire),"downloadCalls":self.downloads.load(Ordering::Acquire),
            "activeWork":self.active(),"forbiddenEffectCalls":self.installs.load(Ordering::Acquire)+self.applies.load(Ordering::Acquire)+self.restarts.load(Ordering::Acquire),
            "installCalls":self.installs.load(Ordering::Acquire),"applyCalls":self.applies.load(Ordering::Acquire),"restartCalls":self.restarts.load(Ordering::Acquire),"archiveProduction":"unsupported"})
    }
}
pub(crate) struct Active(Arc<Control>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn release_before_wait_is_retained_and_work_count_drains() {
        let control = Arc::new(Control::default());
        let active = control.begin();
        assert_eq!(control.active(), 1);
        control.release();
        tokio::time::timeout(
            std::time::Duration::from_millis(100),
            control.wait_release(),
        )
        .await
        .unwrap();
        drop(active);
        assert_eq!(control.active(), 0);
    }
}
