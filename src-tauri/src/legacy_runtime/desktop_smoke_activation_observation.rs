//! One opt-in, fixture-owned activation observation; never changes activation policy.
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const CAPACITY: usize = 64;
const SCHEDULED: u8 = 8;
const DEADLINE: Duration = Duration::from_secs(2);
const STEP: Duration = Duration::from_millis(200);

#[derive(Default)]
struct Log {
    used: bool,
    active: bool,
    started: Option<Instant>,
    records: Vec<Value>,
    total: u32,
    overflow: u32,
    scheduled: u8,
    notifications: u8,
    status: &'static str,
    registered: u8,
    removed: u8,
}
pub(super) struct Observation {
    expected_bundle: String,
    log: Mutex<Log>,
}
impl Observation {
    pub(super) fn from_environment() -> Result<Option<Arc<Self>>, String> {
        let mode = std::env::var("ATOOLS_PANEL_ACTIVATION_OBSERVATION").ok();
        let expected = std::env::var("ATOOLS_PANEL_ACTIVATION_EXPECTED_BUNDLE_ID").ok();
        match (mode.as_deref(), expected) {
            (None, None) => Ok(None),
            (Some("observe"), Some(value)) if expected_bundle(&value) => {
                #[cfg(not(target_os = "macos"))]
                return Err("Activation observation is macOS fixture-only".into());
                #[cfg(target_os = "macos")]
                Ok(Some(Arc::new(Self::new(value))))
            }
            _ => Err(
                "Activation observation requires observe mode and exact expected fixture bundle"
                    .into(),
            ),
        }
    }
    fn new(expected_bundle: String) -> Self {
        Self {
            expected_bundle,
            log: Mutex::new(Log {
                status: "not-started",
                ..Log::default()
            }),
        }
    }
    fn reserve(&self) -> Result<(), String> {
        let mut log = self.log.lock();
        if log.used {
            return Err("Activation observation is single-use or already cancelled".into());
        }
        log.used = true;
        log.started = Some(Instant::now());
        log.status = "observing";
        log.active = true;
        Ok(())
    }
    fn deadline(&self) -> Instant {
        self.log.lock().started.expect("probe reserved") + DEADLINE
    }
    fn observing(&self) -> bool {
        let log = self.log.lock();
        log.active && log.started.is_some_and(|start| start.elapsed() < DEADLINE)
    }
    fn record(
        &self,
        kind: &'static str,
        stage: &'static str,
        sample: Option<u8>,
        flags: Option<Value>,
    ) -> bool {
        if !self.observing() {
            return false;
        }
        let mut log = self.log.lock();
        if !log.active || !log.started.is_some_and(|start| start.elapsed() < DEADLINE) {
            return false;
        }
        log.total = log.total.saturating_add(1);
        // Reserve ten slots for every before/after/scheduled full flag vector.
        if log.records.len() == CAPACITY
            || (kind == "notification"
                && usize::from(log.notifications) >= CAPACITY - usize::from(SCHEDULED) - 2)
        {
            log.overflow = log.overflow.saturating_add(1);
            return false;
        }
        let elapsed = log.started.expect("probe reserved").elapsed().as_secs_f64() * 1000.0;
        let sequence = log.total;
        log.records
            .push(json!({"sequence":sequence,"kind":kind,"stage":stage,
            "sampleOrdinal":sample,"elapsedMs":elapsed,"flags":flags}));
        if sample.is_some() {
            log.scheduled = log.scheduled.saturating_add(1);
        }
        if kind == "notification" {
            log.notifications += 1;
        }
        true
    }
    fn finish(&self, status: &'static str) {
        let mut log = self.log.lock();
        if log.active || !log.used {
            log.used = true;
            log.active = false;
            log.status = status;
        }
    }
    pub(super) fn snapshot(&self) -> Value {
        let log = self.log.lock();
        json!({"schemaVersion":1,"status":log.status,"records":log.records,"total":log.total,
            "overflow":log.overflow,"maxRecords":CAPACITY,"scheduledSamples":log.scheduled,
            "requestedScheduledSamples":SCHEDULED,"observationDeadlineMs":2000,"scheduledStepMs":200,
            "notificationRecords":log.notifications,"reservedSnapshotRecords":10,
            "registeredObservers":log.registered,"removedObservers":log.removed,
            "observerCleanupComplete":log.registered == log.removed,
            "clocks":"record elapsedMs starts at this command; nested flags.elapsedMs uses the fixture foreground start. Compare only within one origin.",
            "scope":"Only this fixture's app and exact main window. One existing ensure request, before/after plus eight finite samples. No extra activation, input, AX, global app identity or idle polling."})
    }
}
fn expected_bundle(value: &str) -> bool {
    value
        .strip_prefix("dev.atools.fixture.dialog.")
        .is_some_and(|tail| {
            tail.len() == 32
                && tail
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
}

struct Guard {
    app: AppHandle,
    observation: Arc<Observation>,
    complete: bool,
}
impl Drop for Guard {
    fn drop(&mut self) {
        if !self.complete {
            self.observation.finish("cancelled-or-deadline");
            let observation = self.observation.clone();
            let _ = self
                .app
                .run_on_main_thread(move || stop_observers(&observation));
        }
    }
}
async fn on_main(
    app: &AppHandle,
    observation: &Arc<Observation>,
    action: impl FnOnce(&AppHandle, &Arc<Observation>) -> Result<Value, String> + Send + 'static,
) -> Result<Value, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let observed = app.clone();
    let state = observation.clone();
    app.run_on_main_thread(move || {
        let result = if state.observing() {
            action(&observed, &state)
        } else {
            Err("Activation observation cancelled or expired".into())
        };
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    tokio::time::timeout_at(
        tokio::time::Instant::from_std(observation.deadline()),
        receiver,
    )
    .await
    .map_err(|_| "Activation observation deadline".to_string())?
    .map_err(|_| "Activation observation callback interrupted".to_string())?
}
pub(super) async fn observe_request(
    app: AppHandle,
    observation: Arc<Observation>,
) -> Result<Value, String> {
    observation.reserve()?;
    let mut guard = Guard {
        app: app.clone(),
        observation: observation.clone(),
        complete: false,
    };
    let mut latest = on_main(&app, &observation, |app, state| {
        install_observers(app, state)?;
        capture(app, state, "before-ensure", None)?;
        // This is the same one existing request; sampling never calls show/focus/activate.
        let response = super::foreground_request_on_main_thread(app, true)?;
        capture(app, state, "after-ensure", None)?;
        Ok(response)
    })
    .await?;
    let start = observation.log.lock().started.expect("probe reserved");
    for ordinal in 1..=SCHEDULED {
        tokio::time::sleep_until(tokio::time::Instant::from_std(
            start + STEP * u32::from(ordinal),
        ))
        .await;
        latest = on_main(&app, &observation, move |app, state| {
            capture(app, state, "scheduled", Some(ordinal))
        })
        .await?;
    }
    on_main(&app, &observation, |_, state| {
        stop_observers(state);
        state.finish("complete");
        Ok(Value::Null)
    })
    .await?;
    guard.complete = true;
    latest["activationObservation"] = observation.snapshot();
    Ok(latest)
}
pub(super) fn cancel(app: &AppHandle, state: &Arc<Observation>) {
    state.finish("window-destroyed");
    let state = state.clone();
    let _ = app.run_on_main_thread(move || stop_observers(&state));
}

#[cfg(target_os = "macos")]
fn activation_policy(value: objc2_app_kit::NSApplicationActivationPolicy) -> &'static str {
    use objc2_app_kit::NSApplicationActivationPolicy;
    match value {
        NSApplicationActivationPolicy::Regular => "regular",
        NSApplicationActivationPolicy::Accessory => "accessory",
        NSApplicationActivationPolicy::Prohibited => "prohibited",
        _ => "unknown",
    }
}
#[cfg(target_os = "macos")]
fn capture(
    app: &AppHandle,
    state: &Observation,
    stage: &'static str,
    sample: Option<u8>,
) -> Result<Value, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSRunningApplication, NSWindow, NSWindowStyleMask};
    use objc2_foundation::NSBundle;
    let marker = MainThreadMarker::new().ok_or("Activation snapshot requires the main thread")?;
    let window = app
        .get_webview_window("main")
        .ok_or("Fixture main window unavailable")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    if pointer.is_null() {
        return Err("Fixture native window unavailable".into());
    }
    let window = unsafe { &*pointer.cast::<NSWindow>() };
    if !notifications::matches_window(state, window) {
        return Err("Activation observation main window identity changed".into());
    }
    let application = NSApplication::sharedApplication(marker);
    let running = NSRunningApplication::currentApplication();
    let mut flags = super::foreground_snapshot_on_main_thread(app)?;
    // Keep every flag vector, excluding the unrelated dynamic responder class string.
    flags
        .as_object_mut()
        .expect("foreground object")
        .remove("keyboardResponderClass");
    flags["eligibility"] = json!({"applicationPolicy":activation_policy(application.activationPolicy()),
        "runningApplicationPolicy":activation_policy(running.activationPolicy()),"finishedLaunching":running.isFinishedLaunching(),
        "runtimeBundleMatchesExpected":running.bundleIdentifier().map(|id|id.to_string() == state.expected_bundle),
        "mainBundleMatchesExpected":NSBundle::mainBundle().bundleIdentifier().map(|id|id.to_string() == state.expected_bundle),
        "configBundleMatchesExpected":app.config().identifier == state.expected_bundle,
        "runningApplicationActive":running.isActive(),"runningApplicationHidden":running.isHidden(),
        "canBecomeKeyWindow":window.canBecomeKeyWindow(),"canBecomeMainWindow":window.canBecomeMainWindow(),
        "isKeyWindow":window.isKeyWindow(),"isMainWindow":window.isMainWindow(),
        "isMiniaturized":window.isMiniaturized(),"isOnActiveSpace":window.isOnActiveSpace(),
        "isVisible":window.isVisible(),"nonactivatingPanelStyle":window.styleMask().contains(NSWindowStyleMask::NonactivatingPanel)});
    if !state.record("snapshot", stage, sample, Some(flags.clone())) {
        return Err(
            "Activation snapshot could not be retained within its observation budget".into(),
        );
    }
    Ok(flags)
}
#[cfg(not(target_os = "macos"))]
fn capture(
    _: &AppHandle,
    _: &Observation,
    _: &'static str,
    _: Option<u8>,
) -> Result<Value, String> {
    Err("Activation observation is macOS fixture-only".into())
}

