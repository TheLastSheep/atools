use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "macos")]
mod macos;

#[derive(Default)]
struct ActivationState {
    installed: AtomicBool,
    installing: AtomicBool,
    registered: AtomicU64,
    removed: AtomicU64,
    app_activation_events: AtomicU64,
    main_key_events: AtomicU64,
}

impl ActivationState {
    fn record_app_activation(&self) {
        self.app_activation_events.fetch_add(1, Ordering::Relaxed);
    }

    fn record_main_key(&self) {
        self.main_key_events.fetch_add(1, Ordering::Relaxed);
    }

    fn mark_installed(&self) {
        self.registered.store(2, Ordering::Relaxed);
        self.installed.store(true, Ordering::Release);
        self.installing.store(false, Ordering::Release);
    }

    fn mark_install_failed(&self) {
        self.installing.store(false, Ordering::Release);
    }

    fn mark_removed(&self, count: usize) {
        self.removed.store(count as u64, Ordering::Relaxed);
        self.installed.store(false, Ordering::Release);
    }
}

/// Installs two read-only AppKit notification observers from the setup main thread.
pub(super) fn install(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Settings input activation observation is unsupported on this platform".into())
    }
    #[cfg(target_os = "macos")]
    {
        use objc2::MainThreadMarker;

        MainThreadMarker::new()
            .ok_or("Activation observer installation requires the main thread")?;
        let state = get_or_create_state(app)?;
        if state.installed.load(Ordering::Acquire)
            || state
                .installing
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err("Settings input activation observers are already installed".into());
        }
        match macos::install(app, &state) {
            Ok(()) => {
                state.mark_installed();
                Ok(())
            }
            Err(error) => {
                state.mark_install_failed();
                Err(error)
            }
        }
    }
}

pub(super) async fn sample(app: &AppHandle) -> Result<Value, String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Settings input activation observation is unsupported on this platform".into())
    }
    #[cfg(target_os = "macos")]
    {
        let state = current_state(app)
            .ok_or_else(|| "Activation observation has not been installed".to_owned())?;
        on_main_thread(app, move || macos::sample(&state)).await
    }
}

pub(super) async fn uninstall(app: &AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Settings input activation observation is unsupported on this platform".into())
    }
    #[cfg(target_os = "macos")]
    {
        let state = current_state(app)
            .ok_or_else(|| "Activation observation has not been installed".to_owned())?;
        on_main_thread(app, move || macos::uninstall(&state)).await
    }
}

fn get_or_create_state(app: &AppHandle) -> Result<Arc<ActivationState>, String> {
    if let Some(state) = app.try_state::<Arc<ActivationState>>() {
        return Ok(Arc::clone(state.inner()));
    }
    let state = Arc::new(ActivationState::default());
    if app.manage(Arc::clone(&state)) {
        Ok(state)
    } else {
        current_state(app)
            .ok_or_else(|| "Activation observation state could not be installed".into())
    }
}

fn current_state(app: &AppHandle) -> Option<Arc<ActivationState>> {
    app.try_state::<Arc<ActivationState>>()
        .map(|state| Arc::clone(state.inner()))
}

async fn on_main_thread<T>(
    app: &AppHandle,
    action: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String>
where
    T: Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let _ = sender.send(action());
    })
    .map_err(|error| format!("Could not schedule activation observation: {error}"))?;
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "Activation observation main-thread deadline exceeded".to_owned())?
        .map_err(|_| "Activation observation main-thread callback was interrupted".to_owned())?
}

fn snapshot(
    state: &ActivationState,
    app_active: Option<bool>,
    frontmost_is_self: Option<bool>,
) -> Value {
    json!({
        "installed": state.installed.load(Ordering::Acquire),
        "registered": state.registered.load(Ordering::Relaxed),
        "removed": state.removed.load(Ordering::Relaxed),
        "appActive": app_active,
        "frontmostIsSelf": frontmost_is_self,
        "appActivationEvents": state.app_activation_events.load(Ordering::Relaxed),
        "mainKeyEvents": state.main_key_events.load(Ordering::Relaxed),
        "known": app_active.is_some() && frontmost_is_self.is_some(),
    })
}

#[cfg(test)]
#[path = "settings_input_activation/tests.rs"]
mod tests;
