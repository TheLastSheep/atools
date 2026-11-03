use super::session::ActiveDrag;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::NSEvent;
use std::{
    cell::RefCell,
    collections::HashMap,
    time::{Duration, Instant},
};

pub(super) const LEFT_MOUSE_BUTTON_MASK: usize = 1;
pub(super) const GESTURE_TTL: Duration = Duration::from_secs(30);

#[derive(Clone, Copy)]
pub(super) struct GestureStamp {
    pub(super) window_number: isize,
    pub(super) captured_at: Instant,
}

impl GestureStamp {
    pub(super) fn is_eligible(
        self,
        window_number: isize,
        pressed_buttons: usize,
        now: Instant,
    ) -> bool {
        self.window_number == window_number
            && pressed_buttons & LEFT_MOUSE_BUTTON_MASK != 0
            && now
                .checked_duration_since(self.captured_at)
                .is_some_and(|elapsed| elapsed <= GESTURE_TTL)
    }
}

pub(super) struct CachedMouseDown {
    pub(super) event: Retained<NSEvent>,
    pub(super) stamp: GestureStamp,
}

#[derive(Default)]
pub(super) struct NativeState {
    pub(super) monitor: Option<Retained<AnyObject>>,
    pub(super) cached_down: Option<CachedMouseDown>,
    pub(super) active: HashMap<u64, ActiveDrag>,
    pub(super) deferred_release: HashMap<u64, ActiveDrag>,
}

thread_local! {
    static NATIVE_STATE: RefCell<Option<NativeState>> = const { RefCell::new(None) };
}

pub(super) fn with_state<R>(operation: impl FnOnce(&mut NativeState) -> R) -> Result<R, String> {
    if MainThreadMarker::new().is_none() {
        return Err("AppKit drag state requires the main thread".into());
    }
    NATIVE_STATE.with(|slot| {
        let mut slot = slot
            .try_borrow_mut()
            .map_err(|_| "AppKit drag state is currently in use".to_string())?;
        Ok(operation(slot.get_or_insert_with(NativeState::default)))
    })
}

pub(super) fn with_existing_state<R>(
    operation: impl FnOnce(&mut NativeState) -> R,
) -> Result<Option<R>, String> {
    if MainThreadMarker::new().is_none() {
        return Err("AppKit drag state requires the main thread".into());
    }
    NATIVE_STATE.with(|slot| {
        let mut slot = slot
            .try_borrow_mut()
            .map_err(|_| "AppKit drag state is currently in use".to_string())?;
        Ok(slot.as_mut().map(operation))
    })
}

pub(super) fn discard_if_idle() -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("AppKit drag state requires the main thread".into());
    }
    NATIVE_STATE.with(|slot| {
        let mut slot = slot
            .try_borrow_mut()
            .map_err(|_| "AppKit drag state is currently in use".to_string())?;
        let should_discard = slot.as_ref().is_some_and(|state| {
            state.monitor.is_none()
                && state.cached_down.is_none()
                && state.active.is_empty()
                && state.deferred_release.is_empty()
        });
        if should_discard {
            *slot = None;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::{GestureStamp, GESTURE_TTL, LEFT_MOUSE_BUTTON_MASK};
    use std::time::{Duration, Instant};

    #[test]
    fn gesture_requires_same_window_pressed_left_button_and_fresh_event() {
        let down = Instant::now();
        let stamp = GestureStamp {
            window_number: 17,
            captured_at: down,
        };

        assert!(stamp.is_eligible(17, LEFT_MOUSE_BUTTON_MASK, down));
        assert!(!stamp.is_eligible(18, LEFT_MOUSE_BUTTON_MASK, down));
        assert!(!stamp.is_eligible(17, 0, down));
        assert!(!stamp.is_eligible(
            17,
            LEFT_MOUSE_BUTTON_MASK,
            down + GESTURE_TTL + Duration::from_nanos(1)
        ));
        assert!(!stamp.is_eligible(17, LEFT_MOUSE_BUTTON_MASK, down - Duration::from_nanos(1)));
    }
}
