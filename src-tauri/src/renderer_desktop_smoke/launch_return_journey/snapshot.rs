use serde_json::Value;

pub(super) fn valid_dom(dom: &Value) -> bool {
    if !exact_keys(
        dom,
        &[
            "inputValue",
            "pastedText",
            "selectedTitle",
            "visibility",
            "documentHasFocus",
            "inputFocused",
            "actions",
            "adapter",
        ],
    ) {
        return false;
    }
    if !nullable_text(dom.get("inputValue"), 256)
        || !nullable_text(dom.get("pastedText"), 4096)
        || !nullable_text(dom.get("selectedTitle"), 256)
        || !nullable_text(dom.get("visibility"), 16)
        || !nullable_bool(dom.get("documentHasFocus"))
        || !nullable_bool(dom.get("inputFocused"))
    {
        return false;
    }
    let actions = dom.get("actions");
    if !exact_keys(
        actions.unwrap_or(&Value::Null),
        &[
            "metaFDefaultPrevented",
            "launchRejected",
            "launchResolved",
            "arrowDownDefaultPrevented",
            "enterDefaultPrevented",
        ],
    ) || ![
        "metaFDefaultPrevented",
        "launchRejected",
        "launchResolved",
        "arrowDownDefaultPrevented",
        "enterDefaultPrevented",
    ]
    .iter()
    .all(|key| nullable_bool(actions.and_then(|value| value.get(*key))))
    {
        return false;
    }
    let Some(adapter) = dom.get("adapter") else {
        return false;
    };
    if !exact_keys(
        adapter,
        &[
            "launchCalls",
            "outstandingNativeCalls",
            "listeners",
            "windowDrag",
        ],
    ) || !nullable_u64(adapter.get("launchCalls"))
        || !nullable_u64(adapter.get("outstandingNativeCalls"))
        || !valid_listeners(adapter.get("listeners"))
        || !valid_window_drag(adapter.get("windowDrag"))
    {
        return false;
    }
    true
}

fn valid_listeners(value: Option<&Value>) -> bool {
    let Some(value) = value else { return false };
    let keys = [
        "focusEvents",
        "appState",
        "appCatalog",
        "appLaunched",
        "contextMenu",
        "settingsView",
        "generalPreferenceEvents",
        "localShortcutEvents",
    ];
    exact_keys(value, &keys)
        && valid_focus(value.get("focusEvents"))
        && valid_app_state(value.get("appState"))
        && valid_app_catalog(value.get("appCatalog"))
        && valid_app_launched(value.get("appLaunched"))
        && valid_context_menu(value.get("contextMenu"))
        && valid_settings_view(value.get("settingsView"))
        && valid_general_preferences(value.get("generalPreferenceEvents"))
        && valid_local_shortcut_events(value.get("localShortcutEvents"))
}

fn valid_local_shortcut_events(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(
        value,
        &[
            "subscribers",
            "listenerState",
            "deliveredEvents",
            "registrationErrors",
            "callbackErrors",
            "registrationsPending",
            "lateListenerUnlistens",
            "cleanupPending",
            "cleanupErrors",
            "invalidEvents",
            "staleEvents",
            "latestRevision",
            "replayPending",
        ],
    ) && valid_event_source_fields(value)
        && value.get("invalidEvents").and_then(Value::as_u64).is_some()
        && value.get("staleEvents").and_then(Value::as_u64).is_some()
        && nullable_u64(value.get("latestRevision"))
        && value
            .get("replayPending")
            .and_then(Value::as_bool)
            .is_some()
}

fn valid_focus(value: Option<&Value>) -> bool {
    exact_keys(
        value.unwrap_or(&Value::Null),
        &[
            "subscribers",
            "listenerState",
            "deliveredEvents",
            "registrationErrors",
            "callbackErrors",
            "registrationsPending",
            "lateListenerUnlistens",
            "cleanupPending",
            "cleanupErrors",
            "windowContextAvailable",
        ],
    ) && valid_event_source_fields(value.unwrap_or(&Value::Null))
        && value
            .and_then(|value| value.get("windowContextAvailable"))
            .and_then(Value::as_bool)
            == Some(false)
}

fn valid_app_state(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(
        value,
        &[
            "version",
            "revision",
            "historySubscribers",
            "pinnedSubscribers",
            "listenerState",
            "eventSource",
            "queuedMutations",
            "acceptedReplies",
            "acceptedEvents",
            "stalePayloads",
            "invalidPayloads",
            "mutationFailures",
            "applyErrors",
            "callbackErrors",
            "disposed",
        ],
    ) && value.get("version").and_then(Value::as_u64) == Some(1)
        && valid_event_source(value.get("eventSource"))
}

fn valid_app_catalog(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(
        value,
        &["cachedApps", "readPending", "invalidations", "eventSource"],
    ) && valid_event_source(value.get("eventSource"))
}

fn valid_app_launched(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(value, &["invalidPayloads", "eventSource"])
        && valid_event_source(value.get("eventSource"))
}

fn valid_context_menu(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(
        value,
        &[
            "version",
            "subscribers",
            "showInFlight",
            "whitelistedCommands",
            "showRequests",
            "showFailures",
            "acceptedCommands",
            "ignoredEvents",
            "invalidEvents",
            "callbackErrors",
            "eventSource",
            "disposed",
        ],
    ) && value.get("version").and_then(Value::as_u64) == Some(1)
        && valid_event_source(value.get("eventSource"))
}

