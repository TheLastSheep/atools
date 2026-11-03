use super::{report, storage};
use crate::{
    renderer_desktop_smoke::{
        profile::Profile,
        settings_input_journey::{self, PluginInventoryHarness},
    },
    state::AppState,
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Wry};

const JOURNEY_TIMEOUT: Duration = Duration::from_secs(150);
const PENDING_TIMEOUT: Duration = Duration::from_secs(10);
const PENDING_TIMEOUT_ERROR: &str = "builtin-state-pending-timeout";
const PENDING_INVALID: &str = "builtin-state-pending-state-invalid";
const REGISTER_FAILED: &str = "builtin-state-metadata-register-failed";
const DISABLED_INVALID: &str = "builtin-state-disabled-state-not-preserved";
const DOCUMENT_INVALID: &str = "builtin-state-document-not-preserved";
const ATTACHMENT_INVALID: &str = "builtin-state-attachment-not-preserved";
const STARTUP_INVALID: &str = "builtin-state-startup-refresh-invalid";
const RESTORE_FAILED: &str = "builtin-state-restore-mutation-failed";
const RESTORE_INVALID: &str = "builtin-state-restore-refresh-invalid";
const RUNTIME_STARTED: &str = "builtin-state-runtime-started";
const DATABASE_INVALID: &str = "builtin-state-database-identity-invalid";

pub(super) fn start(app: AppHandle<Wry>) {
    let Some(settings_harness) = app.try_state::<settings_input_journey::Harness>() else {
        app.exit(1);
        return;
    };
    let profile = settings_harness.profile_arc();
    tauri::async_runtime::spawn(async move {
        let mut report_value = report::MainReport::new(&profile);
        report_value.observations.resume_claimed = Some(true);
        let result = tokio::time::timeout(
            JOURNEY_TIMEOUT,
            run(&app, &profile, &mut report_value.observations),
        )
        .await;
        let passed = match result {
            Ok(Ok(())) => report_value.errors.is_empty(),
            Ok(Err(error)) => {
                report::add_error(&mut report_value.errors, error);
                false
            }
            Err(_) => {
                report::add_error(&mut report_value.errors, PENDING_TIMEOUT_ERROR);
                false
            }
        };
        if let Some(inventory) = app.try_state::<PluginInventoryHarness>() {
            if let Some(guard) = inventory.take_bootstrap_guard() {
                guard.complete(Err("PLUGIN_INVENTORY_BOOTSTRAP_ABORTED".to_owned()));
            }
        }
        let written = report::write_main(&profile, &report_value).is_ok();
        if !written {
            report::add_error(
                &mut report_value.errors,
                "builtin-state-report-write-failed",
            );
        }
        let exit_code = i32::from(!(passed && written && report_value.errors.is_empty()));
        if let Some(status) = app.try_state::<Arc<super::super::FixtureExitStatus>>() {
            status
                .code
                .store(exit_code, std::sync::atomic::Ordering::Release);
        }
        app.exit(exit_code);
    });
}

