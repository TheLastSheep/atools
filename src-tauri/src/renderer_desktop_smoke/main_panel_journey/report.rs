use super::state::{Harness, Stage, StageFacts};
use serde_json::{json, Value};

pub(super) const OBSERVER_INSTALL_FAILED: &str = "main-panel-prototype-observer-install-failed";
pub(super) const PANEL_INSTALL_FAILED: &str = "main-panel-prototype-panel-install-failed";
pub(super) const PROBE_INJECTION_FAILED: &str = "main-panel-prototype-probe-injection-failed";
pub(super) const DOM_READY_TIMEOUT: &str = "main-panel-prototype-dom-ready-timeout";
pub(super) const PROBE_INVALID: &str = "main-panel-prototype-probe-invalid";
pub(super) const PROBE_ORDER_INVALID: &str = "main-panel-prototype-probe-order-invalid";
pub(super) const PROBE_ID_EXHAUSTED: &str = "main-panel-prototype-probe-id-exhausted";
pub(super) const BASELINE_INVALID: &str = "main-panel-prototype-baseline-invalid";
pub(super) const SHOW_FAILED: &str = "main-panel-prototype-show-failed";
pub(super) const SHOWN_INVALID: &str = "main-panel-prototype-shown-invalid";
pub(super) const HIDE_FAILED: &str = "main-panel-prototype-hide-failed";
pub(super) const HIDDEN_INVALID: &str = "main-panel-prototype-hidden-invalid";
pub(super) const TOGGLE_RESHOW_FAILED: &str = "main-panel-prototype-toggle-reshow-failed";
pub(super) const RESHOWN_INVALID: &str = "main-panel-prototype-reshown-invalid";
pub(super) const FINAL_HIDE_FAILED: &str = "main-panel-prototype-final-hide-failed";
pub(super) const OBSERVER_CLEANUP_FAILED: &str = "main-panel-prototype-observer-cleanup-failed";
pub(super) const RESTORE_FAILED: &str = "main-panel-prototype-restore-failed";
pub(super) const CLEANUP_STATE_INVALID: &str = "main-panel-prototype-cleanup-state-invalid";
pub(super) const NATIVE_OPERATION_TIMEOUT: &str = "main-panel-prototype-native-operation-timeout";
pub(super) const WATCHDOG_EXPIRED: &str = "main-panel-prototype-watchdog-expired";

const CONVERSION_TRUE_FIELDS: &[&str] = &[
    "scopedIdentifierMatches",
    "mainWindowHiddenBeforeConversion",
    "sameNativeWindow",
    "focusableLayoutSafe",
    "isPanel",
    "panelClassMatches",
    "nonactivatingStyle",
    "selectorAvailable",
    "canBecomeKey",
    "stillHidden",
    "originalDelegateUnchanged",
    "contentViewAndParentUnchanged",
    "collectionBehaviorUnchanged",
    "releasedWhenClosedUnchanged",
    "subviewMasksAdjusted",
];

const RESTORATION_TRUE_FIELDS: &[&str] = &[
    "sameNativeWindow",
    "originalClassRestored",
    "originalDelegateRestored",
    "releasedWhenClosedRestored",
    "subviewMasksRestored",
    "contentViewRestored",
    "styleMaskRestored",
    "levelRestored",
    "collectionBehaviorRestored",
    "hidesOnDeactivateRestored",
    "canBecomeKeyRestored",
    "canBecomeMainRestored",
    "panelFloatingBaselineRestored",
    "panelBecomesKeyBaselineRestored",
    "windowRestored",
];

pub(super) fn report(harness: &Harness) -> Value {
    let state = harness.0.state.lock();
    let conversion = state.conversion.clone();
    let restoration = state.restoration.clone();
    let stages = Stage::ALL
        .iter()
        .map(|stage| {
            state.stages[stage.index()]
                .as_ref()
                .and_then(|facts| serde_json::to_value(facts).ok())
                .unwrap_or(Value::Null)
        })
        .collect::<Vec<_>>();
    let activation = serde_json::to_value(&state.activation).unwrap_or(Value::Null);
    let cleanup = serde_json::to_value(&state.cleanup).unwrap_or(Value::Null);
    let errors = state.errors.clone();
    let passed = errors.is_empty()
        && conversion.as_ref().is_some_and(valid_conversion)
        && restoration.as_ref().is_some_and(valid_restoration)
        && text_method_state_matches(conversion.as_ref(), restoration.as_ref())
        && stages.iter().enumerate().all(|(index, value)| {
            state.stages[index].as_ref().is_some_and(|facts| {
                stage_is_valid(Stage::ALL[index], facts, state.baseline_app_active)
            }) && !value.is_null()
        })
        && state.cleanup.window_hidden == Some(true)
        && state.cleanup.panel_active == Some(false)
        && state.cleanup.native_operations_terminal
        && state.cleanup.observers_removed == Some(true)
        && state.activation.observer_registered == Some(2)
        && state.activation.observer_removed == Some(2)
        && state.activation.observer_installed == Some(false)
        && state.activation.app_activation_event_delta == Some(0)
        && state
            .activation
            .main_key_event_delta
            .is_some_and(|delta| delta >= 2);

    json!({
        "schemaVersion": 1,
        "kind": "main-panel-prototype",
        "journey": "main-panel",
        "scope": "isolated-main-window-panel-prototype",
        "identifier": harness.0.profile.identifier.clone(),
        "root": harness.0.profile.root.to_string_lossy().into_owned(),
        "pid": std::process::id(),
        "runId": harness.0.profile.run_id.clone(),
        "fullProductAcceptance": false,
        "visualStatus": "not-captured",
        "conversion": conversion,
        "restoration": restoration,
        "stages": {
            "baseline": stages[0].clone(),
            "shown": stages[1].clone(),
            "hidden": stages[2].clone(),
            "reshown": stages[3].clone(),
        },
        "activation": activation,
        "cleanup": cleanup,
        "errors": errors,
        "passed": passed,
    })
}