fn valid_settings_view(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(
        value,
        &[
            "version",
            "listenerState",
            "activePhase",
            "input",
            "pendingOpen",
            "openFailures",
            "closeFailures",
            "invalidPayloads",
            "registrationErrors",
            "lateListenerUnlistens",
            "cleanupErrors",
        ],
    ) && value.get("version").and_then(Value::as_u64) == Some(1)
        && valid_settings_input(value.get("input"))
}

fn valid_settings_input(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    let number_fields = [
        "callbacks",
        "invalidPayloads",
        "stalePayloads",
        "callbackErrors",
        "notifyFailures",
        "staleReplies",
    ];
    let boolean_fields = ["notifyPending", "notifyInFlight", "disposed"];
    exact_keys(
        value,
        &[
            "callbacks",
            "invalidPayloads",
            "stalePayloads",
            "callbackErrors",
            "notifyFailures",
            "staleReplies",
            "notifyPending",
            "notifyInFlight",
            "disposed",
        ],
    ) && number_fields
        .iter()
        .all(|key| value.get(*key).and_then(Value::as_u64).is_some())
        && boolean_fields
            .iter()
            .all(|key| value.get(*key).and_then(Value::as_bool).is_some())
}

fn valid_general_preferences(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(value, &["version", "invalidPayloads", "notifiedFields"])
        && value.get("version").and_then(Value::as_u64) == Some(1)
        && exact_keys(
            value.get("notifiedFields").unwrap_or(&Value::Null),
            &["placeholder"],
        )
}

fn valid_event_source(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(
        value,
        &[
            "subscribers",
            "listenerState",
            "deliveredEvents",
            "registrationErrors",
            "callbackErrors",
            "registrationsPending",
            "lateListenerUnlistens",
            "cleanupPending",
            "cleanupErrors",
        ],
    ) && valid_event_source_fields(value)
}

fn valid_event_source_fields(value: &Value) -> bool {
    [
        "subscribers",
        "deliveredEvents",
        "registrationErrors",
        "callbackErrors",
        "registrationsPending",
        "lateListenerUnlistens",
        "cleanupPending",
        "cleanupErrors",
    ]
    .iter()
    .all(|key| value.get(*key).and_then(Value::as_u64).is_some())
        && value.get("listenerState").and_then(Value::as_str).is_some()
}

fn valid_window_drag(value: Option<&Value>) -> bool {
    let value = value.unwrap_or(&Value::Null);
    exact_keys(
        value,
        &[
            "disposed",
            "pending",
            "queued",
            "inFlight",
            "pendingPositionReads",
            "queuedMoves",
            "queuedLocks",
            "positionReads",
            "moveRequests",
            "lockRequests",
            "dispatchedPositions",
            "dispatchedMoves",
            "dispatchedLocks",
            "coalescedMoves",
            "rejectedOperations",
            "failures",
            "cancelledReads",
            "droppedAfterDispose",
        ],
    ) && [
        "pending",
        "queued",
        "pendingPositionReads",
        "queuedMoves",
        "queuedLocks",
        "positionReads",
        "moveRequests",
        "lockRequests",
        "dispatchedPositions",
        "dispatchedMoves",
        "dispatchedLocks",
        "coalescedMoves",
        "rejectedOperations",
        "failures",
        "cancelledReads",
        "droppedAfterDispose",
    ]
    .iter()
    .all(|key| value.get(*key).and_then(Value::as_u64).is_some())
        && value.get("disposed").and_then(Value::as_bool).is_some()
        && value
            .get("inFlight")
            .is_some_and(|entry| entry.is_null() || entry.as_str().is_some())
}

fn nullable_text(value: Option<&Value>, max: usize) -> bool {
    value.is_some_and(|value| {
        value.is_null() || value.as_str().is_some_and(|text| text.len() <= max)
    })
}

fn nullable_bool(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.is_null() || value.as_bool().is_some())
}

fn nullable_u64(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value.is_null() || value.as_u64().is_some())
}

fn exact_keys(value: &Value, required: &[&str]) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.len() == required.len() && required.iter().all(|key| object.contains_key(*key))
}

#[cfg(test)]
mod tests {
    use super::valid_local_shortcut_events;
    use serde_json::json;

    fn event_snapshot() -> serde_json::Value {
        json!({
            "subscribers": 1,
            "listenerState": "listening",
            "deliveredEvents": 0,
            "registrationErrors": 0,
            "callbackErrors": 0,
            "registrationsPending": 0,
            "lateListenerUnlistens": 0,
            "cleanupPending": 0,
            "cleanupErrors": 0,
            "invalidEvents": 0,
            "staleEvents": 0,
            "latestRevision": null,
            "replayPending": false
        })
    }

    #[test]
    fn local_shortcut_snapshot_accepts_exact_valid_shape() {
        assert!(valid_local_shortcut_events(Some(&event_snapshot())));
    }

    #[test]
    fn local_shortcut_snapshot_rejects_invalid_revision_and_extra_fields() {
        let mut invalid_revision = event_snapshot();
        invalid_revision["latestRevision"] = json!("2");
        assert!(!valid_local_shortcut_events(Some(&invalid_revision)));

        let mut extra = event_snapshot();
        extra["unknown"] = json!(true);
        assert!(!valid_local_shortcut_events(Some(&extra)));
    }
}

#[cfg(test)]
#[path = "snapshot_settings_input_tests.rs"]
mod settings_input_tests;