async fn run(
    app: &AppHandle<Wry>,
    profile: &Profile,
    observations: &mut report::MainObservations,
) -> Result<(), &'static str> {
    if profile.resume_seed_pid.is_none() {
        return Err("builtin-state-resume-owner-invalid");
    }
    let (readiness, db) = {
        let state = app.try_state::<AppState>().ok_or(PENDING_INVALID)?;
        (
            state.plugin_inventory_readiness.clone(),
            Arc::clone(&state.db),
        )
    };
    let configured_visible = db
        .get_setting("settings-general")
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("showTrayIcon").and_then(Value::as_bool));
    observations.tray_configured_visible = configured_visible;
    observations.tray_native_visible = crate::native_tray_visibility::read_apply(app, None).ok();
    if observations.tray_configured_visible != Some(false)
        || observations.tray_native_visible != Some(false)
    {
        return Err(STARTUP_INVALID);
    }
    let main_ready = settings_input_journey::wait_main_ready(app)
        .await
        .map_err(|_| PENDING_TIMEOUT_ERROR)?;
    if main_ready["inputFound"].as_bool() != Some(true) {
        return Err(PENDING_TIMEOUT_ERROR);
    }
    let target = settings_input_journey::select_inventory_target(app)
        .await
        .map_err(|_| PENDING_INVALID)?;
    tokio::time::timeout(
        PENDING_TIMEOUT,
        readiness.wait_until_waiting(PENDING_TIMEOUT),
    )
    .await
    .map_err(|_| PENDING_TIMEOUT_ERROR)?
    .map_err(|_| PENDING_TIMEOUT_ERROR)?;
    observations.pending_waiter_observed = Some(true);

    let pending = settings_input_journey::inspect_main_inventory(app, &target, None, None, None)
        .await
        .map_err(|_| PENDING_INVALID)?;
    observations.pending_list_read_count = count(&pending, "listReadCount");
    observations.pending_native_calls = count(&pending, "pendingNativeCalls");
    observations.store_ready_before_release = bool_value(&pending, "storeReady");
    observations.startup_event_delivered_before = count(&pending, "eventDeliveredEvents");
    observations.startup_list_read_before = observations.pending_list_read_count;
    if observations.pending_list_read_count != Some(1)
        || observations
            .pending_native_calls
            .is_none_or(|value| value == 0)
        || observations.store_ready_before_release != Some(false)
    {
        return Err(PENDING_INVALID);
    }

    let builtin_dir =
        settings_input_journey::staged_builtin_plugins_dir().map_err(|_| REGISTER_FAILED)?;
    let package_dir = builtin_dir.join("timestamp");
    let before_metadata = storage::timestamp_plugin(&db, &package_dir).ok_or(PENDING_INVALID)?;
    if before_metadata.enabled {
        return Err(PENDING_INVALID);
    }
    let (document_before, attachment_before) =
        storage::state_matches(&db, &before_metadata.id, &profile.run_id);
    if !document_before {
        observations.document_preserved = Some(false);
        return Err(DOCUMENT_INVALID);
    }
    if !attachment_before {
        observations.attachment_preserved = Some(false);
        return Err(ATTACHMENT_INVALID);
    }

    let inventory = app
        .try_state::<PluginInventoryHarness>()
        .ok_or(REGISTER_FAILED)?;
    let guard = inventory.take_bootstrap_guard().ok_or(REGISTER_FAILED)?;
    drop(inventory);
    if crate::builtin_plugins::load_builtin_plugins(Arc::clone(&db), Some(builtin_dir))
        .await
        .is_err()
    {
        guard.complete(Err("PLUGIN_INVENTORY_BOOTSTRAP_FAILED".to_owned()));
        return Err(REGISTER_FAILED);
    }
    observations.metadata_registered = Some(true);
    crate::plugin_inventory::bootstrap::complete_metadata_registration(app, guard);

    let plugin = storage::timestamp_plugin(&db, &package_dir).ok_or(DISABLED_INVALID)?;
    observations.enabled_after_metadata_refresh = Some(plugin.enabled);
    if plugin.id != before_metadata.id || plugin.enabled {
        return Err(DISABLED_INVALID);
    }
    let (document_after, attachment_after) =
        storage::state_matches(&db, &plugin.id, &profile.run_id);
    observations.document_preserved = Some(document_before && document_after);
    observations.attachment_preserved = Some(attachment_before && attachment_after);
    if !document_after {
        return Err(DOCUMENT_INVALID);
    }
    if !attachment_after {
        return Err(ATTACHMENT_INVALID);
    }

    let expected_startup_event = observations
        .startup_event_delivered_before
        .and_then(|value| value.checked_add(1))
        .filter(|value| *value <= 4096)
        .ok_or(STARTUP_INVALID)?;
    let startup = settings_input_journey::inspect_main_inventory(
        app,
        &target,
        Some(0),
        Some(expected_startup_event),
        None,
    )
    .await
    .map_err(|_| STARTUP_INVALID)?;
    observations.startup_store_ready = bool_value(&startup, "storeReady");
    observations.startup_timestamp_match_count = count(&startup, "timestampMatchCount");
    observations.startup_target_app_count = count(&startup, "targetAppCount");
    observations.startup_event_delivered_after = count(&startup, "eventDeliveredEvents");
    observations.startup_list_read_after = count(&startup, "listReadCount");
    if observations.startup_store_ready != Some(true)
        || observations.startup_timestamp_match_count != Some(0)
        || observations.startup_target_app_count != Some(1)
        || !plus_one(
            observations.startup_event_delivered_before,
            observations.startup_event_delivered_after,
        )
        || observations.startup_list_read_before != Some(1)
        || !matches!(observations.startup_list_read_after, Some(1 | 2))
        || !catalog_settled(&startup)
    {
        return Err(STARTUP_INVALID);
    }

    observations.restore_event_delivered_before = observations.startup_event_delivered_after;
    observations.restore_list_read_before = observations.startup_list_read_after;
    let mutation =
        crate::plugin_mutations::toggle(app, Arc::clone(&db), plugin.id.clone(), true).await;
    let restored = mutation.is_ok_and(|value| value.enabled)
        && db.get_plugin(&plugin.id).is_ok_and(|stored| stored.enabled);
    observations.restore_committed = Some(restored);
    if !restored {
        return Err(RESTORE_FAILED);
    }
    let expected_event = observations
        .restore_event_delivered_before
        .and_then(|value| value.checked_add(1))
        .filter(|value| *value <= 4096)
        .ok_or(RESTORE_INVALID)?;
    let expected_list = observations
        .restore_list_read_before
        .and_then(|value| value.checked_add(1))
        .filter(|value| *value <= 4096)
        .ok_or(RESTORE_INVALID)?;
    let final_state = settings_input_journey::inspect_main_inventory(
        app,
        &target,
        Some(1),
        Some(expected_event),
        Some(expected_list),
    )
    .await
    .map_err(|_| RESTORE_INVALID)?;
    observations.enabled_after_restore =
        Some(db.get_plugin(&plugin.id).is_ok_and(|stored| stored.enabled));
    observations.final_timestamp_match_count = count(&final_state, "timestampMatchCount");
    observations.final_target_app_count = count(&final_state, "targetAppCount");
    observations.restore_event_delivered_after = count(&final_state, "eventDeliveredEvents");
    observations.restore_list_read_after = count(&final_state, "listReadCount");
    if observations.enabled_after_restore != Some(true)
        || observations.final_timestamp_match_count != Some(1)
        || observations.final_target_app_count != Some(1)
        || !plus_one(
            observations.restore_event_delivered_before,
            observations.restore_event_delivered_after,
        )
        || !plus_one(
            observations.restore_list_read_before,
            observations.restore_list_read_after,
        )
        || !catalog_settled(&final_state)
    {
        return Err(RESTORE_INVALID);
    }

    let state = app.try_state::<AppState>().ok_or(RUNTIME_STARTED)?;
    observations.plugin_ui_opened = Some(state.active_plugin.lock().is_some());
    observations.preload_started = crate::legacy_runtime::inventory_snapshot(app)
        .ok()
        .filter(|(_, truncated)| !truncated)
        .map(|(sessions, _)| !sessions.is_empty());
    if observations.plugin_ui_opened != Some(false) || observations.preload_started != Some(false) {
        return Err(RUNTIME_STARTED);
    }

    report::apply_database_identity(
        &mut observations.database_device,
        &mut observations.database_inode,
        storage::database_identity(&storage::database_path(&profile.root)),
    );
    observations.created_at_fingerprint = storage::fingerprint_created_at(&db, &plugin.id);
    if observations.database_device.is_none()
        || observations.database_inode.is_none()
        || observations.created_at_fingerprint.is_none()
    {
        return Err(DATABASE_INVALID);
    }
    Ok(())
}

fn count(value: &serde_json::Value, key: &str) -> Option<u64> {
    value[key].as_u64().filter(|count| *count <= 4096)
}

fn bool_value(value: &serde_json::Value, key: &str) -> Option<bool> {
    value[key].as_bool()
}

fn plus_one(before: Option<u64>, after: Option<u64>) -> bool {
    before
        .and_then(|value| value.checked_add(1))
        .is_some_and(|expected| expected <= 4096 && after == Some(expected))
}

fn catalog_settled(value: &serde_json::Value) -> bool {
    bool_value(value, "storeReady") == Some(true)
        && count(value, "cachedPlugins") == Some(1)
        && bool_value(value, "catalogReadPending") == Some(false)
        && bool_value(value, "catalogLateChangePending") == Some(false)
        && value["listenerState"].as_str() == Some("listening")
        && count(value, "pluginCallbackErrors") == Some(0)
        && count(value, "invalidPayloads") == Some(0)
        && count(value, "registrationErrors") == Some(0)
        && count(value, "listenerCallbackErrors") == Some(0)
        && count(value, "registrationsPending") == Some(0)
        && count(value, "cleanupErrors") == Some(0)
}
