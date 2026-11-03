mod constructor_probe;
mod journey;
mod operations;
mod probe;
mod report;
mod state;

use std::sync::Arc;
use tauri::{ipc::Invoke, AppHandle, Manager, Wry};

pub(super) use state::Harness;

pub(super) fn initialize(
    app: &AppHandle<Wry>,
    profile: Arc<super::profile::Profile>,
) -> Result<(), String> {
    if app.try_state::<Harness>().is_some() {
        return Ok(());
    }
    let harness = Harness::new(profile);
    if !app.manage(harness.clone()) {
        return Err("main-panel-prototype-harness-unavailable".to_owned());
    }

    if super::settings_input_activation::install(app).is_err() {
        harness.note_error(report::OBSERVER_INSTALL_FAILED);
        let mut state = harness.0.state.lock();
        state.observer_installed = Some(false);
        state.initialization_failed = true;
        return Ok(());
    }
    harness.0.state.lock().observer_installed = Some(true);

    match crate::window::macos_main_panel::install_scoped(app, &harness.0.profile.run_id) {
        Ok(facts) => {
            let active = crate::window::macos_main_panel::is_active(app);
            {
                let mut state = harness.0.state.lock();
                state.conversion = serde_json::to_value(facts).ok();
                state.panel_active = Some(active);
                state.initialization_failed = !active;
            }
            if !active {
                harness.note_error(report::PANEL_INSTALL_FAILED);
            }
        }
        Err(error) => {
            match crate::window::macos_main_panel::installation_diagnostic(
                app,
                &harness.0.profile.run_id,
                &error,
            )
            .and_then(|value| {
                serde_json::to_string(&value).map_err(|_| "diagnostic-serialization".to_owned())
            }) {
                Ok(value) if value.len() <= 4096 => {
                    eprintln!("main-panel-prototype installation-diagnostic {value}");
                }
                _ => eprintln!("main-panel-prototype installation-diagnostic unavailable"),
            }
            harness.note_error(report::PANEL_INSTALL_FAILED);
            let active = crate::window::macos_main_panel::is_active(app);
            {
                let mut state = harness.0.state.lock();
                state.panel_active = Some(active);
                state.initialization_failed = true;
                state.conversion = crate::window::macos_main_panel::snapshot_conversion(app)
                    .ok()
                    .and_then(|facts| serde_json::to_value(facts).ok());
            }
            if active {
                let hidden = crate::window::hide_main_window(app).is_ok();
                if !hidden {
                    harness.note_error(report::RESTORE_FAILED);
                }
                match crate::window::macos_main_panel::restore_scoped(app) {
                    Ok(facts) => {
                        let active_after = crate::window::macos_main_panel::is_active(app);
                        let mut state = harness.0.state.lock();
                        state.restoration = serde_json::to_value(facts).ok();
                        state.panel_active = Some(active_after);
                        if active_after {
                            state.unsafe_to_exit = true;
                        }
                    }
                    Err(_) => {
                        harness.note_error(report::RESTORE_FAILED);
                        harness.0.state.lock().unsafe_to_exit = true;
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) fn on_page_load(
    webview: &tauri::Webview<Wry>,
    payload: &tauri::webview::PageLoadPayload<'_>,
) {
    probe::on_page_load(webview, payload);
}

pub(super) fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![probe::main_panel_probe]
}

pub(super) fn handles(command: &str) -> bool {
    command == "main_panel_probe"
}

pub(super) fn start(app: AppHandle<Wry>) {
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    if !harness.begin_start() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let initialization_failed = { harness.0.state.lock().initialization_failed };
        if !initialization_failed {
            if let Err(error) = journey::run(&app, &harness).await {
                harness.note_error(error);
            }
        }
        journey::finish(&app, &harness).await;
    });
}
