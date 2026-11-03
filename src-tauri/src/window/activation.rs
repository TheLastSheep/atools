//! macOS foreground requests shared by the launcher and native fixtures.

#[cfg(any(target_os = "macos", test))]
pub(super) mod state;

#[cfg(any(target_os = "macos", test))]
use std::sync::{Condvar, Mutex};
#[cfg(any(target_os = "macos", test))]
use std::time::{Duration, Instant};
use tauri::AppHandle;

#[cfg(any(target_os = "macos", test))]
const MAIN_THREAD_REQUEST_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Debug, PartialEq, Eq)]
enum DispatchState {
    Pending,
    // Once the main-thread closure claims the request, AppKit activation cannot be interrupted.
    Started,
    Completed(Result<(), String>),
    Cancelled,
}

#[cfg(any(target_os = "macos", test))]
struct MainThreadRequest {
    state: Mutex<DispatchState>,
    changed: Condvar,
}

#[cfg(any(target_os = "macos", test))]
impl MainThreadRequest {
    fn new() -> Self {
        Self {
            state: Mutex::new(DispatchState::Pending),
            changed: Condvar::new(),
        }
    }

    fn try_start(&self) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if *state != DispatchState::Pending {
            return false;
        }
        *state = DispatchState::Started;
        true
    }

    fn complete(&self, result: Result<(), String>) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if *state == DispatchState::Started {
            *state = DispatchState::Completed(result);
            self.changed.notify_all();
        }
    }

    fn wait(&self, timeout: Duration) -> Result<(), String> {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        loop {
            match &*state {
                DispatchState::Completed(result) => return result.clone(),
                DispatchState::Cancelled => {
                    return Err(
                        "macOS activation timed out and was cancelled before starting".into(),
                    )
                }
                DispatchState::Pending | DispatchState::Started => {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        return match &*state {
                            DispatchState::Pending => {
                                *state = DispatchState::Cancelled;
                                self.changed.notify_all();
                                Err("macOS activation timed out and was cancelled before starting".into())
                            }
                            DispatchState::Started => Err("macOS activation timed out after starting; the native request cannot be interrupted".into()),
                            DispatchState::Completed(result) => result.clone(),
                            DispatchState::Cancelled => Err("macOS activation timed out and was cancelled before starting".into()),
                        };
                    }
                    let (next, _) = self
                        .changed
                        .wait_timeout(state, remaining)
                        .unwrap_or_else(|error| error.into_inner());
                    state = next;
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn activate_current_application(app: &AppHandle) -> tauri::Result<()> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSApplicationActivationOptions, NSRunningApplication};
    use std::sync::Arc;

    fn request_on_main_thread(app: &AppHandle) -> Result<(), String> {
        if MainThreadMarker::new().is_none() {
            return Err("macOS activation request did not run on the main thread".into());
        }
        let marker = MainThreadMarker::new().expect("main-thread marker checked above");
        let current = NSRunningApplication::currentApplication();
        let eligibility = ActivationEligibility::capture(&current);
        let application = NSApplication::sharedApplication(marker);
        let before = state::ForegroundSnapshot::capture_with_application(app, &application);
        let request_sent = current.activateWithOptions(NSApplicationActivationOptions::empty());
        // AppKit's BOOL says whether the request was sent, not whether the target state was reached.
        let after = state::ForegroundSnapshot::capture_with_application(app, &application);
        let result = activation_request_result(request_sent, eligibility, before, after);
        #[cfg(feature = "legacy-node-smoke")]
        if result.is_err() {
            if let Some(payload) = state::activation_failure_json(
                request_sent,
                eligibility.finished_launching,
                &eligibility.activation_policy.label(),
                eligibility.terminated,
                before,
                after,
            ) {
                eprintln!("renderer-smoke activation-failure {payload}");
            }
        }
        result
    }

    let result = if MainThreadMarker::new().is_some() {
        request_on_main_thread(app)
    } else {
        let request = Arc::new(MainThreadRequest::new());
        let main_thread_request = request.clone();
        let app_handle = app.clone();
        app.run_on_main_thread(move || {
            if main_thread_request.try_start() {
                main_thread_request.complete(request_on_main_thread(&app_handle));
            }
        })?;
        request.wait(MAIN_THREAD_REQUEST_TIMEOUT)
    };

    result.map_err(std::io::Error::other)?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub(super) fn activate_current_application(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ActivationPolicyDiagnostic {
    Regular,
    Accessory,
    Prohibited,
    Unknown(isize),
}

#[cfg(any(target_os = "macos", test))]
impl ActivationPolicyDiagnostic {
    fn label(self) -> String {
        match self {
            Self::Regular => "regular".into(),
            Self::Accessory => "accessory".into(),
            Self::Prohibited => "prohibited".into(),
            Self::Unknown(value) => format!("unknown({value})"),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ActivationEligibility {
    finished_launching: bool,
    activation_policy: ActivationPolicyDiagnostic,
    terminated: bool,
}

#[cfg(target_os = "macos")]
impl ActivationEligibility {
    fn capture(application: &objc2_app_kit::NSRunningApplication) -> Self {
        use objc2_app_kit::NSApplicationActivationPolicy as Policy;

        let policy = application.activationPolicy();
        let activation_policy = if policy == Policy::Regular {
            ActivationPolicyDiagnostic::Regular
        } else if policy == Policy::Accessory {
            ActivationPolicyDiagnostic::Accessory
        } else if policy == Policy::Prohibited {
            ActivationPolicyDiagnostic::Prohibited
        } else {
            ActivationPolicyDiagnostic::Unknown(policy.0)
        };
        Self {
            finished_launching: application.isFinishedLaunching(),
            activation_policy,
            terminated: application.isTerminated(),
        }
    }
}

#[cfg(any(target_os = "macos", test))]
fn activation_request_result(
    accepted: bool,
    eligibility: ActivationEligibility,
    before: state::ForegroundSnapshot,
    after: state::ForegroundSnapshot,
) -> Result<(), String> {
    if accepted || after.meets_foreground_conditions() {
        Ok(())
    } else {
        Err(format!(
            "macOS activation did not result in the main window being foregrounded (requestSent={}, finishedLaunching={}, activationPolicy={}, terminated={}, pre={}, post={})",
            accepted,
            eligibility.finished_launching,
            eligibility.activation_policy.label(),
            eligibility.terminated,
            before.diagnostic_fields(),
            after.diagnostic_fields(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        activation_request_result, state::ForegroundSnapshot, ActivationEligibility,
        ActivationPolicyDiagnostic, MainThreadRequest,
    };
    use std::time::Duration;

    fn regular_eligibility() -> ActivationEligibility {
        ActivationEligibility {
            finished_launching: true,
            activation_policy: ActivationPolicyDiagnostic::Regular,
            terminated: false,
        }
    }

    #[test]
    fn accepted_activation_request_returns_success() {
        assert_eq!(
            activation_request_result(
                true,
                regular_eligibility(),
                ForegroundSnapshot::not_foreground(),
                ForegroundSnapshot::not_foreground(),
            ),
            Ok(())
        );
    }

    #[test]
    fn rejected_request_passes_only_when_post_state_meets_all_foreground_conditions() {
        assert_eq!(
            activation_request_result(
                false,
                regular_eligibility(),
                ForegroundSnapshot::not_foreground(),
                ForegroundSnapshot::foreground(),
            ),
            Ok(())
        );
    }

    #[test]
    fn rejected_request_fails_when_pre_state_is_foreground_but_post_state_is_not() {
        let error = activation_request_result(
            false,
            regular_eligibility(),
            ForegroundSnapshot::foreground(),
            ForegroundSnapshot::not_foreground(),
        )
        .unwrap_err();
        assert!(error.contains("requestSent=false"));
        assert!(error.contains("pre={appActive=true"));
        assert!(error.contains("post={appActive=false"));
    }

    #[test]
    fn rejected_request_fails_when_app_is_active_but_another_app_is_frontmost() {
        let before = ForegroundSnapshot::foreground();
        let after = ForegroundSnapshot {
            app_active: Some(true),
            frontmost_is_self: Some(false),
            ..before
        };
        assert!(
            activation_request_result(false, regular_eligibility(), before, after)
                .unwrap_err()
                .contains("frontmostIsSelf=false")
        );
    }

    #[test]
    fn rejected_request_fails_for_missing_or_unfocused_main_window_state() {
        let foreground = ForegroundSnapshot::foreground();
        let cases = [
            ForegroundSnapshot {
                main_window_available: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_visible: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_key: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_focused: Some(false),
                ..foreground
            },
            ForegroundSnapshot {
                main_focused: None,
                ..foreground
            },
        ];
        for after in cases {
            assert!(
                activation_request_result(false, regular_eligibility(), foreground, after).is_err()
            );
        }
    }

    #[test]
    fn missing_main_window_fails_closed_and_reports_unknown_native_state() {
        let before = ForegroundSnapshot::foreground();
        let missing = ForegroundSnapshot {
            main_window_available: Some(false),
            main_visible: None,
            main_key: None,
            main_focused: None,
            main_on_active_space: None,
            main_occlusion_visible: None,
            ..before
        };
        let error =
            activation_request_result(false, regular_eligibility(), before, missing).unwrap_err();
        assert!(error.contains("mainWindowAvailable=false"));
        assert!(error.contains("mainVisible=unknown"));
        assert!(error.contains("mainKey=unknown"));
        assert!(error.contains("mainFocused=unknown"));
    }

    #[test]
    fn accepted_request_does_not_claim_editor_input_is_ready() {
        let post = ForegroundSnapshot::not_foreground();
        assert!(activation_request_result(
            true,
            regular_eligibility(),
            ForegroundSnapshot::not_foreground(),
            post,
        )
        .is_ok());
        assert!(!post.meets_foreground_conditions());
    }

    #[test]
    fn queued_request_timeout_cancels_before_native_activation_starts() {
        let request = MainThreadRequest::new();
        assert_eq!(
            request.wait(Duration::ZERO),
            Err("macOS activation timed out and was cancelled before starting".into())
        );
        assert!(!request.try_start());
        assert_eq!(
            request.wait(Duration::ZERO),
            Err("macOS activation timed out and was cancelled before starting".into())
        );
    }

    #[test]
    fn started_request_returns_native_rejection_and_cannot_run_twice() {
        let request = MainThreadRequest::new();
        assert!(request.try_start());
        assert!(!request.try_start());
        request.complete(activation_request_result(
            false,
            regular_eligibility(),
            ForegroundSnapshot::not_foreground(),
            ForegroundSnapshot::not_foreground(),
        ));
        assert_eq!(
            request.wait(Duration::ZERO),
            Err("macOS activation did not result in the main window being foregrounded (requestSent=false, finishedLaunching=true, activationPolicy=regular, terminated=false, pre={appActive=false, appHidden=false, frontmostIsSelf=false, mainWindowAvailable=false, mainVisible=false, mainKey=false, mainFocused=false, mainOnActiveSpace=false, mainOcclusionVisible=false}, post={appActive=false, appHidden=false, frontmostIsSelf=false, mainWindowAvailable=false, mainVisible=false, mainKey=false, mainFocused=false, mainOnActiveSpace=false, mainOcclusionVisible=false})".into())
        );
    }

    #[test]
    fn completed_request_returns_native_success() {
        let request = MainThreadRequest::new();
        assert!(request.try_start());
        request.complete(activation_request_result(
            true,
            regular_eligibility(),
            ForegroundSnapshot::foreground(),
            ForegroundSnapshot::not_foreground(),
        ));
        assert_eq!(request.wait(Duration::ZERO), Ok(()));
    }

    #[test]
    fn started_request_timeout_reports_uncertain_completion_without_cancelling() {
        let request = MainThreadRequest::new();
        assert!(request.try_start());
        assert_eq!(
            request.wait(Duration::ZERO),
            Err("macOS activation timed out after starting; the native request cannot be interrupted".into())
        );
        assert!(!request.try_start());
        request.complete(Ok(()));
        assert_eq!(request.wait(Duration::ZERO), Ok(()));
    }

    #[test]
    fn completed_result_wakes_waiter_and_returns_from_another_thread() {
        use std::sync::Arc;
        use std::thread;

        let request = Arc::new(MainThreadRequest::new());
        let main_thread_request = request.clone();
        let completion = thread::spawn(move || {
            assert!(main_thread_request.try_start());
            main_thread_request.complete(activation_request_result(
                false,
                regular_eligibility(),
                ForegroundSnapshot::not_foreground(),
                ForegroundSnapshot::not_foreground(),
            ));
        });
        assert_eq!(
            request.wait(Duration::from_secs(1)),
            Err("macOS activation did not result in the main window being foregrounded (requestSent=false, finishedLaunching=true, activationPolicy=regular, terminated=false, pre={appActive=false, appHidden=false, frontmostIsSelf=false, mainWindowAvailable=false, mainVisible=false, mainKey=false, mainFocused=false, mainOnActiveSpace=false, mainOcclusionVisible=false}, post={appActive=false, appHidden=false, frontmostIsSelf=false, mainWindowAvailable=false, mainVisible=false, mainKey=false, mainFocused=false, mainOnActiveSpace=false, mainOcclusionVisible=false})".into())
        );
        completion.join().unwrap();
    }

    #[test]
    fn rejected_activation_reports_observed_launch_policy_and_termination_state() {
        let eligibility = ActivationEligibility {
            finished_launching: false,
            activation_policy: ActivationPolicyDiagnostic::Prohibited,
            terminated: true,
        };
        assert_eq!(
            activation_request_result(false, eligibility, ForegroundSnapshot::not_foreground(), ForegroundSnapshot::not_foreground()),
            Err("macOS activation did not result in the main window being foregrounded (requestSent=false, finishedLaunching=false, activationPolicy=prohibited, terminated=true, pre={appActive=false, appHidden=false, frontmostIsSelf=false, mainWindowAvailable=false, mainVisible=false, mainKey=false, mainFocused=false, mainOnActiveSpace=false, mainOcclusionVisible=false}, post={appActive=false, appHidden=false, frontmostIsSelf=false, mainWindowAvailable=false, mainVisible=false, mainKey=false, mainFocused=false, mainOnActiveSpace=false, mainOcclusionVisible=false})".into())
        );
    }
}
