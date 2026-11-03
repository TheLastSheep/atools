use serde_json::{json, Value};

pub(super) const SCOPE: &str = "hidden-original-vue-local-app-search";

pub(super) const BASELINE_INVALID: &str = "settings-input-local-app-search-baseline-invalid";
pub(super) const CHECKBOX_TOGGLE_FAILED: &str =
    "settings-input-local-app-search-checkbox-toggle-failed";
pub(super) const DISABLED_NOT_STORED: &str = "settings-input-local-app-search-disabled-not-stored";
pub(super) const MAIN_APP_NOT_EXCLUDED: &str =
    "settings-input-local-app-search-main-app-not-excluded";
pub(super) const NON_APP_CONTROL_MISSING: &str =
    "settings-input-local-app-search-non-app-control-missing";
pub(super) const CHILD_CLOSE_FAILED: &str = "settings-input-local-app-search-child-close-failed";
pub(super) const REOPEN_FAILED: &str = "settings-input-local-app-search-reopen-failed";
pub(super) const PERSISTENCE_READBACK_INVALID: &str =
    "settings-input-local-app-search-persistence-readback-invalid";
pub(super) const ENABLED_NOT_STORED: &str = "settings-input-local-app-search-enabled-not-stored";
pub(super) const MAIN_APP_NOT_RESTORED: &str =
    "settings-input-local-app-search-main-app-not-restored";
pub(super) const NATIVE_CATALOG_CHANGED: &str =
    "settings-input-local-app-search-native-catalog-changed";
pub(super) const PATH_RESOLVE_INVALID: &str =
    "settings-input-local-app-search-path-resolve-invalid";
pub(super) const CLEANUP_FAILED: &str = "settings-input-local-app-search-cleanup-failed";
pub(super) const PROBE_FAILED: &str = "settings-input-local-app-search-probe-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-input-local-app-search-report-write-failed";

const CHECK_KEYS: &[&str] = &[
    "initialUiEnabled",
    "initialDatabaseEnabled",
    "disableUiClick",
    "disabledDatabaseStored",
    "mainAppExcluded",
    "mainNonAppPreservedDisabled",
    "reopenedChildFresh",
    "reopenedUiPersistedDisabled",
    "reopenedDatabasePersistedDisabled",
    "enableUiClick",
    "enabledDatabaseStored",
    "mainAppRestored",
    "mainNonAppPreservedEnabled",
    "nativeCatalogUnchanged",
    "finalUiEnabled",
    "childClosed",
    "targetCanonicalPathResolved",
];

const ERROR_CODES: &[&str] = &[
    BASELINE_INVALID,
    CHECKBOX_TOGGLE_FAILED,
    DISABLED_NOT_STORED,
    MAIN_APP_NOT_EXCLUDED,
    NON_APP_CONTROL_MISSING,
    CHILD_CLOSE_FAILED,
    REOPEN_FAILED,
    PERSISTENCE_READBACK_INVALID,
    ENABLED_NOT_STORED,
    MAIN_APP_NOT_RESTORED,
    NATIVE_CATALOG_CHANGED,
    PATH_RESOLVE_INVALID,
    CLEANUP_FAILED,
    PROBE_FAILED,
    REPORT_WRITE_FAILED,
];

const MAIN_OPERATION: &str = "mainLocalAppSearchSearch";
const CHILD_INSPECT_OPERATION: &str = "childLocalAppSearchInspect";
const CHILD_TOGGLE_OPERATION: &str = "childLocalAppSearchToggle";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Checks {
    pub(super) initial_ui_enabled: bool,
    pub(super) initial_database_enabled: bool,
    pub(super) disable_ui_click: bool,
    pub(super) disabled_database_stored: bool,
    pub(super) main_app_excluded: bool,
    pub(super) main_non_app_preserved_disabled: bool,
    pub(super) reopened_child_fresh: bool,
    pub(super) reopened_ui_persisted_disabled: bool,
    pub(super) reopened_database_persisted_disabled: bool,
    pub(super) enable_ui_click: bool,
    pub(super) enabled_database_stored: bool,
    pub(super) main_app_restored: bool,
    pub(super) main_non_app_preserved_enabled: bool,
    pub(super) native_catalog_unchanged: bool,
    pub(super) final_ui_enabled: bool,
    pub(super) child_closed: bool,
    pub(super) target_canonical_path_resolved: bool,
}

