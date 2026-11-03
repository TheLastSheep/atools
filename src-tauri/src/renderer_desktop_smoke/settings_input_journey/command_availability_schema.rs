use serde_json::{json, Value};

pub(super) const SCOPE: &str = "hidden-original-vue-command-availability";

pub(super) const BASELINE_INVALID: &str = "settings-command-availability-baseline-invalid";
pub(super) const DISABLE_FAILED: &str = "settings-command-availability-disable-failed";
pub(super) const DISABLE_NOT_STORED: &str = "settings-command-availability-disable-not-stored";
pub(super) const MAIN_NOT_EXCLUDED: &str = "settings-command-availability-main-not-excluded";
pub(super) const ENABLE_FAILED: &str = "settings-command-availability-enable-failed";
pub(super) const ENABLE_NOT_STORED: &str = "settings-command-availability-enable-not-stored";
pub(super) const MAIN_NOT_RESTORED: &str = "settings-command-availability-main-not-restored";
pub(super) const UNRELATED_SETTINGS_CHANGED: &str =
    "settings-command-availability-unrelated-settings-changed";
pub(super) const PROBE_FAILED: &str = "settings-command-availability-probe-failed";
pub(super) const RESTORE_FAILED: &str = "settings-command-availability-restore-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-command-availability-report-write-failed";

const CHECK_KEYS: &[&str] = &[
    "baselineEnabled",
    "disableMenuDispatched",
    "disabledStored",
    "childDisabledReadBack",
    "mainExcluded",
    "enableMenuDispatched",
    "enabledStored",
    "childEnabledReadBack",
    "mainRestored",
    "unrelatedSettingsUnchanged",
];

const ERROR_CODES: &[&str] = &[
    BASELINE_INVALID,
    DISABLE_FAILED,
    DISABLE_NOT_STORED,
    MAIN_NOT_EXCLUDED,
    ENABLE_FAILED,
    ENABLE_NOT_STORED,
    MAIN_NOT_RESTORED,
    UNRELATED_SETTINGS_CHANGED,
    PROBE_FAILED,
    RESTORE_FAILED,
    REPORT_WRITE_FAILED,
];

const CHILD_OPERATIONS: &[&str] = &[
    "childAvailabilityBaseline",
    "childAvailabilityDisable",
    "childAvailabilityDisabledReadBack",
    "childAvailabilityEnable",
    "childAvailabilityEnabledReadBack",
];

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Checks {
    pub(super) baseline_enabled: bool,
    pub(super) disable_menu_dispatched: bool,
    pub(super) disabled_stored: bool,
    pub(super) child_disabled_read_back: bool,
    pub(super) main_excluded: bool,
    pub(super) enable_menu_dispatched: bool,
    pub(super) enabled_stored: bool,
    pub(super) child_enabled_read_back: bool,
    pub(super) main_restored: bool,
    pub(super) unrelated_settings_unchanged: bool,
}

impl Checks {
    pub(super) fn all_passed(&self) -> bool {
        self.baseline_enabled
            && self.disable_menu_dispatched
            && self.disabled_stored
            && self.child_disabled_read_back
            && self.main_excluded
            && self.enable_menu_dispatched
            && self.enabled_stored
            && self.child_enabled_read_back
            && self.main_restored
            && self.unrelated_settings_unchanged
    }

