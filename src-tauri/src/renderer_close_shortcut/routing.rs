//! Menu actions are focused; a WindowRequest already names Main and must never raise it.
use super::{policy, Runtime};
use std::{sync::atomic::Ordering, time::Instant};
use tauri::{AppHandle, Manager};
#[derive(Clone)]
enum Action {
    Search {
        focused: bool,
        focus_epoch: u64,
        host: usize,
        policy_generation: u64,
    },
    #[cfg(feature = "ztools-multiwebview")]
    Settings {
        target: crate::renderer_settings_view::native_close::NativeCloseTarget,
        focused: bool,
        focus_epoch: u64,
        host: usize,
        policy_generation: u64,
    },
    Native {
        window: Option<String>,
        key_window: usize,
    },
}
fn host_identity(app: &AppHandle) -> Option<usize> {
    let window = super::window_compat::main(app)?;
    #[cfg(target_os = "macos")]
    {
        window.ns_window().ok().map(|window| window as usize)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Some(1)
    }
}
fn capture(app: &AppHandle, focused: bool) -> Option<Action> {
    let runtime = app.try_state::<Runtime>()?;
    if runtime.closed.load(Ordering::Acquire) {
        return None;
    }
    if focused && super::window_compat::focused(app).is_none_or(|window| window.label() != "main") {
        #[cfg(target_os = "macos")]
        {
            let key_window = super::native::key_window().ok()?;
            if key_window == 0 {
                return None;
            }
            return Some(Action::Native {
                window: super::window_compat::focused(app).map(|window| window.label().into()),
                key_window,
            });
        }
        #[cfg(not(target_os = "macos"))]
        return None;
    }
    let host = host_identity(app)?;
    let focus_epoch = runtime.focus_epoch.load(Ordering::Acquire);
    #[cfg(target_os = "macos")]
    let policy_generation = if focused {
        let state = runtime.state.try_lock()?;
        let state = state.as_ref()?;
        if !state.projection.known {
            return None;
        }
        state.projection.snapshot.generation
    } else {
        0
    };
    #[cfg(not(target_os = "macos"))]
    let policy_generation = 0;
    #[cfg(feature = "ztools-multiwebview")]
    match crate::renderer_settings_view::native_close::capture(app) {
        crate::renderer_settings_view::native_close::NativeCloseState::Owned(target) => {
            return Some(Action::Settings {
                target,
                focused,
                focus_epoch,
                host,
                policy_generation,
            })
        }
        crate::renderer_settings_view::native_close::NativeCloseState::Absent => {}
        _ => return None,
    }
    if runtime.guard.lock().suppress_hide(Instant::now()) {
        return None;
    }
    Some(Action::Search {
        focused,
        focus_epoch,
        host,
        policy_generation,
    })
}
struct Context {
    host: Option<usize>,
    focus_epoch: u64,
    focused_main: bool,
    policy_generation: Option<u64>,
    closed: bool,
}
fn context_valid(
    focused: bool,
    epoch: u64,
    host: usize,
    generation: u64,
    current: &Context,
) -> bool {
    !current.closed
        && current.host == Some(host)
        && (!focused
            || (current.focused_main
                && current.focus_epoch == epoch
                && current.policy_generation == Some(generation)))
}
fn still_owned(app: &AppHandle, focused: bool, epoch: u64, host: usize, generation: u64) -> bool {
    let Some(runtime) = app.try_state::<Runtime>() else {
        return false;
    };
    #[cfg(target_os = "macos")]
    let policy_generation = if focused {
        runtime.state.try_lock().and_then(|state| {
            state
                .as_ref()
                .filter(|state| state.projection.known)
                .map(|state| state.projection.snapshot.generation)
        })
    } else {
        None
    };
    #[cfg(not(target_os = "macos"))]
    let policy_generation = Some(0);
    context_valid(
        focused,
        epoch,
        host,
        generation,
        &Context {
            host: host_identity(app),
            focus_epoch: runtime.focus_epoch.load(Ordering::Acquire),
            focused_main: super::window_compat::focused(app)
                .is_some_and(|window| window.label() == "main"),
            policy_generation,
            closed: runtime.closed.load(Ordering::Acquire),
        },
    )
}

