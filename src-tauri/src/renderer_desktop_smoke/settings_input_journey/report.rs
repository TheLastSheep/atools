use serde_json::{json, Value};

pub(super) const SCOPE: &str = "hidden-original-vue-real-settings-input";
pub(super) const STAGE_KEYS: [&str; 12] = [
    "startup",
    "openAllCommands",
    "mainMatch",
    "mainNoMatch",
    "mainClear",
    "pinSearch",
    "childValueReturn",
    "ownerRotation",
    "closeCleanup",
    "freshReopen",
    "unpinSearch",
    "finalCleanup",
];

const SEARCH_PIN_FLAGS: &[&str] = &[
    "initiallyEmpty",
    "pinStored",
    "pinReadBack",
    "mainPinned",
    "unpinStored",
    "unpinReadBack",
    "mainUnpinned",
    "historyUnchanged",
];
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

const ERROR_CODES: &[&str] = &[
    "settings-input-profile-invalid",
    "settings-input-fixture-owner-invalid",
    "settings-input-fixture-seed-invalid",
    "settings-input-fixture-seed-failed",
    "settings-input-main-webview-unavailable",
    "settings-input-main-probe-injection-failed",
    "settings-input-main-ready-timeout",
    "settings-input-probe-operation-invalid",
    "settings-input-probe-timeout",
    "settings-input-probe-protocol-rejected",
    "settings-input-main-store-observation-unavailable",
    "settings-input-catalog-unavailable",
    "settings-input-catalog-target-unavailable",
    "settings-input-catalog-target-not-unique",
    "settings-input-updater-startup-count-invalid",
    "settings-input-updater-native-snapshot-invalid",
    "settings-input-settings-open-failed",
    "settings-input-open-not-invoked",
    "settings-input-open-native-rejected",
    "settings-input-open-pending",
    "settings-input-open-diagnostics-unavailable",
    "settings-input-open-diagnostics-incomplete",
    "settings-input-listener-failed",
    "settings-input-listener-registration-error",
    "settings-input-listener-inactive",
    "settings-input-listener-pending",
    "settings-input-event-invalid",
    "settings-input-runtime-state-unavailable",
    "settings-input-runtime-not-initialized",
    "settings-input-runtime-observation-incomplete",
    "settings-input-bundle-not-cached",
    "settings-input-bundle-load-active",
    "settings-input-session-absent",
    "settings-input-session-opening",
    "settings-input-session-closing",
    "settings-input-session-not-ready",
    "settings-input-viewport-invalid",
    "settings-input-viewport-unavailable",
    "settings-input-resource-root-unavailable",
    "settings-input-resource-root-missing",
    "settings-input-resource-root-invalid",
    "settings-input-resource-root-noncanonical",
    "settings-input-child-not-ready",
    "settings-input-child-identity-invalid",
    "settings-input-child-probe-injection-failed",
    "settings-input-all-commands-route-invalid",
    "settings-input-catalog-baseline-invalid",
    "settings-input-main-match-invalid",
    "settings-input-main-no-match-invalid",
    "settings-input-main-clear-invalid",
    "settings-input-search-pin-initial-state-invalid",
    "settings-input-search-pin-operation-invalid",
    "settings-input-search-pin-state-invalid",
    "settings-input-search-pin-readback-invalid",
    "settings-input-search-pin-main-dom-invalid",
    "settings-input-search-unpin-main-dom-invalid",
    "settings-input-child-value-return-invalid",
    "settings-input-shortcuts-owner-invalid",
    "settings-input-stale-owner-not-rejected",
    "settings-input-out-plugin-unavailable",
    "settings-input-close-not-drained",
    "settings-input-fresh-session-invalid",
    "settings-input-hidden-presentation-invalid",
    "settings-input-window-became-visible-or-focused",
    "settings-input-activation-invalid",
    "settings-input-data-store-not-nonpersistent",
    "settings-input-native-state-invalid",
    "settings-input-stage-not-reached",
    "settings-input-watchdog-timeout",
    "settings-input-journey-failed",
    "settings-input-cleanup-failed",
    "settings-input-observer-uninstall-failed",
    "settings-input-report-write-failed",
    "settings-input-command-aliases-failed",
    "settings-input-window-opacity-failed",
    "settings-input-tray-visibility-failed",
    "settings-input-main-hotkey-failed",
];

