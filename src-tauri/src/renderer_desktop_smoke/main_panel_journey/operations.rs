use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::{oneshot, Notify};

const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(2);
const MAIN_THREAD_BUSY: &str = "main-panel-prototype-native-operation-busy";
const MAIN_THREAD_DISPATCH_FAILED: &str = "main-panel-prototype-native-operation-dispatch-failed";
const MAIN_THREAD_TIMEOUT_ERROR: &str = "main-panel-prototype-native-operation-timeout";
const MAIN_THREAD_INTERRUPTED: &str = "main-panel-prototype-native-operation-interrupted";
const MAIN_THREAD_PANIC: &str = "main-panel-prototype-native-operation-panicked";

#[derive(Default)]
pub(super) struct NativeOperations {
    in_flight: AtomicBool,
    scheduled: AtomicUsize,
    started: AtomicUsize,
    completed: AtomicUsize,
    unconfirmed_external: AtomicBool,
    changed: Notify,
}

impl NativeOperations {
    pub(super) async fn run<T>(
        self: &Arc<Self>,
        app: &AppHandle<Wry>,
        action: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
    ) -> Result<T, &'static str>
    where
        T: Send + 'static,
    {
        if self
            .in_flight
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(MAIN_THREAD_BUSY);
        }
        self.scheduled.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        let operations = Arc::clone(self);
        let task = move || {
            operations.started.fetch_add(1, Ordering::Relaxed);
            let completion = Completion(Arc::clone(&operations));
            let result = catch_unwind(AssertUnwindSafe(action)).unwrap_or(Err(MAIN_THREAD_PANIC));
            // Publish terminal native state before waking a caller that may enqueue the next action.
            drop(completion);
            let _ = sender.send(result);
        };

        if app.run_on_main_thread(task).is_err() {
            self.finish_without_start();
            return Err(MAIN_THREAD_DISPATCH_FAILED);
        }

        match tokio::time::timeout(MAIN_THREAD_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(MAIN_THREAD_INTERRUPTED),
            Err(_) => Err(MAIN_THREAD_TIMEOUT_ERROR),
        }
    }

    pub(super) fn mark_external_unconfirmed(&self) {
        self.unconfirmed_external.store(true, Ordering::Release);
    }

    pub(super) fn is_terminal(&self) -> bool {
        !self.in_flight.load(Ordering::Acquire)
            && self.scheduled.load(Ordering::Acquire) == self.completed.load(Ordering::Acquire)
            && !self.unconfirmed_external.load(Ordering::Acquire)
    }

    pub(super) async fn wait_terminal(&self, timeout: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            if self.is_terminal() {
                return true;
            }
            let changed = self.changed.notified();
            if self.is_terminal() {
                return true;
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return self.is_terminal();
            }
        }
    }

    fn finish_without_start(&self) {
        self.completed.fetch_add(1, Ordering::Relaxed);
        self.in_flight.store(false, Ordering::Release);
        self.changed.notify_waiters();
    }
}

struct Completion(Arc<NativeOperations>);

impl Drop for Completion {
    fn drop(&mut self) {
        self.0.completed.fetch_add(1, Ordering::Relaxed);
        self.0.in_flight.store(false, Ordering::Release);
        self.0.changed.notify_waiters();
    }
}

#[derive(Clone, Debug)]
pub(super) struct NativeWindowEvidence {
    pub(super) snapshot: serde_json::Value,
    pub(super) frontmost_pid: Option<i32>,
    pub(super) content_view_stable: Option<bool>,
}

pub(super) async fn capture_window(
    app: &AppHandle<Wry>,
    operations: &Arc<NativeOperations>,
) -> Result<NativeWindowEvidence, &'static str> {
    let dispatch_app = app.clone();
    let capture_app = dispatch_app.clone();
    operations
        .run(&dispatch_app, move || {
            let snapshot = crate::window::MainWindowSnapshot::capture(&capture_app);
            let snapshot = serde_json::to_value(snapshot)
                .map_err(|_| "main-panel-prototype-window-snapshot-invalid")?;
            let frontmost_pid = frontmost_process_id();
            let content_view_stable = crate::window::macos_main_panel::is_active(&capture_app)
                .then(|| {
                    crate::window::macos_main_panel::content_view_matches_original(&capture_app)
                        .ok()
                })
                .flatten();
            Ok(NativeWindowEvidence {
                snapshot,
                frontmost_pid,
                content_view_stable,
            })
        })
        .await
}

#[cfg(target_os = "macos")]
fn frontmost_process_id() -> Option<i32> {
    objc2_app_kit::NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|application| application.processIdentifier())
}

#[cfg(not(target_os = "macos"))]
fn frontmost_process_id() -> Option<i32> {
    None
}

pub(super) async fn activation_observation(
    app: &AppHandle<Wry>,
    operations: &Arc<NativeOperations>,
) -> Option<serde_json::Value> {
    match super::super::settings_input_activation::sample(app).await {
        Ok(value) => Some(value),
        Err(error) => {
            if error.contains("deadline exceeded") || error.contains("callback was interrupted") {
                operations.mark_external_unconfirmed();
            }
            None
        }
    }
}
