use serde_json::Value;

const ROOT_KEYS: &[&str] = &[
    "documentHidden",
    "before",
    "after",
    "rafCallbacks",
    "elapsedMs",
    "timedOut",
];
const FACT_KEYS: &[&str] = &["sidebar", "menus"];
const SIDEBAR_KEYS: &[&str] = &[
    "generalUnique",
    "generalActive",
    "generalColorComparable",
    "generalColorUsesPrimary",
    "shortcutUnique",
    "shortcutInactive",
    "shortcutColorComparable",
    "shortcutColorUsesText",
];
const MENU_KEYS: &[&str] = &[
    "total",
    "body",
    "theme",
    "leave",
    "enter",
    "ownersOpen",
    "visible",
];

pub(super) fn validate_evidence(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, ROOT_KEYS)
        || !value["documentHidden"].is_boolean()
        || !value["timedOut"].is_boolean()
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    validate_facts(&value["before"])?;
    validate_facts(&value["after"])?;

    let callbacks = value["rafCallbacks"]
        .as_u64()
        .filter(|count| *count <= 2)
        .ok_or("settings-input-probe-protocol-rejected")?;
    let elapsed = value["elapsedMs"]
        .as_f64()
        .filter(|elapsed| elapsed.is_finite() && (0.0..=2000.0).contains(elapsed))
        .ok_or("settings-input-probe-protocol-rejected")?;
    let timed_out = value["timedOut"].as_bool() == Some(true);
    if timed_out != (callbacks < 2) {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn validate_facts(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, FACT_KEYS) {
        return Err("settings-input-probe-protocol-rejected");
    }
    validate_sidebar(&value["sidebar"])?;
    validate_menus(&value["menus"])
}

fn validate_sidebar(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, SIDEBAR_KEYS)
        || SIDEBAR_KEYS.iter().any(|key| !value[*key].is_boolean())
        || (value["generalColorUsesPrimary"].as_bool() == Some(true)
            && value["generalColorComparable"].as_bool() != Some(true))
        || (value["shortcutColorUsesText"].as_bool() == Some(true)
            && value["shortcutColorComparable"].as_bool() != Some(true))
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn validate_menus(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, MENU_KEYS) {
        return Err("settings-input-probe-protocol-rejected");
    }
    let mut counts = [0_u64; MENU_KEYS.len()];
    for (index, key) in MENU_KEYS.iter().enumerate() {
        counts[index] = value[*key]
            .as_u64()
            .ok_or("settings-input-probe-protocol-rejected")?;
        if counts[index] > 64 {
            return Err("settings-input-paint-diagnostic-count-overflow");
        }
    }
    if counts[1] + counts[2] > counts[0]
        || counts[3] > counts[0]
        || counts[4] > counts[0]
        || counts[6] > counts[0]
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

#[cfg(test)]
mod tests {
    use super::validate_evidence;
    use serde_json::{json, Value};

    fn evidence() -> Value {
        json!({
            "documentHidden": true,
            "before": {
                "sidebar": {
                    "generalUnique": true,
                    "generalActive": true,
                    "generalColorComparable": true,
                    "generalColorUsesPrimary": true,
                    "shortcutUnique": true,
                    "shortcutInactive": true,
                    "shortcutColorComparable": true,
                    "shortcutColorUsesText": true
                },
                "menus": {
                    "total": 1,
                    "body": 0,
                    "theme": 1,
                    "leave": 0,
                    "enter": 0,
                    "ownersOpen": 0,
                    "visible": 0
                }
            },
            "after": {
                "sidebar": {
                    "generalUnique": true,
                    "generalActive": true,
                    "generalColorComparable": true,
                    "generalColorUsesPrimary": true,
                    "shortcutUnique": true,
                    "shortcutInactive": true,
                    "shortcutColorComparable": true,
                    "shortcutColorUsesText": true
                },
                "menus": {
                    "total": 0,
                    "body": 0,
                    "theme": 0,
                    "leave": 0,
                    "enter": 0,
                    "ownersOpen": 0,
                    "visible": 0
                }
            },
            "rafCallbacks": 0,
            "elapsedMs": 1000,
            "timedOut": true
        })
    }

    #[test]
    fn accepts_bounded_fixed_shape_diagnostic() {
        assert_eq!(validate_evidence(&evidence()), Ok(()));
    }

    #[test]
    fn rejects_menu_count_overflow_with_fixed_error() {
        let mut value = evidence();
        value["before"]["menus"]["total"] = json!(65);
        assert_eq!(
            validate_evidence(&value),
            Err("settings-input-paint-diagnostic-count-overflow")
        );
    }

    #[test]
    fn rejects_unknown_fields_and_inconsistent_frame_count() {
        let mut extra = evidence();
        extra["before"]["rawText"] = json!(true);
        assert!(validate_evidence(&extra).is_err());

        let mut frames = evidence();
        frames["rafCallbacks"] = json!(2);
        assert!(validate_evidence(&frames).is_err());
    }
}