#[cfg(test)]
#[path = "report_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "report_stage_tests.rs"]
mod stage_tests;

fn valid_conversion(value: &Value) -> bool {
    CONVERSION_TRUE_FIELDS
        .iter()
        .all(|field| value.get(*field).and_then(Value::as_bool) == Some(true))
        && valid_original_class_assessment(value.get("originalClassAssessment"), value)
        && value.get("panelClass").and_then(Value::as_str) == Some("AToolsMainPanel")
        && value
            .get("originalInstanceSize")
            .and_then(Value::as_u64)
            .is_some_and(|size| {
                value
                    .get("panelInstanceSize")
                    .and_then(Value::as_u64)
                    .is_some_and(|panel| panel <= size)
            })
        && value
            .get("panelInstanceSize")
            .and_then(Value::as_u64)
            .is_some_and(|panel| {
                value
                    .get("taoFocusableOffset")
                    .and_then(Value::as_u64)
                    .is_some_and(|offset| {
                        offset >= panel
                            && offset
                                .checked_add(std::mem::size_of::<objc2::runtime::Bool>() as u64)
                                .is_some_and(|end| {
                                    value
                                        .get("originalInstanceSize")
                                        .and_then(Value::as_u64)
                                        .is_some_and(|original| end <= original)
                                })
                    })
            })
        && value.get("canBecomeMain").and_then(Value::as_bool) == Some(false)
        && value.get("nsPanelOwnIvarCount").and_then(Value::as_u64) == Some(0)
        && value.get("floating").and_then(Value::as_bool) == Some(true)
        && value.get("hidesOnDeactivate").and_then(Value::as_bool) == Some(false)
        && value.get("becomesKeyOnlyIfNeeded").and_then(Value::as_bool) == Some(false)
        && value.get("level").and_then(Value::as_i64)
            == i64::try_from(objc2_app_kit::NSModalPanelWindowLevel + 1).ok()
        && nullable_bool(value.get("textInputMethodAdded"))
        && value.get("runtimeMethodLifetime").and_then(Value::as_str) == Some("until-process-exit")
        && value
            .get("runtimeMethodRemovalSupported")
            .and_then(Value::as_bool)
            == Some(false)
}

fn valid_original_class_assessment(assessment: Option<&Value>, conversion: &Value) -> bool {
    const KEYS: &[&str] = &[
        "kind",
        "actualClass",
        "reportedClass",
        "actualSuperclass",
        "actualInstanceSize",
        "taoInstanceSize",
        "ownIvarCount",
        "ownMethodNames",
        "taoDirectSuperclassIsNsWindow",
    ];
    let Some(assessment) = assessment else {
        return false;
    };
    let Some(object) = assessment.as_object() else {
        return false;
    };
    if object.len() != KEYS.len() || KEYS.iter().any(|key| !object.contains_key(*key)) {
        return false;
    }
    let Some(kind) = assessment.get("kind").and_then(Value::as_str) else {
        return false;
    };
    let Some(actual_class) = assessment.get("actualClass").and_then(Value::as_str) else {
        return false;
    };
    let Some(reported_class) = assessment.get("reportedClass").and_then(Value::as_str) else {
        return false;
    };
    let Some(actual_superclass) = assessment.get("actualSuperclass").and_then(Value::as_str) else {
        return false;
    };
    let Some(actual_size) = assessment.get("actualInstanceSize").and_then(Value::as_u64) else {
        return false;
    };
    let Some(tao_size) = assessment.get("taoInstanceSize").and_then(Value::as_u64) else {
        return false;
    };
    let Some(_own_ivar_count) = assessment.get("ownIvarCount").and_then(Value::as_u64) else {
        return false;
    };
    let Some(methods) = assessment.get("ownMethodNames").and_then(Value::as_array) else {
        return false;
    };
    let mut previous: Option<&str> = None;
    for method in methods {
        let Some(method) = method.as_str() else {
            return false;
        };
        if previous.is_some_and(|last: &str| last >= method) {
            return false;
        }
        previous = Some(method);
    }
    let direct_superclass_is_nswindow = assessment
        .get("taoDirectSuperclassIsNsWindow")
        .and_then(Value::as_bool)
        == Some(true);
    if reported_class != "TaoWindow"
        || actual_class
            != conversion
                .get("originalClass")
                .and_then(Value::as_str)
                .unwrap_or_default()
        || actual_size != tao_size
        || actual_size
            != conversion
                .get("originalInstanceSize")
                .and_then(Value::as_u64)
                .unwrap_or(0)
        || !direct_superclass_is_nswindow
    {
        return false;
    }
    match kind {
        "tao" => actual_class == "TaoWindow" && actual_superclass == "NSWindow",
        "foundation-kvo-content-view" => {
            actual_class == "NSKVONotifying_TaoWindow"
                && actual_superclass == "TaoWindow"
                && assessment.get("ownIvarCount").and_then(Value::as_u64) == Some(0)
                && methods.len() == 4
                && methods[0].as_str() == Some("_isKVOA")
                && methods[1].as_str() == Some("class")
                && methods[2].as_str() == Some("dealloc")
                && methods[3].as_str() == Some("setContentView:")
        }
        _ => false,
    }
}