    pub(super) fn to_value(&self) -> Value {
        json!({
            "baselineEnabled": self.baseline_enabled,
            "disableMenuDispatched": self.disable_menu_dispatched,
            "disabledStored": self.disabled_stored,
            "childDisabledReadBack": self.child_disabled_read_back,
            "mainExcluded": self.main_excluded,
            "enableMenuDispatched": self.enable_menu_dispatched,
            "enabledStored": self.enabled_stored,
            "childEnabledReadBack": self.child_enabled_read_back,
            "mainRestored": self.main_restored,
            "unrelatedSettingsUnchanged": self.unrelated_settings_unchanged,
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
        "journey": "settings-command-availability",
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
        || value["journey"].as_str() != Some("settings-command-availability")
        || value["scope"].as_str() != Some(SCOPE)
        || value["identifier"].as_str().is_none_or(str::is_empty)
        || value["root"].as_str().is_none_or(str::is_empty)
        || value["pid"].as_u64().is_none_or(|pid| pid == 0)
        || !valid_run_id(value["runId"].as_str().unwrap_or_default())
    {
        return false;
    }

    let Some(errors) = value["errors"].as_array() else {
        return false;
    };
    let mut seen = std::collections::BTreeSet::new();
    if errors.len() > 16
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

fn valid_run_id(run_id: &str) -> bool {
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

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    if CHILD_OPERATIONS.contains(&operation) {
        return caller.starts_with("ztools-settings-");
    }
    operation == "mainCommandAvailability" && caller == "main"
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    let (keys, count_fields, allow_null_main_count): (&[&str], &[(&str, u64)], bool) =
        match operation {
            "childAvailabilityBaseline" => (
                &[
                    "routeAllCommands",
                    "targetCount",
                    "openMenuCount",
                    "documentHidden",
                    "documentHasFocus",
                ],
                &[("targetCount", 4096), ("openMenuCount", 64)],
                false,
            ),
            "childAvailabilityDisable" | "childAvailabilityEnable" => (
                &[
                    "routeAllCommands",
                    "targetCount",
                    "menuOpened",
                    "menuItemFound",
                    "clickDispatched",
                    "menuStateReflected",
                    "alreadyDesired",
                    "documentHidden",
                    "documentHasFocus",
                ],
                &[("targetCount", 4096)],
                false,
            ),
            "childAvailabilityDisabledReadBack" | "childAvailabilityEnabledReadBack" => (
                &[
                    "routeAllCommands",
                    "arrayValue",
                    "readBack",
                    "entryCount",
                    "documentHidden",
                    "documentHasFocus",
                ],
                &[("entryCount", 4096)],
                false,
            ),
            "mainCommandAvailability" => (
                &[
                    "storeUnique",
                    "storeReady",
                    "searchCallable",
                    "targetCount",
                    "inputFound",
                    "inputEmpty",
                    "documentHidden",
                    "documentHasFocus",
                ],
                &[("targetCount", 4096)],
                true,
            ),
            _ => return None,
        };

    Some(validate_evidence_fields(
        value,
        keys,
        count_fields,
        allow_null_main_count,
    ))
}

fn validate_evidence_fields(
    value: &Value,
    keys: &[&str],
    count_fields: &[(&str, u64)],
    allow_null_main_count: bool,
) -> Result<(), &'static str> {
    if !exact_keys(value, keys) {
        return Err("settings-input-probe-protocol-rejected");
    }
    let invalid_count = count_fields.iter().any(|(key, max)| {
        let is_unobserved_main_count =
            allow_null_main_count && *key == "targetCount" && value[*key].is_null();
        !is_unobserved_main_count && value[*key].as_u64().is_none_or(|count| count > *max)
    });
    if keys
        .iter()
        .filter(|key| {
            !count_fields
                .iter()
                .any(|(count_key, _)| **key == *count_key)
        })
        .any(|key| !value[*key].is_boolean())
        || invalid_count
    {
        return Err("settings-input-probe-protocol-rejected");
    }

    if matches!(keys.first().copied(), Some("routeAllCommands"))
        && keys.contains(&"clickDispatched")
        && value["clickDispatched"].as_bool() == Some(true)
        && (value["menuOpened"].as_bool() != Some(true)
            || value["menuItemFound"].as_bool() != Some(true)
            || value["alreadyDesired"].as_bool() == Some(true))
    {
        return Err("settings-input-probe-protocol-rejected");
    }

    if keys.contains(&"readBack")
        && value["readBack"].as_bool() == Some(true)
        && (value["routeAllCommands"].as_bool() != Some(true)
            || value["arrayValue"].as_bool() != Some(true))
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        report, valid_operation, valid_report, validate_probe_evidence, Checks, ERROR_CODES,
        REPORT_WRITE_FAILED,
    };
    use crate::renderer_desktop_smoke::profile::{PaintPresentation, Profile};
    use serde_json::json;
    use std::path::PathBuf;

    fn profile() -> Profile {
        let run_id = "0123456789abcdef0123456789abcdef".to_owned();
        Profile {
            root: PathBuf::from("/private/tmp/settings-command-availability-test"),
            dist: PathBuf::from("/private/tmp/settings-command-availability-dist"),
            output: PathBuf::from(
                "/private/tmp/run-0123456789abcdef0123456789abcdef/native-report.json",
            ),
            auto_clear: "never".to_owned(),
            identifier: format!("dev.atools.renderer-settings-input.{run_id}"),
            run_id,
            settings_journey: false,
            settings_height_case: None,
            manual_ui: false,
            settings_input_journey: true,
            builtin_state_seed: false,
            builtin_state_journey: false,
            resume_seed_pid: None,
            main_hotkey_recovery_first: false,
            main_hotkey_recovery_second: false,
            resume_hotkey_owner_pid: None,
            paint_presentation: PaintPresentation::Hidden,
            launcher_journey: false,
            launch_return_journey: false,
            launch_target_kind: crate::renderer_desktop_smoke::profile::LaunchTargetKind::App,
            registration_source:
                crate::renderer_desktop_smoke::profile::RegistrationSource::CoreSeed,
            catalog_journey: false,
            updater_journey: false,
            updater_about: false,
            window_drag: false,
            main_panel_journey: false,
            clipboard_context_journey: false,
        }
    }

    #[test]
    fn report_shape_is_frozen_and_pass_requires_every_check_and_no_errors() {
        let mut checks = Checks {
            baseline_enabled: true,
            disable_menu_dispatched: true,
            disabled_stored: true,
            child_disabled_read_back: true,
            main_excluded: true,
            enable_menu_dispatched: true,
            enabled_stored: true,
            child_enabled_read_back: true,
            main_restored: true,
            unrelated_settings_unchanged: true,
        };
        let profile = profile();
        let passed = report(&profile, &checks, &[]);
        assert!(valid_report(&passed));
        assert_eq!(passed["schemaVersion"], 1);
        assert_eq!(passed["journey"], "settings-command-availability");
        assert_eq!(passed["identifier"], profile.identifier);
        assert_eq!(passed["root"], profile.root.to_string_lossy().as_ref());

        checks.main_excluded = false;
        let failed = report(&profile, &checks, &[REPORT_WRITE_FAILED]);
        assert!(valid_report(&failed));
        assert_eq!(failed["passed"], false);
        assert!(!valid_report(&report(
            &profile,
            &checks,
            &["unlisted-error"]
        )));
        assert!(!valid_report(&report(
            &profile,
            &checks,
            &[REPORT_WRITE_FAILED, REPORT_WRITE_FAILED]
        )));
        assert_eq!(ERROR_CODES.len(), 11);
    }

    #[test]
    fn probe_operations_are_confined_to_the_expected_original_webview() {
        let child = "ztools-settings-0123456789abcdef0123456789abcdef";
        assert!(valid_operation("childAvailabilityDisable", child));
        assert!(!valid_operation("childAvailabilityDisable", "main"));
        assert!(valid_operation("mainCommandAvailability", "main"));
        assert!(!valid_operation("mainCommandAvailability", child));
    }

    #[test]
    fn child_baseline_requires_bounded_numeric_target_and_open_menu_counts() {
        let evidence = json!({
            "routeAllCommands": true,
            "targetCount": 1,
            "openMenuCount": 0,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        assert_eq!(
            validate_probe_evidence("childAvailabilityBaseline", &evidence),
            Some(Ok(()))
        );
        let mut at_limits = evidence.clone();
        at_limits["targetCount"] = json!(4096);
        at_limits["openMenuCount"] = json!(64);
        assert_eq!(
            validate_probe_evidence("childAvailabilityBaseline", &at_limits),
            Some(Ok(()))
        );

        for (key, invalid) in [
            ("targetCount", json!("1")),
            ("targetCount", json!(null)),
            ("targetCount", json!(4097)),
            ("openMenuCount", json!(false)),
            ("openMenuCount", json!(null)),
            ("openMenuCount", json!("0")),
            ("openMenuCount", json!(65)),
        ] {
            let mut malformed = evidence.clone();
            malformed[key] = invalid;
            assert!(
                validate_probe_evidence("childAvailabilityBaseline", &malformed)
                    .unwrap()
                    .is_err(),
                "{key}"
            );
        }
    }

    #[test]
    fn probe_evidence_is_fixed_boolean_count_data_without_private_identity_fields() {
        let evidence = json!({
            "storeUnique": true,
            "storeReady": true,
            "searchCallable": true,
            "targetCount": 1,
            "inputFound": true,
            "inputEmpty": true,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        assert_eq!(
            validate_probe_evidence("mainCommandAvailability", &evidence),
            Some(Ok(()))
        );
        let mut unobserved = evidence.clone();
        unobserved["targetCount"] = json!(null);
        assert_eq!(
            validate_probe_evidence("mainCommandAvailability", &unobserved),
            Some(Ok(()))
        );
        let mut private = evidence.clone();
        private["path"] = json!("/private/target");
        assert!(validate_probe_evidence("mainCommandAvailability", &private)
            .unwrap()
            .is_err());
        let mut out_of_range = evidence;
        out_of_range["targetCount"] = json!(4097);
        assert!(
            validate_probe_evidence("mainCommandAvailability", &out_of_range)
                .unwrap()
                .is_err()
        );
    }
}
