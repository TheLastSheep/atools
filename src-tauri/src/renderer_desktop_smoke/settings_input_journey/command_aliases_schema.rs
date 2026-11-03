use serde_json::Value;
use std::path::Path;

pub(super) const SCOPE: &str = "hidden-original-vue-command-aliases";
pub(super) const REPORT_NAME: &str = "native-command-aliases-report.json";

pub(super) const BASELINE_INVALID: &str = "settings-command-aliases-baseline-invalid";
pub(super) const OPEN_FAILED: &str = "settings-command-aliases-open-failed";
pub(super) const ADD_FAILED: &str = "settings-command-aliases-add-failed";
pub(super) const EDIT_FAILED: &str = "settings-command-aliases-edit-failed";
pub(super) const REOPEN_FAILED: &str = "settings-command-aliases-reopen-failed";
pub(super) const DELETE_FAILED: &str = "settings-command-aliases-delete-failed";
pub(super) const MAIN_SEARCH_INVALID: &str = "settings-command-aliases-main-search-invalid";
pub(super) const STATE_INVALID: &str = "settings-command-aliases-state-invalid";
pub(super) const UNRELATED_CHANGED: &str = "settings-command-aliases-unrelated-changed";
pub(super) const COUNTER_INVALID: &str = "settings-command-aliases-counter-invalid";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-command-aliases-report-write-failed";

const ERROR_CODES: &[&str] = &[
    BASELINE_INVALID,
    OPEN_FAILED,
    ADD_FAILED,
    EDIT_FAILED,
    REOPEN_FAILED,
    DELETE_FAILED,
    MAIN_SEARCH_INVALID,
    STATE_INVALID,
    UNRELATED_CHANGED,
    COUNTER_INVALID,
    REPORT_WRITE_FAILED,
];

const OBSERVATION_BOOL_KEYS: &[&str] = &[
    "initialStateValid",
    "addMenuDispatched",
    "addDialogOpened",
    "addSaveDispatched",
    "addStored",
    "addMainMatched",
    "editSaveDispatched",
    "editStored",
    "editMainUpdated",
    "closedAfterEdit",
    "freshSessionOnReopen",
    "reopenReadBack",
    "deleteDialogOpened",
    "deleteConfirmed",
    "deleteStored",
    "deleteMainExcluded",
    "unrelatedPreserved",
    "noAppCatalogReload",
    "pluginUiOpened",
    "preloadStarted",
];

const OBSERVATION_COUNT_KEYS: &[&str] = &[
    "aliasEventsBefore",
    "aliasEventsAfterAdd",
    "aliasEventsAfterEdit",
    "aliasEventsAfterDelete",
    "appListReadsBefore",
    "appListReadsAfter",
    "addMatchCount",
    "editOldMatchCount",
    "editNewMatchCount",
    "deleteMatchCount",
];

const REPORT_KEYS: &[&str] = &[
    "schemaVersion",
    "journey",
    "scope",
    "identifier",
    "root",
    "pid",
    "runId",
    "observations",
    "errors",
];

const OBSERVATION_KEYS: &[&str] = &[
    "initialStateValid",
    "addMenuDispatched",
    "addDialogOpened",
    "addSaveDispatched",
    "addStored",
    "addMainMatched",
    "editSaveDispatched",
    "editStored",
    "editMainUpdated",
    "closedAfterEdit",
    "freshSessionOnReopen",
    "reopenReadBack",
    "deleteDialogOpened",
    "deleteConfirmed",
    "deleteStored",
    "deleteMainExcluded",
    "unrelatedPreserved",
    "noAppCatalogReload",
    "pluginUiOpened",
    "preloadStarted",
    "aliasEventsBefore",
    "aliasEventsAfterAdd",
    "aliasEventsAfterEdit",
    "aliasEventsAfterDelete",
    "appListReadsBefore",
    "appListReadsAfter",
    "addMatchCount",
    "editOldMatchCount",
    "editNewMatchCount",
    "deleteMatchCount",
];

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    match operation {
        "mainAliasSearch" | "mainAliasInspect" => caller == "main",
        "childAliasOpenAdd"
        | "childAliasOpenAddDiagnostic"
        | "childAliasAddSave"
        | "childAliasEditSave"
        | "childAliasReadBack"
        | "childAliasDelete" => caller.starts_with("ztools-settings-"),
        _ => false,
    }
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    if operation == "childAliasOpenAddDiagnostic" {
        return Some(super::command_aliases_open_add_diagnostic::validate_evidence(value));
    }
    let (keys, counts): (&[&str], &[&str]) = match operation {
        "childAliasOpenAdd" => (&["menuDispatched", "dialogOpened"], &[]),
        "childAliasAddSave" | "childAliasEditSave" => (&["saveDispatched", "saveCompleted"], &[]),
        "childAliasReadBack" => (&["routeValid", "aliasVisible"], &[]),
        "childAliasDelete" => (
            &["deleteDialogOpened", "deleteConfirmed", "rowRemoved"],
            &[],
        ),
        "mainAliasSearch" => (
            &[
                "inputFound",
                "eventDispatched",
                "valueMatches",
                "resultCount",
                "storeTargetCount",
                "matchedTarget",
            ],
            &["resultCount", "storeTargetCount"],
        ),
        "mainAliasInspect" => (
            &["eventSourceListening", "aliasEvents", "appListReads"],
            &["aliasEvents", "appListReads"],
        ),
        _ => return None,
    };
    Some(validate_exact_object(value, keys, counts))
}

