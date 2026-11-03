use super::window_facts::{exact_keys, nullable_bool, nullable_count};
use serde_json::{json, Value};

const CLIPBOARD_KEYS: &[&str] = &[
    "initialUiDays",
    "initialStoredDays",
    "at30",
    "at1",
    "afterReset180",
    "finalUiDays",
    "finalStoredDays",
];
const RETENTION_KEYS: &[&str] = &[
    "uiDays",
    "storedDays",
    "resetDispatched",
    "beforeCapture",
    "captureSucceeded",
    "afterCapture",
];
const RESET_KEYS: &[&str] = &[
    "uiDays",
    "storedDays",
    "resetDispatched",
    "beforeReset",
    "afterReset",
    "beforeCapture",
    "captureSucceeded",
    "afterCapture",
];
const SNAPSHOT_KEYS: &[&str] = &[
    "pasteboardCount",
    "legacyCount",
    "expiredUnpinnedPresent",
    "recentUnpinnedPresent",
    "expiredPinnedPresent",
    "legacyExpiredPresent",
    "legacyRecentPresent",
    "reset100DayPresent",
    "legacyReset100DayPresent",
];
pub(super) fn empty_clipboard() -> Value {
    json!({
        "initialUiDays": null, "initialStoredDays": null,
        "at30": empty_retention(), "at1": empty_retention(),
        "afterReset180": {
            "uiDays": null, "storedDays": null, "resetDispatched": null,
            "beforeReset": empty_snapshot(), "afterReset": empty_snapshot(),
            "beforeCapture": empty_snapshot(), "captureSucceeded": null, "afterCapture": empty_snapshot(),
        },
        "finalUiDays": null, "finalStoredDays": null,
    })
}

fn empty_retention() -> Value {
    json!({"uiDays": null, "storedDays": null, "resetDispatched": null,
        "beforeCapture": empty_snapshot(), "captureSucceeded": null, "afterCapture": empty_snapshot()})
}

fn empty_snapshot() -> Value {
    json!({"pasteboardCount": null, "legacyCount": null,
        "expiredUnpinnedPresent": null, "recentUnpinnedPresent": null, "expiredPinnedPresent": null,
        "legacyExpiredPresent": null, "legacyRecentPresent": null,
        "reset100DayPresent": null, "legacyReset100DayPresent": null})
}

pub(super) fn valid_clipboard(value: &Value) -> bool {
    exact_keys(value, CLIPBOARD_KEYS)
        && valid_days_or_null(&value["initialUiDays"], true)
        && valid_days_or_null(&value["initialStoredDays"], true)
        && valid_retention(&value["at30"])
        && valid_retention(&value["at1"])
        && exact_keys(&value["afterReset180"], RESET_KEYS)
        && valid_days_or_null(&value["afterReset180"]["uiDays"], true)
        && valid_days_or_null(&value["afterReset180"]["storedDays"], true)
        && nullable_bool(&value["afterReset180"]["resetDispatched"])
        && ["beforeReset", "afterReset", "beforeCapture", "afterCapture"]
            .iter()
            .all(|key| valid_snapshot(&value["afterReset180"][*key]))
        && nullable_bool(&value["afterReset180"]["captureSucceeded"])
        && valid_days_or_null(&value["finalUiDays"], true)
        && valid_days_or_null(&value["finalStoredDays"], true)
}

fn valid_retention(value: &Value) -> bool {
    exact_keys(value, RETENTION_KEYS)
        && valid_days_or_null(&value["uiDays"], true)
        && valid_days_or_null(&value["storedDays"], true)
        && nullable_bool(&value["resetDispatched"])
        && valid_snapshot(&value["beforeCapture"])
        && nullable_bool(&value["captureSucceeded"])
        && valid_snapshot(&value["afterCapture"])
}

fn valid_snapshot(value: &Value) -> bool {
    exact_keys(value, SNAPSHOT_KEYS)
        && ["pasteboardCount", "legacyCount"]
            .iter()
            .all(|key| nullable_count(&value[*key]))
        && SNAPSHOT_KEYS[2..]
            .iter()
            .all(|key| nullable_bool(&value[*key]))
}

pub(super) fn valid_days_or_null(value: &Value, allow_null: bool) -> bool {
    value.is_null() && allow_null
        || value
            .as_u64()
            .is_some_and(|days| (1..=3650).contains(&days))
}

#[cfg(test)]
mod tests {
    use super::{empty_clipboard, valid_clipboard};
    use serde_json::{json, Value};

    #[test]
    fn partial_capture_failure_preserves_nested_snapshot_shapes() {
        let mut facts = empty_clipboard();
        facts["at30"]["uiDays"] = json!(30);
        facts["at30"]["storedDays"] = json!(30);
        facts["at30"]["resetDispatched"] = Value::Bool(false);
        assert!(
            valid_clipboard(&facts),
            "an unobserved capture remains null-shaped"
        );

        facts["at30"]["afterCapture"] = Value::Null;
        assert!(
            !valid_clipboard(&facts),
            "replacing the exact nullable snapshot with null loses failure diagnostics"
        );

        let mut reset = empty_clipboard();
        reset["afterReset180"]["uiDays"] = json!(180);
        reset["afterReset180"]["storedDays"] = json!(180);
        reset["afterReset180"]["resetDispatched"] = Value::Bool(true);
        reset["afterReset180"]["beforeReset"]["pasteboardCount"] = json!(3);
        assert!(
            valid_clipboard(&reset),
            "an interrupted reset report retains known facts"
        );
    }
}
