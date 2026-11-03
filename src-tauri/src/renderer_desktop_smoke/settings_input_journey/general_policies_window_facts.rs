use serde_json::{json, Value};

const UI_KEYS: &[&str] = &[
    "initialUiStrategy",
    "initialStoredStrategy",
    "cursor",
    "primary",
    "lastActive",
    "remember",
    "reopened",
    "restored",
    "unrelatedSettingsPreserved",
];
const SELECTION_KEYS: &[&str] = &["uiSelected", "storedStrategy"];
const REOPEN_KEYS: &[&str] = &["freshSession", "uiStrategy", "storedStrategy"];
const RESTORED_KEYS: &[&str] = &["uiStrategy", "storedStrategy"];
const GEOMETRY_KEYS: &[&str] = &["cursor", "primary", "lastActiveFallback", "remember"];
const SAFETY_KEYS: &[&str] = &["phases", "focusEventsBefore", "focusEventsAfter"];
const SAFETY_FACT_KEYS: &[&str] = &["visible", "focused"];
const SAMPLE_KEYS: &[&str] = &["cursor", "monitor", "window"];
const MONITOR_KEYS: &[&str] = &[
    "x",
    "y",
    "width",
    "height",
    "workX",
    "workY",
    "workWidth",
    "workHeight",
    "scaleFactor",
    "isPrimary",
];
const WINDOW_KEYS: &[&str] = &["x", "y", "width", "height"];
const REMEMBER_KEYS: &[&str] = &["monitor", "windowSize", "saved", "moved", "restored"];
const SIZE_KEYS: &[&str] = &["width", "height"];
const POINT_KEYS: &[&str] = &["x", "y"];
const STRATEGIES: &[&str] = &["remember", "cursor", "primary", "lastActive"];

pub(super) fn empty_window_ui() -> Value {
    json!({
        "initialUiStrategy": null, "initialStoredStrategy": null,
        "cursor": {"uiSelected": null, "storedStrategy": null},
        "primary": {"uiSelected": null, "storedStrategy": null},
        "lastActive": {"uiSelected": null, "storedStrategy": null},
        "remember": {"uiSelected": null, "storedStrategy": null},
        "reopened": {"freshSession": null, "uiStrategy": null, "storedStrategy": null},
        "restored": {"uiStrategy": null, "storedStrategy": null},
        "unrelatedSettingsPreserved": null,
    })
}

pub(super) fn empty_geometry() -> Value {
    json!({
        "cursor": empty_position_sample(), "primary": empty_position_sample(),
        "lastActiveFallback": {
            "externalWindowAvailable": null, "position": empty_position_sample(),
        },
        "remember": {
            "monitor": empty_monitor(), "windowSize": {"width": null, "height": null},
            "saved": {"x": null, "y": null}, "moved": {"x": null, "y": null},
            "restored": {"x": null, "y": null},
        },
    })
}

