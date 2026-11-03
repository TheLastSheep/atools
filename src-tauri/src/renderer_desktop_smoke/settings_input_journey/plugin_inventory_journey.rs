use super::{
    fixture_control,
    plugin_inventory_observations::{self as observations, Data, Mutation, Readiness},
    probe,
    state::Harness,
};
use crate::{
    plugin_inventory::readiness::{BootstrapCompletionGuard, PluginInventoryReadiness},
    state::AppState,
};
use atools_core::Database;
use parking_lot::Mutex;
use serde_json::Value;
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager, Wry};

const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
const READINESS_TIMEOUT: &str = "settings-input-plugin-inventory-readiness-timeout";
const PENDING_INVALID: &str = "settings-input-plugin-inventory-pending-state-invalid";
const REGISTER_FAILED: &str = "settings-input-plugin-inventory-timestamp-register-failed";
const READY_INVALID: &str = "settings-input-plugin-inventory-ready-state-invalid";
const EVENT_INVALID: &str = "settings-input-plugin-inventory-event-listener-invalid";
const DISABLE_MUTATION_FAILED: &str = "settings-input-plugin-inventory-disable-mutation-failed";
const DISABLE_REFRESH_INVALID: &str = "settings-input-plugin-inventory-disable-refresh-invalid";
const RESTORE_MUTATION_FAILED: &str = "settings-input-plugin-inventory-restore-mutation-failed";
const RESTORE_REFRESH_INVALID: &str = "settings-input-plugin-inventory-restore-refresh-invalid";
const RUNTIME_STARTED: &str = "settings-input-plugin-inventory-runtime-started";

#[derive(Clone)]
pub(in crate::renderer_desktop_smoke) struct PluginInventoryHarness {
    profile: Arc<super::super::profile::Profile>,
    readiness: PluginInventoryReadiness,
    completion: Arc<Mutex<Option<BootstrapCompletionGuard>>>,
    plugin_id: Arc<Mutex<Option<String>>>,
    data: Arc<Mutex<Data>>,
}

impl PluginInventoryHarness {
    fn new(
        profile: Arc<super::super::profile::Profile>,
        readiness: PluginInventoryReadiness,
        completion: BootstrapCompletionGuard,
    ) -> Self {
        Self {
            profile,
            readiness,
            completion: Arc::new(Mutex::new(Some(completion))),
            plugin_id: Arc::new(Mutex::new(None)),
            data: Arc::new(Mutex::new(Data::default())),
        }
    }

    fn complete(&self, outcome: Result<(), String>) {
        if let Some(guard) = self.completion.lock().take() {
            guard.complete(outcome);
        }
    }

    fn complete_metadata_registration(&self, app: &AppHandle<Wry>) {
        if let Some(guard) = self.completion.lock().take() {
            crate::plugin_inventory::bootstrap::complete_metadata_registration(app, guard);
        }
    }

    pub(in crate::renderer_desktop_smoke) fn take_bootstrap_guard(
        &self,
    ) -> Option<BootstrapCompletionGuard> {
        self.completion.lock().take()
    }

    fn has_pending_guard(&self) -> bool {
        self.completion.lock().is_some()
    }

    fn record_error(&self, code: &'static str) {
        observations::add_error(&mut self.data.lock(), code);
    }

    fn record_readiness(&self, value: Readiness) {
        self.data.lock().readiness = value;
    }

    fn record_mutation(&self, enabled: bool, value: Mutation) {
        if enabled {
            self.data.lock().restore = value;
        } else {
            self.data.lock().disable = value;
        }
    }

    fn plugin_id(&self) -> Option<String> {
        self.plugin_id.lock().clone()
    }

    fn set_plugin_id(&self, id: String) {
        *self.plugin_id.lock() = Some(id);
    }
}

pub(super) fn prepare(
    profile: Arc<super::super::profile::Profile>,
    readiness: PluginInventoryReadiness,
) -> Result<PluginInventoryHarness, String> {
    if !profile.settings_input_journey {
        return Err("settings-input-profile-invalid".to_owned());
    }
    let completion = readiness.begin_bootstrap()?;
    Ok(PluginInventoryHarness::new(profile, readiness, completion))
}

pub(super) async fn release_pending_inventory(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
) -> Result<(), &'static str> {
    let Some(state) = app.try_state::<PluginInventoryHarness>() else {
        return Err(PENDING_INVALID);
    };
    let fixture = (*state).clone();
    let result = release_inner(app, harness, target, &fixture).await;
    if let Err(code) = result {
        fixture.record_error(code);
        fixture.complete(Err("PLUGIN_INVENTORY_BOOTSTRAP_FAILED".to_owned()));
        return Err(code);
    }
    Ok(())
}

