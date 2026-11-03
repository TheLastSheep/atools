use super::local_app_search_schema as schema;
use serde_json::{json, Value};
use std::path::Path;

const FILE_NAME: &str = "native-local-app-search-observations.json";
const MAX_ARTIFACT_BYTES: usize = 8 * 1024;
const PHASE_KEYS: &[&str] = &["baseline", "disabled", "enabled"];
const OBSERVATION_KEYS: &[&str] = &[
    "storeUnique",
    "storeReady",
    "searchCallable",
    "inputFound",
    "inputEmpty",
    "documentHidden",
    "documentHasFocus",
    "appTargetCount",
    "timestampMatchCount",
    "timestampIdentityValid",
];
const BOOLEAN_KEYS: &[&str] = &[
    "storeUnique",
    "storeReady",
    "searchCallable",
    "inputFound",
    "inputEmpty",
    "documentHidden",
    "documentHasFocus",
    "timestampIdentityValid",
];
const COUNT_KEYS: &[&str] = &["appTargetCount", "timestampMatchCount"];

#[derive(Clone, Debug, Default)]
pub(super) struct MainSearchObservations {
    baseline: Option<Value>,
    disabled: Option<Value>,
    enabled: Option<Value>,
}

impl MainSearchObservations {
    pub(super) fn record_baseline(&mut self, value: Option<&Value>) {
        self.baseline = value.cloned();
    }

    pub(super) fn record_disabled(&mut self, value: Option<&Value>) {
        self.disabled = value.cloned();
    }

    pub(super) fn record_enabled(&mut self, value: Option<&Value>) {
        self.enabled = value.cloned();
    }

    fn to_value(&self, profile: &super::super::profile::Profile) -> Value {
        json!({
            "schemaVersion": 1,
            "identifier": profile.identifier,
            "root": profile.root.to_string_lossy(),
            "pid": std::process::id(),
            "runId": profile.run_id,
            "phases": {
                "baseline": phase(self.baseline.as_ref()),
                "disabled": phase(self.disabled.as_ref()),
                "enabled": phase(self.enabled.as_ref()),
            },
        })
    }

    pub(super) fn write(
        &self,
        profile: &super::super::profile::Profile,
    ) -> Result<(), &'static str> {
        let value = self.to_value(profile);
        if !valid_report(&value) {
            return Err(schema::REPORT_WRITE_FAILED);
        }
        let bytes = serde_json::to_vec(&value).map_err(|_| schema::REPORT_WRITE_FAILED)?;
        if bytes.len() > MAX_ARTIFACT_BYTES {
            return Err(schema::REPORT_WRITE_FAILED);
        }
        super::local_app_search_report::write_owned_artifact(profile, FILE_NAME, &value)
    }
}

fn phase(value: Option<&Value>) -> Value {
    json!({
        "storeUnique": optional_bool(value, "storeUnique"),
        "storeReady": optional_bool(value, "storeReady"),
        "searchCallable": optional_bool(value, "searchCallable"),
        "inputFound": optional_bool(value, "inputFound"),
        "inputEmpty": optional_bool(value, "inputEmpty"),
        "documentHidden": optional_bool(value, "documentHidden"),
        "documentHasFocus": optional_bool(value, "documentHasFocus"),
        "appTargetCount": optional_count(value, "appTargetCount"),
        "timestampMatchCount": optional_count(value, "timestampMatchCount"),
        "timestampIdentityValid": optional_bool(value, "timestampIdentityValid"),
    })
}

fn optional_bool(value: Option<&Value>, key: &str) -> Value {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_bool)
        .map(Value::Bool)
        .unwrap_or(Value::Null)
}

fn optional_count(value: Option<&Value>, key: &str) -> Value {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_u64)
        .filter(|count| *count <= 4096)
        .map(Value::from)
        .unwrap_or(Value::Null)
}

