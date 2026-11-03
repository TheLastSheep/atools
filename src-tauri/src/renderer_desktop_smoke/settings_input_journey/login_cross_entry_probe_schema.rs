use serde_json::Value;

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    matches!(
        operation,
        "fallbackLoginInspect"
            | "fallbackLoginDisable"
            | "fallbackLoginSave"
            | "fallbackLoginConflict"
            | "fallbackLoginReread"
    ) && caller == "settings"
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    match operation {
        "fallbackLoginInspect" => Some(validate_observation(value)),
        "fallbackLoginDisable" | "fallbackLoginConflict" | "fallbackLoginReread" => {
            Some(validate_action(value, false))
        }
        "fallbackLoginSave" => Some(validate_action(value, true)),
        _ => None,
    }
}

pub(super) fn stage_observation(surface: &str, action: Option<&Value>) -> Value {
    let observed = action.and_then(|value| value.get("after")).or(action);
    let mut stage = super::empty_stage(surface);
    if let Some(observed) = observed {
        for key in [
            "ready",
            "controlUnique",
            "enabled",
            "disabled",
            "indeterminate",
            "overviewUnknown",
            "hasConflictMessage",
            "saveState",
        ] {
            if let Some(value) = observed.get(key) {
                stage[key] = value.clone();
            }
        }
        if action.is_some_and(|value| value.get("ok").is_some()) {
            let action = action.expect("checked action value");
            stage["actionDispatched"] = action["dispatched"].clone();
            stage["actionSucceeded"] = Value::Bool(
                action["ok"].as_bool() == Some(true)
                    && action["dispatched"].as_bool() == Some(true)
                    && (action.get("placeholderObserved").is_none()
                        || action["placeholderObserved"].as_bool() == Some(true)),
            );
        }
    }
    stage
}

fn validate_observation(value: &Value) -> Result<(), &'static str> {
    const KEYS: &[&str] = &[
        "ready",
        "controlUnique",
        "enabled",
        "disabled",
        "indeterminate",
        "overviewUnknown",
        "hasConflictMessage",
        "saveState",
    ];
    if !exact_keys(value, KEYS)
        || !nullable_bool(&value["ready"])
        || !nullable_bool(&value["controlUnique"])
        || !nullable_bool(&value["enabled"])
        || !nullable_bool(&value["disabled"])
        || !nullable_bool(&value["indeterminate"])
        || !nullable_bool(&value["overviewUnknown"])
        || !nullable_bool(&value["hasConflictMessage"])
        || !valid_save_state(&value["saveState"])
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn validate_action(value: &Value, with_placeholder: bool) -> Result<(), &'static str> {
    let keys: &[&str] = if with_placeholder {
        &[
            "ok",
            "dispatched",
            "reason",
            "before",
            "after",
            "placeholderObserved",
        ]
    } else {
        &["ok", "dispatched", "reason", "before", "after"]
    };
    if !exact_keys(value, keys)
        || value["ok"].as_bool().is_none()
        || !nullable_bool(&value["dispatched"])
        || !valid_reason(&value["reason"])
        || validate_observation(&value["before"]).is_err()
        || validate_observation(&value["after"]).is_err()
        || (with_placeholder && !nullable_bool(&value["placeholderObserved"]))
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn valid_reason(value: &Value) -> bool {
    value.is_null()
        || matches!(
            value.as_str(),
            Some(
                "control-unavailable"
                    | "control-not-enabled"
                    | "action-not-confirmed"
                    | "native-conflict"
                    | "conflict-not-observed"
                    | "reread-control-unavailable"
                    | "reread-not-confirmed"
                    | "placeholder-control-unavailable"
                    | "save-status-unavailable"
                    | "native-input-setter-unavailable"
                    | "placeholder-save-not-confirmed"
                    | "probe-failed"
            )
        )
}

fn valid_save_state(value: &Value) -> bool {
    value.is_null()
        || matches!(
            value.as_str(),
            Some("idle" | "saved" | "saving" | "error" | "unknown")
        )
}

fn nullable_bool(value: &Value) -> bool {
    value.is_null() || value.is_boolean()
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}
