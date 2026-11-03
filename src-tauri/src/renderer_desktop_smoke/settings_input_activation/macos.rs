use std::{
    cell::RefCell,
    ptr::NonNull,
    sync::{Arc, Weak},
};

use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{
    NSApplication, NSApplicationDidBecomeActiveNotification, NSWindow,
    NSWindowDidBecomeKeyNotification, NSWorkspace,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSNotificationName};
use tauri::AppHandle;

use super::ActivationState;

struct Tokens {
    center: Retained<NSNotificationCenter>,
    owner: Weak<ActivationState>,
    _window: Retained<NSWindow>,
    values: Vec<Retained<AnyObject>>,
}

impl Drop for Tokens {
    fn drop(&mut self) {
        for token in &self.values {
            unsafe { self.center.removeObserver(token) };
        }
        if let Some(state) = self.owner.upgrade() {
            state.mark_removed(self.values.len());
        }
    }
}

thread_local! {
    static TOKENS: RefCell<Option<Tokens>> = const { RefCell::new(None) };
}

pub(super) fn install(app: &AppHandle, state: &Arc<ActivationState>) -> Result<(), String> {
    let marker = MainThreadMarker::new().ok_or("Activation observers require the main thread")?;
    if TOKENS.with(|slot| slot.borrow().is_some()) {
        return Err("Activation observer slot is already occupied".into());
    }
    let window = crate::window::main_window(app)
        .map_err(|_| "Main window is unavailable for activation observation")?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    if pointer.is_null() {
        return Err("Main native window is unavailable for activation observation".into());
    }
    let native_window = unsafe { &*pointer.cast::<NSWindow>() };
    let retained_window = unsafe { Retained::retain(pointer.cast::<NSWindow>()) }
        .ok_or("Main native window could not be retained for activation observation")?;
    let center = NSNotificationCenter::defaultCenter();
    let application = NSApplication::sharedApplication(marker);

    let app_state = Arc::clone(state);
    let app_token = unsafe {
        add_observer(
            &center,
            &NSApplicationDidBecomeActiveNotification,
            &application,
            move |_| app_state.record_app_activation(),
        )
    };
    let window_state = Arc::clone(state);
    let window_token = unsafe {
        add_observer(
            &center,
            &NSWindowDidBecomeKeyNotification,
            native_window,
            move |_| window_state.record_main_key(),
        )
    };
    let tokens = Tokens {
        center,
        owner: Arc::downgrade(state),
        _window: retained_window,
        values: vec![app_token, window_token],
    };
    TOKENS.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err("Activation observer slot became occupied during installation".into());
        }
        *slot = Some(tokens);
        Ok(())
    })
}

pub(super) fn sample(state: &ActivationState) -> Result<serde_json::Value, String> {
    let marker = MainThreadMarker::new().ok_or("Activation sample requires the main thread")?;
    let app_active = NSApplication::sharedApplication(marker).isActive();
    let frontmost_is_self = NSWorkspace::sharedWorkspace()
        .frontmostApplication()
        .map(|application| application.processIdentifier() == std::process::id() as i32);
    Ok(super::snapshot(state, Some(app_active), frontmost_is_self))
}

pub(super) fn uninstall(state: &Arc<ActivationState>) -> Result<(), String> {
    if MainThreadMarker::new().is_none() {
        return Err("Activation observers must be removed on the main thread".into());
    }
    let tokens = TOKENS.with(|slot| {
        let mut slot = slot.borrow_mut();
        match slot.as_ref() {
            Some(tokens)
                if tokens
                    .owner
                    .upgrade()
                    .is_some_and(|owner| Arc::ptr_eq(&owner, state)) =>
            {
                Ok(slot.take())
            }
            Some(_) => Err("Activation observer slot belongs to another app".to_owned()),
            None if !state.installed.load(std::sync::atomic::Ordering::Acquire) => Ok(None),
            None => Err("Installed activation observers are missing from the main thread".into()),
        }
    })?;
    drop(tokens);
    Ok(())
}

fn add_observer(
    center: &NSNotificationCenter,
    name: &NSNotificationName,
    object: &AnyObject,
    callback: impl Fn(NonNull<NSNotification>) + 'static,
) -> Retained<AnyObject> {
    let block = block2::RcBlock::new(callback);
    unsafe {
        objc2::msg_send![center,
            addObserverForName: Some(name),
            object: Some(object),
            queue: None::<&AnyObject>,
            usingBlock: &*block]
    }
}
