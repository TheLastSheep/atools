use super::{GestureStamp, StartAuthorization, StartGate, GESTURE_TTL};
use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType, NSWindow};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::HashMap,
    ptr::NonNull,
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};
use tokio::sync::oneshot;

const LEFT_MOUSE_BUTTON_MASK: usize = 1;
const START_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(500);

struct CachedMouseDown {
    event: Retained<NSEvent>,
    stamp: GestureStamp,
}

#[derive(Default)]
struct MonitorState {
    monitor: Option<Retained<AnyObject>>,
    windows: HashMap<String, isize>,
    cached_down: Option<CachedMouseDown>,
}

thread_local! {
    static STATE: RefCell<Option<MonitorState>> = const { RefCell::new(None) };
}

pub(super) fn register_window(label: &str, window: &WebviewWindow) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err(unsupported(
            "window registration requires the AppKit main thread",
        ));
    }
    let pointer = window
        .ns_window()
        .map_err(|error| build_error(format!("unable to inspect NSWindow: {error}")))?;
    if pointer.is_null() {
        return Err(build_error("native NSWindow handle is unavailable"));
    }
    // SAFETY: Tauri owns this live NSWindow; registration runs synchronously
    // on the AppKit main thread and only reads its stable window number.
    let window_number = unsafe { &*pointer.cast::<NSWindow>() }.windowNumber();
    ensure_monitor()?;
    let inserted = with_state(|state| {
        if let Some(previous_number) = state.windows.insert(label.to_string(), window_number) {
            if previous_number != window_number
                && state
                    .cached_down
                    .as_ref()
                    .is_some_and(|down| down.stamp.window_number == previous_number)
            {
                state.cached_down = None;
            }
        }
    });
    if let Err(error) = inserted {
        remove_monitor_if_idle();
        return Err(error);
    }
    Ok(())
}

pub(super) fn forget_window(app: &AppHandle, label: &str) {
    if MainThreadMarker::new().is_some() {
        forget_on_main(label);
        return;
    }
    let label = label.to_string();
    if let Err(error) = app.run_on_main_thread(move || forget_on_main(&label)) {
        tracing::warn!(%error, "could not schedule native drag monitor cleanup");
    }
}

pub(super) async fn start_dragging<F>(
    app: &AppHandle,
    label: &str,
    started_at_ms: u64,
    prepared_at: Instant,
    prepared_at_ms: u64,
    preflight: F,
) -> Result<Value, String>
where
    F: FnOnce(&WebviewWindow) -> Result<StartAuthorization, String> + Send + 'static,
{
    let gate = Arc::new(StartGate::default());
    let (ack_sender, ack_receiver) = oneshot::channel::<Result<Value, String>>();
    let callback_gate = gate.clone();
    let worker = app.clone();
    let label = label.to_string();
    app.run_on_main_thread(move || {
        if !callback_gate.begin_checking() {
            return;
        }
        let result = start_preflight(
            &worker,
            &label,
            started_at_ms,
            prepared_at,
            prepared_at_ms,
            &callback_gate,
            preflight,
        );
        match result {
            Ok((native_window, event, snapshot)) => {
                if !callback_gate.accept() {
                    let _ = ack_sender.send(Err(timeout_error()));
                    return;
                }
                // A failed send means the timeout/caller already dropped the
                // receiver. Do not start a gesture after that cancellation.
                if ack_sender.send(Ok(snapshot)).is_ok() {
                    // SAFETY: Both retained AppKit objects were obtained on
                    // the main thread. No state borrow or lock crosses this
                    // call; AppKit may synchronously re-enter its event loop.
                    native_window.performWindowDragWithEvent(&event);
                }
            }
            Err(error) => {
                callback_gate.cancel();
                let _ = ack_sender.send(Err(error));
            }
        }
    })
    .map_err(|error| {
        gate.cancel();
        format!("ERR_ATOOLS_NATIVE_WINDOW_MAIN_THREAD: {error}")
    })?;

    let mut ack_receiver = ack_receiver;
    let timeout_result = tokio::time::timeout(START_TIMEOUT, &mut ack_receiver).await;
    match timeout_result {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("ERR_ATOOLS_NATIVE_WINDOW_DRAG_ACK: start acknowledgement ended".into()),
        Err(_) => {
            if gate.cancel() {
                Err(timeout_error())
            } else {
                // Accepted means the UI callback won the deadline race. Keep
                // the receiver alive until its already-authorized ACK arrives;
                // otherwise the sender could mistake cancellation for timeout.
                match ack_receiver.await {
                    Ok(result) => result,
                    Err(_) => {
                        Err("ERR_ATOOLS_NATIVE_WINDOW_DRAG_ACK: start acknowledgement ended".into())
                    }
                }
            }
        }
    }
}

