use serde_json::Value;

pub(super) fn valid_operation(operation: &str, generation: u8, caller: &str) -> bool {
    if super::preference_schema::handles(operation) {
        return super::preference_schema::valid_operation(operation, generation, caller);
    }
    match operation {
        "entryButton" | "exitButton" => generation == 1 && caller == "main",
        "entryKeyboard" => generation == 2 && caller == "main",
        "childInitial" => generation == 1 && caller.starts_with("ztools-settings-"),
        "childSave" => generation == 1 && caller.starts_with("ztools-settings-"),
        "childReopen" => generation == 2 && caller.starts_with("ztools-settings-"),
        "childEscapeWitness" => generation == 2 && caller.starts_with("ztools-settings-"),
        "afterEscapeExit" => generation == 2 && caller == "main",
        _ => false,
    }
}

pub(super) fn validate_evidence(
    operation: &str,
    generation: u8,
    evidence: &Value,
) -> Result<(), &'static str> {
    if super::preference_schema::handles(operation) {
        return super::preference_schema::validate_evidence(operation, generation, evidence);
    }
    let fields: &[&str] = match operation {
        "entryButton" => &[
            "mainPluginMode",
            "buttonLocated",
            "buttonClicked",
            "openCallObserved",
            "placeholderNotificationCount",
        ],
        "entryKeyboard" => &[
            "mainPluginMode",
            "inputLocated",
            "eventDispatched",
            "defaultPrevented",
            "syntheticDom",
            "openCallObserved",
        ],
        "childInitial" => &[
            "domMounted",
            "inputFound",
            "placeholderMatches",
            "notIframe",
            "platform",
            "nativeReady",
            "launchAtLoginAvailable",
            "opacityApplied",
            "themeApplied",
            "projectionFieldCount",
            "secretsAbsent",
            "readGeneralSucceeded",
            "genericAppDenied",
            "coreDenied",
            "coreDenialDiagnostic",
            "unlistedResourceDenied",
            "documentIdentity",
            "sessionIdentity",
        ],
        "childSave" => &[
            "inputChanged",
            "saveAcknowledged",
            "projectionPersisted",
            "projectionFieldCount",
        ],
        "childReopen" => &[
            "domMounted",
            "inputFound",
            "placeholderMatches",
            "notIframe",
            "platform",
            "nativeReady",
            "launchAtLoginAvailable",
            "opacityApplied",
            "themeApplied",
            "projectionFieldCount",
            "secretsAbsent",
            "readGeneralSucceeded",
            "genericAppDenied",
            "coreDenied",
            "coreDenialDiagnostic",
            "unlistedResourceDenied",
            "staleSessionRejected",
            "documentIdentity",
            "sessionIdentity",
        ],
        "exitButton" => &[
            "buttonLocated",
            "buttonClicked",
            "searchQueryEmpty",
            "searchFocused",
            "visiblePlaceholderMatches",
            "placeholderNotificationCount",
            "closedPhaseObserved",
        ],
        "childEscapeWitness" => &[
            "escapeEventDispatched",
            "captureListenerObserved",
            "bubbles",
            "cancelable",
        ],
        "afterEscapeExit" => &["searchQueryEmpty", "searchFocused", "backToSearchObserved"],
        _ => return Err("settings-journey-probe-operation-rejected"),
    };
    if !valid_operation(
        operation,
        generation,
        if operation.starts_with("child") {
            "ztools-settings-child"
        } else {
            "main"
        },
    ) && !matches!(operation, "exitButton" | "afterEscapeExit")
    {
        return Err("settings-journey-probe-generation-rejected");
    }
    let object = evidence
        .as_object()
        .ok_or("settings-journey-probe-evidence-shape-rejected")?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err("settings-journey-probe-evidence-fields-rejected");
    }
    for field in fields {
        let value = &evidence[*field];
        if *field == "platform" {
            if value.as_str() != Some("darwin") {
                return Err("settings-journey-probe-platform-rejected");
            }
        } else if *field == "documentIdentity" {
            if value
                .as_str()
                .is_none_or(|identity| identity.is_empty() || identity.len() > 64)
            {
                return Err("settings-journey-probe-document-identity-rejected");
            }
        } else if *field == "sessionIdentity" {
            if value
                .as_str()
                .is_none_or(|identity| identity.is_empty() || identity.len() > 64)
            {
                return Err("settings-journey-probe-session-identity-rejected");
            }
        } else if *field == "projectionFieldCount" {
            if value.as_u64().is_none_or(|count| count > 64) {
                return Err("settings-journey-probe-projection-count-rejected");
            }
        } else if *field == "placeholderNotificationCount" {
            if value.as_u64().is_none_or(|count| count > 128) {
                return Err("settings-journey-probe-notification-count-rejected");
            }
        } else if *field == "coreDenialDiagnostic" {
            if value
                .as_str()
                .is_none_or(|diagnostic| diagnostic.len() > 4096)
            {
                return Err("settings-journey-probe-core-diagnostic-rejected");
            }
        } else if !value.is_boolean() {
            return Err("settings-journey-probe-boolean-rejected");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::validate_evidence;
    use serde_json::{json, Value};

    fn child_initial_evidence(diagnostic: Value) -> Value {
        json!({
            "domMounted": true,
            "inputFound": true,
            "placeholderMatches": true,
            "notIframe": true,
            "platform": "darwin",
            "nativeReady": true,
            "launchAtLoginAvailable": true,
            "opacityApplied": true,
            "themeApplied": true,
            "projectionFieldCount": 43,
            "secretsAbsent": true,
            "readGeneralSucceeded": true,
            "genericAppDenied": true,
            "coreDenied": false,
            "coreDenialDiagnostic": diagnostic,
            "unlistedResourceDenied": true,
            "documentIdentity": "fixture-document",
            "sessionIdentity": "11111111111111111111111111111111"
        })
    }

    #[test]
    fn core_denial_diagnostic_is_only_a_bounded_string() {
        let exact_limit = child_initial_evidence(json!("é".repeat(2048)));
        assert_eq!(validate_evidence("childInitial", 1, &exact_limit), Ok(()));

        let oversized = child_initial_evidence(json!("é".repeat(2048) + "a"));
        assert_eq!(
            validate_evidence("childInitial", 1, &oversized),
            Err("settings-journey-probe-core-diagnostic-rejected")
        );

        let non_string = child_initial_evidence(json!({"message": "must not be copied"}));
        assert_eq!(
            validate_evidence("childInitial", 1, &non_string),
            Err("settings-journey-probe-core-diagnostic-rejected")
        );
    }
}
