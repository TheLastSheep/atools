use serde_json::{Map, Value};

pub(super) const PREFERENCE_FIELDS: &[&str] = &[
    "showRecentInSearch",
    "recentRows",
    "pinnedRows",
    "searchMode",
    "showMatchRecommendation",
    "tabKeyFunction",
    "tabTargetCommand",
    "spaceOpenCommand",
];

pub(super) const GENERAL_SAFE_FIELDS: &[&str] = &[
    "placeholder",
    "theme",
    "primaryColor",
    "customColor",
    "autoClear",
    "showRecentInSearch",
    "recentRows",
    "pinnedRows",
    "searchMode",
    "showMatchRecommendation",
    "tabKeyFunction",
    "tabTargetCommand",
    "spaceOpenCommand",
];

const BOOLEAN_FIELDS: &[&str] = &[
    "showRecentInSearch",
    "showMatchRecommendation",
    "spaceOpenCommand",
];

const EDIT_STAGES: &[&str] = &[
    "complete",
    "control-missing",
    "checkbox-event-missing",
    "dropdown-trigger-missing",
    "dropdown-option-missing",
    "dropdown-option-click-missing",
    "text-input-unavailable",
    "text-input-event-missing",
    "control-value-mismatch",
    "native-readback-missing",
    "native-value-mismatch",
    "native-revision-not-advanced",
];

pub(super) fn handles(operation: &str) -> bool {
    matches!(
        operation,
        "childPreferenceEdit"
            | "childPreferenceRejectReadonly"
            | "childPreferenceRejectInvalid"
            | "childPreferencesReopen"
            | "observePreferences"
            | "observeColdStartup"
    )
}

pub(super) fn valid_operation(operation: &str, generation: u8, caller: &str) -> bool {
    let child = caller.starts_with("ztools-settings-");
    match operation {
        "childPreferenceEdit"
        | "childPreferenceRejectReadonly"
        | "childPreferenceRejectInvalid" => generation == 1 && child,
        "childPreferencesReopen" => generation == 2 && child,
        "observePreferences" => generation == 1 && caller == "main",
        "observeColdStartup" => generation == 1 && caller == "main",
        _ => false,
    }
}

pub(super) fn validate_evidence(
    operation: &str,
    generation: u8,
    evidence: &Value,
) -> Result<(), &'static str> {
    let object = evidence
        .as_object()
        .ok_or("settings-preferences-evidence-shape-rejected")?;
    match operation {
        "childPreferenceEdit" => validate_edit(generation, object),
        "childPreferenceRejectReadonly" | "childPreferenceRejectInvalid" => {
            validate_rejection(generation, object)
        }
        "childPreferencesReopen" => validate_reopen(generation, object),
        "observePreferences" => validate_main(generation, object),
        "observeColdStartup" => validate_cold_startup(generation, object),
        _ => Err("settings-preferences-probe-operation-rejected"),
    }
}

fn validate_edit(generation: u8, object: &Map<String, Value>) -> Result<(), &'static str> {
    require_generation(generation, 1)?;
    require_keys(
        object,
        &[
            "field",
            "controlFound",
            "actionObserved",
            "valueChanged",
            "matchesTarget",
            "nativeReadbackMatches",
            "revisionAdvanced",
            "uiValue",
            "stage",
        ],
    )?;
    let field = object["field"]
        .as_str()
        .ok_or("settings-preferences-field-rejected")?;
    if !PREFERENCE_FIELDS.contains(&field) {
        return Err("settings-preferences-field-rejected");
    }
    require_field_value(field, &object["uiValue"], true)?;
    require_booleans(
        object,
        &[
            "controlFound",
            "actionObserved",
            "valueChanged",
            "matchesTarget",
            "nativeReadbackMatches",
            "revisionAdvanced",
        ],
    )?;
    let stage = object["stage"]
        .as_str()
        .filter(|stage| EDIT_STAGES.contains(stage))
        .ok_or("settings-preferences-edit-stage-rejected")?;
    let all_succeeded = [
        "controlFound",
        "actionObserved",
        "valueChanged",
        "matchesTarget",
        "nativeReadbackMatches",
        "revisionAdvanced",
    ]
    .iter()
    .all(|field| object[*field].as_bool() == Some(true));
    if stage == "complete" {
        if !all_succeeded || object["uiValue"].is_null() {
            return Err("settings-preferences-edit-stage-inconsistent");
        }
    } else if all_succeeded {
        return Err("settings-preferences-edit-stage-inconsistent");
    }
    Ok(())
}

