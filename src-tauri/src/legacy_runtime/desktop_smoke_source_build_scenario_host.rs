//! Tauri command adapters for the isolated source-build scenario ledger.
use super::scenario_diagnostics::{self as ledger, FrontendScenarioMessage, NativeCommand};
use serde_json::Value;
use tauri::{AppHandle, Manager};

fn with_fixture<T>(
    app: &AppHandle,
    action: impl FnOnce(&mut ledger::ScenarioLedger) -> Result<T, &'static str>,
) -> Result<T, String> {
    let fixture = app.state::<super::Fixture>();
    let mut state = fixture.scenario_diagnostics.lock();
    action(&mut state).map_err(str::to_owned)
}

fn profile_label(app: &AppHandle) -> String {
    app.state::<super::Fixture>().profile.label().to_owned()
}

fn command_received(app: &AppHandle, command: NativeCommand) -> Result<bool, String> {
    let profile = profile_label(app);
    if !ledger::tracks_native_calls(&profile) {
        return Ok(false);
    }
    with_fixture(app, |state| {
        ledger::record_received_for_profile(&profile, state, command)?;
        Ok(true)
    })
}

fn command_completed(
    app: &AppHandle,
    command: NativeCommand,
    tracked: bool,
    succeeded: bool,
) -> Result<(), String> {
    if !tracked {
        return Ok(());
    }
    let profile = profile_label(app);
    with_fixture(app, |state| {
        ledger::record_completed_for_profile(&profile, state, command, succeeded)
    })
}

#[tauri::command]
pub(super) fn native_source_build_fixture(app: AppHandle) -> Result<Value, String> {
    let tracked = command_received(&app, NativeCommand::Fixture)?;
    let result = super::source_build_fixture_payload(&app);
    command_completed(&app, NativeCommand::Fixture, tracked, true)?;
    Ok(result)
}

#[tauri::command]
pub(super) fn native_source_build_snapshot(app: AppHandle) -> Result<Value, String> {
    let tracked = command_received(&app, NativeCommand::Snapshot)?;
    let result = super::source_build_snapshot_payload(&app).and_then(|mut payload| {
        let fixture = app.state::<super::Fixture>();
        if fixture.profile.label() == "synthetic" {
            let state = app.state::<crate::state::AppState>();
            let plugin = state.db.get_plugin(fixture.profile.plugin_id()).ok();
            let entry = plugin
                .as_ref()
                .map(super::identity::installed_entry_observation)
                .transpose()?;
            if let Value::Object(fields) = &mut payload {
                fields.insert(
                    "installedPackageReadiness".into(),
                    serde_json::json!(entry.as_ref().map(|value| &value.readiness)),
                );
                fields.insert(
                    "installedManifestMain".into(),
                    serde_json::json!(entry.as_ref().and_then(|value| value.main.as_deref())),
                );
                fields.insert(
                    "installedManifestAtPackageRoot".into(),
                    serde_json::json!(entry
                        .as_ref()
                        .is_some_and(|value| value.manifest_at_package_root)),
                );
            }
        }
        Ok(payload)
    });
    command_completed(&app, NativeCommand::Snapshot, tracked, result.is_ok())?;
    result
}

#[tauri::command(rename = "scan_default_ztools_plugins")]
pub(super) fn scenario_scan_default_ztools_plugins(
    app: AppHandle,
) -> Result<Vec<crate::ztools_import::ZToolsImportCandidate>, String> {
    let tracked = command_received(&app, NativeCommand::Scan)?;
    let result = super::scan_default_ztools_plugins_impl(&app);
    command_completed(&app, NativeCommand::Scan, tracked, result.is_ok())?;
    result
}

#[tauri::command(rename = "inspect_ztools_source_build")]
pub(super) async fn scenario_inspect_ztools_source_build(
    app: AppHandle,
    path: String,
) -> Result<Value, String> {
    let tracked = command_received(&app, NativeCommand::Inspect)?;
    let result =
        crate::plugin_source_build::api::inspect_ztools_source_build(app.clone(), path).await;
    if tracked {
        with_fixture(&app, |state| {
            state.record_inspection_result(result.as_ref().map_err(String::as_str));
            Ok(())
        })?;
    }
    command_completed(&app, NativeCommand::Inspect, tracked, result.is_ok())?;
    result
}

#[tauri::command]
pub(super) fn native_source_build_scenario_diagnostic(
    app: AppHandle,
    message: FrontendScenarioMessage,
) -> Result<(), String> {
    let profile = profile_label(&app);
    if !ledger::tracks_native_calls(&profile) {
        return Err("Scenario diagnostics are unavailable for this profile".into());
    }
    app.state::<super::Fixture>()
        .scenario_diagnostics
        .lock()
        .record_frontend(message)
        .map_err(str::to_owned)
}
