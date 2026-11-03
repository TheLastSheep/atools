use serde_json::Value;

const FIELDS: &[&str] = &[
    "storeReady",
    "timestampMatchCount",
    "targetAppCount",
    "listReadCount",
    "pendingNativeCalls",
    "cachedPlugins",
    "catalogReadPending",
    "catalogLateChangePending",
    "pluginCallbackErrors",
    "invalidPayloads",
    "listenerState",
    "eventDeliveredEvents",
    "registrationErrors",
    "listenerCallbackErrors",
    "registrationsPending",
    "cleanupErrors",
];

const BOOL_FIELDS: &[&str] = &[
    "storeReady",
    "catalogReadPending",
    "catalogLateChangePending",
];
const COUNT_FIELDS: &[&str] = &[
    "timestampMatchCount",
    "targetAppCount",
    "listReadCount",
    "pendingNativeCalls",
    "cachedPlugins",
    "pluginCallbackErrors",
    "invalidPayloads",
    "eventDeliveredEvents",
    "registrationErrors",
    "listenerCallbackErrors",
    "registrationsPending",
    "cleanupErrors",
];

pub(super) fn validate_evidence(value: &Value) -> Result<(), &'static str> {
    let object = value
        .as_object()
        .ok_or("settings-input-probe-protocol-rejected")?;
    if object.len() != FIELDS.len() || FIELDS.iter().any(|key| !object.contains_key(*key)) {
        return Err("settings-input-probe-protocol-rejected");
    }
    for key in BOOL_FIELDS {
        if !value[*key].is_null() && !value[*key].is_boolean() {
            return Err("settings-input-probe-protocol-rejected");
        }
    }
    for key in COUNT_FIELDS {
        if !value[*key].is_null() && value[*key].as_u64().is_none_or(|count| count > 4096) {
            return Err("settings-input-probe-protocol-rejected");
        }
    }
    if !value["listenerState"].is_null()
        && !matches!(
            value["listenerState"].as_str(),
            Some("idle" | "registering" | "listening" | "failed" | "disposed")
        )
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}
