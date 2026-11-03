use super::{
    native::{parse_general, raw_general},
    preference_schema::{GENERAL_SAFE_FIELDS, PREFERENCE_FIELDS},
    probe,
    state::Harness,
};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Webview, Wry};

const EDIT_SEQUENCE: &[&str] = &[
    "searchMode",
    "showRecentInSearch",
    "pinnedRows",
    "recentRows",
    "showMatchRecommendation",
    "tabKeyFunction",
    "tabTargetCommand",
    "spaceOpenCommand",
];

pub(super) async fn observe_cold_startup(
    app: &AppHandle<Wry>,
    harness: &Harness,
    baseline: &Value,
) -> Result<(), &'static str> {
    let expected = select_fields(baseline, GENERAL_SAFE_FIELDS);
    let evidence = probe::observe_cold_startup(app, harness, &expected).await?;
    let field_matches = select_fields(&evidence["fieldMatches"], GENERAL_SAFE_FIELDS);
    let tab_target_bytes = evidence["tabTargetCommandBytes"].as_u64();
    let expected_tab_target_bytes = baseline["tabTargetCommand"]
        .as_str()
        .map(|command| command.len() as u64);
    let verified = evidence["piniaAppFound"].as_bool() == Some(true)
        && evidence["windowStoreFound"].as_bool() == Some(true)
        && evidence["fieldCount"].as_u64() == Some(GENERAL_SAFE_FIELDS.len() as u64)
        && GENERAL_SAFE_FIELDS
            .iter()
            .all(|field| evidence["fieldMatches"][*field].as_bool() == Some(true))
        && tab_target_bytes == expected_tab_target_bytes
        && expected_tab_target_bytes == Some(2049);

    harness.set(
        &["preferences", "coldStartup"],
        json!({
            "passed": verified,
            "scope": "native-seed-before-plugin-entry",
            "piniaAppFound": evidence["piniaAppFound"],
            "windowStoreFound": evidence["windowStoreFound"],
            "fieldCount": evidence["fieldCount"],
            "fieldMatches": field_matches,
            "tabTargetCommandBytes": tab_target_bytes.map_or(Value::Null, Value::from)
        }),
    );
    if !verified {
        harness.record_error("settings-cold-startup-general-store-seed-mismatch");
    }
    Ok(())
}

pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
) -> Result<(), &'static str> {
    let mut current =
        parse_general(&raw_general(app)?).ok_or("settings-preferences-baseline-invalid")?;
    let mut rows = initial_rows();

    for field in EDIT_SEQUENCE {
        let target = target_value(field).ok_or("settings-preferences-target-invalid")?;
        let before = current.clone();
        let edit_evidence = probe::preference_edit(app, harness, child, id, field, &target).await?;
        let after_raw = raw_general(app)?;
        let after = parse_general(&after_raw).ok_or("settings-preferences-native-read-invalid")?;

        let ui_edited = edit_evidence["field"].as_str() == Some(field)
            && edit_evidence["stage"].as_str() == Some("complete")
            && edit_evidence["controlFound"].as_bool() == Some(true)
            && edit_evidence["actionObserved"].as_bool() == Some(true)
            && edit_evidence["valueChanged"].as_bool() == Some(true)
            && edit_evidence["matchesTarget"].as_bool() == Some(true)
            && edit_evidence["uiValue"] == target;
        let native_committed = after.get(*field) == Some(&target)
            && edit_evidence["stage"].as_str() == Some("complete")
            && before.get(*field) != Some(&target)
            && only_general_field_changed(&before, &after, field)
            && edit_evidence["nativeReadbackMatches"].as_bool() == Some(true)
            && edit_evidence["revisionAdvanced"].as_bool() == Some(true);

        harness.set(
            &["preferences", "probeStages", *field],
            edit_evidence["stage"].clone(),
        );
        set_row(&mut rows, field, "edited", Value::Bool(ui_edited));
        set_row(&mut rows, field, "committed", Value::Bool(native_committed));
        harness.set(&["preferences", "fields"], Value::Array(rows.clone()));
        if !ui_edited {
            harness.record_error("settings-preference-control-edit-not-observed");
        }
        if !native_committed {
            harness.record_error("settings-preference-native-commit-not-observed");
        }
        current = after;
    }

    record_rejection(app, harness, child, id, "readonly").await?;
    record_rejection(app, harness, child, id, "invalidValue").await?;

    Ok(())
}

