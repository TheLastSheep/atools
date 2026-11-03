use super::super::super::observations::Stage;
use serde_json::Value;

const MAX_READINESS_BYTES: usize = 4096;
const MAX_COUNTER: u64 = 128;
pub(super) const MAX_DOM_SNAPSHOT_BYTES: usize = 16 * 1024;

pub(super) fn readiness_errors(value: &Value) -> Vec<&'static str> {
    let mut errors = Vec::new();
    if serde_json::to_vec(value).map_or(true, |bytes| bytes.len() > MAX_READINESS_BYTES) {
        errors.push("renderer-readiness-evidence-exceeds-limit");
        return errors;
    }
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        errors.push("renderer-readiness-schema-version-mismatch");
    }
    if value.get("ready").and_then(Value::as_bool) != Some(true) {
        errors.push("renderer-ready-contract-not-met");
    }
    if value.get("inputFound").and_then(Value::as_bool) != Some(true) {
        errors.push("original-search-input-missing");
    }
    if value.get("adapterPresent").and_then(Value::as_bool) != Some(true) {
        errors.push("production-host-adapter-missing");
    }
    if value
        .get("nativeListenersListening")
        .and_then(Value::as_bool)
        != Some(true)
    {
        errors.push("production-native-listeners-not-listening");
    }
    if !bounded_positive_counts(value.get("eventSourceSubscribers"), 4) {
        errors.push("production-event-source-subscriber-count-mismatch");
    }
    if !bounded_positive_counts(value.get("appStateSubscriberCounts"), 2) {
        errors.push("production-app-state-subscribers-not-ready");
    }
    if !bounded_positive_count(value.get("contextMenuSubscriberCount")) {
        errors.push("production-context-menu-subscriber-not-ready");
    }
    if value.get("settingsCacheCount").and_then(Value::as_u64) != Some(14) {
        errors.push("production-settings-cache-not-ready");
    }
    let native_invocations = value
        .get("nativeInvocationCount")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    if native_invocations == 0 || native_invocations > MAX_COUNTER {
        errors.push("production-native-ipc-not-observed-or-out-of-bounds");
    }
    if !value
        .get("appCatalogReadCount")
        .and_then(Value::as_u64)
        .is_some_and(|count| count > 0 && count <= MAX_COUNTER && count <= native_invocations)
    {
        errors.push("production-app-catalog-read-not-observed-or-out-of-bounds");
    }
    if value.get("outstandingNativeCalls").and_then(Value::as_u64) != Some(0) {
        errors.push("production-native-ipc-not-settled-at-readiness");
    }
    errors
}

pub(super) fn observation_errors(stage: Stage, value: &Value) -> Vec<&'static str> {
    let mut errors = Vec::new();
    if !value.is_object() {
        return vec!["renderer-observation-schema-is-not-an-object"];
    }
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        errors.push("renderer-observation-schema-version-mismatch");
    }
    if value.get("stage").and_then(Value::as_str) != Some(stage.as_str()) {
        errors.push("renderer-observation-stage-mismatch");
    }
    for field in [
        "stageReady",
        "inputFound",
        "documentHasFocus",
        "inputFocused",
    ] {
        if value.get(field).and_then(Value::as_bool).is_none() {
            errors.push("renderer-observation-boolean-field-invalid");
            break;
        }
    }
    if !matches!(
        value.get("documentVisibility").and_then(Value::as_str),
        Some("visible" | "hidden")
    ) {
        errors.push("renderer-document-visibility-schema-invalid");
    }
    match value.get("inputValue") {
        Some(Value::String(input)) if input.len() <= 64 => {}
        _ => errors.push("renderer-input-value-schema-invalid"),
    }
    for field in ["selectionStart", "selectionEnd"] {
        let valid = value.get(field).is_some_and(|selection| {
            selection.is_null() || selection.as_u64().is_some_and(|offset| offset <= 64)
        });
        if !valid {
            errors.push("renderer-input-selection-schema-invalid");
            break;
        }
    }
    if !value
        .get("adapter")
        .is_some_and(|adapter| adapter.is_null() || adapter.is_object())
    {
        errors.push("renderer-adapter-snapshot-schema-invalid");
    }
    if !value.get("disposeError").is_some_and(|error| {
        error.is_null() || error.as_str().is_some_and(|message| message.len() <= 128)
    }) {
        errors.push("renderer-dispose-error-schema-invalid");
    }
    let pre_dispose_counters = value.get("preDisposeCounters");
    if matches!(stage, Stage::Disposed | Stage::DisposedReturn) {
        if !pre_dispose_counters.is_some_and(valid_pre_dispose_counters) {
            errors.push("pre-dispose-counter-baseline-schema-invalid");
        }
    } else if pre_dispose_counters.is_some_and(|counters| !counters.is_null()) {
        errors.push("pre-dispose-counter-baseline-outside-dispose-stages");
    }
    errors
}

fn valid_pre_dispose_counters(value: &Value) -> bool {
    let Some(root) = value.as_object() else {
        return false;
    };
    if root.len() != 2 {
        return false;
    }
    let Some(native_calls) = root.get("nativeCalls").and_then(Value::as_object) else {
        return false;
    };
    if native_calls.is_empty() || native_calls.len() > 32 {
        return false;
    }
    let mut total_native_calls = 0_u64;
    for (name, count) in native_calls {
        let Some(count) = count.as_u64() else {
            return false;
        };
        if name.is_empty() || name.len() > 128 || count > MAX_COUNTER {
            return false;
        }
        total_native_calls = total_native_calls.saturating_add(count);
    }
    if total_native_calls > MAX_COUNTER {
        return false;
    }
    let Some(delivered) = root
        .get("eventSourceDeliveredEvents")
        .and_then(Value::as_object)
    else {
        return false;
    };
    let expected_sources = ["focusEvents", "appState", "contextMenu", "appCatalog"];
    delivered.len() == expected_sources.len()
        && expected_sources.iter().all(|source| {
            delivered
                .get(*source)
                .and_then(Value::as_u64)
                .is_some_and(|count| count <= MAX_COUNTER)
        })
}

fn bounded_positive_counts(value: Option<&Value>, expected: usize) -> bool {
    value.and_then(Value::as_array).is_some_and(|counts| {
        counts.len() == expected && counts.iter().all(bounded_positive_count_value)
    })
}

fn bounded_positive_count(value: Option<&Value>) -> bool {
    value.is_some_and(bounded_positive_count_value)
}

fn bounded_positive_count_value(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|count| (1..=MAX_COUNTER).contains(&count))
}
