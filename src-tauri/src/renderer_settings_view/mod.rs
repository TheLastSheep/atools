#![cfg(feature = "ztools-multiwebview")]

mod about;
mod accounting;
mod app_global_shortcuts;
mod app_icon_authorization;
mod app_shortcuts_intent;
mod app_shortcuts_recording;
mod auto_return;
pub(crate) mod bundle;
mod cleanup;
mod command_data;
mod commands;
mod disabled_commands;
mod event_payload;
mod general_write;
mod height;
mod hotkey_recording;
pub(crate) use app_shortcuts_recording::{
    deliver as deliver_app_recording, target_live as app_recording_target_live,
};
mod identity;
mod intent_protocol;
mod launch_at_login;
mod legacy_launch_at_login;
mod lifecycle;
mod local_shortcut_files;
mod local_shortcut_protocol;
mod local_shortcuts;
mod main_authority;
mod native_appearance;
pub(crate) mod native_close;
mod native_drop;
mod open_claims;
mod open_coordination;
mod open_native;
mod open_service;
mod phase;
mod preferences;
pub(crate) mod presentation;
mod protocol;
mod search_pins;
mod session;
mod session_material;
mod sub_input;
mod validation;

use std::sync::Arc;

use serde_json::Value;
use tauri::{Builder, Manager, Wry};

use self::{bundle::SettingsBundle, session::SettingsViewRuntime};

pub(crate) const SETTINGS_SCHEME: &str = "atools-settings";
pub(crate) const SETTINGS_EVENT: &str = "atools://renderer-settings-view";

pub(crate) use app_icon_authorization::authorize_app_icon_child_request;
pub(crate) use auto_return::return_to_search_after_hide;
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use commands::{
    call_renderer_settings as fixture_call_renderer_settings,
    close_renderer_settings as fixture_close_renderer_settings,
};
pub(crate) use commands::{dispatch, handles};
pub(crate) use hotkey_recording::{
    deliver as deliver_hotkey_recording, target_live as hotkey_recording_target_live,
};
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use identity::is_expected_settings_url;
pub(crate) use main_authority::{
    on_main_destroyed_instance, on_main_page_load, on_main_window_destroyed, prepare_main,
    revoke_main_for_shutdown,
};
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use native_drop::{
    fixture_binding_active, inject_owned_fixture_drop, FixtureDropCompletion, FixtureDropReceipt,
};
#[cfg(feature = "legacy-node-smoke")]
pub(crate) use preferences::project_general_settings;
pub(crate) use session::UpdaterGrant;

pub(crate) fn register(builder: Builder<Wry>) -> Builder<Wry> {
    protocol::register(builder)
}

pub(crate) fn install_bundle(
    app: &tauri::AppHandle,
    bundle: Arc<SettingsBundle>,
) -> Result<(), String> {
    runtime(app)?.cache_bundle(bundle)
}

pub(crate) fn on_window_destroyed(app: &tauri::AppHandle, label: &str) {
    cleanup::on_window_destroyed(app, label);
}

pub(crate) fn stop(app: &tauri::AppHandle) {
    cleanup::stop(app);
}

pub(crate) fn snapshot(app: &tauri::AppHandle) -> Value {
    let Ok(runtime) = runtime(app) else {
        return serde_json::json!({
            "sessionCount":0,
            "bundleCached":false,
            "runtimeInitialized":false,
            "stateAvailable":false,
        });
    };
    let session = runtime.current().ok().flatten();
    let child_present = session
        .as_ref()
        .is_some_and(|session| app.get_webview(&session.label).is_some());
    let layout_count = crate::window::main_child_layout_active_count(app).ok();
    runtime.diagnostics(child_present, layout_count)
}

fn runtime(app: &tauri::AppHandle) -> Result<Arc<SettingsViewRuntime>, String> {
    app.try_state::<Arc<SettingsViewRuntime>>()
        .map(|state| Arc::clone(state.inner()))
        .ok_or_else(|| "Settings view runtime is unavailable".into())
}

#[cfg(test)]
pub(crate) fn poisoned_snapshot_for_test() -> Value {
    SettingsViewRuntime::poisoned_snapshot_for_test()
}
