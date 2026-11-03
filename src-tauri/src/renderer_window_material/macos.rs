use std::{ptr::NonNull, time::Duration};

use objc2::{rc::Retained, MainThreadMarker};
use objc2_app_kit::{
    NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSView,
    NSVisualEffectView, NSWindow,
};
use objc2_foundation::NSArray;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Window};
use tokio::sync::oneshot;
use window_vibrancy::{
    apply_vibrancy, clear_vibrancy, NSVisualEffectMaterial as VibrancyMaterial,
    NSVisualEffectState as VibrancyState,
};

use super::{policy::Ownership, MaterialLease, RendererWindowMaterial};

const VIEW_TAG: isize = 91_376_254;
const EXPECTED_MATERIAL: isize = 15;
const EXPECTED_BLENDING: isize = 0;
const EXPECTED_STATE: isize = 0;
const MAX_NATIVE_VIEWS: usize = 2048;
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy)]
struct EffectViewFacts {
    material: isize,
    blending_mode: isize,
    state: isize,
}

struct NativeFacts {
    effect_count: u64,
    effect_view: Option<EffectViewFacts>,
    effective_appearance: &'static str,
}

pub(super) fn claim_main_owner(
    app: &AppHandle,
    state: &RendererWindowMaterial,
) -> Result<(), String> {
    require_main_thread()?;
    let window = main_window(app)?;
    let mut ownership = state.ownership.lock();
    ownership.ensure_open()?;
    ensure_effect(&window, &mut ownership)?;
    ownership.add_main_owner()?;
    Ok(())
}

pub(super) async fn acquire_settings(app: &AppHandle) -> Result<MaterialLease, String> {
    if MainThreadMarker::new().is_some() {
        return acquire_settings_on_main(app);
    }
    let task_app = app.clone();
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        if sender.is_closed() {
            return;
        }
        let result = acquire_settings_on_main(&task_app);
        if let Err(returned) = sender.send(result) {
            if let Ok(mut lease) = returned {
                let release = release_settings_on_main(&lease.app, &lease.window, lease.lease_id);
                if release.is_ok() {
                    lease.disarm();
                }
            }
        }
    })
    .map_err(|_| "Main-thread material acquire could not be scheduled".to_owned())?;
    tokio::time::timeout(MAIN_THREAD_TIMEOUT, receiver)
        .await
        .map_err(|_| "Main-thread material acquire timed out".to_owned())?
        .map_err(|_| "Main-thread material acquire stopped before replying".to_owned())?
}

fn acquire_settings_on_main(app: &AppHandle) -> Result<MaterialLease, String> {
    let window = main_window(app)?;
    acquire_settings_for_window_on_main(app, &window)
}

pub(super) fn acquire_settings_for_window_on_main(
    app: &AppHandle,
    window: &Window,
) -> Result<MaterialLease, String> {
    require_main_thread()?;
    let state = app
        .try_state::<RendererWindowMaterial>()
        .ok_or_else(|| "Native window material manager is unavailable".to_owned())?;
    let mut ownership = state.ownership.lock();
    let lease_id = ownership.reserve_lease_id()?;
    ensure_effect(window, &mut ownership)?;
    ownership.add_settings_lease(lease_id)?;
    Ok(MaterialLease {
        app: app.clone(),
        window: window.clone(),
        lease_id,
        active: true,
    })
}

pub(super) async fn release_settings(
    app: AppHandle,
    window: Window,
    lease_id: u64,
) -> Result<(), String> {
    let task_app = app.clone();
    on_main_thread(&app, move || {
        release_settings_on_main(&task_app, &window, lease_id)
    })
    .await
}

pub(super) fn enqueue_release(app: AppHandle, window: Window, lease_id: u64) {
    if MainThreadMarker::new().is_some() {
        let _ = release_settings_on_main(&app, &window, lease_id);
        return;
    }
    let task_app = app.clone();
    if app
        .run_on_main_thread(move || {
            let _ = release_settings_on_main(&task_app, &window, lease_id);
        })
        .is_err()
    {
        mark_release_unscheduled(&app, lease_id);
    }
}

fn mark_release_unscheduled(app: &AppHandle, lease_id: u64) {
    if let Some(state) = app.try_state::<RendererWindowMaterial>() {
        let mut ownership = state.ownership.lock();
        ownership.remove_settings_lease(lease_id);
        if ownership.should_clear_effect() {
            ownership.mark_cleanup_pending();
        }
    }
}

fn release_settings_on_main(app: &AppHandle, window: &Window, lease_id: u64) -> Result<(), String> {
    require_main_thread()?;
    let Some(state) = app.try_state::<RendererWindowMaterial>() else {
        return Ok(());
    };
    let mut ownership = state.ownership.lock();
    let removed = ownership.remove_settings_lease(lease_id);
    if !removed && !ownership.cleanup_pending() {
        return Ok(());
    }
    if !ownership.should_clear_effect() {
        return Ok(());
    }
    clear_owned_effect_from_window(window, &mut ownership)
}