pub(super) fn empty_report(profile: &super::super::profile::Profile) -> Value {
    json!({
        "schemaVersion": 3,
        "journey": "settings-input",
        "scope": SCOPE,
        "identifier": profile.identifier,
        "root": profile.root.to_string_lossy(),
        "pid": std::process::id(),
        "runId": profile.run_id,
        "autoClear": profile.auto_clear,
        "passed": false,
        "timedOut": false,
        "elapsedMs": 0,
        "updaterStatus": {
            "startupCalls": 0,
            "verifiedCalls": 0,
            "idle": false,
            "unchecked": false,
            "hasUpdate": false,
            "hasDownloadedAbsent": false,
            "nativeIdle": false,
            "nativeUnchecked": false,
            "nativeUpdateAbsent": false,
            "nativeErrorAbsent": false
        },
        "catalogSelection": {"available": false, "canonicalNonEmpty": false},
        "searchPins": {
            "initiallyEmpty": false,
            "pinStored": false,
            "pinReadBack": false,
            "mainPinned": false,
            "unpinStored": false,
            "unpinReadBack": false,
            "mainUnpinned": false,
            "historyUnchanged": false,
            "initialRevision": null,
            "pinnedRevision": null,
            "unpinnedRevision": null
        },
        "stages": [],
        "cleanup": {
            "sessionCount": null,
            "childCount": null,
            "layoutCount": null,
            "pendingCalls": null,
            "pendingWrites": null,
            "observerRemoved": null,
            "observerRegistered": null,
            "activationKnown": false,
            "appActive": null,
            "frontmostIsSelf": null,
            "focusGainedEvents": null,
            "appActivationEvents": null,
            "mainKeyEvents": null
        },
        "errors": []
    })
}

