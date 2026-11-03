use serde_json::Value;
use std::path::Path;

#[cfg(test)]
#[path = "launch_at_login_schema_tests.rs"]
mod tests;

pub(super) const REPORT_NAME: &str = "native-launch-at-login-report.json";
pub(super) const OWNER_INVALID: &str = "settings-launch-at-login-owner-invalid";
pub(super) const INSTALL_FAILED: &str = "settings-launch-at-login-install-failed";
pub(super) const BASELINE_INVALID: &str = "settings-launch-at-login-baseline-invalid";
pub(super) const ENABLE_FAILED: &str = "settings-launch-at-login-enable-failed";
pub(super) const CLOSE_FAILED: &str = "settings-launch-at-login-close-failed";
pub(super) const REOPEN_FAILED: &str = "settings-launch-at-login-reopen-failed";
pub(super) const EXTERNAL_DISABLE_FAILED: &str = "settings-launch-at-login-external-disable-failed";
pub(super) const CONFLICT_INVALID: &str = "settings-launch-at-login-conflict-invalid";
pub(super) const READBACK_INVALID: &str = "settings-launch-at-login-readback-invalid";
pub(super) const SAFETY_INVALID: &str = "settings-launch-at-login-safety-invalid";
pub(super) const CLEANUP_FAILED: &str = "settings-launch-at-login-cleanup-failed";
pub(super) const REPORT_WRITE_FAILED: &str = "settings-launch-at-login-report-write-failed";

const ERRORS: &[&str] = &[
    OWNER_INVALID,
    INSTALL_FAILED,
    BASELINE_INVALID,
    ENABLE_FAILED,
    CLOSE_FAILED,
    REOPEN_FAILED,
    EXTERNAL_DISABLE_FAILED,
    CONFLICT_INVALID,
    READBACK_INVALID,
    SAFETY_INVALID,
    CLEANUP_FAILED,
    REPORT_WRITE_FAILED,
];

pub(super) fn empty_observations() -> Value {
    serde_json::json!({
        "install": { "ownerVerified": null, "attempted": null, "proofInstalled": null },
        "baseline": { "routeGeneral": null, "controlUnique": null, "uiEnabled": null,
            "getterEnabled": null, "nativeEnabled": null },
        "enable": { "routeGeneral": null, "controlUnique": null, "clickDispatched": null,
            "uiEnabled": null, "getterEnabled": null, "errorCode": null, "nativeEnabled": null },
        "freshEnabled": { "newSession": null, "routeGeneral": null, "controlUnique": null,
            "uiEnabled": null, "getterEnabled": null, "nativeEnabled": null },
        "externalDisable": { "attempted": null, "confirmed": null, "nativeEnabled": null },
        "conflict": { "routeGeneral": null, "controlUnique": null, "clickDispatched": null,
            "uiEnabled": null, "getterEnabled": null, "rollbackObserved": null,
            "errorCode": null, "nativeEnabled": null },
        "freshDisabled": { "newSession": null, "routeGeneral": null, "controlUnique": null,
            "uiEnabled": null, "getterEnabled": null, "nativeEnabled": null },
        "childClosed": null, "pluginUiOpened": null, "preloadStarted": null,
        "cleanup": { "attempted": null, "unregistered": null, "osEnabled": null,
            "nativeCallsTerminal": null }
    })
}