pub(super) async fn observe_main_after_exit(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let current = parse_general(&raw_general(app)?)
        .ok_or("settings-preferences-final-native-read-invalid")?;
    let expected_preferences = select_fields(&current, PREFERENCE_FIELDS);
    let main_evidence =
        probe::observe_main_preferences(app, harness, &expected_preferences).await?;
    let main_values = &main_evidence["values"];
    let present_fields = main_evidence["presentFields"].as_array();
    let mut rows = row_values(harness);
    let main_snapshot_matches = |field: &str| {
        main_evidence["piniaAppFound"].as_bool() == Some(true)
            && main_evidence["windowStoreFound"].as_bool() == Some(true)
            && present_fields
                .is_some_and(|fields| fields.iter().any(|item| item.as_str() == Some(field)))
            && main_values.get(field) == current.get(field)
    };
    for field in EDIT_SEQUENCE {
        let matched = main_snapshot_matches(field);
        set_row(&mut rows, field, "mainApplied", Value::Bool(matched));
        if !matched {
            harness.record_error("settings-preference-main-store-update-not-observed");
        }
    }
    harness.set(&["preferences", "fields"], Value::Array(rows));

    let mode = main_evidence["searchModeStructure"]["mode"].clone();
    let selector = main_evidence["searchModeStructure"]["selector"].clone();
    let structure = &main_evidence["searchModeStructure"];
    let mode_structure_verified = mode.as_str() == current["searchMode"].as_str()
        && selector.as_str() == Some(".aggregate-view")
        && structure["visible"].as_bool() == Some(true)
        && structure["rowCountClaimed"].as_bool() == Some(false)
        && structure["queryInjected"].as_bool() == Some(true)
        && structure["queryRestored"].as_bool() == Some(true)
        && structure["resultCount"]
            .as_u64()
            .is_some_and(|count| count >= 1)
        && structure["unavailableReason"].as_str() == Some("none");
    let main_observation = json!({
        "piniaAppFound": main_evidence["piniaAppFound"],
        "windowStoreFound": main_evidence["windowStoreFound"],
        "presentFields": main_evidence["presentFields"],
        "values": main_evidence["values"],
        "searchModeStructure": {
            "verified": mode_structure_verified,
            "mode": mode,
            "selector": selector,
            "visible": structure["visible"],
            "rowCountClaimed": structure["rowCountClaimed"],
            "queryInjected": structure["queryInjected"],
            "queryRestored": structure["queryRestored"],
            "resultCount": structure["resultCount"],
            "unavailableReason": structure["unavailableReason"]
        }
    });
    harness.set(&["preferences", "mainObservation"], main_observation);
    if !mode_structure_verified {
        harness.record_error("settings-search-mode-visible-structure-not-observed");
    }
    Ok(())
}

pub(super) async fn inspect_reopened(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
) -> Result<(), &'static str> {
    let reopened = probe::preferences_reopen(app, harness, child, id).await?;
    let raw = raw_general(app)?;
    let native = parse_general(&raw).ok_or("settings-preferences-reopen-native-read-invalid")?;
    let native_read_succeeded = reopened["nativeReadSucceeded"].as_bool() == Some(true);
    let mut control_verified = true;
    let mut native_matches = native_read_succeeded;
    let mut rows = row_values(harness);

    for field in EDIT_SEQUENCE {
        let expected = native.get(*field).cloned().unwrap_or(Value::Null);
        let control_matches = reopened["controlFound"][*field].as_bool() == Some(true)
            && reopened["controlValues"][*field] == expected;
        let child_native_matches = reopened["nativeValues"][*field] == expected;
        let matched = control_matches && child_native_matches && native_read_succeeded;
        set_row(&mut rows, field, "reopened", Value::Bool(matched));
        control_verified &= control_matches;
        native_matches &= child_native_matches;
        if !matched {
            harness.record_error("settings-preference-reopened-value-not-matched");
        }
    }

    harness.set(&["preferences", "fields"], Value::Array(rows));
    harness.set(
        &["preferences", "reopenObservation"],
        json!({
            "controlsVerified": control_verified,
            "nativeMatches": native_matches,
            "controlFound": reopened["controlFound"],
            "controlValues": reopened["controlValues"],
            "nativeValues": reopened["nativeValues"]
        }),
    );
    if !control_verified || !native_matches {
        harness.record_error("settings-preference-reopen-three-way-check-failed");
    }
    Ok(())
}

