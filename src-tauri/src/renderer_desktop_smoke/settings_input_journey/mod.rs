mod auto_back_journey;
mod child_background;
mod child_probe_url;
mod cleanup;
mod command_aliases;
mod command_aliases_open_add_diagnostic;
mod command_aliases_report;
mod command_aliases_schema;
mod command_aliases_storage;
mod command_availability;
mod command_availability_schema;
mod diagnostics;
mod fixture_control;
mod general_policies_clipboard_journey;
mod general_policies_clipboard_runtime;
mod general_policies_journey;
mod general_policies_probe;
mod general_policies_schema;
mod general_policies_window_runtime;
mod journey;
mod launch_at_login_journey;
mod launch_at_login_operations;
mod launch_at_login_probe;
mod launch_at_login_schema;
mod local_app_search;
mod local_app_search_facts;
mod local_app_search_lifecycle;
mod local_app_search_observations;
mod local_app_search_report;
mod local_app_search_schema;
mod login_cross_entry_flow;
mod login_cross_entry_journey;
mod login_cross_entry_probe;
mod login_cross_entry_schema;
mod login_cross_entry_storage;
mod login_cross_entry_window;
mod main_hotkey_journey;
mod main_hotkey_schema;
mod main_hotkey_startup_journey;
mod main_hotkey_startup_schema;
mod main_hotkey_startup_storage;
mod material;
mod material_report;
mod native;
mod paint_diagnostics;
mod plugin_inventory_journey;
mod plugin_inventory_observations;
mod plugin_inventory_schema;
mod presented_paint;
mod presented_paint_capture;
mod presented_paint_report;
mod presented_paint_theme;
mod presented_paint_window;
mod probe;
mod probe_caller;
mod probe_operation_schema;
mod probe_page_load;
mod probe_protocol;
mod readiness;
mod report;
mod retired_session;
mod schema;
mod search_pins_journey;
mod snapshot;
mod stage;
mod state;
mod theme;
mod tray_visibility_journey;
mod tray_visibility_schema;
mod updater_status;
mod window_opacity_journey;
mod window_opacity_schema;

use crate::{pasteboard_runtime::PasteboardRuntime, state::AppState};
use atools_core::{AppConfig, Database};
use serde_json::Value;
use std::sync::Arc;
use tauri::{
    ipc::Invoke, webview::PageLoadPayload, AppHandle, Manager, Webview, Window, WindowEvent, Wry,
};

pub(super) use plugin_inventory_journey::PluginInventoryHarness;
pub(super) use state::Harness;

pub(super) fn prepare(
    profile: Arc<super::profile::Profile>,
    db: Arc<Database>,
) -> Result<Harness, String> {
    state::prepare(profile, db)
}

pub(super) fn prepare_plugin_inventory(
    profile: Arc<super::profile::Profile>,
    readiness: crate::plugin_inventory::readiness::PluginInventoryReadiness,
) -> Result<PluginInventoryHarness, String> {
    plugin_inventory_journey::prepare(profile, readiness)
}

pub(super) fn prepare_app_state(
    profile: Arc<super::profile::Profile>,
    config: AppConfig,
    db: Arc<Database>,
    pasteboard: Arc<PasteboardRuntime>,
) -> Result<(AppState, Option<PluginInventoryHarness>), String> {
    if profile.settings_input_journey {
        let state = AppState::new_pending_builtin_inventory(config, db, None, pasteboard);
        let inventory =
            prepare_plugin_inventory(profile, state.plugin_inventory_readiness.clone())?;
        Ok((state, Some(inventory)))
    } else {
        Ok((
            AppState::new_prepopulated_inventory(config, db, None, pasteboard),
            None,
        ))
    }
}

pub(super) fn handler() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    state::handler()
}

pub(super) fn handles(command: &str) -> bool {
    state::handles(command)
}

pub(super) fn observe_command(invoke: &Invoke<Wry>) {
    login_cross_entry_journey::observe_command(invoke);
}

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    probe::on_page_load(webview, payload);
}

pub(super) fn record_window_event(window: &Window<Wry>, event: &WindowEvent) {
    state::record_window_event(window, event);
}

pub(super) fn start(app: AppHandle<Wry>) {
    install_fixture_runtime_managers(&app);
    if app.state::<Harness>().profile().main_hotkey_recovery_first
        || app.state::<Harness>().profile().main_hotkey_recovery_second
    {
        main_hotkey_startup_journey::start(app);
        return;
    }
    journey::start(app);
}

pub(super) fn initialize_hotkey_recovery(app: &AppHandle<Wry>) {
    main_hotkey_startup_journey::initialize(app);
}

#[cfg(feature = "legacy-node-smoke")]
pub(super) fn start_builtin_state(app: AppHandle<Wry>) {
    install_fixture_runtime_managers(&app);
    super::builtin_state::start_main(app);
}

fn install_fixture_runtime_managers(app: &AppHandle<Wry>) {
    if app
        .try_state::<Arc<crate::legacy_runtime::Sessions>>()
        .is_none()
    {
        app.manage(Arc::new(crate::legacy_runtime::Sessions::default()));
    }
    if !crate::plugin_background_runtime::is_installed(app) {
        crate::plugin_background_runtime::install_manager(app);
    }
}

pub(super) async fn wait_main_ready(app: &AppHandle<Wry>) -> Result<Value, &'static str> {
    app.try_state::<Harness>()
        .ok_or("settings-input-main-ready-timeout")?
        .wait_main_ready()
        .await
}

pub(super) async fn select_inventory_target(
    app: &AppHandle<Wry>,
) -> Result<(String, String), &'static str> {
    let harness = app
        .try_state::<Harness>()
        .ok_or("settings-input-catalog-target-unavailable")?;
    native::select_real_catalog_target(app, &harness).await?;
    harness
        .target()
        .ok_or("settings-input-catalog-target-unavailable")
}

pub(super) async fn inspect_main_inventory(
    app: &AppHandle<Wry>,
    target: &(String, String),
    expected_timestamp_count: Option<u64>,
    expected_event_count: Option<u64>,
    expected_list_read_count: Option<u64>,
) -> Result<Value, &'static str> {
    let harness = app
        .try_state::<Harness>()
        .ok_or("settings-input-probe-protocol-rejected")?;
    probe::main_plugin_inventory(
        app,
        &harness,
        target,
        expected_timestamp_count,
        expected_event_count,
        expected_list_read_count,
    )
    .await
}

pub(super) fn staged_builtin_plugins_dir() -> Result<std::path::PathBuf, &'static str> {
    fixture_control::staged_builtin_plugins_dir()
}

pub(super) fn builtin_state_general_seed() -> Value {
    state::builtin_state_general_seed()
}