pub(super) fn build(
    profile: &super::super::profile::Profile,
    elapsed_ms: u64,
    attempted: bool,
    observations: &Value,
    errors: &[&'static str],
) -> Value {
    let mut report = serde_json::json!({
        "schemaVersion": 1, "journey": "settings-launch-at-login",
        "scope": "hidden-original-vue-launch-at-login",
        "identifier": profile.identifier, "root": profile.root.to_string_lossy(),
        "pid": std::process::id(), "runId": profile.run_id, "elapsedMs": elapsed_ms,
        "attempted": attempted, "observations": observations, "errors": errors, "passed": false,
    });
    report["passed"] = Value::Bool(observations_passed(observations) && errors.is_empty());
    report
}

pub(super) fn valid_report(profile: &super::super::profile::Profile, report: &Value) -> bool {
    const KEYS: &[&str] = &[
        "schemaVersion",
        "journey",
        "scope",
        "identifier",
        "root",
        "pid",
        "runId",
        "elapsedMs",
        "attempted",
        "observations",
        "errors",
        "passed",
    ];
    exact_keys(report, KEYS)
        && report["schemaVersion"].as_u64() == Some(1)
        && report["journey"].as_str() == Some("settings-launch-at-login")
        && report["scope"].as_str() == Some("hidden-original-vue-launch-at-login")
        && report["identifier"].as_str() == Some(profile.identifier.as_str())
        && report["root"].as_str() == Some(profile.root.to_string_lossy().as_ref())
        && report["pid"].as_u64() == Some(std::process::id() as u64)
        && report["runId"].as_str() == Some(profile.run_id.as_str())
        && report["elapsedMs"]
            .as_u64()
            .is_some_and(|value| value <= 180_000)
        && report["attempted"].as_bool().is_some()
        && valid_profile(profile)
        && valid_observations(&report["observations"])
        && valid_errors(&report["errors"])
        && report["passed"].as_bool()
            == Some(
                observations_passed(&report["observations"])
                    && report["errors"].as_array().is_some_and(Vec::is_empty),
            )
}

pub(super) fn observations_passed(value: &Value) -> bool {
    value["install"]["ownerVerified"].as_bool() == Some(true)
        && value["install"]["attempted"].as_bool() == Some(true)
        && value["install"]["proofInstalled"].as_bool() == Some(true)
        && value["baseline"]["routeGeneral"].as_bool() == Some(true)
        && value["baseline"]["controlUnique"].as_bool() == Some(true)
        && value["baseline"]["uiEnabled"].as_bool() == Some(false)
        && value["baseline"]["getterEnabled"].as_bool() == Some(false)
        && value["baseline"]["nativeEnabled"].as_bool() == Some(false)
        && value["enable"]["routeGeneral"].as_bool() == Some(true)
        && value["enable"]["controlUnique"].as_bool() == Some(true)
        && value["enable"]["clickDispatched"].as_bool() == Some(true)
        && value["enable"]["uiEnabled"].as_bool() == Some(true)
        && value["enable"]["getterEnabled"].as_bool() == Some(true)
        && value["enable"]["errorCode"].is_null()
        && value["enable"]["nativeEnabled"].as_bool() == Some(true)
        && reopen_enabled(&value["freshEnabled"])
        && value["externalDisable"]["attempted"].as_bool() == Some(true)
        && value["externalDisable"]["confirmed"].as_bool() == Some(true)
        && value["externalDisable"]["nativeEnabled"].as_bool() == Some(false)
        && value["conflict"]["routeGeneral"].as_bool() == Some(true)
        && value["conflict"]["controlUnique"].as_bool() == Some(true)
        && value["conflict"]["clickDispatched"].as_bool() == Some(true)
        && value["conflict"]["uiEnabled"].as_bool() == Some(true)
        && value["conflict"]["getterEnabled"].is_null()
        && value["conflict"]["rollbackObserved"].as_bool() == Some(true)
        && value["conflict"]["errorCode"].as_str() == Some("conflict")
        && value["conflict"]["nativeEnabled"].as_bool() == Some(false)
        && reopen_disabled(&value["freshDisabled"])
        && value["childClosed"].as_bool() == Some(true)
        && value["pluginUiOpened"].as_bool() == Some(false)
        && value["preloadStarted"].as_bool() == Some(false)
        && value["cleanup"]["attempted"].as_bool() == Some(true)
        && value["cleanup"]["unregistered"].as_bool() == Some(true)
        && value["cleanup"]["osEnabled"].as_bool() == Some(false)
        && value["cleanup"]["nativeCallsTerminal"].as_bool() == Some(true)
}

pub(super) fn cleanup_safe(value: &Value) -> bool {
    valid_observations(value)
        && value["install"]["ownerVerified"].as_bool() == Some(true)
        && value["install"]["attempted"].as_bool() == Some(true)
        && value["install"]["proofInstalled"].as_bool() == Some(true)
        && value["cleanup"]["attempted"].as_bool() == Some(true)
        && value["cleanup"]["unregistered"].as_bool() == Some(true)
        && value["cleanup"]["osEnabled"].as_bool() == Some(false)
        && value["cleanup"]["nativeCallsTerminal"].as_bool() == Some(true)
}

pub(super) fn validate_probe_evidence(
    operation: &str,
    value: &Value,
) -> Option<Result<(), &'static str>> {
    let fields: &[&str] = match operation {
        "childLaunchAtLoginInspect" => &[
            "routeGeneral",
            "controlUnique",
            "uiEnabled",
            "getterEnabled",
        ],
        "childLaunchAtLoginClick" => &[
            "routeGeneral",
            "controlUnique",
            "clickDispatched",
            "uiEnabled",
            "getterEnabled",
            "errorCode",
        ],
        _ => return None,
    };
    if !exact_keys(value, fields) {
        return Some(Err("settings-input-probe-protocol-rejected"));
    }
    for field in fields.iter().filter(|field| **field != "errorCode") {
        if !nullable_bool(&value[*field]) {
            return Some(Err("settings-input-probe-protocol-rejected"));
        }
    }
    if operation == "childLaunchAtLoginClick"
        && !(value["errorCode"].is_null()
            || matches!(
                value["errorCode"].as_str(),
                Some(
                    "conflict"
                        | "approval"
                        | "legacy"
                        | "unavailable"
                        | "unsupported"
                        | "recovery"
                        | "other"
                )
            ))
    {
        return Some(Err("settings-input-probe-protocol-rejected"));
    }
    Some(Ok(()))
}