#[cfg(target_os = "macos")]
mod notifications {
    use super::*;
    use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
    use objc2_app_kit::*;
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName};
    use std::{cell::RefCell, ptr::NonNull, sync::Weak};
    struct Tokens {
        center: Retained<NSNotificationCenter>,
        owner: Weak<Observation>,
        window: Retained<NSWindow>,
        values: Vec<Retained<AnyObject>>,
    }
    impl Drop for Tokens {
        fn drop(&mut self) {
            // Tokens are installed, stored and destroyed only in the main thread's local slot.
            for value in &self.values {
                unsafe { self.center.removeObserver(value) };
            }
            if let Some(state) = self.owner.upgrade() {
                state.log.lock().removed = self.values.len() as u8;
            }
        }
    }
    thread_local! { static TOKENS: RefCell<Option<Tokens>> = const { RefCell::new(None) }; }
    pub(super) fn install(app: &AppHandle, state: &Arc<Observation>) -> Result<(), String> {
        let marker =
            MainThreadMarker::new().ok_or("Activation observers require the main thread")?;
        let window = app
            .get_webview_window("main")
            .ok_or("Fixture main window unavailable")?;
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        if pointer.is_null() {
            return Err("Fixture native window unavailable".into());
        }
        let native_window = unsafe { &*pointer.cast::<NSWindow>() };
        let application = NSApplication::sharedApplication(marker);
        let center = NSNotificationCenter::defaultCenter();
        let mut tokens = Tokens {
            center,
            owner: Arc::downgrade(state),
            window: unsafe { Retained::retain(pointer.cast::<NSWindow>()) }
                .ok_or("Fixture main window retain failed")?,
            values: Vec::new(),
        };
        let mut add = |name: &NSNotificationName, object: &AnyObject, stage: &'static str| {
            let state = state.clone();
            // The callback captures only Send+Sync Rust state and never reads notification payloads.
            let callback_state = state.clone();
            let block = block2::RcBlock::new(move |_: NonNull<NSNotification>| {
                callback_state.record("notification", stage, None, None);
            });
            let token: Retained<AnyObject> = unsafe {
                objc2::msg_send![&*tokens.center,
                addObserverForName: Some(name), object: Some(object), queue: None::<&AnyObject>, usingBlock: &*block]
            };
            tokens.values.push(token);
            state.log.lock().registered = tokens.values.len() as u8;
        };
        unsafe {
            for (name, stage) in [
                (
                    NSApplicationDidFinishLaunchingNotification,
                    "app-did-finish-launching",
                ),
                (
                    NSApplicationDidBecomeActiveNotification,
                    "app-did-become-active",
                ),
                (
                    NSApplicationDidResignActiveNotification,
                    "app-did-resign-active",
                ),
                (NSApplicationDidHideNotification, "app-did-hide"),
                (NSApplicationDidUnhideNotification, "app-did-unhide"),
            ] {
                add(name, &application, stage);
            }
            for (name, stage) in [
                (NSWindowDidBecomeKeyNotification, "window-did-become-key"),
                (NSWindowDidResignKeyNotification, "window-did-resign-key"),
                (
                    NSWindowDidChangeOcclusionStateNotification,
                    "window-did-change-occlusion",
                ),
            ] {
                add(name, native_window, stage);
            }
        }
        TOKENS.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot.is_some() {
                return Err("Activation observer slot already occupied".into());
            }
            state.log.lock().registered = tokens.values.len() as u8;
            *slot = Some(tokens);
            Ok(())
        })
    }
    pub(super) fn stop(state: &Arc<Observation>) {
        if MainThreadMarker::new().is_none() {
            return;
        }
        TOKENS.with(|slot| {
            let mut slot = slot.borrow_mut();
            if slot
                .as_ref()
                .and_then(|tokens| tokens.owner.upgrade())
                .is_some_and(|owner| Arc::ptr_eq(&owner, state))
            {
                slot.take();
            }
        });
    }
    pub(super) fn matches_window(state: &Observation, window: &NSWindow) -> bool {
        if MainThreadMarker::new().is_none() {
            return false;
        }
        TOKENS.with(|slot| {
            slot.borrow().as_ref().is_some_and(|tokens| {
                tokens
                    .owner
                    .upgrade()
                    .is_some_and(|owner| std::ptr::eq(owner.as_ref(), state))
                    && std::ptr::eq(tokens.window.as_ref(), window)
            })
        })
    }
}
#[cfg(target_os = "macos")]
use notifications::{install as install_observers, stop as stop_observers};
#[cfg(not(target_os = "macos"))]
fn install_observers(_: &AppHandle, _: &Arc<Observation>) -> Result<(), String> {
    Err("macOS fixture-only".into())
}
#[cfg(not(target_os = "macos"))]
fn stop_observers(_: &Arc<Observation>) {}

#[cfg(test)]
#[path = "desktop_smoke_activation_observation_tests.rs"]
mod tests;
