//! Scoped native Close roles for the original renderer; red-dot and Quit remain distinct.
mod instance_identity;
#[cfg(target_os = "macos")]
mod menu;
#[cfg(target_os = "macos")]
mod native;
mod policy;
mod roles;
mod routing;
mod window_compat;
use parking_lot::Mutex;
pub(crate) use policy::enabled as enabled_from_raw;
pub(crate) use policy::Snapshot;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Builder, Manager, Wry};
#[derive(Default)]
pub(crate) struct Runtime {
    #[cfg(target_os = "macos")]
    state: Mutex<Option<menu::State>>,
    guard: Mutex<policy::CloseGuard>,
    focus_epoch: AtomicU64,
    closed: AtomicBool,
}
pub(crate) fn is_original(app: &AppHandle) -> bool {
    let config = app.config();
    let original = config.identifier == "dev.atools.desktop"
        && config.build.dev_url.is_none()
        && matches!(config.build.frontend_dist.as_ref(),Some(tauri::utils::config::FrontendDist::Directory(path)) if path==std::path::Path::new("../packages/ztools-renderer/dist"));
    #[cfg(feature = "legacy-node-smoke")]
    {
        return original || crate::renderer_desktop_smoke::manual_ui::authorizes_material(app);
    }
    #[cfg(not(feature = "legacy-node-smoke"))]
    original
}
pub(crate) fn register(builder: Builder<Wry>) -> Builder<Wry> {
    let builder = builder.manage(Runtime::default());
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu::build).on_menu_event(|app, event| {
        if matches!(event.id().as_ref(), menu::CLOSE_ON | menu::CLOSE_OFF) {
            routing::menu_request(app);
        }
    });
    builder
}
pub(crate) fn setup(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    if is_original(app) {
        menu::refresh(app)?;
    }
    Ok(())
}
pub(crate) fn focus_changed(app: &AppHandle) {
    if !is_original(app) {
        return;
    }
    let Some(runtime) = app.try_state::<Runtime>() else {
        return;
    };
    let epoch = runtime.focus_epoch.fetch_add(1, Ordering::AcqRel) + 1;
    #[cfg(target_os = "macos")]
    if objc2::MainThreadMarker::new().is_some() && menu::refresh(app).is_ok() {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || {
            let Some(runtime) = app.try_state::<Runtime>() else {
                return;
            };
            if runtime.closed.load(Ordering::Acquire)
                || runtime.focus_epoch.load(Ordering::Acquire) != epoch
            {
                return;
            }
            #[cfg(target_os = "macos")]
            if let Err(error) = menu::refresh(&app) {
                tracing::warn!(%error,"Close menu focus projection was not confirmed");
            }
        });
    });
}
pub(crate) fn read(app: &AppHandle) -> Result<Snapshot, String> {
    #[cfg(target_os = "macos")]
    {
        return menu::read(app);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err(policy::UNSUPPORTED.into())
    }
}
pub(crate) fn apply(app: &AppHandle, target: bool) -> Result<Snapshot, String> {
    #[cfg(target_os = "macos")]
    {
        return menu::apply(app, target);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, target);
        Err(policy::UNSUPPORTED.into())
    }
}
pub(crate) fn restore(
    app: &AppHandle,
    previous: Snapshot,
    applied: Snapshot,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        return menu::restore(app, previous, applied);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, previous, applied);
        Err(policy::UNSUPPORTED.into())
    }
}
pub(crate) fn main_window_request(app: &AppHandle) -> bool {
    routing::window_request(app)
}
pub(crate) fn stop(app: &AppHandle) {
    if let Some(runtime) = app.try_state::<Runtime>() {
        runtime.closed.store(true, Ordering::Release);
        runtime.focus_epoch.fetch_add(1, Ordering::AcqRel);
    }
    #[cfg(target_os = "macos")]
    if let Err(error) = menu::release_readback_holds(app) {
        tracing::warn!(%error,"Close menu readback ownership was retained during shutdown");
    }
}

pub(crate) fn settings_close_completed(
    app: &AppHandle,
    id: &str,
    current_id: &str,
    reason: &str,
    succeeded: bool,
) {
    if let Some(runtime) = app.try_state::<Runtime>() {
        if !runtime.closed.load(Ordering::Acquire) {
            runtime.guard.lock().complete(
                id,
                current_id,
                reason,
                succeeded,
                std::time::Instant::now(),
            );
        }
    }
}
#[cfg(target_os = "macos")]
fn on_main<T: Send + 'static>(
    app: &AppHandle,
    action: impl FnOnce(AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let handle = app.clone();
    if objc2::MainThreadMarker::new().is_some() {
        return action(handle);
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = tx.send(action(handle));
    })
    .map_err(|_| policy::RECOVERY)?;
    rx.recv().map_err(|_| policy::RECOVERY.to_string())?
}