async fn release_inner(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
    fixture: &PluginInventoryHarness,
) -> Result<(), &'static str> {
    wait_until_pending_waiter(fixture).await?;
    let pending = probe::main_plugin_inventory(app, harness, target, None, None, None)
        .await
        .map_err(|_| PENDING_INVALID)?;
    let pending_list_reads = count(&pending, "listReadCount");
    let pending_native_calls = count(&pending, "pendingNativeCalls");
    let store_ready_before = bool_value(&pending, "storeReady");
    if pending_list_reads != Some(1)
        || pending_native_calls.is_none_or(|count| count == 0)
        || store_ready_before != Some(false)
    {
        fixture.record_readiness(Readiness {
            waiter_observed: Some(true),
            pending_list_read_count: pending_list_reads,
            pending_native_calls,
            store_ready_before_release: store_ready_before,
            ..Readiness::default()
        });
        return Err(PENDING_INVALID);
    }

    let db = app.state::<AppState>().db.clone();
    let plugin_id = tauri::async_runtime::spawn_blocking(move || {
        fixture_control::register_timestamp_control(&db)
    })
    .await
    .map_err(|_| REGISTER_FAILED)?
    .map_err(|_| REGISTER_FAILED)?;
    fixture.set_plugin_id(plugin_id);
    fixture.complete_metadata_registration(app);

    let expected_event_count = count(&pending, "eventDeliveredEvents")
        .and_then(|count| count.checked_add(1))
        .filter(|count| *count <= 4096)
        .ok_or(EVENT_INVALID)?;
    let ready = probe::main_plugin_inventory(
        app,
        harness,
        target,
        Some(1),
        Some(expected_event_count),
        None,
    )
    .await
    .map_err(|_| READY_INVALID)?;
    let delivered_before = count(&pending, "eventDeliveredEvents");
    let delivered_after = count(&ready, "eventDeliveredEvents");
    let delivered_delta = delivered_after
        .zip(delivered_before)
        .and_then(|(after, before)| after.checked_sub(before));
    let invalid_payloads = count(&ready, "invalidPayloads");
    let settled = catalog_settled(&ready);
    let listener_ready = listener_ready(&ready);
    let readiness = Readiness {
        waiter_observed: Some(true),
        pending_list_read_count: pending_list_reads,
        pending_native_calls,
        store_ready_before_release: store_ready_before,
        registration_committed: Some(true),
        first_list_read_count: count(&ready, "listReadCount"),
        store_ready_after_release: bool_value(&ready, "storeReady"),
        timestamp_match_count: count(&ready, "timestampMatchCount"),
        target_app_count: count(&ready, "targetAppCount"),
        plugin_catalog_settled: Some(settled && listener_ready),
        startup_event_delivered: delivered_delta,
        event_invalid_payloads_after_startup: invalid_payloads,
    };
    fixture.record_readiness(readiness);
    if !listener_ready {
        return Err(EVENT_INVALID);
    }
    if delivered_delta != Some(1) || invalid_payloads != Some(0) {
        return Err(EVENT_INVALID);
    }
    if !settled
        || count(&ready, "listReadCount").is_none_or(|count| !(1..=2).contains(&count))
        || bool_value(&ready, "storeReady") != Some(true)
        || count(&ready, "timestampMatchCount") != Some(1)
        || count(&ready, "targetAppCount") != Some(1)
    {
        return Err(READY_INVALID);
    }
    Ok(())
}

pub(super) async fn toggle_timestamp_inventory(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
) -> Result<(), &'static str> {
    let Some(state) = app.try_state::<PluginInventoryHarness>() else {
        return Err(PENDING_INVALID);
    };
    let fixture = (*state).clone();
    let Some(plugin_id) = fixture.plugin_id() else {
        fixture.record_error(PENDING_INVALID);
        return Err(PENDING_INVALID);
    };
    let disabled = mutate_and_observe(app, harness, target, &fixture, &plugin_id, false).await;
    fixture.record_mutation(false, disabled.observation);
    let restored = mutate_and_observe(app, harness, target, &fixture, &plugin_id, true).await;
    fixture.record_mutation(true, restored.observation);

    if let Err(code) = disabled.result {
        fixture.record_error(code);
        return Err(code);
    }
    if let Err(code) = restored.result {
        fixture.record_error(code);
        return Err(code);
    }
    Ok(())
}

struct MutationAttempt {
    observation: Mutation,
    result: Result<(), &'static str>,
}

