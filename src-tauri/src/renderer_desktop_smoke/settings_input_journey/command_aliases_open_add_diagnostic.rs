use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Webview, Wry};

pub(super) const REPORT_NAME: &str = "native-command-aliases-open-add-diagnostic.json";
const PROBE_FAILED: &str = "settings-command-aliases-open-add-diagnostic-probe-failed";
const EVIDENCE_KEYS: &[&str] = &[
    "phase",
    "sendState",
    "route",
    "cardCount",
    "openDropdownCount",
    "menuCount",
    "dialogCount",
    "aliasTabActive",
    "inputPresent",
    "invokeAvailable",
    "hadException",
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

pub(super) async fn open_add_with_diagnostic(
    app: &AppHandle<Wry>,
    harness: &super::state::Harness,
    child: &Webview<Wry>,
    target: &(String, String),
    alias: &str,
) -> Result<Value, &'static str> {
    let original = super::probe::child_alias_open_add(app, harness, child, target, alias).await;
    if !original.as_ref().is_ok_and(|value| {
        value["menuDispatched"].as_bool() == Some(true)
            && value["dialogOpened"].as_bool() == Some(true)
    }) {
        let observations = super::probe::child_alias_open_add_diagnostic(app, harness, child)
            .await
            .ok()
            .filter(|value| validate_evidence(value).is_ok());
        let report = build(harness.profile(), observations);
        if !valid_report(&report)
            || super::local_app_search_report::write_owned_artifact(
                harness.profile(),
                REPORT_NAME,
                &report,
            )
            .is_err()
        {
            harness.add_error("settings-input-report-write-failed");
        }
    }
    original
}

pub(super) fn validate_evidence(value: &Value) -> Result<(), &'static str> {
    if !exact_keys(value, EVIDENCE_KEYS)
        || !one_of(
            value["phase"].as_str(),
            &[
                "not-started",
                "arguments",
                "route",
                "card",
                "menu",
                "dialog",
                "complete",
                "error",
            ],
        )
        || !one_of(
            value["sendState"].as_str(),
            &[
                "not-attempted",
                "pending",
                "accepted",
                "rejected",
                "unavailable",
            ],
        )
        || !one_of(
            value["route"].as_str(),
            &["general", "allCommands", "shortcuts", "other"],
        )
        || ![
            "aliasTabActive",
            "inputPresent",
            "invokeAvailable",
            "hadException",
        ]
        .iter()
        .all(|key| value[*key].is_boolean())
        || !["cardCount", "openDropdownCount", "menuCount", "dialogCount"]
            .iter()
            .all(|key| value[*key].is_null() || value[*key].as_u64().is_some_and(|n| n <= 4096))
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(())
}

fn build(profile: &super::super::profile::Profile, observations: Option<Value>) -> Value {
    let failed = observations.is_none();
    json!({
        "schemaVersion": 1,
        "journey": "settings-command-aliases-open-add-diagnostic",
        "scope": super::command_aliases_schema::SCOPE,
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "observations": observations,
        "errors": if failed { vec![PROBE_FAILED] } else { vec![] },
    })
}

fn valid_report(value: &Value) -> bool {
    if !exact_keys(value, REPORT_KEYS)
        || value["schemaVersion"].as_u64() != Some(1)
        || value["journey"].as_str() != Some("settings-command-aliases-open-add-diagnostic")
        || value["scope"].as_str() != Some(super::command_aliases_schema::SCOPE)
        || value["pid"].as_u64().is_none_or(|pid| pid == 0)
    {
        return false;
    }
    let Some(run_id) = value["runId"].as_str().filter(|id| valid_run_id(id)) else {
        return false;
    };
    let expected_identifier = format!("dev.atools.renderer-settings-input.{run_id}");
    let expected_root = format!("/private/tmp/atools-renderer-settings-input-{run_id}");
    if value["identifier"].as_str() != Some(expected_identifier.as_str())
        || value["root"].as_str() != Some(expected_root.as_str())
        || !Path::new(&expected_root).is_absolute()
    {
        return false;
    }
    let Some(errors) = value["errors"].as_array() else {
        return false;
    };
    match (&value["observations"], errors.as_slice()) {
        (Value::Null, [error]) => error.as_str() == Some(PROBE_FAILED),
        (observations, []) => validate_evidence(observations).is_ok(),
        _ => false,
    }
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

fn one_of(value: Option<&str>, allowed: &[&str]) -> bool {
    value.is_some_and(|value| allowed.contains(&value))
}

fn valid_run_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::{valid_report, validate_evidence, PROBE_FAILED};
    use serde_json::{json, Value};

    fn evidence() -> Value {
        json!({
            "phase":"menu", "sendState":"accepted", "route":"allCommands",
            "cardCount":1, "openDropdownCount":1, "menuCount":1, "dialogCount":0,
            "aliasTabActive":false, "inputPresent":false,
            "invokeAvailable":true, "hadException":false
        })
    }

    fn report(observations: Value, errors: Value) -> Value {
        let run_id = "0123456789abcdef0123456789abcdef";
        json!({
            "schemaVersion":1,
            "journey":"settings-command-aliases-open-add-diagnostic",
            "scope":"hidden-original-vue-command-aliases",
            "identifier":format!("dev.atools.renderer-settings-input.{run_id}"),
            "root":format!("/private/tmp/atools-renderer-settings-input-{run_id}"),
            "pid":12,
            "runId":run_id,
            "observations":observations,
            "errors":errors
        })
    }

    #[test]
    fn diagnostic_evidence_is_exact_typed_and_bounded() {
        assert!(validate_evidence(&evidence()).is_ok());
        let mut nullable = evidence();
        nullable["cardCount"] = Value::Null;
        assert!(validate_evidence(&nullable).is_ok());
        let mut at_limit = evidence();
        at_limit["menuCount"] = json!(4096);
        assert!(validate_evidence(&at_limit).is_ok());
        for (key, invalid) in [
            ("phase", json!("unknown")),
            ("sendState", json!("maybe")),
            ("route", json!("/shortcuts")),
            ("menuCount", json!(4097)),
            ("dialogCount", json!("0")),
            ("inputPresent", json!(null)),
        ] {
            let mut value = evidence();
            value[key] = invalid;
            assert!(validate_evidence(&value).is_err(), "{key}");
        }
        let mut extra = evidence();
        extra["rawText"] = json!("must be rejected");
        assert!(validate_evidence(&extra).is_err());
        let mut missing = evidence();
        missing.as_object_mut().unwrap().remove("hadException");
        assert!(validate_evidence(&missing).is_err());
    }

    #[test]
    fn diagnostic_report_binds_owner_and_failure_without_a_pass_bit() {
        let success = report(evidence(), json!([]));
        assert!(valid_report(&success));
        let failed = report(Value::Null, json!([PROBE_FAILED]));
        assert!(valid_report(&failed));
        let mut invalid = success.clone();
        invalid["pid"] = json!(0);
        assert!(!valid_report(&invalid));
        let mut invalid = success.clone();
        invalid["identifier"] = json!("other");
        assert!(!valid_report(&invalid));
        let mut invalid = success.clone();
        invalid["passed"] = json!(true);
        assert!(!valid_report(&invalid));
        let mut invalid = success.clone();
        invalid["errors"] = json!([PROBE_FAILED]);
        assert!(!valid_report(&invalid));
        let mut invalid = failed.clone();
        invalid["errors"] = json!([]);
        assert!(!valid_report(&invalid));
        let mut invalid = failed;
        invalid["errors"] = json!(["settings-command-aliases-unknown-error"]);
        assert!(!valid_report(&invalid));
    }
}