pub(super) fn valid_operation(operation: &str, caller: &str) -> bool {
    matches!(
        operation,
        "childLaunchAtLoginInspect" | "childLaunchAtLoginClick"
    ) && caller.starts_with("ztools-settings-")
}

fn valid_observations(value: &Value) -> bool {
    const OBS: &[&str] = &[
        "install",
        "baseline",
        "enable",
        "freshEnabled",
        "externalDisable",
        "conflict",
        "freshDisabled",
        "childClosed",
        "pluginUiOpened",
        "preloadStarted",
        "cleanup",
    ];
    const INSTALL: &[&str] = &["ownerVerified", "attempted", "proofInstalled"];
    const BASELINE: &[&str] = &[
        "routeGeneral",
        "controlUnique",
        "uiEnabled",
        "getterEnabled",
        "nativeEnabled",
    ];
    const CLICK: &[&str] = &[
        "routeGeneral",
        "controlUnique",
        "clickDispatched",
        "uiEnabled",
        "getterEnabled",
        "errorCode",
        "nativeEnabled",
    ];
    const REOPEN: &[&str] = &[
        "newSession",
        "routeGeneral",
        "controlUnique",
        "uiEnabled",
        "getterEnabled",
        "nativeEnabled",
    ];
    const EXTERNAL: &[&str] = &["attempted", "confirmed", "nativeEnabled"];
    const CONFLICT: &[&str] = &[
        "routeGeneral",
        "controlUnique",
        "clickDispatched",
        "uiEnabled",
        "getterEnabled",
        "rollbackObserved",
        "errorCode",
        "nativeEnabled",
    ];
    const CLEANUP: &[&str] = &[
        "attempted",
        "unregistered",
        "osEnabled",
        "nativeCallsTerminal",
    ];
    exact_keys(value, OBS)
        && exact_keys(&value["install"], INSTALL)
        && exact_keys(&value["baseline"], BASELINE)
        && exact_keys(&value["enable"], CLICK)
        && exact_keys(&value["freshEnabled"], REOPEN)
        && exact_keys(&value["externalDisable"], EXTERNAL)
        && exact_keys(&value["conflict"], CONFLICT)
        && exact_keys(&value["freshDisabled"], REOPEN)
        && exact_keys(&value["cleanup"], CLEANUP)
        && [
            "install",
            "baseline",
            "enable",
            "freshEnabled",
            "externalDisable",
            "conflict",
            "freshDisabled",
            "cleanup",
        ]
        .iter()
        .all(|group| {
            value[*group].as_object().is_some_and(|object| {
                object.iter().all(|(key, item)| {
                    if key == "errorCode" {
                        valid_probe_error(item)
                    } else {
                        nullable_bool(item)
                    }
                })
            })
        })
        && ["childClosed", "pluginUiOpened", "preloadStarted"]
            .iter()
            .all(|key| nullable_bool(&value[*key]))
}

fn nullable_bool(value: &Value) -> bool {
    value.is_null() || value.as_bool().is_some()
}
fn valid_probe_error(value: &Value) -> bool {
    value.is_null()
        || matches!(
            value.as_str(),
            Some(
                "conflict"
                    | "approval"
                    | "legacy"
                    | "unavailable"
                    | "unsupported"
                    | "recovery"
                    | "other"
            )
        )
}

fn valid_errors(value: &Value) -> bool {
    let Some(codes) = value.as_array() else {
        return false;
    };
    codes.len() <= ERRORS.len()
        && codes
            .iter()
            .all(|code| code.as_str().is_some_and(|code| ERRORS.contains(&code)))
        && codes
            .iter()
            .enumerate()
            .all(|(index, code)| !codes[..index].contains(code))
}

fn valid_profile(profile: &super::super::profile::Profile) -> bool {
    profile.identifier == format!("dev.atools.renderer-settings-input.{}", profile.run_id)
        && valid_run_id(&profile.run_id)
        && profile.root.parent() == Some(Path::new("/private/tmp"))
        && profile.root.file_name().and_then(|name| name.to_str())
            == Some(format!("atools-renderer-settings-input-{}", profile.run_id).as_str())
        && profile.output.file_name().and_then(|name| name.to_str()) == Some("native-report.json")
}

fn valid_run_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn exact_keys(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
    })
}

fn reopen_enabled(value: &Value) -> bool {
    value["newSession"].as_bool() == Some(true)
        && value["routeGeneral"].as_bool() == Some(true)
        && value["controlUnique"].as_bool() == Some(true)
        && value["uiEnabled"].as_bool() == Some(true)
        && value["getterEnabled"].as_bool() == Some(true)
        && value["nativeEnabled"].as_bool() == Some(true)
}

fn reopen_disabled(value: &Value) -> bool {
    value["newSession"].as_bool() == Some(true)
        && value["routeGeneral"].as_bool() == Some(true)
        && value["controlUnique"].as_bool() == Some(true)
        && value["uiEnabled"].as_bool() == Some(false)
        && value["getterEnabled"].as_bool() == Some(false)
        && value["nativeEnabled"].as_bool() == Some(false)
}
