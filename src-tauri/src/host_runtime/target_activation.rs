//! Bounded activation of the exact external app captured before ATools opened.
use super::clipboard_paste::ForegroundTarget;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::AppHandle;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(2);
const FRONTMOST_TIMEOUT: Duration = Duration::from_millis(350);
const FRONTMOST_POLL: Duration = Duration::from_millis(10);

fn needs_activation(
    current: &ForegroundTarget,
    expected: &ForegroundTarget,
    atools_pid: i32,
) -> Result<bool, String> {
    if current == expected {
        Ok(false)
    } else if current.pid == atools_pid {
        Ok(true)
    } else {
        Err("Foreground changed to another application; refusing to steal focus".into())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum RequestState {
    Pending,
    Started,
    Complete(Result<(), String>),
    Cancelled,
}

struct ActivationRequest {
    state: Mutex<RequestState>,
    changed: Condvar,
}

impl ActivationRequest {
    fn new() -> Self {
        Self {
            state: Mutex::new(RequestState::Pending),
            changed: Condvar::new(),
        }
    }

    fn try_start(&self, authorized: &dyn Fn() -> bool) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if *state != RequestState::Pending || !authorized() {
            if *state == RequestState::Pending {
                *state = RequestState::Cancelled;
                self.changed.notify_all();
            }
            return false;
        }
        *state = RequestState::Started;
        true
    }

    fn complete(&self, result: Result<(), String>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if *state == RequestState::Started {
            *state = RequestState::Complete(result);
            self.changed.notify_all();
        }
    }

    fn wait(&self, timeout: Duration, authorized: &dyn Fn() -> bool) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            match &*state {
                RequestState::Complete(result) => return result.clone(),
                RequestState::Cancelled => {
                    return Err("Target activation was cancelled before starting".into())
                }
                RequestState::Pending | RequestState::Started => {
                    if !authorized() {
                        if *state == RequestState::Pending {
                            *state = RequestState::Cancelled;
                            self.changed.notify_all();
                            return Err("Clipboard session closed before target activation".into());
                        }
                    }
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        if *state == RequestState::Pending {
                            *state = RequestState::Cancelled;
                            self.changed.notify_all();
                            return Err(
                                "Target activation timed out and was cancelled before starting"
                                    .into(),
                            );
                        }
                        return Err("Target activation timed out after starting".into());
                    }
                    let poll = remaining.min(FRONTMOST_POLL);
                    let (next, _) = self
                        .changed
                        .wait_timeout(state, poll)
                        .unwrap_or_else(|error| error.into_inner());
                    state = next;
                }
            }
        }
    }
}

pub(super) fn restore_target(
    app: &AppHandle,
    target: &ForegroundTarget,
    authorized: Arc<dyn Fn() -> bool + Send + Sync>,
) -> Result<(), String> {
    if !authorized() {
        return Err("Clipboard session closed before target activation".into());
    }
    #[cfg(target_os = "macos")]
    {
        if !needs_activation(&live_target()?, target, std::process::id() as i32)? {
            return Ok(());
        }
        let request = Arc::new(ActivationRequest::new());
        let callback_request = request.clone();
        let callback_authorized = authorized.clone();
        let queued_target = target.clone();
        app.run_on_main_thread(move || {
            if callback_request.try_start(callback_authorized.as_ref()) {
                callback_request.complete(activate_target_on_main_thread(&queued_target));
            }
        })
        .map_err(|_| "Target activation could not be queued".to_string())?;
        request.wait(REQUEST_TIMEOUT, authorized.as_ref())?;
        confirm_frontmost(&target, authorized.as_ref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let _ = target;
        Err("Direct paste is currently available on macOS".into())
    }
}

#[cfg(target_os = "macos")]
fn live_target() -> Result<ForegroundTarget, String> {
    use objc2_app_kit::NSWorkspace;
    let app = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .ok_or("No foreground application")?;
    Ok(ForegroundTarget {
        pid: app.processIdentifier(),
        bundle_id: app.bundleIdentifier().map(|value| value.to_string()),
    })
}

#[cfg(target_os = "macos")]
fn activate_target_on_main_thread(target: &ForegroundTarget) -> Result<(), String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};

    if MainThreadMarker::new().is_none() {
        return Err("Target activation did not run on the main thread".into());
    }
    let current = live_target()?;
    if !needs_activation(&current, target, std::process::id() as i32)? {
        return Ok(());
    }
    let application = NSRunningApplication::runningApplicationWithProcessIdentifier(target.pid)
        .ok_or("Previously active application is no longer running")?;
    if application.isTerminated()
        || application
            .bundleIdentifier()
            .map(|value| value.to_string())
            != target.bundle_id
    {
        return Err("Previously active application identity changed".into());
    }
    if !application.activateWithOptions(NSApplicationActivationOptions::empty()) {
        return Err("Previously active application rejected activation".into());
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn confirm_frontmost(
    target: &ForegroundTarget,
    authorized: &dyn Fn() -> bool,
) -> Result<(), String> {
    let deadline = Instant::now() + FRONTMOST_TIMEOUT;
    loop {
        if !authorized() {
            return Err("Clipboard session closed while restoring target".into());
        }
        let current = live_target()?;
        if current == *target {
            return Ok(());
        }
        if current.pid != std::process::id() as i32 {
            return Err("Another application became foreground; refusing to steal focus".into());
        }
        if Instant::now() >= deadline {
            return Err("Previously active application did not become foreground".into());
        }
        std::thread::sleep(FRONTMOST_POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::{needs_activation, ActivationRequest, RequestState};
    use crate::host_runtime::clipboard_paste::ForegroundTarget;
    use std::time::Duration;

    #[test]
    fn queued_activation_cancelled_by_close_cannot_start_late() {
        let request = ActivationRequest::new();
        assert_eq!(
            request.wait(Duration::from_millis(1), &|| false),
            Err("Clipboard session closed before target activation".into())
        );
        assert!(!request.try_start(&|| true));
        assert_eq!(
            request.wait(Duration::from_millis(1), &|| true),
            Err("Target activation was cancelled before starting".into())
        );
    }

    #[test]
    fn dequeue_checks_current_authorization_before_claiming_native_activation() {
        let request = ActivationRequest::new();
        assert!(!request.try_start(&|| false));
        assert_eq!(*request.state.lock().unwrap(), RequestState::Cancelled);
    }

    #[test]
    fn timed_out_pending_activation_callback_cannot_start_late() {
        let request = ActivationRequest::new();
        assert!(request
            .wait(Duration::ZERO, &|| true)
            .unwrap_err()
            .contains("cancelled before starting"));
        assert!(!request.try_start(&|| true));
    }

    #[test]
    fn started_native_activation_is_the_only_non_cancellable_state() {
        let request = ActivationRequest::new();
        assert!(request.try_start(&|| true));
        request.complete(Ok(()));
        assert_eq!(request.wait(Duration::from_millis(1), &|| true), Ok(()));
    }

    #[test]
    fn exact_target_is_not_reactivated_and_third_party_foreground_is_never_stolen() {
        let target = ForegroundTarget {
            pid: 42,
            bundle_id: Some("target.app".into()),
        };
        assert_eq!(needs_activation(&target, &target, 7), Ok(false));
        let launcher = ForegroundTarget {
            pid: 7,
            bundle_id: Some("atools.app".into()),
        };
        assert_eq!(needs_activation(&launcher, &target, 7), Ok(true));
        let other = ForegroundTarget {
            pid: 99,
            bundle_id: Some("other.app".into()),
        };
        assert!(needs_activation(&other, &target, 7).is_err());
    }
}