fn validate_exact_object(
    value: &Value,
    keys: &[&str],
    counts: &[&str],
) -> Result<(), &'static str> {
    let object = value
        .as_object()
        .ok_or("settings-input-probe-protocol-rejected")?;
    if object.len() != keys.len() || keys.iter().any(|key| !object.contains_key(*key)) {
        return Err("settings-input-probe-protocol-rejected");
    }
    for key in keys {
        if counts.contains(key) {
            if !value[*key].is_null() && value[*key].as_u64().is_none_or(|count| count > 4096) {
                return Err("settings-input-probe-protocol-rejected");
            }
        } else if *key == "eventSourceListening" {
            if !value[*key].is_null() && !value[*key].is_boolean() {
                return Err("settings-input-probe-protocol-rejected");
            }
        } else if !value[*key].is_boolean() {
            return Err("settings-input-probe-protocol-rejected");
        }
    }
    Ok(())
}

pub(super) fn empty_observations() -> Value {
    let mut observations = serde_json::Map::new();
    for key in OBSERVATION_BOOL_KEYS {
        observations.insert((*key).to_owned(), Value::Null);
    }
    for key in OBSERVATION_COUNT_KEYS {
        observations.insert((*key).to_owned(), Value::Null);
    }
    Value::Object(observations)
}

pub(super) fn valid_report(value: &Value) -> bool {
    if !exact_keys(value, REPORT_KEYS)
        || value["schemaVersion"].as_u64() != Some(1)
        || value["journey"].as_str() != Some("settings-command-aliases")
        || value["scope"].as_str() != Some(SCOPE)
        || value["pid"].as_u64().is_none_or(|pid| pid == 0)
    {
        return false;
    }
    let Some(run_id) = value["runId"].as_str().filter(|id| valid_run_id(id)) else {
        return false;
    };
    if value["identifier"].as_str()
        != Some(format!("dev.atools.renderer-settings-input.{run_id}").as_str())
        || value["root"].as_str()
            != Some(format!("/private/tmp/atools-renderer-settings-input-{run_id}").as_str())
    {
        return false;
    }
    let Some(root) = value["root"].as_str() else {
        return false;
    };
    if !Path::new(root).is_absolute() || !valid_observations(&value["observations"]) {
        return false;
    }
    let Some(errors) = value["errors"].as_array() else {
        return false;
    };
    let mut seen = std::collections::BTreeSet::new();
    errors.len() <= ERROR_CODES.len()
        && errors.iter().all(|error| {
            error
                .as_str()
                .is_some_and(|code| ERROR_CODES.contains(&code) && seen.insert(code))
        })
}

