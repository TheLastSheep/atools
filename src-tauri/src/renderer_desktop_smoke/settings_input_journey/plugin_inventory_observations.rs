use serde::Serialize;
use serde_json::Value;
use std::path::Path;

const FILE_NAME: &str = "native-plugin-inventory-observations.json";
const MAX_ARTIFACT_BYTES: usize = 12 * 1024;
const ERRORS: &[&str] = &[
    "settings-input-plugin-inventory-readiness-timeout",
    "settings-input-plugin-inventory-pending-state-invalid",
    "settings-input-plugin-inventory-timestamp-register-failed",
    "settings-input-plugin-inventory-ready-state-invalid",
    "settings-input-plugin-inventory-event-listener-invalid",
    "settings-input-plugin-inventory-disable-mutation-failed",
    "settings-input-plugin-inventory-disable-refresh-invalid",
    "settings-input-plugin-inventory-restore-mutation-failed",
    "settings-input-plugin-inventory-restore-refresh-invalid",
    "settings-input-plugin-inventory-runtime-started",
    "settings-input-plugin-inventory-report-write-failed",
];

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Readiness {
    pub(super) waiter_observed: Option<bool>,
    pub(super) pending_list_read_count: Option<u64>,
    pub(super) pending_native_calls: Option<u64>,
    pub(super) store_ready_before_release: Option<bool>,
    pub(super) registration_committed: Option<bool>,
    pub(super) first_list_read_count: Option<u64>,
    pub(super) store_ready_after_release: Option<bool>,
    pub(super) timestamp_match_count: Option<u64>,
    pub(super) target_app_count: Option<u64>,
    pub(super) plugin_catalog_settled: Option<bool>,
    pub(super) startup_event_delivered: Option<u64>,
    pub(super) event_invalid_payloads_after_startup: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Mutation {
    pub(super) mutation_committed: Option<bool>,
    pub(super) event_listener_ready_before: Option<bool>,
    pub(super) event_listener_ready_after: Option<bool>,
    pub(super) event_delivered_before: Option<u64>,
    pub(super) event_delivered_after: Option<u64>,
    pub(super) event_invalid_payloads_before: Option<u64>,
    pub(super) event_invalid_payloads_after: Option<u64>,
    pub(super) event_callback_errors_before: Option<u64>,
    pub(super) event_callback_errors_after: Option<u64>,
    pub(super) list_read_before: Option<u64>,
    pub(super) list_read_after: Option<u64>,
    pub(super) store_ready: Option<bool>,
    pub(super) timestamp_match_count: Option<u64>,
    pub(super) target_app_count: Option<u64>,
    pub(super) plugin_ui_opened: Option<bool>,
    pub(super) preload_started: Option<bool>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Data {
    pub(super) readiness: Readiness,
    pub(super) disable: Mutation,
    pub(super) restore: Mutation,
    pub(super) errors: Vec<&'static str>,
}

pub(super) fn add_error(data: &mut Data, code: &'static str) {
    if ERRORS.contains(&code) && !data.errors.contains(&code) && data.errors.len() < ERRORS.len() {
        data.errors.push(code);
    }
}

pub(super) fn report(profile: &super::super::profile::Profile, data: &Data) -> Value {
    serde_json::json!({
        "schemaVersion": 1,
        "journey": "settings-plugin-inventory",
        "scope": "hidden-original-vue-plugin-inventory",
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "readiness": data.readiness,
        "disable": data.disable,
        "restore": data.restore,
        "errors": data.errors,
    })
}

pub(super) fn write(
    profile: &super::super::profile::Profile,
    data: &Data,
) -> Result<(), &'static str> {
    let value = report(profile, data);
    if !valid_report(&value) {
        return Err("settings-input-plugin-inventory-report-write-failed");
    }
    let bytes = serde_json::to_vec(&value)
        .map_err(|_| "settings-input-plugin-inventory-report-write-failed")?;
    if bytes.len() > MAX_ARTIFACT_BYTES {
        return Err("settings-input-plugin-inventory-report-write-failed");
    }
    super::local_app_search_report::write_owned_artifact(profile, FILE_NAME, &value)
        .map_err(|_| "settings-input-plugin-inventory-report-write-failed")
}

fn valid_report(value: &Value) -> bool {
    let Some(run_id) = value["runId"].as_str() else {
        return false;
    };
    let expected_identifier = format!("dev.atools.renderer-settings-input.{run_id}");
    exact_keys(
        value,
        &[
            "schemaVersion",
            "journey",
            "scope",
            "identifier",
            "root",
            "pid",
            "runId",
            "readiness",
            "disable",
            "restore",
            "errors",
        ],
    ) && value["schemaVersion"].as_u64() == Some(1)
        && value["journey"].as_str() == Some("settings-plugin-inventory")
        && value["scope"].as_str() == Some("hidden-original-vue-plugin-inventory")
        && value["identifier"].as_str() == Some(expected_identifier.as_str())
        && value["root"]
            .as_str()
            .is_some_and(|root| Path::new(root).is_absolute())
        && value["pid"].as_u64().is_some_and(|pid| pid > 0)
        && valid_run_id(run_id)
        && valid_readiness(&value["readiness"])
        && valid_mutation(&value["disable"])
        && valid_mutation(&value["restore"])
        && valid_errors(&value["errors"])
        && serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_ARTIFACT_BYTES)
}