async fn mutate_and_observe(
    app: &AppHandle<Wry>,
    harness: &Harness,
    target: &(String, String),
    fixture: &PluginInventoryHarness,
    plugin_id: &str,
    enabled: bool,
) -> MutationAttempt {
    let (mutation_error, refresh_error) = if enabled {
        (RESTORE_MUTATION_FAILED, RESTORE_REFRESH_INVALID)
    } else {
        (DISABLE_MUTATION_FAILED, DISABLE_REFRESH_INVALID)
    };
    let mut observation = Mutation::default();
    let before = match probe::main_plugin_inventory(app, harness, target, None, None, None).await {
        Ok(value) => value,
        Err(_) => {
            return MutationAttempt {
                observation,
                result: Err(refresh_error),
            };
        }
    };
    observation.event_listener_ready_before = Some(listener_ready(&before));
    observation.event_delivered_before = count(&before, "eventDeliveredEvents");
    observation.event_invalid_payloads_before = count(&before, "invalidPayloads");
    observation.event_callback_errors_before = callback_errors(&before);
    observation.list_read_before = count(&before, "listReadCount");

    let db = app.state::<AppState>().db.clone();
    let mutation =
        crate::plugin_mutations::toggle(app, db.clone(), plugin_id.to_owned(), enabled).await;
    let committed = match mutation {
        Ok(plugin) if plugin.enabled == enabled => read_enabled(&db, plugin_id, enabled).await,
        _ => false,
    };
    observation.mutation_committed = Some(committed);
    if !committed {
        return MutationAttempt {
            observation,
            result: Err(mutation_error),
        };
    }

    let expected_event_count = observation
        .event_delivered_before
        .and_then(|value| value.checked_add(1));
    let expected_list_read = observation
        .list_read_before
        .and_then(|value| value.checked_add(1));
    if expected_event_count.is_none_or(|count| count > 4096)
        || expected_list_read.is_none_or(|count| count > 4096)
    {
        return MutationAttempt {
            observation,
            result: Err(refresh_error),
        };
    }
    let runtime = runtime_activity(app, plugin_id);
    let after = probe::main_plugin_inventory(
        app,
        harness,
        target,
        Some(if enabled { 1 } else { 0 }),
        expected_event_count,
        expected_list_read,
    )
    .await;
    let Ok(after) = after else {
        observation.plugin_ui_opened = runtime.0;
        observation.preload_started = runtime.1;
        return MutationAttempt {
            observation,
            result: Err(refresh_error),
        };
    };
    observation.event_listener_ready_after = Some(listener_ready(&after));
    observation.event_delivered_after = count(&after, "eventDeliveredEvents");
    observation.event_invalid_payloads_after = count(&after, "invalidPayloads");
    observation.event_callback_errors_after = callback_errors(&after);
    observation.list_read_after = count(&after, "listReadCount");
    observation.store_ready = bool_value(&after, "storeReady");
    observation.timestamp_match_count = count(&after, "timestampMatchCount");
    observation.target_app_count = count(&after, "targetAppCount");
    observation.plugin_ui_opened = runtime.0;
    observation.preload_started = runtime.1;

    let refreshed = observation.event_listener_ready_before == Some(true)
        && observation.event_listener_ready_after == Some(true)
        && plus_one(
            observation.event_delivered_before,
            observation.event_delivered_after,
        )
        && observation.event_invalid_payloads_before == Some(0)
        && observation.event_invalid_payloads_after == Some(0)
        && observation.event_callback_errors_before == Some(0)
        && observation.event_callback_errors_after == Some(0)
        && plus_one(observation.list_read_before, observation.list_read_after)
        && observation.store_ready == Some(true)
        && observation.timestamp_match_count == Some(if enabled { 1 } else { 0 })
        && observation.target_app_count == Some(1)
        && observation.plugin_ui_opened == Some(false)
        && observation.preload_started == Some(false);
    MutationAttempt {
        observation,
        result: if refreshed {
            Ok(())
        } else if runtime.0 == Some(true) || runtime.1 == Some(true) {
            Err(RUNTIME_STARTED)
        } else {
            Err(refresh_error)
        },
    }
}

async fn read_enabled(db: &Arc<Database>, plugin_id: &str, expected: bool) -> bool {
    let db = Arc::clone(db);
    let id = plugin_id.to_owned();
    tauri::async_runtime::spawn_blocking(move || db.get_plugin(&id))
        .await
        .ok()
        .and_then(Result::ok)
        .is_some_and(|plugin| plugin.enabled == expected)
}

