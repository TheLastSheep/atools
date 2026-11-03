use tauri::{AppHandle, Manager, Wry};

use super::{trace::NativePresentationObservation, IDENTITY_INVALID, SHOW_FAILED, WINDOW_HIDDEN};

#[derive(Clone, Copy, Debug)]
pub(super) struct OrderFrontOutcome {
    pub(super) previous_level: Option<isize>,
    pub(super) after_order_front: Option<NativePresentationObservation>,
    pub(super) after_hide: Option<NativePresentationObservation>,
    pub(super) error: Option<&'static str>,
}

#[derive(Clone, Copy, Debug)]
pub(super) struct OrderOutOutcome {
    pub(super) after_hide: Option<NativePresentationObservation>,
    pub(super) error: Option<&'static str>,
}

#[cfg(target_os = "macos")]
pub(super) fn inspect(app: &AppHandle<Wry>, run_id: &str) -> NativePresentationObservation {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow, NSWindowOcclusionState, NSWorkspace};

    let mut observation = NativePresentationObservation::default();
    let Some(marker) = MainThreadMarker::new() else {
        return observation;
    };

    let application = NSApplication::sharedApplication(marker);
    observation.app_active = Some(application.isActive());
    observation.app_hidden = Some(application.isHidden());
    observation.frontmost_is_self = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|running| running.processIdentifier() == std::process::id() as i32);

    let Ok(window) = validated_main_window(app, run_id) else {
        return observation;
    };
    let Ok(pointer) = window.ns_window() else {
        return observation;
    };
    if pointer.is_null() {
        return observation;
    }

    let native = unsafe { &*pointer.cast::<NSWindow>() };
    observation.visible = window.is_visible().ok();
    observation.window_focused = window.is_focused().ok();
    observation.window_key = Some(native.isKeyWindow());
    observation.occlusion_visible = Some(
        native
            .occlusionState()
            .contains(NSWindowOcclusionState::Visible),
    );
    observation.on_active_space = Some(native.isOnActiveSpace());
    observation
}

#[cfg(not(target_os = "macos"))]
pub(super) fn inspect(_app: &AppHandle<Wry>, _run_id: &str) -> NativePresentationObservation {
    NativePresentationObservation::default()
}

/// Orders only the validated fixture main NSWindow at its configured level, without making it key
/// or activating ATools. This level is retained only for the short-lived QA presentation lease.
#[cfg(target_os = "macos")]
pub(super) fn order_front(app: &AppHandle<Wry>, run_id: &str) -> OrderFrontOutcome {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;

    let failure = |error| OrderFrontOutcome {
        previous_level: None,
        after_order_front: None,
        after_hide: None,
        error: Some(error),
    };
    if MainThreadMarker::new().is_none() {
        return failure(SHOW_FAILED);
    }
    let window = match validated_main_window(app, run_id) {
        Ok(window) => window,
        Err(error) => return failure(error),
    };
    let pointer = match window.ns_window() {
        Ok(pointer) if !pointer.is_null() => pointer,
        _ => return failure(SHOW_FAILED),
    };
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    if native.isVisible() {
        return OrderFrontOutcome {
            previous_level: None,
            after_order_front: Some(inspect(app, run_id)),
            after_hide: None,
            error: Some(SHOW_FAILED),
        };
    }

    let previous_level = native.level();
    native.orderFrontRegardless();
    let after_order_front = inspect(app, run_id);
    if after_order_front.after_order_front_unfocused() {
        return OrderFrontOutcome {
            previous_level: Some(previous_level),
            after_order_front: Some(after_order_front),
            after_hide: None,
            error: None,
        };
    }

    native.orderOut(None);
    native.setLevel(previous_level);
    OrderFrontOutcome {
        previous_level: Some(previous_level),
        after_order_front: Some(after_order_front),
        after_hide: Some(inspect(app, run_id)),
        error: Some(if after_order_front.focus_changed() {
            super::FOCUS_CHANGED
        } else {
            SHOW_FAILED
        }),
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn order_front(_app: &AppHandle<Wry>, _run_id: &str) -> OrderFrontOutcome {
    OrderFrontOutcome {
        previous_level: None,
        after_order_front: None,
        after_hide: None,
        error: Some(SHOW_FAILED),
    }
}

/// Hides only the owned fixture window and restores its saved native level.
#[cfg(target_os = "macos")]
pub(super) fn order_out(
    app: &AppHandle<Wry>,
    run_id: &str,
    previous_level: Option<isize>,
) -> OrderOutOutcome {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;

    if MainThreadMarker::new().is_none() {
        return OrderOutOutcome {
            after_hide: None,
            error: Some(WINDOW_HIDDEN),
        };
    }
    let window = match validated_main_window(app, run_id) {
        Ok(window) => window,
        Err(error) => {
            return OrderOutOutcome {
                after_hide: Some(inspect(app, run_id)),
                error: Some(if error == IDENTITY_INVALID {
                    error
                } else {
                    WINDOW_HIDDEN
                }),
            };
        }
    };
    let pointer = match window.ns_window() {
        Ok(pointer) if !pointer.is_null() => pointer,
        _ => {
            return OrderOutOutcome {
                after_hide: Some(inspect(app, run_id)),
                error: Some(WINDOW_HIDDEN),
            };
        }
    };
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    native.orderOut(None);
    if let Some(level) = previous_level {
        native.setLevel(level);
    }
    let after_hide = inspect(app, run_id);
    OrderOutOutcome {
        error: (after_hide.visible != Some(false)).then_some(WINDOW_HIDDEN),
        after_hide: Some(after_hide),
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn order_out(
    _app: &AppHandle<Wry>,
    _run_id: &str,
    _previous_level: Option<isize>,
) -> OrderOutOutcome {
    OrderOutOutcome {
        after_hide: None,
        error: Some(WINDOW_HIDDEN),
    }
}

#[cfg(target_os = "macos")]
fn validated_main_window(
    app: &AppHandle<Wry>,
    run_id: &str,
) -> Result<tauri::Window<Wry>, &'static str> {
    if !valid_run_id(run_id)
        || app.config().identifier != format!("dev.atools.renderer-settings-input.{run_id}")
    {
        return Err(IDENTITY_INVALID);
    }
    let window = crate::window::main_window(app).map_err(|_| IDENTITY_INVALID)?;
    if window.label() != "main" {
        return Err(IDENTITY_INVALID);
    }
    Ok(window)
}

pub(super) fn valid_run_id(run_id: &str) -> bool {
    uuid::Uuid::parse_str(run_id)
        .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.simple().to_string() == run_id)
}

#[cfg(test)]
#[path = "presented_paint_window_native_tests.rs"]
mod tests;
