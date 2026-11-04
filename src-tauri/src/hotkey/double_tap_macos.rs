//! Passive session event tap. All native resources are created/released on AppKit's thread.
use super::super::{
    double_tap::Modifier,
    double_tap_input::InputState,
    main_dispatch::{self, Token},
};
use block2::RcBlock;
use core_graphics::event::CGEventFlags;
use objc2::{msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{
    NSWorkspace, NSWorkspaceDidWakeNotification, NSWorkspaceSessionDidBecomeActiveNotification,
    NSWorkspaceSessionDidResignActiveNotification, NSWorkspaceWillSleepNotification,
};
use parking_lot::Mutex;
use std::{
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::AppHandle;

type Raw = *mut c_void;
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn CGPreflightListenEventAccess() -> bool;
    fn CGEventTapCreate(
        location: u32,
        placement: u32,
        options: u32,
        mask: u64,
        callback: extern "C" fn(Raw, u32, Raw, Raw) -> Raw,
        context: Raw,
    ) -> Raw;
    fn CGEventTapEnable(tap: Raw, enable: bool);
    fn CGEventTapIsEnabled(tap: Raw) -> bool;
    fn CGEventGetIntegerValueField(event: Raw, field: u32) -> i64;
    fn CGEventGetFlags(event: Raw) -> u64;
    fn CGEventGetTimestamp(event: Raw) -> u64;
    fn CGEventSourceKeyState(state: i32, key: u16) -> bool;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    static kCFRunLoopCommonModes: Raw;
    fn CFRunLoopGetMain() -> Raw;
    fn CFMachPortCreateRunLoopSource(allocator: Raw, port: Raw, order: isize) -> Raw;
    fn CFRunLoopAddSource(runloop: Raw, source: Raw, mode: Raw);
    fn CFRunLoopRemoveSource(runloop: Raw, source: Raw, mode: Raw);
    fn CFRunLoopContainsSource(runloop: Raw, source: Raw, mode: Raw) -> u8;
    fn CFMachPortInvalidate(port: Raw);
    fn CFMachPortIsValid(port: Raw) -> u8;
    fn CFRelease(value: Raw);
}
#[repr(C)]
struct Timebase {
    numerator: u32,
    denominator: u32,
}
extern "C" {
    fn mach_absolute_time() -> u64;
    fn mach_timebase_info(info: *mut Timebase) -> i32;
}
fn timestamp() -> Option<u64> {
    let mut scale = Timebase {
        numerator: 0,
        denominator: 0,
    };
    unsafe {
        if mach_timebase_info(&mut scale) != 0 || scale.denominator == 0 {
            return None;
        }
        Some(
            (mach_absolute_time() as u128 * scale.numerator as u128 / scale.denominator as u128)
                .min(u64::MAX as u128) as u64,
        )
    }
}
struct Monitor {
    app: AppHandle,
    modifier: Modifier,
    token: Arc<Token>,
    input: Mutex<InputState>,
    alive: AtomicBool,
    paused: AtomicBool,
    pending: AtomicBool,
    epoch: AtomicU64,
    recording_epoch: AtomicU64,
    tap: AtomicUsize,
}
#[derive(Clone, Copy)]
pub(in crate::hotkey) struct Lease {
    tap: usize,
    source: usize,
    context: usize,
    observers: [usize; 4],
}

pub(in crate::hotkey) fn preflight() -> Result<(), String> {
    if unsafe { CGPreflightListenEventAccess() } {
        Ok(())
    } else {
        Err(super::PERMISSION_REQUIRED.into())
    }
}
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    if MainThreadMarker::new().is_some() {
        return action();
    }
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = send.send(action());
    })
    .map_err(|_| "SETTINGS_HOTKEY_OUTCOME_UNKNOWN")?;
    receive
        .recv()
        .map_err(|_| "SETTINGS_HOTKEY_OUTCOME_UNKNOWN".to_string())?
}
fn refresh(monitor: &Monitor) -> Result<(), String> {
    // One finite snapshot, never periodic polling or stored input content.
    let held =
        super::super::double_tap_input::snapshot(|key| unsafe { CGEventSourceKeyState(0, key) });
    monitor.input.lock().establish(held);
    monitor.epoch.store(
        timestamp().ok_or("SETTINGS_HOTKEY_OUTCOME_UNKNOWN")?,
        Ordering::Release,
    );
    monitor.pending.store(false, Ordering::Release);
    Ok(())
}
fn rebaseline(monitor: &Arc<Monitor>) {
    if monitor.paused.load(Ordering::Acquire) {
        return;
    }
    if monitor.pending.swap(true, Ordering::AcqRel) {
        return;
    }
    monitor.token.invalidate_pending();
    monitor.epoch.store(u64::MAX, Ordering::Release);
    let monitor = monitor.clone();
    let app = monitor.app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = app.run_on_main_thread(move || {
            if !monitor.alive.load(Ordering::Acquire)
                || monitor.paused.load(Ordering::Acquire)
                || main_dispatch::is_closed(&monitor.app)
            {
                return;
            }
            let tap = monitor.tap.load(Ordering::Acquire) as Raw;
            if !tap.is_null() && unsafe { CGPreflightListenEventAccess() } {
                unsafe { CGEventTapEnable(tap, true) };
                let _ = refresh(&monitor);
            }
        });
    });
}
extern "C" fn callback(_: Raw, kind: u32, event: Raw, context: Raw) -> Raw {
    // Context is owned until the main-thread source is removed and its tap invalidated.
    let monitor = unsafe { &*(context as *const Arc<Monitor>) };
    if !monitor.alive.load(Ordering::Acquire) || monitor.paused.load(Ordering::Acquire) {
        return event;
    }
    if kind == 0xffff_fffe || kind == 0xffff_ffff {
        rebaseline(monitor);
        return event;
    }
    if event.is_null() || !matches!(kind, 10 | 11 | 12) {
        return event;
    }
    let time = unsafe { CGEventGetTimestamp(event) };
    let key = unsafe { CGEventGetIntegerValueField(event, 9) };
    if !(0..128).contains(&key) {
        rebaseline(monitor);
        return event;
    }
    let flags = CGEventFlags::from_bits_truncate(unsafe { CGEventGetFlags(event) });
    let mut groups = 0;
    for (index, flag) in [
        CGEventFlags::CGEventFlagCommand,
        CGEventFlags::CGEventFlagControl,
        CGEventFlags::CGEventFlagAlternate,
        CGEventFlags::CGEventFlagShift,
    ]
    .iter()
    .enumerate()
    {
        if flags.contains(*flag) {
            groups |= 1 << index;
        }
    }
    let Ok(gate) = crate::app_global_shortcuts::recording::gate(&monitor.app) else {
        return event;
    };
    if kind == 12
        && super::super::double_tap_input::physical_modifier(key as u16)
            .is_some_and(|physical| physical.modifier == monitor.modifier)
    {
        if let Some(receipt) = monitor.token.receipt.lock().as_ref() {
            receipt.edge(groups & (1 << monitor.modifier as u8) != 0);
        }
    }
    if time < monitor.epoch.load(Ordering::Acquire) {
        rebaseline(monitor);
        return event;
    }
    let recording_epoch = gate.epoch();
    if gate.busy()
        || monitor
            .recording_epoch
            .swap(recording_epoch, Ordering::AcqRel)
            != recording_epoch
    {
        rebaseline(monitor);
        return event;
    }
    if monitor.pending.load(Ordering::Acquire) {
        return event;
    }
    let Some(mut input) = monitor.input.try_lock() else {
        rebaseline(monitor);
        return event;
    };
    let fired = input.observe(kind, key as u16, groups, Duration::from_nanos(time));
    let lost = input.take_lost();
    drop(input);
    if lost {
        rebaseline(monitor);
        return event;
    }
    if fired == Some(monitor.modifier) {
        main_dispatch::enqueue_double(&monitor.app, &monitor.token, recording_epoch);
    }
    event
}
fn observers(monitor: &Arc<Monitor>) -> [usize; 4] {
    let workspace = NSWorkspace::sharedWorkspace();
    let center: Retained<AnyObject> = unsafe { msg_send![&*workspace, notificationCenter] };
    let mut result = [0; 4];
    for (index, name) in unsafe {
        [
            NSWorkspaceWillSleepNotification,
            NSWorkspaceDidWakeNotification,
            NSWorkspaceSessionDidResignActiveNotification,
            NSWorkspaceSessionDidBecomeActiveNotification,
        ]
    }
    .iter()
    .enumerate()
    {
        let monitor = monitor.clone();
        let block = RcBlock::new(move |_: *mut AnyObject| {
            rebaseline(&monitor);
        });
        let observer: Retained<AnyObject> = unsafe {
            msg_send![&*center,addObserverForName:*name,object:ptr::null::<AnyObject>(),queue:ptr::null::<AnyObject>(),usingBlock:&*block]
        };
        result[index] = Retained::into_raw(observer) as usize;
    }
    result
}
pub(in crate::hotkey) fn create(
    app: &AppHandle,
    modifier: Modifier,
    token: Arc<Token>,
) -> Result<Lease, super::CreateFailure> {
    let handle = app.clone();
    on_main(app, move || Ok(create_inner(handle, modifier, token)))
        .map_err(super::CreateFailure::Clean)?
}
fn create_inner(
    handle: AppHandle,
    modifier: Modifier,
    token: Arc<Token>,
) -> Result<Lease, super::CreateFailure> {
    use super::CreateFailure::{Clean, Owned};
    (|| {
        preflight().map_err(Clean)?;
        if main_dispatch::is_closed(&handle) {
            return Err(Clean("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into()));
        }
        let monitor = Arc::new(Monitor {
            app: handle.clone(),
            modifier,
            token,
            input: Mutex::new(InputState::default()),
            alive: AtomicBool::new(true),
            paused: AtomicBool::new(false),
            pending: AtomicBool::new(true),
            epoch: AtomicU64::new(u64::MAX),
            recording_epoch: AtomicU64::new(
                crate::app_global_shortcuts::recording::gate(&handle)
                    .map_err(Clean)?
                    .epoch(),
            ),
            tap: AtomicUsize::new(0),
        });
        let context = Box::into_raw(Box::new(monitor.clone())) as Raw;
        // SDK: kCGSessionEventTap=1, kCGHeadInsertEventTap=0, kCGEventTapOptionListenOnly=1.
        let tap = unsafe {
            CGEventTapCreate(
                1,
                0,
                1,
                (1 << 10) | (1 << 11) | (1 << 12),
                callback,
                context,
            )
        };
        if tap.is_null() {
            unsafe {
                drop(Box::from_raw(context as *mut Arc<Monitor>));
            }
            return Err(Clean("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into()));
        }
        monitor.tap.store(tap as usize, Ordering::Release);
        let source = unsafe { CFMachPortCreateRunLoopSource(ptr::null_mut(), tap, 0) };
        if source.is_null() {
            unsafe {
                CFMachPortInvalidate(tap);
                CFRelease(tap);
                drop(Box::from_raw(context as *mut Arc<Monitor>));
            }
            return Err(Clean("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into()));
        }
        unsafe {
            CFRunLoopAddSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes);
        }
        let lease = Lease {
            tap: tap as usize,
            source: source as usize,
            context: context as usize,
            observers: [0; 4],
        };
        if !unsafe { CGEventTapIsEnabled(tap) }
            || unsafe { CFRunLoopContainsSource(CFRunLoopGetMain(), source, kCFRunLoopCommonModes) }
                == 0
        {
            if release_inner(lease).is_err() {
                return Err(Owned(lease));
            }
            return Err(Clean("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into()));
        }
        let lease = Lease {
            observers: observers(&monitor),
            ..lease
        };
        if refresh(&monitor).is_err() {
            if release_inner(lease).is_err() {
                return Err(Owned(lease));
            }
            return Err(Clean("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into()));
        }
        Ok(lease)
    })()
}
pub(in crate::hotkey) fn healthy(app: &AppHandle, lease: Lease) -> Result<bool, String> {
    on_main(app, move || {
        Ok(
            unsafe { CGPreflightListenEventAccess() && CGEventTapIsEnabled(lease.tap as Raw) }
                && !unsafe { &*(lease.context as *const Arc<Monitor>) }
                    .pending
                    .load(Ordering::Acquire),
        )
    })
}
fn release_inner(lease: Lease) -> Result<(), String> {
    let monitor = unsafe { &*(lease.context as *const Arc<Monitor>) };
    monitor.alive.store(false, Ordering::Release);
    monitor.tap.store(0, Ordering::Release);
    unsafe {
        CGEventTapEnable(lease.tap as Raw, false);
        CFMachPortInvalidate(lease.tap as Raw);
        CFRunLoopRemoveSource(
            CFRunLoopGetMain(),
            lease.source as Raw,
            kCFRunLoopCommonModes,
        );
        if CFMachPortIsValid(lease.tap as Raw) != 0
            || CFRunLoopContainsSource(
                CFRunLoopGetMain(),
                lease.source as Raw,
                kCFRunLoopCommonModes,
            ) != 0
        {
            return Err("SETTINGS_NATIVE_RECOVERY_FAILED".into());
        }
        let workspace = NSWorkspace::sharedWorkspace();
        let center: Retained<AnyObject> = msg_send![&*workspace, notificationCenter];
        for observer in lease.observers {
            if observer != 0 {
                let _: () = msg_send![&*center,removeObserver:&*(observer as *const AnyObject)];
                drop(Retained::from_raw(observer as *mut AnyObject));
            }
        }
        CFRelease(lease.source as Raw);
        CFRelease(lease.tap as Raw);
        drop(Box::from_raw(lease.context as *mut Arc<Monitor>));
    }
    Ok(())
}
pub(in crate::hotkey) fn release(app: &AppHandle, lease: Lease) -> Result<(), String> {
    on_main(app, move || release_inner(lease))
}

pub(in crate::hotkey) fn recover(app: &AppHandle, lease: Lease) -> Result<(), String> {
    on_main(app, move || {
        preflight()?;
        let monitor = unsafe { &*(lease.context as *const Arc<Monitor>) };
        if !monitor.alive.load(Ordering::Acquire) {
            return Err("SETTINGS_NATIVE_RECOVERY_FAILED".into());
        }
        monitor.paused.store(false, Ordering::Release);
        unsafe { CGEventTapEnable(lease.tap as Raw, true) };
        if !unsafe { CGEventTapIsEnabled(lease.tap as Raw) } {
            return Err("SETTINGS_HOTKEY_OUTCOME_UNKNOWN".into());
        }
        refresh(monitor)
    })
}

pub(in crate::hotkey) fn suspend(app: &AppHandle, lease: Lease) -> Result<(), String> {
    on_main(app, move || {
        let monitor = unsafe { &*(lease.context as *const Arc<Monitor>) };
        if !monitor.alive.load(Ordering::Acquire) {
            return Err("SETTINGS_NATIVE_RECOVERY_FAILED".into());
        }
        monitor.paused.store(true, Ordering::Release);
        monitor.token.invalidate_pending();
        unsafe { CGEventTapEnable(lease.tap as Raw, false) };
        if unsafe { CGEventTapIsEnabled(lease.tap as Raw) } {
            return Err("SETTINGS_NATIVE_RECOVERY_FAILED".into());
        }
        Ok(())
    })
}