fn runtime_activity(app: &AppHandle<Wry>, plugin_id: &str) -> (Option<bool>, Option<bool>) {
    let Some(state) = app.try_state::<AppState>() else {
        return (None, None);
    };
    let plugin_ui_opened = Some(state.active_plugin.lock().is_some());
    let preload_started = crate::legacy_runtime::inventory_snapshot(app)
        .ok()
        .filter(|(_, truncated)| !truncated)
        .map(|(sessions, _)| {
            sessions
                .iter()
                .any(|session| session.plugin_id == plugin_id)
        });
    (plugin_ui_opened, preload_started)
}

pub(super) async fn finalize(app: &AppHandle<Wry>, harness: &Harness) {
    let Some(state) = app.try_state::<PluginInventoryHarness>() else {
        harness.add_error(PENDING_INVALID);
        return;
    };
    let fixture = (*state).clone();
    if fixture.has_pending_guard() {
        fixture.record_error(READINESS_TIMEOUT);
        fixture.complete(Err("PLUGIN_INVENTORY_BOOTSTRAP_ABORTED".to_owned()));
        harness.add_error(READINESS_TIMEOUT);
    }
    if !ensure_timestamp_enabled(app, &fixture).await {
        fixture.record_error(RESTORE_MUTATION_FAILED);
        harness.add_error(RESTORE_MUTATION_FAILED);
    }
    if fixture.data.lock().readiness.waiter_observed.is_none() {
        fixture.record_error(PENDING_INVALID);
        harness.add_error(PENDING_INVALID);
    }
    if fixture.data.lock().disable.mutation_committed.is_none() {
        fixture.record_error(DISABLE_MUTATION_FAILED);
        harness.add_error(DISABLE_MUTATION_FAILED);
    }
    if fixture.data.lock().restore.mutation_committed.is_none() {
        fixture.record_error(RESTORE_MUTATION_FAILED);
        harness.add_error(RESTORE_MUTATION_FAILED);
    }
    if observations::write(&fixture.profile, &fixture.data.lock()).is_err() {
        fixture.record_error("settings-input-plugin-inventory-report-write-failed");
        harness.add_error("settings-input-plugin-inventory-report-write-failed");
    }
}

async fn wait_until_pending_waiter(fixture: &PluginInventoryHarness) -> Result<(), &'static str> {
    #[cfg(any(test, feature = "legacy-node-smoke"))]
    {
        fixture
            .readiness
            .wait_until_waiting(WAIT_TIMEOUT)
            .await
            .map_err(|_| READINESS_TIMEOUT)?;
        fixture.record_readiness(Readiness {
            waiter_observed: Some(true),
            ..Readiness::default()
        });
        Ok(())
    }
    #[cfg(not(any(test, feature = "legacy-node-smoke")))]
    {
        let _ = fixture;
        Err(READINESS_TIMEOUT)
    }
}

async fn ensure_timestamp_enabled(app: &AppHandle<Wry>, fixture: &PluginInventoryHarness) -> bool {
    let Some(plugin_id) = fixture.plugin_id() else {
        return true;
    };
    let db = app.state::<AppState>().db.clone();
    if read_enabled(&db, &plugin_id, true).await {
        return true;
    }
    crate::plugin_mutations::toggle(app, db.clone(), plugin_id.clone(), true)
        .await
        .is_ok()
        && read_enabled(&db, &plugin_id, true).await
}

fn count(value: &Value, key: &str) -> Option<u64> {
    value[key].as_u64().filter(|count| *count <= 4096)
}

fn bool_value(value: &Value, key: &str) -> Option<bool> {
    value[key].as_bool()
}

fn listener_ready(value: &Value) -> bool {
    value["listenerState"].as_str() == Some("listening")
        && count(value, "registrationErrors") == Some(0)
        && count(value, "registrationsPending") == Some(0)
        && count(value, "cleanupErrors") == Some(0)
}

fn catalog_settled(value: &Value) -> bool {
    count(value, "cachedPlugins") == Some(1)
        && bool_value(value, "catalogReadPending") == Some(false)
        && bool_value(value, "catalogLateChangePending") == Some(false)
        && count(value, "pluginCallbackErrors") == Some(0)
        && count(value, "listenerCallbackErrors") == Some(0)
}

fn callback_errors(value: &Value) -> Option<u64> {
    count(value, "pluginCallbackErrors")?
        .checked_add(count(value, "listenerCallbackErrors")?)
        .filter(|count| *count <= 4096)
}

fn plus_one(before: Option<u64>, after: Option<u64>) -> bool {
    before
        .and_then(|before| before.checked_add(1))
        .is_some_and(|expected| after == Some(expected))
}