fn valid_restoration(value: &Value) -> bool {
    RESTORATION_TRUE_FIELDS
        .iter()
        .all(|field| value.get(*field).and_then(Value::as_bool) == Some(true))
        && nullable_bool(value.get("textInputMethodRemains"))
        && value.get("runtimeMethodLifetime").and_then(Value::as_str) == Some("until-process-exit")
        && value
            .get("runtimeMethodRemovalSupported")
            .and_then(Value::as_bool)
            == Some(false)
}

fn nullable_bool(value: Option<&Value>) -> bool {
    match value {
        Some(Value::Bool(_) | Value::Null) => true,
        _ => false,
    }
}

fn text_method_state_matches(conversion: Option<&Value>, restoration: Option<&Value>) -> bool {
    conversion
        .and_then(|value| value.get("textInputMethodAdded"))
        .and_then(Value::as_bool)
        .zip(
            restoration
                .and_then(|value| value.get("textInputMethodRemains"))
                .and_then(Value::as_bool),
        )
        .is_some_and(|(added, remains)| added == remains)
}

pub(super) fn stage_is_valid(
    stage: Stage,
    facts: &StageFacts,
    baseline_app_active: Option<bool>,
) -> bool {
    let foreground = &facts.foreground;
    let known_main_window = foreground
        .get("mainWindowAvailable")
        .and_then(Value::as_bool)
        == Some(true);
    let app_state_stable = baseline_app_active.is_some()
        && foreground.get("appActive").and_then(Value::as_bool) == baseline_app_active;
    let native_window = match stage {
        Stage::Baseline => {
            app_state_stable
                && facts.app_activation_event_delta == Some(0)
                && facts.main_key_event_delta == Some(0)
                && known_main_window
                && foreground.get("mainVisible").and_then(Value::as_bool) == Some(false)
                && foreground.get("mainKey").and_then(Value::as_bool) == Some(false)
                && foreground.get("mainFocused").and_then(Value::as_bool) == Some(false)
                && facts.frontmost_matches_baseline == Some(true)
                && facts.input_found == Some(true)
                && !facts.document_has_focus
        }
        Stage::Shown | Stage::Reshown => {
            app_state_stable
                && facts.app_activation_event_delta == Some(0)
                && facts
                    .main_key_event_delta
                    .is_some_and(|delta| delta >= if stage == Stage::Shown { 1 } else { 2 })
                && known_main_window
                && foreground.get("appHidden").and_then(Value::as_bool) == Some(false)
                && foreground.get("mainVisible").and_then(Value::as_bool) == Some(true)
                && foreground.get("mainKey").and_then(Value::as_bool) == Some(true)
                && foreground.get("mainFocused").and_then(Value::as_bool) == Some(true)
                && foreground.get("mainOnActiveSpace").and_then(Value::as_bool) == Some(true)
                && foreground
                    .get("mainOcclusionVisible")
                    .and_then(Value::as_bool)
                    == Some(true)
                && facts.frontmost_matches_baseline == Some(true)
                && facts.input_found == Some(true)
                && facts.input_focused == Some(true)
                && facts.document_visible
                && facts.document_has_focus
        }
        Stage::Hidden => {
            app_state_stable
                && facts.app_activation_event_delta == Some(0)
                && facts.main_key_event_delta.is_some_and(|delta| delta >= 1)
                && known_main_window
                && foreground.get("mainVisible").and_then(Value::as_bool) == Some(false)
                && foreground.get("mainKey").and_then(Value::as_bool) == Some(false)
                && foreground.get("mainFocused").and_then(Value::as_bool) == Some(false)
                && facts.frontmost_matches_baseline == Some(true)
                && facts.input_found == Some(true)
                && !facts.document_has_focus
        }
    };
    facts.content_view_stable == Some(true) && native_window
}