impl Checks {
    pub(super) fn all_passed(&self) -> bool {
        let value = self.to_value();
        CHECK_KEYS
            .iter()
            .all(|key| value[*key].as_bool() == Some(true))
    }

    pub(super) fn to_value(&self) -> Value {
        json!({
            "initialUiEnabled": self.initial_ui_enabled,
            "initialDatabaseEnabled": self.initial_database_enabled,
            "disableUiClick": self.disable_ui_click,
            "disabledDatabaseStored": self.disabled_database_stored,
            "mainAppExcluded": self.main_app_excluded,
            "mainNonAppPreservedDisabled": self.main_non_app_preserved_disabled,
            "reopenedChildFresh": self.reopened_child_fresh,
            "reopenedUiPersistedDisabled": self.reopened_ui_persisted_disabled,
            "reopenedDatabasePersistedDisabled": self.reopened_database_persisted_disabled,
            "enableUiClick": self.enable_ui_click,
            "enabledDatabaseStored": self.enabled_database_stored,
            "mainAppRestored": self.main_app_restored,
            "mainNonAppPreservedEnabled": self.main_non_app_preserved_enabled,
            "nativeCatalogUnchanged": self.native_catalog_unchanged,
            "finalUiEnabled": self.final_ui_enabled,
            "childClosed": self.child_closed,
            "targetCanonicalPathResolved": self.target_canonical_path_resolved,
        })
    }
}

pub(super) fn report(
    profile: &super::super::profile::Profile,
    checks: &Checks,
    errors: &[&'static str],
) -> Value {
    json!({
        "schemaVersion": 1,
        "journey": "settings-local-app-search",
        "scope": SCOPE,
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "passed": checks.all_passed() && errors.is_empty(),
        "errors": errors,
        "checks": checks.to_value(),
    })
}

pub(super) fn valid_report(value: &Value) -> bool {
    let Some(report) = value.as_object() else {
        return false;
    };
    let run_id = value["runId"].as_str().unwrap_or_default();
    let expected_identifier = format!("dev.atools.renderer-settings-input.{run_id}");
    if report.len() != 10
        || [
            "schemaVersion",
            "journey",
            "scope",
            "identifier",
            "root",
            "pid",
            "runId",
            "passed",
            "errors",
            "checks",
        ]
        .iter()
        .any(|key| !report.contains_key(*key))
        || value["schemaVersion"].as_u64() != Some(1)
        || value["journey"].as_str() != Some("settings-local-app-search")
        || value["scope"].as_str() != Some(SCOPE)
        || value["identifier"].as_str().is_none_or(str::is_empty)
        || value["root"].as_str().is_none_or(str::is_empty)
        || value["pid"].as_u64().is_none_or(|pid| pid == 0)
        || !valid_run_id(run_id)
        || value["identifier"].as_str() != Some(expected_identifier.as_str())
    {
        return false;
    }

    let Some(errors) = value["errors"].as_array() else {
        return false;
    };
    let mut seen = std::collections::BTreeSet::new();
    if errors.len() > ERROR_CODES.len()
        || errors.iter().any(|error| {
            let Some(code) = error.as_str() else {
                return true;
            };
            !ERROR_CODES.contains(&code) || !seen.insert(code)
        })
    {
        return false;
    }

    let checks = &value["checks"];
    exact_keys(checks, CHECK_KEYS)
        && CHECK_KEYS.iter().all(|key| checks[*key].is_boolean())
        && value["passed"].as_bool()
            == Some(
                CHECK_KEYS
                    .iter()
                    .all(|key| checks[*key].as_bool() == Some(true))
                    && errors.is_empty(),
            )
}

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    match operation {
        MAIN_OPERATION => caller == "main",
        CHILD_INSPECT_OPERATION | CHILD_TOGGLE_OPERATION => caller.starts_with("ztools-settings-"),
        _ => false,
    }
}