pub(super) async fn observe(app: &AppHandle) -> Result<Value, String> {
    let task_app = app.clone();
    on_main_thread(app, move || observe_on_main(&task_app)).await
}

fn observe_on_main(app: &AppHandle) -> Result<Value, String> {
    require_main_thread()?;
    let state = app.try_state::<RendererWindowMaterial>();
    let ownership = state.as_ref().map(|state| state.ownership.lock());
    let window = main_window(app)?;
    let facts = inspect_window(&window)?;
    let (main_owner, settings_lease_count, total_owners, cleanup_pending) = match ownership {
        Some(ownership) => (
            ownership.main_owner(),
            ownership.settings_lease_count(),
            ownership.total_owners(),
            ownership.cleanup_pending(),
        ),
        None => (false, 0, 0, false),
    };
    let details = facts.effect_view;
    Ok(json!({
        "installed": state.is_some(),
        "supported": true,
        "mainOwner": main_owner,
        "settingsLeaseCount": settings_lease_count,
        "totalOwners": total_owners,
        "cleanupPending": cleanup_pending,
        "effectCount": facts.effect_count,
        "tag": (facts.effect_count > 0).then_some(VIEW_TAG),
        "material": details.map(|facts| facts.material),
        "blendingMode": details.map(|facts| facts.blending_mode),
        "state": details.map(|facts| facts.state),
        "effectiveAppearance": facts.effective_appearance,
    }))
}

pub(super) fn stop(app: &AppHandle) -> Result<(), String> {
    stop_on_main(app)
}

fn stop_on_main(app: &AppHandle) -> Result<(), String> {
    require_main_thread()?;
    let Some(state) = app.try_state::<RendererWindowMaterial>() else {
        return Ok(());
    };
    let mut ownership = state.ownership.lock();
    let should_clear = ownership.begin_stop();
    if !should_clear {
        return Ok(());
    }
    if crate::window::main_window(app).is_err() {
        ownership.forget_destroyed_window();
        return Ok(());
    }
    clear_owned_effect(app, &mut ownership)
}

pub(super) fn on_window_destroyed(app: &AppHandle) {
    if let Some(state) = app.try_state::<RendererWindowMaterial>() {
        state.ownership.lock().forget_destroyed_window();
    }
}

async fn on_main_thread<T, F>(app: &AppHandle, action: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    if MainThreadMarker::new().is_some() {
        return action();
    }
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        if sender.is_closed() {
            return;
        }
        let _ = sender.send(action());
    })
    .map_err(|_| "Main-thread material task could not be scheduled".to_owned())?;
    tokio::time::timeout(MAIN_THREAD_TIMEOUT, receiver)
        .await
        .map_err(|_| "Main-thread material task timed out".to_owned())?
        .map_err(|_| "Main-thread material task stopped before replying".to_owned())?
}

fn ensure_effect(window: &Window, ownership: &mut Ownership) -> Result<(), String> {
    let facts = inspect_window(window)?;
    if ownership.effect_owned() {
        if facts.effect_count == 1 && is_expected_effect(facts.effect_view) {
            ownership.mark_effect_owned();
            return Ok(());
        }
        if facts.effect_count != 0 {
            return Err("Owned Main material no longer matches FullScreenUI".into());
        }
        ownership.mark_effect_cleared();
    } else if facts.effect_count != 0 {
        return Err("Main already contains an unowned visual effect view".into());
    }

    if let Err(error) = ownership.install_effect(|| {
        apply_vibrancy(
            window,
            VibrancyMaterial::FullScreenUI,
            Some(VibrancyState::FollowsWindowActiveState),
            None,
        )
        .map_err(|error| format!("FullScreenUI material could not be applied: {error:?}"))
    }) {
        recover_failed_apply(window, ownership);
        return Err(error);
    }

    let after = match inspect_window(window) {
        Ok(facts) => facts,
        Err(error) => {
            recover_failed_apply(window, ownership);
            return Err(error);
        }
    };
    if after.effect_count == 1 && is_expected_effect(after.effect_view) {
        return Ok(());
    }
    recover_failed_apply(window, ownership);
    Err("FullScreenUI material readback did not match the requested effect".into())
}

fn recover_failed_apply(window: &Window, ownership: &mut Ownership) {
    let Ok(facts) = inspect_window(window) else {
        ownership.mark_cleanup_pending();
        return;
    };
    if facts.effect_count == 0 {
        ownership.mark_effect_cleared();
        return;
    }
    ownership.mark_effect_owned();
    if clear_owned_effect_from_window(window, ownership).is_err() {
        ownership.mark_cleanup_pending();
    }
}