pub(super) fn stage(
    key: &'static str,
    passed: bool,
    elapsed_ms: u64,
    dom: Value,
    native: Value,
    activation: Value,
    presentation: Value,
    errors: &[&'static str],
) -> Value {
    json!({
        "key": key,
        "passed": passed && errors.is_empty(),
        "elapsedMs": elapsed_ms,
        "dom": dom,
        "native": native,
        "activation": activation,
        "presentation": presentation,
        "errors": errors
    })
}

pub(super) fn empty_dom() -> Value {
    json!({
        "mainReady": false,
        "childReady": false,
        "routeValid": false,
        "matchedCount": null,
        "restoredCount": null,
        "inputEmpty": false,
        "queryMatches": false,
        "baselineCount": null,
        "filteredCount": null,
        "mainDocumentHidden": false,
        "mainDocumentHasFocus": true,
        "childDocumentHidden": null,
        "childDocumentHasFocus": null
    })
}

pub(super) fn empty_native() -> Value {
    json!({
        "sessionCount": null,
        "childCount": null,
        "layoutCount": null,
        "pendingCalls": null,
        "pendingWrites": null,
        "controlSequence": null,
        "userSequence": null,
        "valueBytes": null,
        "inputVisible": null,
        "windowVisible": null,
        "windowFocused": null,
        "focusGainedEvents": null,
        "generation": null,
        "valueVersion": null,
        "mainDataStorePersistent": null,
        "childDataStorePersistent": null,
        "staleInputRejected": null,
        "freshSession": null,
        "opaqueSessionId": null
    })
}

pub(super) fn is_error_code(code: &str) -> bool {
    ERROR_CODES.contains(&code) || super::local_app_search_schema::is_error_code(code)
}

pub(super) fn add_error(report: &mut Value, code: &'static str) {
    let code = if is_error_code(code) {
        code
    } else {
        "settings-input-journey-failed"
    };
    if let Some(errors) = report["errors"].as_array_mut() {
        let item = Value::String(code.to_owned());
        if !errors.contains(&item) {
            errors.push(item);
        }
    }
    report["passed"] = Value::Bool(false);
}

pub(super) fn push_stage(report: &mut Value, value: Value) {
    if let Some(stages) = report["stages"].as_array_mut() {
        stages.push(value);
    }
}

pub(super) fn set_path(report: &mut Value, path: &[&str], value: Value) {
    let Some((last, parents)) = path.split_last() else {
        return;
    };
    let mut cursor = report;
    for key in parents {
        cursor = &mut cursor[*key];
    }
    cursor[*last] = value;
}

pub(super) fn ensure_all_stages(report: &mut Value) {
    for key in STAGE_KEYS {
        let already_present = report["stages"].as_array().is_some_and(|stages| {
            stages
                .iter()
                .any(|stage| stage["key"].as_str() == Some(key))
        });
        if !already_present {
            push_stage(
                report,
                stage(
                    key,
                    false,
                    0,
                    empty_dom(),
                    empty_native(),
                    json!({
                        "installed": false,
                        "registered": 0,
                        "removed": 0,
                        "appActive": true,
                        "frontmostIsSelf": true,
                        "appActivationEvents": 0,
                        "mainKeyEvents": 0,
                        "known": false
                    }),
                    json!({"hiddenSmoke": false, "suppressedFocusRequests": 0}),
                    &["settings-input-stage-not-reached"],
                ),
            );
            add_error(report, "settings-input-stage-not-reached");
        }
    }
    if let Some(stages) = report["stages"].as_array_mut() {
        stages.sort_by_key(|stage| {
            STAGE_KEYS
                .iter()
                .position(|key| stage["key"].as_str() == Some(*key))
                .unwrap_or(STAGE_KEYS.len())
        });
    }
}

pub(super) fn compute_passed(report: &Value) -> bool {
    report["schemaVersion"].as_u64() == Some(3)
        && report["journey"].as_str() == Some("settings-input")
        && report["scope"].as_str() == Some(SCOPE)
        && report["autoClear"].as_str() == Some("never")
        && report["timedOut"].as_bool() == Some(false)
        && report["errors"].as_array().is_some_and(Vec::is_empty)
        && updater_passed(&report["updaterStatus"])
        && report["catalogSelection"]["available"].as_bool() == Some(true)
        && report["catalogSelection"]["canonicalNonEmpty"].as_bool() == Some(true)
        && search_pins_passed(&report["searchPins"])
        && report["stages"].as_array().is_some_and(|stages| {
            stages.len() == STAGE_KEYS.len()
                && stages.iter().zip(STAGE_KEYS).all(|(stage, key)| {
                    stage["key"].as_str() == Some(key)
                        && stage["passed"].as_bool() == Some(true)
                        && stage["errors"].as_array().is_some_and(Vec::is_empty)
                })
        })
        && fresh_reopen_replay_passed(&report["stages"])
        && cleanup_passed(&report["cleanup"])
}

fn search_pins_passed(value: &Value) -> bool {
    SEARCH_PIN_FLAGS
        .iter()
        .all(|key| value[*key].as_bool() == Some(true))
        && value
            .get("initialRevision")
            .and_then(Value::as_u64)
            .is_some_and(|initial| {
                initial <= MAX_SAFE_INTEGER
                    && value
                        .get("pinnedRevision")
                        .and_then(Value::as_u64)
                        .is_some_and(|pinned| {
                            pinned <= MAX_SAFE_INTEGER
                                && initial.checked_add(1) == Some(pinned)
                                && value
                                    .get("unpinnedRevision")
                                    .and_then(Value::as_u64)
                                    .is_some_and(|unpinned| {
                                        unpinned <= MAX_SAFE_INTEGER
                                            && pinned.checked_add(1) == Some(unpinned)
                                    })
                        })
            })
}

fn fresh_reopen_replay_passed(stages: &Value) -> bool {
    stages.as_array().is_some_and(|stages| {
        stages
            .iter()
            .find(|stage| stage["key"].as_str() == Some("freshReopen"))
            .is_some_and(|stage| stage["native"]["staleInputRejected"].as_bool() == Some(true))
    })
}

fn updater_passed(status: &Value) -> bool {
    status["startupCalls"].as_u64() == Some(1)
        && status["verifiedCalls"].as_u64() == Some(2)
        && status["idle"].as_bool() == Some(true)
        && status["unchecked"].as_bool() == Some(true)
        && status["hasUpdate"].as_bool() == Some(false)
        && status["hasDownloadedAbsent"].as_bool() == Some(true)
        && status["nativeIdle"].as_bool() == Some(true)
        && status["nativeUnchecked"].as_bool() == Some(true)
        && status["nativeUpdateAbsent"].as_bool() == Some(true)
        && status["nativeErrorAbsent"].as_bool() == Some(true)
}

fn cleanup_passed(cleanup: &Value) -> bool {
    [
        "sessionCount",
        "childCount",
        "layoutCount",
        "pendingCalls",
        "pendingWrites",
    ]
    .iter()
    .all(|key| cleanup[*key].as_u64() == Some(0))
        && cleanup["observerRemoved"].as_u64() == Some(2)
        && cleanup["observerRegistered"].as_u64() == Some(2)
        && cleanup["activationKnown"].as_bool() == Some(true)
        && cleanup["appActive"].as_bool() == Some(false)
        && cleanup["frontmostIsSelf"].as_bool() == Some(false)
        && cleanup["focusGainedEvents"].as_u64() == Some(0)
        && cleanup["appActivationEvents"].as_u64() == Some(0)
        && cleanup["mainKeyEvents"].as_u64() == Some(0)
}

#[cfg(test)]
mod tests {
    use super::{compute_passed, SCOPE, STAGE_KEYS};
    use serde_json::{json, Value};

    fn complete_report() -> Value {
        let stages = STAGE_KEYS
            .iter()
            .map(|key| {
                json!({
                    "key": key,
                    "passed": true,
                    "errors": [],
                    "native": {"staleInputRejected": *key == "freshReopen"}
                })
            })
            .collect::<Vec<_>>();
        json!({
            "schemaVersion": 3,
            "journey": "settings-input",
            "scope": SCOPE,
            "autoClear": "never",
            "timedOut": false,
            "errors": [],
            "updaterStatus": {
                "startupCalls": 1,
                "verifiedCalls": 2,
                "idle": true,
                "unchecked": true,
                "hasUpdate": false,
                "hasDownloadedAbsent": true,
                "nativeIdle": true,
                "nativeUnchecked": true,
                "nativeUpdateAbsent": true,
                "nativeErrorAbsent": true
            },
            "catalogSelection": {"available": true, "canonicalNonEmpty": true},
            "searchPins": {
                "initiallyEmpty": true,
                "pinStored": true,
                "pinReadBack": true,
                "mainPinned": true,
                "unpinStored": true,
                "unpinReadBack": true,
                "mainUnpinned": true,
                "historyUnchanged": true,
                "initialRevision": 10,
                "pinnedRevision": 11,
                "unpinnedRevision": 12
            },
            "stages": stages,
            "cleanup": {
                "sessionCount": 0,
                "childCount": 0,
                "layoutCount": 0,
                "pendingCalls": 0,
                "pendingWrites": 0,
                "observerRemoved": 2,
                "observerRegistered": 2,
                "activationKnown": true,
                "appActive": false,
                "frontmostIsSelf": false,
                "focusGainedEvents": 0,
                "appActivationEvents": 0,
                "mainKeyEvents": 0
            }
        })
    }

    #[test]
    fn schema_three_requires_both_real_pin_transitions_and_safe_revisions() {
        assert!(compute_passed(&complete_report()));

        let mut pin_missing = complete_report();
        pin_missing["searchPins"]["pinReadBack"] = Value::Bool(false);
        assert!(!compute_passed(&pin_missing));

        let mut unpin_missing = complete_report();
        unpin_missing["searchPins"]["mainUnpinned"] = Value::Bool(false);
        assert!(!compute_passed(&unpin_missing));

        let mut skipped_revision = complete_report();
        skipped_revision["searchPins"]["unpinnedRevision"] = json!(13);
        assert!(!compute_passed(&skipped_revision));

        let mut unsafe_revision = complete_report();
        unsafe_revision["searchPins"]["unpinnedRevision"] = json!(9_007_199_254_740_992u64);
        assert!(!compute_passed(&unsafe_revision));
    }
}

#[cfg(test)]
#[path = "local_app_search_error_tests.rs"]
mod local_app_search_error_tests;