fn start_preflight<F>(
    app: &AppHandle,
    label: &str,
    started_at_ms: u64,
    prepared_at: Instant,
    prepared_at_ms: u64,
    gate: &StartGate,
    preflight: F,
) -> Result<(Retained<NSWindow>, Retained<NSEvent>, Value), String>
where
    F: FnOnce(&WebviewWindow) -> Result<StartAuthorization, String>,
{
    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("ERR_ATOOLS_NATIVE_WINDOW_NOT_FOUND: {label}"))?;
    let pointer = window
        .ns_window()
        .map_err(|error| format!("ERR_ATOOLS_NATIVE_WINDOW: {error}"))?;
    if pointer.is_null() {
        return Err("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: NSWindow is unavailable".into());
    }
    // SAFETY: The live Tauri NSWindow is retained while the handoff runs and
    // AppKit dragging can enter a nested event loop.
    let native_window =
        unsafe { Retained::retain(pointer.cast::<NSWindow>()) }.ok_or_else(|| {
            "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: NSWindow is unavailable".to_string()
        })?;
    let snapshot = crate::plugin_browser_window_native::snapshot::snapshot_now(&window)?;
    let authorization = preflight(&window)?;
    if !authorization.allows() {
        return Err(
            "ERR_ATOOLS_NATIVE_WINDOW_AUTHORIZATION: drag request is no longer current".into(),
        );
    }
    if !gate.is_checking() {
        return Err(timeout_error());
    }
    let candidate = consume_candidate(
        native_window.windowNumber(),
        started_at_ms,
        prepared_at_ms,
        prepared_at,
    )?;
    let snapshot = json!({ "value": null, "snapshot": snapshot.to_value()? });
    Ok((native_window, candidate.event, snapshot))
}

fn consume_candidate(
    window_number: isize,
    started_at_ms: u64,
    prepared_at_ms: u64,
    prepared_at: Instant,
) -> Result<CachedMouseDown, String> {
    if MainThreadMarker::new().is_none() {
        return Err(unsupported(
            "gesture consumption requires the AppKit main thread",
        ));
    }
    let now = Instant::now();
    let left_button_pressed = NSEvent::pressedMouseButtons() as usize & LEFT_MOUSE_BUTTON_MASK != 0;
    with_state(|state| {
        let Some(candidate) = state.cached_down.as_ref() else {
            return Err(gesture_error("a recent real left mouse-down is required"));
        };
        if candidate.stamp.window_number != window_number {
            return Err(gesture_error("mouse-down belongs to a different window"));
        }
        if candidate.stamp.captured_epoch_ms > started_at_ms {
            return Err(gesture_error(
                "mouse-down is newer than the DOM gesture request",
            ));
        }
        if !candidate.stamp.is_eligible(
            window_number,
            left_button_pressed,
            started_at_ms,
            prepared_at_ms,
            prepared_at,
            now,
        ) {
            if now
                .checked_duration_since(candidate.stamp.captured_at)
                .map_or(true, |elapsed| elapsed > GESTURE_TTL)
                || !left_button_pressed
            {
                state.cached_down = None;
            }
            return Err(gesture_error(
                "mouse-down expired or is not an eligible left drag",
            ));
        }
        state
            .cached_down
            .take()
            .ok_or_else(|| gesture_error("mouse-down was already consumed"))
    })?
}

fn ensure_monitor() -> Result<(), String> {
    if with_state(|state| state.monitor.is_some())? {
        return Ok(());
    }
    let monitor = install_monitor()?;
    let stored = with_state(|state| {
        if state.monitor.is_some() {
            false
        } else {
            state.monitor = Some(monitor.clone());
            true
        }
    });
    match stored {
        Ok(true) => Ok(()),
        Ok(false) => {
            // SAFETY: This exact token was just returned by AppKit.
            unsafe { NSEvent::removeMonitor(&monitor) };
            Ok(())
        }
        Err(error) => {
            // SAFETY: The token remains locally retained after the failed
            // thread-local state update.
            unsafe { NSEvent::removeMonitor(&monitor) };
            Err(error)
        }
    }
}

