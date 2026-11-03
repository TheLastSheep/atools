use super::state::{self, CachedMouseDown, GestureStamp};
use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSEvent, NSEventMask, NSEventType};
use std::{ptr::NonNull, time::Instant};

pub(super) fn install() -> Result<(), String> {
    let already_installed = state::with_state(|state| state.monitor.is_some())?;
    if already_installed {
        return Ok(());
    }

    let handler = RcBlock::new(|event: NonNull<NSEvent>| -> *mut NSEvent {
        if MainThreadMarker::new().is_none() {
            return event.as_ptr();
        }
        // SAFETY: AppKit passes a live NSEvent to the local monitor callback.
        let event_ref = unsafe { event.as_ref() };
        let event_type = event_ref.r#type();
        let window_number = event_ref.windowNumber();
        match event_type {
            NSEventType::LeftMouseDown => {
                // SAFETY: The local-monitor event pointer is valid for this
                // callback. Retain it because beginDraggingSession needs the
                // original mouse-down event after the monitor callback ends.
                if let Some(event) = unsafe { Retained::retain(event.as_ptr()) } {
                    let _ = state::with_state(|state| {
                        state.cached_down = Some(CachedMouseDown {
                            event,
                            stamp: GestureStamp {
                                window_number,
                                captured_at: Instant::now(),
                            },
                        });
                    });
                }
            }
            NSEventType::LeftMouseUp => {
                let _ = state::with_state(|state| state.cached_down = None);
            }
            _ => {}
        }

        // SAFETY: Returning the same borrowed pointer is the documented way
        // for a local monitor to let the original event continue unchanged.
        event.as_ptr()
    });
    let mask = NSEventMask::LeftMouseDown | NSEventMask::LeftMouseUp;
    // SAFETY: The handler always returns the valid event pointer supplied for
    // this callback; it never creates, stores, or returns a dangling pointer.
    let monitor = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &handler) }
        .ok_or_else(|| "AppKit did not install the local mouse monitor".to_string())?;
    let monitor: Retained<AnyObject> = monitor;
    let monitor_for_state = monitor.clone();
    let stored = state::with_state(move |state| {
        if state.monitor.is_none() {
            state.monitor = Some(monitor_for_state);
            true
        } else {
            false
        }
    });
    match stored {
        Ok(true) => {}
        Ok(false) => {
            // SAFETY: This is the token returned by the monitor installation above.
            unsafe { NSEvent::removeMonitor(&monitor) };
            return Ok(());
        }
        Err(error) => {
            // SAFETY: The installation token remains retained locally.
            unsafe { NSEvent::removeMonitor(&monitor) };
            return Err(error);
        }
    }
    Ok(())
}

pub(super) fn consume(window_number: isize) -> Result<Retained<NSEvent>, String> {
    let pressed = NSEvent::pressedMouseButtons() as usize;
    let now = Instant::now();
    let cached = state::with_existing_state(|state| {
        let Some(cached) = state.cached_down.as_ref() else {
            return Err(
                "native file drag requires a recent real left mouse-down in this WebView".into(),
            );
        };
        if cached.stamp.window_number != window_number {
            return Err("native file drag mouse-down belongs to a different window".into());
        }
        if !cached.stamp.is_eligible(window_number, pressed, now) {
            state.cached_down = None;
            return Err(
                "native file drag mouse-down expired or the left button is no longer pressed"
                    .into(),
            );
        }
        let cached = state
            .cached_down
            .take()
            .ok_or_else(|| "native file drag mouse-down was consumed".to_string())?;
        Ok(cached.event)
    })?;
    cached.unwrap_or_else(|| {
        Err("native file drag requires a recent real left mouse-down in this WebView".into())
    })
}

pub(super) fn clear_for_window(window_number: isize) {
    let _ = state::with_existing_state(|state| {
        if state
            .cached_down
            .as_ref()
            .is_some_and(|down| down.stamp.window_number == window_number)
        {
            state.cached_down = None;
        }
    });
}

pub(super) fn uninstall() {
    let monitor = state::with_existing_state(|state| {
        state.cached_down = None;
        state.monitor.take()
    })
    .ok()
    .flatten()
    .flatten();
    if let Some(monitor) = monitor {
        // SAFETY: This token was returned by addLocalMonitor and is retained
        // until removed on the AppKit main thread.
        unsafe { NSEvent::removeMonitor(&monitor) };
        drop(monitor);
    }
    let _ = state::discard_if_idle();
}