async fn record_rejection(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    id: &str,
    kind: &str,
) -> Result<(), &'static str> {
    let operation = match kind {
        "readonly" => "readonly",
        "invalidValue" => "invalidValue",
        _ => return Err("settings-preferences-rejection-kind-invalid"),
    };
    let before = raw_general(app)?;
    let evidence = probe::preference_rejection(app, harness, child, id, operation).await?;
    let after = raw_general(app)?;
    let error_code = evidence["errorCode"].as_str().unwrap_or("unobserved");
    let revision_unchanged = evidence["readSucceeded"].as_bool() == Some(true)
        && evidence["revisionBefore"].as_str().is_some()
        && evidence["revisionBefore"] == evidence["revisionAfter"];
    let raw_unchanged = before == after;
    let projection_unchanged = evidence["projectionUnchanged"].as_bool() == Some(true);
    let rejected = error_code == "SETTINGS_INVALID_ARGUMENT"
        && revision_unchanged
        && raw_unchanged
        && projection_unchanged;
    let report = json!({
        "errorCode": error_code,
        "revisionUnchanged": revision_unchanged,
        "rawUnchanged": raw_unchanged,
        "projectionUnchanged": projection_unchanged
    });
    let path = if operation == "readonly" {
        &["preferences", "rejectionEvidence", "readonly"][..]
    } else {
        &["preferences", "rejectionEvidence", "invalidValue"][..]
    };
    harness.set(path, report);
    let field = if operation == "readonly" {
        "readonlyRejected"
    } else {
        "invalidValueRejected"
    };
    harness.set(&["preferences", field], Value::Bool(rejected));
    if !rejected {
        harness.record_error("settings-preference-invalid-patch-not-rejected-safely");
    }
    Ok(())
}

fn initial_rows() -> Vec<Value> {
    EDIT_SEQUENCE
        .iter()
        .map(|field| {
            json!({
                "field": field,
                "edited": false,
                "committed": false,
                "mainApplied": false,
                "reopened": false
            })
        })
        .collect()
}

fn target_value(field: &str) -> Option<Value> {
    Some(match field {
        "searchMode" => Value::String("aggregate".to_owned()),
        "showRecentInSearch" => Value::Bool(true),
        "pinnedRows" | "recentRows" => Value::from(3),
        "showMatchRecommendation" => Value::Bool(false),
        "tabKeyFunction" => Value::String("target-command".to_owned()),
        "tabTargetCommand" => Value::String("ATools-native-target".to_owned()),
        "spaceOpenCommand" => Value::Bool(true),
        _ => return None,
    })
}

fn set_row(rows: &mut [Value], field: &str, key: &str, value: Value) {
    if let Some(row) = rows
        .iter_mut()
        .find(|row| row["field"].as_str() == Some(field))
    {
        row[key] = value;
    }
}

fn row_values(harness: &Harness) -> Vec<Value> {
    harness
        .snapshot()
        .get("preferences")
        .and_then(|preferences| preferences.get("fields"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(initial_rows)
}

fn only_general_field_changed(before: &Value, after: &Value, field: &str) -> bool {
    let (Some(before), Some(after)) = (before.as_object(), after.as_object()) else {
        return false;
    };
    before.len() == after.len()
        && before.contains_key(field)
        && before
            .iter()
            .filter(|(key, _)| key.as_str() != field)
            .all(|(key, value)| after.get(key) == Some(value))
        && before.get(field) != after.get(field)
}

fn select_fields(source: &Value, fields: &[&str]) -> Value {
    let mut selected = Map::with_capacity(fields.len());
    for field in fields {
        selected.insert(
            (*field).to_owned(),
            source.get(*field).cloned().unwrap_or(Value::Null),
        );
    }
    Value::Object(selected)
}