fn install_monitor() -> Result<Retained<AnyObject>, String> {
    let handler = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        if MainThreadMarker::new().is_none() {
            return event.as_ptr();
        }
        // SAFETY: AppKit provides a live event for the monitor callback.
        let event_ref = unsafe { event.as_ref() };
        match event_ref.r#type() {
            NSEventType::LeftMouseDown => {
                let window_number = event_ref.windowNumber();
                let epoch_ms = unix_epoch_ms();
                if let Some(captured_epoch_ms) = epoch_ms {
                    let tracked = with_state(|state| {
                        state
                            .windows
                            .values()
                            .any(|number| *number == window_number)
                    })
                    .unwrap_or(false);
                    if tracked {
                        // SAFETY: Retain the original event while AppKit's
                        // local-monitor callback returns it unchanged.
                        if let Some(retained_event) = unsafe { Retained::retain(event.as_ptr()) } {
                            let stamp = GestureStamp {
                                window_number,
                                captured_at: Instant::now(),
                                captured_epoch_ms,
                                control_down: event_ref
                                    .modifierFlags()
                                    .contains(NSEventModifierFlags::Control),
                            };
                            let _ = with_state(|state| {
                                state.cached_down = Some(CachedMouseDown {
                                    event: retained_event,
                                    stamp,
                                });
                            });
                        }
                    }
                }
            }
            NSEventType::LeftMouseUp => {
                let _ = with_state(|state| state.cached_down = None);
            }
            _ => {}
        }
        // Pass the exact original event through the local monitor unchanged.
        event.as_ptr()
    });
    let mask = NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp;
    // SAFETY: The handler returns the original borrowed event or its exact
    // pointer, as required by AppKit's local-monitor contract.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) }
        .ok_or_else(|| unsupported("AppKit did not install the local mouse monitor"))?;
    let monitor: Retained<AnyObject> = monitor;
    Ok(monitor)
}

fn forget_on_main(label: &str) {
    let monitor = with_state(|state| {
        let removed_number = state.windows.remove(label);
        if removed_number.is_some_and(|number| {
            state
                .cached_down
                .as_ref()
                .is_some_and(|down| down.stamp.window_number == number)
        }) {
            state.cached_down = None;
        }
        if state.windows.is_empty() {
            state.cached_down = None;
            state.monitor.take()
        } else {
            None
        }
    })
    .ok()
    .flatten();
    if let Some(monitor) = monitor {
        // SAFETY: The monitor is retained until this main-thread removal.
        unsafe { NSEvent::removeMonitor(&monitor) };
    }
    discard_state_if_idle();
}

fn remove_monitor_if_idle() {
    let monitor = with_state(|state| {
        if state.windows.is_empty() {
            state.cached_down = None;
            state.monitor.take()
        } else {
            None
        }
    })
    .ok()
    .flatten();
    if let Some(monitor) = monitor {
        // SAFETY: The monitor is retained until this main-thread removal.
        unsafe { NSEvent::removeMonitor(&monitor) };
    }
    discard_state_if_idle();
}

fn discard_state_if_idle() {
    if MainThreadMarker::new().is_none() {
        return;
    }
    STATE.with(|slot| {
        if let Ok(mut slot) = slot.try_borrow_mut() {
            if slot.as_ref().is_some_and(|state| {
                state.monitor.is_none() && state.windows.is_empty() && state.cached_down.is_none()
            }) {
                *slot = None;
            }
        }
    });
}

fn with_state<R>(operation: impl FnOnce(&mut MonitorState) -> R) -> Result<R, String> {
    if MainThreadMarker::new().is_none() {
        return Err(unsupported("AppKit monitor state requires the main thread"));
    }
    STATE.with(|slot| {
        let mut slot = slot
            .try_borrow_mut()
            .map_err(|_| unsupported("AppKit monitor state is re-entered"))?;
        Ok(operation(slot.get_or_insert_with(MonitorState::default)))
    })
}

fn unix_epoch_ms() -> Option<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
}

fn gesture_error(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_GESTURE: {}", message.as_ref())
}

fn build_error(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_BUILD: {}", message.as_ref())
}

fn unsupported(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: {}", message.as_ref())
}

fn timeout_error() -> String {
    format!(
        "ERR_ATOOLS_NATIVE_WINDOW_TIMEOUT: drag start was not accepted within {} ms",
        START_TIMEOUT.as_millis()
    )
}