fn valid_readiness(value: &Value) -> bool {
    let keys = [
        "waiterObserved",
        "pendingListReadCount",
        "pendingNativeCalls",
        "storeReadyBeforeRelease",
        "registrationCommitted",
        "firstListReadCount",
        "storeReadyAfterRelease",
        "timestampMatchCount",
        "targetAppCount",
        "pluginCatalogSettled",
        "startupEventDelivered",
        "eventInvalidPayloadsAfterStartup",
    ];
    let bools = [
        "waiterObserved",
        "storeReadyBeforeRelease",
        "registrationCommitted",
        "storeReadyAfterRelease",
        "pluginCatalogSettled",
    ];
    let counts = [
        "pendingListReadCount",
        "pendingNativeCalls",
        "firstListReadCount",
        "timestampMatchCount",
        "targetAppCount",
        "startupEventDelivered",
        "eventInvalidPayloadsAfterStartup",
    ];
    valid_fields(value, &keys, &bools, &counts)
}

fn valid_mutation(value: &Value) -> bool {
    let keys = [
        "mutationCommitted",
        "eventListenerReadyBefore",
        "eventListenerReadyAfter",
        "eventDeliveredBefore",
        "eventDeliveredAfter",
        "eventInvalidPayloadsBefore",
        "eventInvalidPayloadsAfter",
        "eventCallbackErrorsBefore",
        "eventCallbackErrorsAfter",
        "listReadBefore",
        "listReadAfter",
        "storeReady",
        "timestampMatchCount",
        "targetAppCount",
        "pluginUiOpened",
        "preloadStarted",
    ];
    let bools = [
        "mutationCommitted",
        "eventListenerReadyBefore",
        "eventListenerReadyAfter",
        "storeReady",
        "pluginUiOpened",
        "preloadStarted",
    ];
    let counts = [
        "eventDeliveredBefore",
        "eventDeliveredAfter",
        "eventInvalidPayloadsBefore",
        "eventInvalidPayloadsAfter",
        "eventCallbackErrorsBefore",
        "eventCallbackErrorsAfter",
        "listReadBefore",
        "listReadAfter",
        "timestampMatchCount",
        "targetAppCount",
    ];
    valid_fields(value, &keys, &bools, &counts)
}

fn valid_fields(value: &Value, keys: &[&str], bools: &[&str], counts: &[&str]) -> bool {
    exact_keys(value, keys)
        && bools
            .iter()
            .all(|key| value[*key].is_null() || value[*key].is_boolean())
        && counts.iter().all(|key| {
            value[*key].is_null() || value[*key].as_u64().is_some_and(|count| count <= 4096)
        })
}

fn valid_errors(value: &Value) -> bool {
    let Some(errors) = value.as_array() else {
        return false;
    };
    let mut seen = std::collections::BTreeSet::new();
    errors.len() <= ERRORS.len()
        && errors.iter().all(|error| {
            error
                .as_str()
                .is_some_and(|code| ERRORS.contains(&code) && seen.insert(code))
        })
}

fn valid_run_id(run_id: &str) -> bool {
    run_id.len() == 32
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}
