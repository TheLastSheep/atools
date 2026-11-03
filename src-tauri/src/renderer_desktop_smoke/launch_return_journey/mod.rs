mod expectations;
mod failure_snapshot;
mod history_expectations;
mod journey;
mod local_targets;
mod native;
mod probe;
mod protocol;
mod report;
#[cfg(feature = "ztools-multiwebview")]
mod settings_registration_fixtures;
#[cfg(feature = "ztools-multiwebview")]
mod settings_registration_flow;
#[cfg(feature = "ztools-multiwebview")]
mod settings_registration_focus;
#[cfg(feature = "ztools-multiwebview")]
mod settings_registration_observe;
mod settings_registration_report;
#[cfg(feature = "ztools-multiwebview")]
mod settings_registration_transport;
#[cfg(feature = "ztools-multiwebview")]
mod settings_registration_verify;
mod snapshot;

use atools_core::Database;
use std::sync::Arc;
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    AppHandle, Manager, Webview, Window, WindowEvent, Wry,
};

pub(in crate::renderer_desktop_smoke) use protocol::Harness;

pub(in crate::renderer_desktop_smoke) struct Prepared {
    pub(in crate::renderer_desktop_smoke) source:
        crate::launcher_app_catalog_source::LauncherAppCatalogSource,
    pub(in crate::renderer_desktop_smoke) harness: Harness,
}

pub(in crate::renderer_desktop_smoke) fn prepare(
    profile: Arc<super::profile::Profile>,
    db: Arc<Database>,
) -> Result<Prepared, String> {
    let hidden = super::launcher_journey::prepare_hidden(&profile, &db)?;
    let (source, local_shortcut_items) = match profile.launch_target_kind {
        super::profile::LaunchTargetKind::App => (hidden.source, 0),
        super::profile::LaunchTargetKind::LocalShortcut => {
            let local = if profile.registration_source
                == super::profile::RegistrationSource::CoreSeed
            {
                local_targets::prepare(
                    &profile,
                    &db,
                    hidden.first_path.as_str(),
                    hidden.second_path.as_str(),
                )?
            } else {
                #[cfg(feature = "ztools-multiwebview")]
                {
                    settings_registration_fixtures::prepare(
                        &profile,
                        &db,
                        &hidden.first_path,
                        &hidden.second_path,
                    )?
                }
                #[cfg(not(feature = "ztools-multiwebview"))]
                {
                    return Err("settings-child registration requires ztools-multiwebview".into());
                }
            };
            (local.source, local.local_shortcut_items)
        }
    };
    let harness = Harness::new(
        Arc::clone(&profile),
        db,
        hidden.first_path,
        hidden.second_path,
        hidden.fixture_valid,
        local_shortcut_items,
    );
    Ok(Prepared { source, harness })
}

pub(in crate::renderer_desktop_smoke) fn handler(
) -> impl Fn(tauri::ipc::Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        protocol::renderer_launch_return_receipt,
        protocol::renderer_launch_return_probe_ready
    ]
}

pub(in crate::renderer_desktop_smoke) fn handles(command: &str) -> bool {
    command == protocol::RECEIPT_COMMAND || command == protocol::PROBE_READY_COMMAND
}

pub(in crate::renderer_desktop_smoke) fn install_native_witness(
    app: &AppHandle<Wry>,
) -> Result<(), String> {
    let harness = app
        .try_state::<Harness>()
        .ok_or_else(|| "launch-return-harness-missing".to_string())?;
    #[cfg(feature = "ztools-multiwebview")]
    if harness.profile().registration_source == super::profile::RegistrationSource::SettingsChild {
        crate::renderer_settings_view::presentation::install_launch_return_hidden_smoke(
            app,
            harness.profile(),
        )?;
    }
    native::install_witness(app, &harness)
}

pub(in crate::renderer_desktop_smoke) fn on_page_load(
    webview: &Webview<Wry>,
    payload: &PageLoadPayload<'_>,
) {
    if webview.label() != "main"
        || webview.window().label() != "main"
        || !super::controller::is_local_root_url(payload.url())
        || payload.event() != PageLoadEvent::Finished
    {
        return;
    }
    let Some(harness) = webview.app_handle().try_state::<Harness>() else {
        return;
    };
    match probe::inject(webview, &harness) {
        Ok(()) => harness.mark_probe_eval_enqueued(),
        Err(error) => harness.fail_probe_ready(error),
    }
}

pub(in crate::renderer_desktop_smoke) fn record_window_event(
    window: &Window<Wry>,
    event: &WindowEvent,
) {
    if window.label() != "main" {
        return;
    }
    if let Some(harness) = window.app_handle().try_state::<Harness>() {
        native::record_window_event(&harness, event);
    }
}

pub(in crate::renderer_desktop_smoke) fn start(app: AppHandle<Wry>) {
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    tauri::async_runtime::spawn(async move {
        let timeout = if harness.profile().registration_source
            == super::profile::RegistrationSource::SettingsChild
        {
            175
        } else {
            120
        };
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(timeout),
            journey::run(&app, &harness),
        )
        .await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => harness.record_error(error),
            Err(_) => harness.record_error("launch-return-watchdog-timeout"),
        }
        journey::finish(&app, &harness).await;
    });
}