fn validate_rejection(generation: u8, object: &Map<String, Value>) -> Result<(), &'static str> {
    require_generation(generation, 1)?;
    require_keys(
        object,
        &[
            "errorCode",
            "revisionBefore",
            "revisionAfter",
            "projectionUnchanged",
            "readSucceeded",
        ],
    )?;
    for field in ["errorCode", "revisionBefore", "revisionAfter"] {
        if object[field]
            .as_str()
            .is_none_or(|value| value.is_empty() || value.len() > 64)
        {
            return Err("settings-preferences-rejection-text-rejected");
        }
    }
    require_booleans(object, &["projectionUnchanged", "readSucceeded"])
}

fn validate_reopen(generation: u8, object: &Map<String, Value>) -> Result<(), &'static str> {
    require_generation(generation, 2)?;
    require_keys(
        object,
        &[
            "nativeReadSucceeded",
            "controlFound",
            "controlValues",
            "nativeValues",
        ],
    )?;
    if !object["nativeReadSucceeded"].is_boolean() {
        return Err("settings-preferences-reopen-boolean-rejected");
    }
    validate_field_boolean_map(&object["controlFound"])?;
    validate_field_value_map(&object["controlValues"])?;
    validate_field_value_map(&object["nativeValues"])
}

fn validate_main(generation: u8, object: &Map<String, Value>) -> Result<(), &'static str> {
    require_generation(generation, 1)?;
    require_keys(
        object,
        &[
            "piniaAppFound",
            "windowStoreFound",
            "presentFields",
            "values",
            "searchModeStructure",
        ],
    )?;
    require_booleans(object, &["piniaAppFound", "windowStoreFound"])?;
    validate_field_value_map(&object["values"])?;

    let present = object["presentFields"]
        .as_array()
        .ok_or("settings-preferences-main-fields-rejected")?;
    let mut previous = std::collections::HashSet::with_capacity(PREFERENCE_FIELDS.len());
    for entry in present {
        let field = entry
            .as_str()
            .filter(|field| PREFERENCE_FIELDS.contains(field))
            .ok_or("settings-preferences-main-field-rejected")?;
        if !previous.insert(field) || object["values"][field].is_null() {
            return Err("settings-preferences-main-field-rejected");
        }
    }

    let structure = object["searchModeStructure"]
        .as_object()
        .ok_or("settings-preferences-mode-structure-rejected")?;
    require_keys(
        structure,
        &[
            "mode",
            "selector",
            "visible",
            "rowCountClaimed",
            "queryInjected",
            "queryRestored",
            "resultCount",
            "unavailableReason",
        ],
    )?;
    if ["visible", "queryInjected", "queryRestored"]
        .iter()
        .any(|field| !structure[*field].is_boolean())
        || structure["rowCountClaimed"].as_bool() != Some(false)
        || structure["resultCount"]
            .as_u64()
            .is_none_or(|count| count > 1024)
        || structure["unavailableReason"]
            .as_str()
            .is_none_or(|reason| {
                ![
                    "none",
                    "api-unavailable",
                    "catalog-empty",
                    "input-unavailable",
                    "results-timeout",
                    "restore-failed",
                ]
                .contains(&reason)
            })
    {
        return Err("settings-preferences-mode-structure-rejected");
    }
    if !structure["mode"].is_null()
        && structure["mode"]
            .as_str()
            .is_none_or(|mode| mode != "aggregate" && mode != "list")
    {
        return Err("settings-preferences-mode-structure-rejected");
    }
    if !structure["selector"].is_null()
        && structure["selector"].as_str().is_none_or(|selector| {
            selector != ".aggregate-view" && selector != ".list-mode-results"
        })
    {
        return Err("settings-preferences-mode-structure-rejected");
    }
    Ok(())
}

