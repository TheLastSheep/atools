use super::window_facts::exact_keys;
use serde_json::Value;

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    match operation {
        "childGeneralPoliciesAutoBackInspect" | "childGeneralPoliciesAutoBackSelect" => {
            return caller.starts_with("ztools-settings-");
        }
        "mainGeneralPoliciesAutoBackInspect" => return caller == "main",
        _ => {}
    }
    matches!(
        operation,
        "childGeneralPoliciesInspect"
            | "childGeneralPoliciesSelectStrategy"
            | "childGeneralPoliciesSetRetention"
            | "childGeneralPoliciesResetRetention"
    ) && caller.starts_with("ztools-settings-")
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    match operation {
        "childGeneralPoliciesAutoBackInspect" => {
            return Some(validate_auto_back_child(value, false));
        }
        "childGeneralPoliciesAutoBackSelect" => {
            return Some(validate_auto_back_child(value, true));
        }
        "mainGeneralPoliciesAutoBackInspect" => {
            return Some(validate_auto_back_main(value));
        }
        _ => {}
    }
    const BASE: &[&str] = &[
        "routeGeneral",
        "strategyControlUnique",
        "uiStrategy",
        "storedStrategy",
        "retentionControlUnique",
        "uiDays",
        "storedDays",
        "resetButtonUnique",
        "documentHidden",
        "documentHasFocus",
    ];
    let extra: &[&str] = match operation {
        "childGeneralPoliciesInspect" => &[],
        "childGeneralPoliciesSelectStrategy" => &["selectionDispatched"],
        "childGeneralPoliciesSetRetention" => {
            &["inputDispatched", "changeDispatched", "blurDispatched"]
        }
        "childGeneralPoliciesResetRetention" => &["resetDispatched"],
        _ => return None,
    };
    let mut keys = BASE.to_vec();
    keys.extend(extra);
    if !exact_keys(value, &keys)
        || [
            "routeGeneral",
            "strategyControlUnique",
            "retentionControlUnique",
            "resetButtonUnique",
        ]
        .iter()
        .any(|key| !value[*key].is_boolean())
        || !super::window_facts::valid_strategy_value(&value["uiStrategy"])
        || !super::window_facts::valid_strategy_value(&value["storedStrategy"])
        || !super::clipboard_facts::valid_days_or_null(&value["uiDays"], true)
        || !super::clipboard_facts::valid_days_or_null(&value["storedDays"], true)
        || ["documentHidden", "documentHasFocus"]
            .iter()
            .any(|key| !value[*key].is_null() && !value[*key].is_boolean())
        || extra.iter().any(|key| !value[*key].is_boolean())
    {
        return Some(Err("settings-input-probe-protocol-rejected"));
    }
    Some(Ok(()))
}

fn validate_auto_back_child(value: &Value, selection: bool) -> Result<(), &'static str> {
    const BASE: &[&str] = &[
        "routeGeneral",
        "controlUnique",
        "uiValue",
        "dbValue",
        "documentHidden",
        "documentHasFocus",
    ];
    let mut keys = BASE.to_vec();
    if selection {
        keys.push("selectionDispatched");
        keys.push("optionSetValid");
    }
    if !exact_keys(value, &keys)
        || !value["routeGeneral"].is_boolean()
        || !value["controlUnique"].is_boolean()
        || !valid_auto_back_or_null(&value["uiValue"])
        || !valid_auto_back_or_null(&value["dbValue"])
        || ["documentHidden", "documentHasFocus"]
            .iter()
            .any(|key| !value[*key].is_null() && !value[*key].is_boolean())
        || selection
            && (!value["selectionDispatched"].is_boolean() || !value["optionSetValid"].is_boolean())
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn validate_auto_back_main(value: &Value) -> Result<(), &'static str> {
    const KEYS: &[&str] = &[
        "inputFound",
        "queryEmpty",
        "pluginDomPresent",
        "searchDomPresent",
        "documentHidden",
        "documentHasFocus",
    ];
    if !exact_keys(value, KEYS)
        || [
            "inputFound",
            "queryEmpty",
            "pluginDomPresent",
            "searchDomPresent",
        ]
        .iter()
        .any(|key| !value[*key].is_boolean())
        || ["documentHidden", "documentHasFocus"]
            .iter()
            .any(|key| !value[*key].is_null() && !value[*key].is_boolean())
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn valid_auto_back_or_null(value: &Value) -> bool {
    value.is_null()
        || value.as_str().is_some_and(|value| {
            matches!(
                value,
                "immediately" | "30s" | "1m" | "3m" | "5m" | "10m" | "never"
            )
        })
}

#[cfg(test)]
mod tests {
    use super::{valid_operation, validate_probe_evidence};
    use serde_json::json;

    fn child_facts() -> serde_json::Value {
        json!({
            "routeGeneral": true,
            "controlUnique": true,
            "uiValue": "30s",
            "dbValue": "30s",
            "documentHidden": true,
            "documentHasFocus": false,
        })
    }

    #[test]
    fn auto_back_operations_are_bound_to_main_or_owned_settings_child() {
        assert!(valid_operation(
            "childGeneralPoliciesAutoBackInspect",
            "ztools-settings-0123456789abcdef0123456789abcdef"
        ));
        assert!(!valid_operation(
            "childGeneralPoliciesAutoBackInspect",
            "main"
        ));
        assert!(valid_operation(
            "mainGeneralPoliciesAutoBackInspect",
            "main"
        ));
        assert!(!valid_operation(
            "mainGeneralPoliciesAutoBackInspect",
            "ztools-settings-0123456789abcdef0123456789abcdef"
        ));
    }

    #[test]
    fn auto_back_child_evidence_is_exact_and_strictly_typed() {
        assert_eq!(
            validate_probe_evidence("childGeneralPoliciesAutoBackInspect", &child_facts()),
            Some(Ok(()))
        );
        let mut selected = child_facts();
        selected["selectionDispatched"] = json!(true);
        selected["optionSetValid"] = json!(true);
        assert_eq!(
            validate_probe_evidence("childGeneralPoliciesAutoBackSelect", &selected),
            Some(Ok(()))
        );

        let mut invalid_enum = child_facts();
        invalid_enum["dbValue"] = json!("2m");
        assert!(
            validate_probe_evidence("childGeneralPoliciesAutoBackInspect", &invalid_enum)
                .unwrap()
                .is_err()
        );
        let mut extra = child_facts();
        extra["rawSetting"] = json!("must not cross the probe boundary");
        assert!(
            validate_probe_evidence("childGeneralPoliciesAutoBackInspect", &extra)
                .unwrap()
                .is_err()
        );
        assert!(
            validate_probe_evidence("childGeneralPoliciesAutoBackSelect", &child_facts())
                .unwrap()
                .is_err()
        );
    }

    #[test]
    fn auto_back_main_facts_require_dom_and_query_booleans() {
        let facts = json!({
            "inputFound": true,
            "queryEmpty": false,
            "pluginDomPresent": true,
            "searchDomPresent": false,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        assert_eq!(
            validate_probe_evidence("mainGeneralPoliciesAutoBackInspect", &facts),
            Some(Ok(()))
        );
        let mut unknown = facts.clone();
        unknown["queryEmpty"] = json!(null);
        assert!(
            validate_probe_evidence("mainGeneralPoliciesAutoBackInspect", &unknown)
                .unwrap()
                .is_err()
        );
    }
}