pub(super) fn is_error_code(code: &str) -> bool {
    ERROR_CODES.contains(&code)
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    let (keys, count_fields): (&[&str], &[&str]) = match operation {
        MAIN_OPERATION => (
            &[
                "storeUnique",
                "storeReady",
                "searchCallable",
                "appTargetCount",
                "timestampMatchCount",
                "timestampIdentityValid",
                "timestampPath",
                "inputFound",
                "inputEmpty",
                "documentHidden",
                "documentHasFocus",
            ],
            &["appTargetCount", "timestampMatchCount"],
        ),
        CHILD_INSPECT_OPERATION => (
            &[
                "routeGeneral",
                "controlUnique",
                "checked",
                "settingsObject",
                "settingsHasBoolean",
                "settingsEnabled",
                "documentHidden",
                "documentHasFocus",
            ],
            &[],
        ),
        CHILD_TOGGLE_OPERATION => (
            &[
                "routeGeneral",
                "controlUnique",
                "beforeChecked",
                "clickDispatched",
                "afterChecked",
                "settingsObject",
                "settingsHasBoolean",
                "settingsEnabled",
                "documentHidden",
                "documentHasFocus",
            ],
            &[],
        ),
        _ => return None,
    };
    Some(validate_evidence(value, keys, count_fields))
}

fn validate_evidence(value: &Value, fields: &[&str], counts: &[&str]) -> Result<(), &'static str> {
    let object = value
        .as_object()
        .ok_or("settings-input-probe-protocol-rejected")?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err("settings-input-probe-protocol-rejected");
    }
    for field in fields {
        let item = &value[*field];
        if counts.contains(field) {
            if !item.is_null() && item.as_u64().is_none_or(|count| count > 4096) {
                return Err("settings-input-probe-protocol-rejected");
            }
        } else if *field == "timestampPath" {
            if !item.is_null()
                && item
                    .as_str()
                    .is_none_or(|path| path.is_empty() || path.len() > 8_192)
            {
                return Err("settings-input-probe-protocol-rejected");
            }
        } else if !item.is_boolean() {
            return Err("settings-input-probe-protocol-rejected");
        }
    }
    Ok(())
}

pub(super) fn valid_run_id(run_id: &str) -> bool {
    run_id.len() == 32
        && run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn exact_keys(value: &Value, expected: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == expected.len() && expected.iter().all(|key| object.contains_key(*key))
    })
}

#[cfg(test)]
mod tests {
    use super::{valid_operation, valid_report, validate_probe_evidence, CHECK_KEYS, ERROR_CODES};
    use serde_json::{json, Value};

    fn evidence(operation: &str) -> Value {
        match operation {
            "mainLocalAppSearchSearch" => json!({
                "storeUnique": true,
                "storeReady": true,
                "searchCallable": true,
                "appTargetCount": 1,
                "timestampMatchCount": 1,
                "timestampIdentityValid": true,
                "timestampPath": "/tmp/plugins/timestamp",
                "inputFound": true,
                "inputEmpty": true,
                "documentHidden": true,
                "documentHasFocus": false,
            }),
            "childLocalAppSearchInspect" => json!({
                "routeGeneral": true,
                "controlUnique": true,
                "checked": true,
                "settingsObject": true,
                "settingsHasBoolean": true,
                "settingsEnabled": true,
                "documentHidden": true,
                "documentHasFocus": false,
            }),
            _ => json!({
                "routeGeneral": true,
                "controlUnique": true,
                "beforeChecked": true,
                "clickDispatched": true,
                "afterChecked": false,
                "settingsObject": true,
                "settingsHasBoolean": true,
                "settingsEnabled": false,
                "documentHidden": true,
                "documentHasFocus": false,
            }),
        }
    }