fn execute(app: &AppHandle, action: Action) {
    if app
        .try_state::<Runtime>()
        .is_none_or(|runtime| runtime.closed.load(Ordering::Acquire))
    {
        return;
    }
    match action {
        Action::Native { window, key_window } => {
            #[cfg(target_os = "macos")]
            if super::window_compat::focused(app).map(|focused| focused.label().to_owned())
                == window
                && super::native::key_window().ok() == Some(key_window)
            {
                let _ = super::native::perform_native_close();
            }
        }
        Action::Search {
            focused,
            focus_epoch,
            host,
            policy_generation,
        } => {
            if !still_owned(app, focused, focus_epoch, host, policy_generation) {
                return;
            }
            #[cfg(feature = "ztools-multiwebview")]
            if !matches!(
                crate::renderer_settings_view::native_close::capture(app),
                crate::renderer_settings_view::native_close::NativeCloseState::Absent
            ) {
                return;
            }
            let runtime = app.state::<Runtime>();
            if runtime.guard.lock().suppress_hide(Instant::now()) {
                return;
            }
            let dialog_app = app.clone();
            tauri::async_runtime::spawn(async move {
                crate::plugin_dialog_runtime::close_window(&dialog_app, "main").await;
            });
            if let Some(window) = super::window_compat::main(app) {
                crate::window::remember_main_window_position(&window);
            }
            crate::renderer_window_drag::clear(app);
            let _ = crate::window::hide_main_window(app);
        }
        #[cfg(feature = "ztools-multiwebview")]
        Action::Settings {
            target,
            focused,
            focus_epoch,
            host,
            policy_generation,
        } => {
            if !still_owned(app, focused, focus_epoch, host, policy_generation) {
                return;
            }
            if !matches!(crate::renderer_settings_view::native_close::capture(app),crate::renderer_settings_view::native_close::NativeCloseState::Owned(ref current) if current==&target)
            {
                return;
            }
            let runtime = app.state::<Runtime>();
            if !runtime.guard.lock().begin(&target.id) {
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let id = target.id.clone();
                let result = crate::renderer_settings_view::native_close::close(&app, target).await;
                if let Some(runtime) = app.try_state::<Runtime>() {
                    runtime.guard.lock().abandon(&id);
                }
                if let Err(error) = result {
                    tracing::warn!(%error,"Owned Settings close was not fully confirmed");
                }
            });
        }
    }
}
pub(super) fn menu_request(app: &AppHandle) {
    if !super::is_original(app) {
        return;
    }
    #[cfg(target_os = "macos")]
    if super::menu::read(app).is_err() {
        return;
    }
    let Some(action) = capture(app, true) else {
        return;
    };
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let app = handle.clone();
        let _ = handle.run_on_main_thread(move || execute(&app, action));
    });
}
pub(super) fn window_request(app: &AppHandle) -> bool {
    if !super::is_original(app) {
        return false;
    }
    if let Some(action) = capture(app, false) {
        execute(app, action);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delayed_menu_rechecks_host_focus_policy_and_exit() {
        let mut current = Context {
            host: Some(10),
            focus_epoch: 2,
            focused_main: true,
            policy_generation: Some(3),
            closed: false,
        };
        assert!(context_valid(true, 2, 10, 3, &current));
        current.focus_epoch = 4;
        assert!(!context_valid(true, 2, 10, 3, &current));
        current.focus_epoch = 2;
        current.policy_generation = Some(5);
        assert!(!context_valid(true, 2, 10, 3, &current));
        current.policy_generation = Some(3);
        current.host = Some(11);
        assert!(!context_valid(true, 2, 10, 3, &current));
        current.host = Some(10);
        current.closed = true;
        assert!(!context_valid(true, 2, 10, 3, &current));
    }
    #[test]
    fn named_window_request_does_not_require_focus_or_menu_setting_but_keeps_owned_identity() {
        let current = Context {
            host: Some(10),
            focus_epoch: 99,
            focused_main: false,
            policy_generation: None,
            closed: false,
        };
        assert!(context_valid(false, 2, 10, 3, &current));
        assert!(!context_valid(true, 2, 10, 3, &current));
        assert!(!context_valid(false, 2, 11, 3, &current));
    }
}