fn clear_owned_effect(app: &AppHandle, ownership: &mut Ownership) -> Result<(), String> {
    let window = main_window(app).map_err(|_| {
        ownership.mark_cleanup_pending();
        "Main window is unavailable while clearing its visual effect".to_owned()
    })?;
    clear_owned_effect_from_window(&window, ownership)
}

fn clear_owned_effect_from_window(
    window: &Window,
    ownership: &mut Ownership,
) -> Result<(), String> {
    let facts = match inspect_window(window) {
        Ok(facts) => facts,
        Err(error) => {
            ownership.mark_cleanup_pending();
            return Err(error);
        }
    };
    if facts.effect_count == 0 {
        ownership.mark_effect_cleared();
        return Ok(());
    }
    if facts.effect_count != 1 || facts.effect_view.is_none() {
        ownership.mark_cleanup_pending();
        return Err(
            "Owned visual effect cannot be cleared while its tagged view is ambiguous".into(),
        );
    }
    ownership.clear_effect(|| {
        clear_vibrancy(window)
            .map_err(|error| format!("Owned visual effect could not be cleared: {error:?}"))?;
        let after = inspect_window(window)?;
        if after.effect_count == 0 {
            Ok(())
        } else {
            Err("Owned visual effect remained after clear".into())
        }
    })
}

fn is_expected_effect(view: Option<EffectViewFacts>) -> bool {
    view.is_some_and(|facts| {
        facts.material == EXPECTED_MATERIAL
            && facts.blending_mode == EXPECTED_BLENDING
            && facts.state == EXPECTED_STATE
    })
}

fn inspect_window(window: &Window) -> Result<NativeFacts, String> {
    require_main_thread()?;
    let pointer = window
        .ns_window()
        .map_err(|_| "Main native window handle is unavailable".to_owned())?;
    if pointer.is_null() {
        return Err("Main native window handle is unavailable".into());
    }
    // SAFETY: Tauri owns this NSWindow and this pointer is only dereferenced on
    // the AppKit main thread while the window handle remains alive.
    let native = unsafe { &*pointer.cast::<NSWindow>() };
    let content = native
        .contentView()
        .ok_or_else(|| "Main native window has no content view".to_owned())?;
    let (effect_count, effect_view) = inspect_view_tree(&content)?;
    Ok(NativeFacts {
        effect_count,
        effect_view,
        effective_appearance: effective_appearance(native),
    })
}

fn inspect_view_tree(root: &NSView) -> Result<(u64, Option<EffectViewFacts>), String> {
    let root_pointer = NonNull::from(root).as_ptr();
    // SAFETY: root is a valid, live AppKit view for the duration of this
    // main-thread inspection; retaining it keeps the tree root alive in stack.
    let root = unsafe { Retained::retain(root_pointer) }.ok_or_else(|| {
        "Main native content view could not be retained for inspection".to_owned()
    })?;
    let mut pending: Vec<Retained<NSView>> = vec![root];
    let mut visited = 0_usize;
    let mut effect_count = 0_u64;
    let mut effect_view = None;
    while let Some(view) = pending.pop() {
        visited += 1;
        if visited > MAX_NATIVE_VIEWS {
            return Err("Main native view tree exceeds the inspection limit".into());
        }
        if view.tag() == VIEW_TAG {
            effect_count += 1;
            if let Some(effect) = view.downcast_ref::<NSVisualEffectView>() {
                if effect_count == 1 {
                    effect_view = Some(EffectViewFacts {
                        material: effect.material().0,
                        blending_mode: effect.blendingMode().0,
                        state: effect.state().0,
                    });
                }
            } else {
                effect_view = None;
            }
        }
        let children = view.subviews();
        for index in 0..children.count() {
            pending.push(children.objectAtIndex(index));
        }
    }
    Ok((
        effect_count,
        (effect_count == 1).then_some(effect_view).flatten(),
    ))
}

fn effective_appearance(window: &NSWindow) -> &'static str {
    let appearance = window.effectiveAppearance();
    // SAFETY: AppKit exports these immutable appearance-name NSStrings for the
    // process lifetime; this read occurs on the AppKit main thread.
    let appearance_names = unsafe { [NSAppearanceNameAqua, NSAppearanceNameDarkAqua] };
    let names = NSArray::from_slice(&appearance_names);
    let best_match = appearance
        .bestMatchFromAppearancesWithNames(&names)
        .map(|name| name.to_string());
    match best_match.as_deref() {
        Some("NSAppearanceNameAqua") => "light",
        Some("NSAppearanceNameDarkAqua") => "dark",
        _ => "unknown",
    }
}

fn main_window(app: &AppHandle) -> Result<Window, String> {
    crate::window::main_window(app).map_err(|_| "Main window is unavailable".to_owned())
}

pub(super) fn require_main_thread() -> Result<MainThreadMarker, String> {
    MainThreadMarker::new().ok_or_else(|| "Native window material requires the main thread".into())
}