    fn report() -> Value {
        let mut checks = serde_json::Map::new();
        for key in CHECK_KEYS {
            checks.insert((*key).to_owned(), Value::Bool(true));
        }
        json!({
            "schemaVersion": 1,
            "journey": "settings-local-app-search",
            "scope": super::SCOPE,
            "identifier": "dev.atools.renderer-settings-input.0123456789abcdef0123456789abcdef",
            "root": "/private/tmp/run",
            "pid": 7,
            "runId": "0123456789abcdef0123456789abcdef",
            "passed": true,
            "errors": [],
            "checks": checks,
        })
    }

    #[test]
    fn operations_are_scoped_to_original_main_and_owned_child() {
        assert!(valid_operation("mainLocalAppSearchSearch", "main"));
        assert!(!valid_operation(
            "mainLocalAppSearchSearch",
            "ztools-settings-a"
        ));
        assert!(valid_operation(
            "childLocalAppSearchInspect",
            "ztools-settings-a"
        ));
        assert!(valid_operation(
            "childLocalAppSearchToggle",
            "ztools-settings-a"
        ));
        assert!(!valid_operation("childLocalAppSearchToggle", "other"));
    }

    #[test]
    fn probe_evidence_requires_exact_bounded_shape_and_preserves_unknown_counts() {
        let valid = evidence("mainLocalAppSearchSearch");
        assert!(validate_probe_evidence("mainLocalAppSearchSearch", &valid)
            .unwrap()
            .is_ok());
        let mut unknown = valid.clone();
        unknown["appTargetCount"] = Value::Null;
        assert!(
            validate_probe_evidence("mainLocalAppSearchSearch", &unknown)
                .unwrap()
                .is_ok()
        );
        unknown["unexpected"] = json!(true);
        assert!(
            validate_probe_evidence("mainLocalAppSearchSearch", &unknown)
                .unwrap()
                .is_err()
        );
        let mut oversized = valid.clone();
        oversized["timestampMatchCount"] = json!(4097);
        assert!(
            validate_probe_evidence("mainLocalAppSearchSearch", &oversized)
                .unwrap()
                .is_err()
        );

        let mut missing_control = valid.clone();
        missing_control["timestampMatchCount"] = json!(0);
        missing_control["timestampIdentityValid"] = Value::Bool(false);
        missing_control["timestampPath"] = Value::Null;
        assert!(
            validate_probe_evidence("mainLocalAppSearchSearch", &missing_control)
                .unwrap()
                .is_ok()
        );

        let child = evidence("childLocalAppSearchInspect");
        assert!(
            validate_probe_evidence("childLocalAppSearchInspect", &child)
                .unwrap()
                .is_ok()
        );
        let toggle = evidence("childLocalAppSearchToggle");
        assert!(
            validate_probe_evidence("childLocalAppSearchToggle", &toggle)
                .unwrap()
                .is_ok()
        );
    }

    #[test]
    fn report_pass_is_derived_from_all_exact_checks_and_allowlisted_errors() {
        let valid = report();
        assert!(valid_report(&valid));
        let mut incomplete = valid.clone();
        incomplete["checks"]
            .as_object_mut()
            .unwrap()
            .remove("childClosed");
        assert!(!valid_report(&incomplete));

        let mut false_pass = valid.clone();
        false_pass["checks"]["nativeCatalogUnchanged"] = json!(false);
        assert!(!valid_report(&false_pass));

        let mut unknown_error = valid;
        unknown_error["passed"] = json!(false);
        unknown_error["errors"] = json!(["settings-input-local-app-search-not-approved"]);
        assert!(!ERROR_CODES.contains(&"settings-input-local-app-search-not-approved"));
        assert!(!valid_report(&unknown_error));
    }
}