fn valid_report(value: &Value) -> bool {
    let Some(run_id) = value["runId"].as_str() else {
        return false;
    };
    let expected_identifier = format!("dev.atools.renderer-settings-input.{run_id}");
    if !exact_keys(
        value,
        &[
            "schemaVersion",
            "identifier",
            "root",
            "pid",
            "runId",
            "phases",
        ],
    ) || value["schemaVersion"].as_u64() != Some(1)
        || value["identifier"].as_str() != Some(expected_identifier.as_str())
        || value["root"]
            .as_str()
            .is_none_or(|root| !Path::new(root).is_absolute())
        || value["pid"].as_u64().is_none_or(|pid| pid == 0)
        || !schema::valid_run_id(run_id)
        || !exact_keys(&value["phases"], PHASE_KEYS)
    {
        return false;
    }
    if PHASE_KEYS
        .iter()
        .any(|key| !valid_phase(&value["phases"][*key]))
    {
        return false;
    }
    serde_json::to_vec(value).is_ok_and(|bytes| bytes.len() <= MAX_ARTIFACT_BYTES)
}

fn valid_phase(value: &Value) -> bool {
    exact_keys(value, OBSERVATION_KEYS)
        && BOOLEAN_KEYS
            .iter()
            .all(|key| value[*key].is_null() || value[*key].is_boolean())
        && COUNT_KEYS.iter().all(|key| {
            value[*key].is_null() || value[*key].as_u64().is_some_and(|count| count <= 4096)
        })
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

#[cfg(test)]
mod tests {
    use super::{
        valid_report, MainSearchObservations, MAX_ARTIFACT_BYTES, OBSERVATION_KEYS, PHASE_KEYS,
    };
    use crate::renderer_desktop_smoke::profile::{PaintPresentation, Profile};
    use serde_json::{json, Value};
    use std::path::PathBuf;

    fn profile() -> Profile {
        let run_id = "0123456789abcdef0123456789abcdef".to_owned();
        Profile {
            root: PathBuf::from("/private/tmp/atools-run"),
            dist: PathBuf::from("/private/tmp/atools-dist"),
            output: PathBuf::from("/private/tmp/run/native-report.json"),
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
    fn absent_probe_replies_remain_null_in_a_fixed_bounded_document() {
        let observations = MainSearchObservations::default();
        let value = observations.to_value(&profile());
        assert!(valid_report(&value));
        let phases = value["phases"].as_object().unwrap();
        assert_eq!(phases.len(), PHASE_KEYS.len());
        for phase in PHASE_KEYS {
            assert_eq!(
                phases[*phase].as_object().unwrap().len(),
                OBSERVATION_KEYS.len()
            );
            assert_eq!(phases[*phase]["appTargetCount"], Value::Null);
            assert_eq!(phases[*phase]["timestampMatchCount"], Value::Null);
            assert_eq!(phases[*phase]["inputEmpty"], Value::Null);
        }
        assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_ARTIFACT_BYTES);
    }

    #[test]
    fn projection_keeps_only_bounded_safe_fields_and_preserves_false() {
        let mut observations = MainSearchObservations::default();
        let evidence = json!({
            "storeUnique": true,
            "storeReady": true,
            "searchCallable": true,
            "inputFound": true,
            "inputEmpty": false,
            "documentHidden": true,
            "documentHasFocus": false,
            "appTargetCount": 1,
            "timestampMatchCount": 0,
            "timestampIdentityValid": false,
            "timestampPath": "/private/user/plugins/timestamp",
            "query": "private text",
        });
        observations.record_baseline(Some(&evidence));
        let value = observations.to_value(&profile());
        assert!(valid_report(&value));
        assert_eq!(value["phases"]["baseline"]["inputEmpty"], json!(false));
        assert_eq!(value["phases"]["baseline"]["appTargetCount"], json!(1));
        assert_eq!(value["phases"]["baseline"]["timestampMatchCount"], json!(0));
        assert_eq!(
            value["phases"]["baseline"]["timestampIdentityValid"],
            json!(false)
        );
        let encoded = serde_json::to_string(&value).unwrap();
        assert!(!encoded.contains("/private/user/plugins/timestamp"));
        assert!(!encoded.contains("private text"));

        let mut oversized = evidence;
        oversized["appTargetCount"] = json!(4097);
        observations.record_disabled(Some(&oversized));
        let projected = observations.to_value(&profile());
        assert_eq!(
            projected["phases"]["disabled"]["appTargetCount"],
            Value::Null
        );
        assert!(valid_report(&projected));
    }
}