fn valid_observations(value: &Value) -> bool {
    if !exact_keys(value, OBSERVATION_KEYS) {
        return false;
    }
    OBSERVATION_BOOL_KEYS
        .iter()
        .all(|key| value[*key].is_null() || value[*key].is_boolean())
        && OBSERVATION_COUNT_KEYS.iter().all(|key| {
            value[*key].is_null() || value[*key].as_u64().is_some_and(|count| count <= 4096)
        })
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

fn valid_run_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::{empty_observations, valid_operation, valid_report, validate_probe_evidence};
    use serde_json::{json, Value};

    fn report() -> Value {
        let run_id = "0123456789abcdef0123456789abcdef";
        json!({
            "schemaVersion": 1,
            "journey": "settings-command-aliases",
            "scope": "hidden-original-vue-command-aliases",
            "identifier": format!("dev.atools.renderer-settings-input.{run_id}"),
            "root": format!("/private/tmp/atools-renderer-settings-input-{run_id}"),
            "pid": 12,
            "runId": run_id,
            "observations": empty_observations(),
            "errors": [],
        })
    }

    #[test]
    fn operations_are_scoped_and_probe_evidence_is_exact_and_bounded() {
        let child = "ztools-settings-0123456789abcdef0123456789abcdef";
        assert!(valid_operation("childAliasOpenAdd", child));
        assert!(valid_operation("childAliasOpenAddDiagnostic", child));
        assert!(!valid_operation("childAliasOpenAddDiagnostic", "main"));
        assert!(!valid_operation("childAliasDelete", "main"));
        assert!(valid_operation("mainAliasSearch", "main"));
        assert!(!valid_operation("mainAliasSearch", child));
        assert_eq!(
            validate_probe_evidence(
                "mainAliasSearch",
                &json!({
                    "inputFound":true,"eventDispatched":true,"valueMatches":true,
                    "resultCount":1,"storeTargetCount":1,"matchedTarget":true
                })
            ),
            Some(Ok(()))
        );
        for malformed in [
            json!({"inputFound":true,"eventDispatched":true,"valueMatches":true,"resultCount":4097,"storeTargetCount":0,"matchedTarget":true}),
            json!({"inputFound":true,"eventDispatched":true,"valueMatches":true,"resultCount":0,"storeTargetCount":0,"matchedTarget":true,"raw":"x"}),
            json!({"inputFound":true,"eventDispatched":true,"valueMatches":true,"resultCount":"1","storeTargetCount":0,"matchedTarget":true}),
            json!({"inputFound":true,"eventDispatched":true,"valueMatches":true,"resultCount":1,"storeTargetCount":4097,"matchedTarget":true}),
            json!({"inputFound":true,"eventDispatched":true,"valueMatches":true,"resultCount":1,"matchedTarget":null}),
        ] {
            assert!(validate_probe_evidence("mainAliasSearch", &malformed)
                .unwrap()
                .is_err());
        }
        assert_eq!(
            validate_probe_evidence(
                "mainAliasSearch",
                &json!({
                    "inputFound":true,"eventDispatched":true,"valueMatches":true,
                    "resultCount":0,"storeTargetCount":null,"matchedTarget":false
                })
            ),
            Some(Ok(()))
        );
        assert!(validate_probe_evidence("unknownAliasOp", &json!({})).is_none());
        assert_eq!(
            validate_probe_evidence(
                "childAliasReadBack",
                &json!({"routeValid":true,"aliasVisible":false})
            ),
            Some(Ok(()))
        );
        assert_eq!(
            validate_probe_evidence(
                "childAliasAddSave",
                &json!({"saveDispatched":true,"saveCompleted":false})
            ),
            Some(Ok(()))
        );
        assert_eq!(
            validate_probe_evidence(
                "childAliasEditSave",
                &json!({"saveDispatched":true,"saveCompleted":true})
            ),
            Some(Ok(()))
        );
        assert!(
            validate_probe_evidence("childAliasEditSave", &json!({"saveDispatched":true}))
                .unwrap()
                .is_err()
        );
        assert_eq!(
            validate_probe_evidence(
                "childAliasDelete",
                &json!({"deleteDialogOpened":true,"deleteConfirmed":true,"rowRemoved":false})
            ),
            Some(Ok(()))
        );
        assert!(validate_probe_evidence(
            "childAliasDelete",
            &json!({"deleteDialogOpened":true,"deleteConfirmed":true})
        )
        .unwrap()
        .is_err());
        assert!(validate_probe_evidence(
            "mainAliasInspect",
            &json!({"eventSourceListening":true,"aliasEvents":0,"appListReads":4097})
        )
        .unwrap()
        .is_err());
        assert_eq!(
            validate_probe_evidence(
                "mainAliasInspect",
                &json!({"eventSourceListening":true,"aliasEvents":null,"appListReads":null})
            ),
            Some(Ok(()))
        );
        assert_eq!(
            validate_probe_evidence(
                "mainAliasInspect",
                &json!({"eventSourceListening":null,"aliasEvents":null,"appListReads":null})
            ),
            Some(Ok(()))
        );
    }

    #[test]
    fn partial_report_accepts_unknown_observations_as_null_but_rejects_bad_owners() {
        let value = report();
        assert!(valid_report(&value));
        let mut invalid = value.clone();
        invalid["observations"]["pluginUiOpened"] = json!("false");
        assert!(!valid_report(&invalid));
        let mut invalid = value.clone();
        invalid["observations"]["extra"] = json!(false);
        assert!(!valid_report(&invalid));
        let mut invalid = value.clone();
        invalid["root"] = json!("/private/tmp/other");
        assert!(!valid_report(&invalid));
        let mut invalid = value.clone();
        invalid["errors"] = json!([
            "settings-command-aliases-add-failed",
            "settings-command-aliases-add-failed"
        ]);
        assert!(!valid_report(&invalid));
        let mut invalid = value;
        invalid["passed"] = json!(true);
        assert!(!valid_report(&invalid));
    }
}
