//! Native refresh lifecycle for the launcher's fixed application catalog roots.

mod backend;

use crate::{launcher_app_catalog_source::LauncherAppCatalogSource, state::AppState};
use backend::NativeWatcher;
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{plugin::Builder as PluginBuilder, AppHandle, Emitter, Manager, RunEvent, Wry};

const PLUGIN_NAME: &str = "launcher-app-catalog-watch";
const REFRESH_EVENT: &str = "atools://renderer-apps-changed";
const START_FAILURE: &str = "Launcher app catalog watcher could not start";
const CHANGE_FAILURE: &str = "Launcher app catalog change refresh failed";
const START_REFRESH_FAILURE: &str = "Launcher app catalog startup refresh failed";

pub(crate) fn register(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    let plugin = PluginBuilder::<Wry, ()>::new(PLUGIN_NAME)
        .setup(|app, _api| {
            app.manage(Arc::new(Runtime::default()));
            Ok(())
        })
        .on_event(|app, event| match event {
            RunEvent::Ready => {
                if let Some(runtime) = runtime(app) {
                    runtime.on_ready(app);
                }
            }
            RunEvent::Exit => {
                if let Some(runtime) = runtime(app) {
                    runtime.stop();
                }
            }
            _ => {}
        })
        .build();
    builder.plugin(plugin)
}

fn runtime(app: &AppHandle) -> Option<Arc<Runtime>> {
    app.try_state::<Arc<Runtime>>()
        .map(|state| Arc::clone(state.inner()))
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum Phase {
    #[default]
    WaitingForReady,
    Starting,
    Watching,
    Unavailable,
    Stopped,
}

#[derive(Default)]
struct RuntimeState {
    phase: Phase,
    watcher: Option<NativeWatcher>,
}

#[derive(Default)]
struct Runtime {
    state: Mutex<RuntimeState>,
}

impl Runtime {
    fn on_ready(&self, app: &AppHandle) {
        if !self.begin_start() {
            return;
        }
        if self.start(app).is_err() {
            self.mark_unavailable();
            tracing::warn!(
                diagnostic = START_FAILURE,
                "Launcher app catalog watcher unavailable"
            );
        }
    }

    fn begin_start(&self) -> bool {
        let mut state = self.state.lock();
        if state.phase != Phase::WaitingForReady {
            return false;
        }
        state.phase = Phase::Starting;
        true
    }

    fn start(&self, app: &AppHandle) -> Result<(), &'static str> {
        let source = app
            .try_state::<AppState>()
            .map(|state| Arc::clone(&state.launcher_app_catalog))
            .ok_or(START_FAILURE)?;
        let roots = source.watch_roots().map_err(|_| START_FAILURE)?;
        let callback_app = app.clone();
        let callback_source = Arc::clone(&source);
        let on_change: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            if invalidate_then_notify(&callback_source, || notify_main(&callback_app)).is_err() {
                tracing::warn!(
                    diagnostic = CHANGE_FAILURE,
                    "Launcher app catalog refresh failed"
                );
            }
        });
        let watcher = NativeWatcher::start(&roots, on_change).map_err(|_| START_FAILURE)?;
        if let Some(mut watcher) = self.install_watcher(watcher) {
            watcher.stop();
            return Err(START_FAILURE);
        }

        invalidate_then_notify(&source, || notify_main(app)).map_err(|_| START_REFRESH_FAILURE)
    }

    fn install_watcher(&self, watcher: NativeWatcher) -> Option<NativeWatcher> {
        let mut state = self.state.lock();
        if state.phase != Phase::Starting {
            return Some(watcher);
        }
        state.watcher = Some(watcher);
        state.phase = Phase::Watching;
        None
    }

    fn mark_unavailable(&self) {
        let watcher = {
            let mut state = self.state.lock();
            if state.phase == Phase::Stopped {
                return;
            }
            state.phase = Phase::Unavailable;
            state.watcher.take()
        };
        if let Some(mut watcher) = watcher {
            watcher.stop();
        }
    }

    fn stop(&self) {
        let watcher = {
            let mut state = self.state.lock();
            state.phase = Phase::Stopped;
            state.watcher.take()
        };
        if let Some(mut watcher) = watcher {
            watcher.stop();
        }
    }

    #[cfg(test)]
    fn phase(&self) -> Phase {
        self.state.lock().phase
    }
}

fn invalidate_then_notify(
    source: &LauncherAppCatalogSource,
    notify: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    source.invalidate().map_err(|_| CHANGE_FAILURE)?;
    notify().map_err(|_| CHANGE_FAILURE)
}

fn notify_main(app: &AppHandle) -> Result<(), &'static str> {
    let webview = crate::window::main_webview(app).map_err(|_| CHANGE_FAILURE)?;
    if webview.window().label() != "main" {
        return Err(CHANGE_FAILURE);
    }
    app.emit_to(tauri::EventTarget::webview("main"), REFRESH_EVENT, ())
        .map_err(|_| CHANGE_FAILURE)
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