pub(super) fn empty_safety() -> Value {
    let phases = super::PHASES
        .iter()
        .map(|phase| {
            (
                (*phase).to_owned(),
                json!({"visible": null, "focused": null}),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    json!({"phases": phases, "focusEventsBefore": null, "focusEventsAfter": null})
}

fn empty_position_sample() -> Value {
    json!({"cursor": {"x": null, "y": null}, "monitor": empty_monitor(),
        "window": {"x": null, "y": null, "width": null, "height": null}})
}

fn empty_monitor() -> Value {
    json!({"x": null, "y": null, "width": null, "height": null,
        "workX": null, "workY": null, "workWidth": null, "workHeight": null,
        "scaleFactor": null, "isPrimary": null})
}

pub(super) fn valid_window_ui(value: &Value) -> bool {
    exact_keys(value, UI_KEYS)
        && valid_strategy_or_null(&value["initialUiStrategy"])
        && valid_strategy_or_null(&value["initialStoredStrategy"])
        && ["cursor", "primary", "lastActive", "remember"]
            .iter()
            .all(|key| {
                exact_keys(&value[*key], SELECTION_KEYS)
                    && nullable_bool(&value[*key]["uiSelected"])
                    && valid_strategy_or_null(&value[*key]["storedStrategy"])
            })
        && exact_keys(&value["reopened"], REOPEN_KEYS)
        && nullable_bool(&value["reopened"]["freshSession"])
        && valid_strategy_or_null(&value["reopened"]["uiStrategy"])
        && valid_strategy_or_null(&value["reopened"]["storedStrategy"])
        && exact_keys(&value["restored"], RESTORED_KEYS)
        && valid_strategy_or_null(&value["restored"]["uiStrategy"])
        && valid_strategy_or_null(&value["restored"]["storedStrategy"])
        && nullable_bool(&value["unrelatedSettingsPreserved"])
}

pub(super) fn valid_geometry(value: &Value) -> bool {
    exact_keys(value, GEOMETRY_KEYS)
        && ["cursor", "primary", "lastActiveFallback"]
            .iter()
            .all(|key| {
                if *key == "lastActiveFallback" {
                    exact_keys(&value[*key], &["externalWindowAvailable", "position"])
                        && nullable_bool(&value[*key]["externalWindowAvailable"])
                        && valid_position_sample(&value[*key]["position"])
                } else {
                    valid_position_sample(&value[*key])
                }
            })
        && exact_keys(&value["remember"], REMEMBER_KEYS)
        && valid_monitor(&value["remember"]["monitor"])
        && exact_keys(&value["remember"]["windowSize"], SIZE_KEYS)
        && ["width", "height"]
            .iter()
            .all(|key| nullable_positive(&value["remember"]["windowSize"][*key]))
        && ["saved", "moved", "restored"]
            .iter()
            .all(|key| valid_point(&value["remember"][*key]))
}

fn valid_position_sample(value: &Value) -> bool {
    exact_keys(value, SAMPLE_KEYS)
        && valid_point(&value["cursor"])
        && valid_monitor(&value["monitor"])
        && exact_keys(&value["window"], WINDOW_KEYS)
        && ["x", "y"]
            .iter()
            .all(|key| nullable_i32(&value["window"][*key]))
        && ["width", "height"]
            .iter()
            .all(|key| nullable_positive(&value["window"][*key]))
}

fn valid_monitor(value: &Value) -> bool {
    exact_keys(value, MONITOR_KEYS)
        && ["x", "y", "workX", "workY"]
            .iter()
            .all(|key| nullable_i32(&value[*key]))
        && ["width", "height", "workWidth", "workHeight"]
            .iter()
            .all(|key| nullable_positive(&value[*key]))
        && (value["scaleFactor"].is_null()
            || value["scaleFactor"]
                .as_f64()
                .is_some_and(|scale| scale.is_finite() && scale > 0.0 && scale <= 8.0))
        && nullable_bool(&value["isPrimary"])
}

fn valid_point(value: &Value) -> bool {
    exact_keys(value, POINT_KEYS) && ["x", "y"].iter().all(|key| nullable_i32(&value[*key]))
}

pub(super) fn valid_safety(value: &Value) -> bool {
    exact_keys(value, SAFETY_KEYS)
        && exact_keys(&value["phases"], super::PHASES)
        && super::PHASES.iter().all(|phase| {
            exact_keys(&value["phases"][*phase], SAFETY_FACT_KEYS)
                && SAFETY_FACT_KEYS
                    .iter()
                    .all(|key| nullable_bool(&value["phases"][*phase][*key]))
        })
        && nullable_count(&value["focusEventsBefore"])
        && nullable_count(&value["focusEventsAfter"])
}

pub(super) fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

pub(super) fn nullable_bool(value: &Value) -> bool {
    value.is_null() || value.is_boolean()
}
pub(super) fn nullable_count(value: &Value) -> bool {
    value.is_null() || value.as_u64().is_some_and(|count| count <= 4096)
}
fn nullable_positive(value: &Value) -> bool {
    value.is_null()
        || value
            .as_u64()
            .is_some_and(|number| number > 0 && number <= u32::MAX as u64)
}
fn nullable_i32(value: &Value) -> bool {
    value.is_null()
        || value
            .as_i64()
            .is_some_and(|number| i32::try_from(number).is_ok())
}
fn valid_strategy_or_null(value: &Value) -> bool {
    value.is_null()
        || value
            .as_str()
            .is_some_and(|strategy| STRATEGIES.contains(&strategy))
}
pub(super) fn valid_strategy_value(value: &Value) -> bool {
    valid_strategy_or_null(value)
}
