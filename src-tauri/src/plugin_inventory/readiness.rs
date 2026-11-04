use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tokio::sync::watch;

const BOOTSTRAP_FAILED: &str = "PLUGIN_INVENTORY_BOOTSTRAP_FAILED";
const BOOTSTRAP_ABORTED: &str = "PLUGIN_INVENTORY_BOOTSTRAP_ABORTED";
const BOOTSTRAP_PANICKED: &str = "PLUGIN_INVENTORY_BOOTSTRAP_PANICKED";
const BOOTSTRAP_TIMEOUT: &str = "PLUGIN_INVENTORY_WAIT_TIMEOUT";
const BOOTSTRAP_UNAVAILABLE: &str = "PLUGIN_INVENTORY_BOOTSTRAP_UNAVAILABLE";
const BOOTSTRAP_ALREADY_STARTED: &str = "PLUGIN_INVENTORY_BOOTSTRAP_ALREADY_STARTED";
const DEFAULT_WAIT_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Pending,
    Ready,
    Failed(&'static str),
}

struct ReadinessInner {
    phase: watch::Sender<Phase>,
    bootstrap_claimed: AtomicBool,
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pending_wait_observation: PendingWaitObservation,
}

#[derive(Clone)]
pub(crate) struct PluginInventoryReadiness {
    inner: Arc<ReadinessInner>,
}

pub(crate) struct BootstrapCompletionGuard {
    readiness: PluginInventoryReadiness,
    finished: bool,
}

#[cfg(any(test, feature = "legacy-node-smoke"))]
#[derive(Default)]
struct PendingWaitObservation {
    observed: AtomicBool,
    notify: tokio::sync::Notify,
}

impl PluginInventoryReadiness {
    pub(crate) fn pending() -> Self {
        Self::new(Phase::Pending)
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(crate) fn prepopulated_ready() -> Self {
        let readiness = Self::new(Phase::Ready);
        readiness
            .inner
            .bootstrap_claimed
            .store(true, Ordering::Release);
        readiness
    }

    fn new(initial: Phase) -> Self {
        let (phase, _receiver) = watch::channel(initial);
        Self {
            inner: Arc::new(ReadinessInner {
                phase,
                bootstrap_claimed: AtomicBool::new(false),
                #[cfg(any(test, feature = "legacy-node-smoke"))]
                pending_wait_observation: PendingWaitObservation::default(),
            }),
        }
    }

    pub(crate) fn begin_bootstrap(&self) -> Result<BootstrapCompletionGuard, String> {
        if !matches!(*self.inner.phase.borrow(), Phase::Pending) {
            return Err(BOOTSTRAP_ALREADY_STARTED.into());
        }
        self.inner
            .bootstrap_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| BOOTSTRAP_ALREADY_STARTED.to_string())?;
        Ok(BootstrapCompletionGuard {
            readiness: self.clone(),
            finished: false,
        })
    }

    pub(crate) async fn wait_ready(&self) -> Result<(), String> {
        self.wait_with_timeout(DEFAULT_WAIT_TIMEOUT).await
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(crate) async fn wait_ready_with_timeout(&self, timeout: Duration) -> Result<(), String> {
        self.wait_with_timeout(timeout).await
    }

    async fn wait_with_timeout(&self, timeout: Duration) -> Result<(), String> {
        let mut receiver = self.inner.phase.subscribe();
        if let Some(result) = phase_result(&receiver.borrow().clone()) {
            return result;
        }

        let wait = async {
            loop {
                match phase_result(&receiver.borrow_and_update().clone()) {
                    Some(result) => return result,
                    None => {
                        #[cfg(any(test, feature = "legacy-node-smoke"))]
                        self.observe_pending_waiter();
                    }
                }
                if receiver.changed().await.is_err() {
                    return Err(BOOTSTRAP_UNAVAILABLE.into());
                }
            }
        };

        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| BOOTSTRAP_TIMEOUT.to_string())?
    }

    fn transition(&self, next: Phase) -> bool {
        self.inner.phase.send_if_modified(|phase| {
            if !matches!(phase, Phase::Pending) {
                return false;
            }
            *phase = next;
            true
        })
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    fn observe_pending_waiter(&self) {
        if !self
            .inner
            .pending_wait_observation
            .observed
            .swap(true, Ordering::AcqRel)
        {
            self.inner.pending_wait_observation.notify.notify_waiters();
        }
    }

    #[cfg(any(test, feature = "legacy-node-smoke"))]
    pub(crate) async fn wait_until_waiting(&self, timeout: Duration) -> Result<(), String> {
        if self
            .inner
            .pending_wait_observation
            .observed
            .load(Ordering::Acquire)
        {
            return Ok(());
        }
        let notified = self.inner.pending_wait_observation.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self
            .inner
            .pending_wait_observation
            .observed
            .load(Ordering::Acquire)
        {
            return Ok(());
        }
        tokio::time::timeout(timeout, notified)
            .await
            .map(|_| ())
            .map_err(|_| BOOTSTRAP_TIMEOUT.to_string())
    }
}

impl BootstrapCompletionGuard {
    pub(crate) fn complete(mut self, outcome: Result<(), String>) {
        let phase = if outcome.is_ok() {
            Phase::Ready
        } else {
            Phase::Failed(BOOTSTRAP_FAILED)
        };
        self.readiness.transition(phase);
        self.finished = true;
    }
}

impl Drop for BootstrapCompletionGuard {
    fn drop(&mut self) {
        if !self.finished {
            let error = if std::thread::panicking() {
                BOOTSTRAP_PANICKED
            } else {
                BOOTSTRAP_ABORTED
            };
            self.readiness.transition(Phase::Failed(error));
            self.finished = true;
        }
    }
}

fn phase_result(phase: &Phase) -> Option<Result<(), String>> {
    match phase {
        Phase::Pending => None,
        Phase::Ready => Some(Ok(())),
        Phase::Failed(error) => Some(Err((*error).to_string())),
    }
}

#[cfg(test)]
#[path = "readiness_unit_tests.rs"]
mod tests;