fn validate_cold_startup(generation: u8, object: &Map<String, Value>) -> Result<(), &'static str> {
    require_generation(generation, 1)?;
    require_keys(
        object,
        &[
            "piniaAppFound",
            "windowStoreFound",
            "fieldCount",
            "fieldMatches",
            "tabTargetCommandBytes",
        ],
    )?;
    require_booleans(object, &["piniaAppFound", "windowStoreFound"])?;
    if object["fieldCount"]
        .as_u64()
        .is_none_or(|count| count > GENERAL_SAFE_FIELDS.len() as u64)
        || object["tabTargetCommandBytes"]
            .as_u64()
            .is_none_or(|count| count > 4096)
    {
        return Err("settings-preferences-cold-startup-count-rejected");
    }
    let matches = object["fieldMatches"]
        .as_object()
        .ok_or("settings-preferences-cold-startup-fields-rejected")?;
    if matches.len() != GENERAL_SAFE_FIELDS.len()
        || GENERAL_SAFE_FIELDS
            .iter()
            .any(|field| !matches.contains_key(*field))
        || matches.values().any(|value| !value.is_boolean())
    {
        return Err("settings-preferences-cold-startup-fields-rejected");
    }
    Ok(())
}

fn validate_field_boolean_map(value: &Value) -> Result<(), &'static str> {
    let object = value
        .as_object()
        .ok_or("settings-preferences-field-map-rejected")?;
    require_preference_keys(object)?;
    for (field, value) in object {
        if !value.is_boolean() {
            return Err("settings-preferences-field-map-rejected");
        }
        if !PREFERENCE_FIELDS.contains(&field.as_str()) {
            return Err("settings-preferences-field-map-rejected");
        }
    }
    Ok(())
}

fn validate_field_value_map(value: &Value) -> Result<(), &'static str> {
    let object = value
        .as_object()
        .ok_or("settings-preferences-field-map-rejected")?;
    require_preference_keys(object)?;
    for field in PREFERENCE_FIELDS {
        require_field_value(field, &object[*field], true)?;
    }
    Ok(())
}

fn require_preference_keys(object: &Map<String, Value>) -> Result<(), &'static str> {
    if object.len() != PREFERENCE_FIELDS.len()
        || PREFERENCE_FIELDS
            .iter()
            .any(|field| !object.contains_key(*field))
    {
        return Err("settings-preferences-field-map-rejected");
    }
    Ok(())
}

fn require_field_value(field: &str, value: &Value, nullable: bool) -> Result<(), &'static str> {
    if nullable && value.is_null() {
        return Ok(());
    }
    let valid = if BOOLEAN_FIELDS.contains(&field) {
        value.is_boolean()
    } else {
        match field {
            "recentRows" | "pinnedRows" => value.as_u64().is_some_and(|rows| rows <= 20),
            "searchMode" => matches!(value.as_str(), Some("aggregate" | "list")),
            "tabKeyFunction" => matches!(value.as_str(), Some("navigate" | "target-command")),
            "tabTargetCommand" => value.as_str().is_some_and(|command| {
                command.len() <= 4096 && !command.chars().any(char::is_control)
            }),
            _ => false,
        }
    };
    if valid {
        Ok(())
    } else {
        Err("settings-preferences-field-value-rejected")
    }
}

fn require_generation(actual: u8, expected: u8) -> Result<(), &'static str> {
    if actual == expected {
        Ok(())
    } else {
        Err("settings-preferences-generation-rejected")
    }
}

fn require_keys(object: &Map<String, Value>, fields: &[&str]) -> Result<(), &'static str> {
    if object.len() == fields.len() && fields.iter().all(|field| object.contains_key(*field)) {
        Ok(())
    } else {
        Err("settings-preferences-evidence-fields-rejected")
    }
}

fn require_booleans(object: &Map<String, Value>, fields: &[&str]) -> Result<(), &'static str> {
    if fields.iter().all(|field| object[*field].is_boolean()) {
        Ok(())
    } else {
        Err("settings-preferences-evidence-boolean-rejected")
    }
}
