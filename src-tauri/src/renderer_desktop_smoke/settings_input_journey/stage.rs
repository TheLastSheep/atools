use super::{native::Capture, report, state::Harness};
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Wry};

pub(super) async fn record(
    app: &AppHandle<Wry>,
    harness: &Harness,
    started: Instant,
    key: &'static str,
    child_evidence: Option<Value>,
    stale_rejected: Option<bool>,
    fresh_session: Option<bool>,
    main_evidence: Value,
    stage_ok: bool,
    stage_error: &'static str,
) -> Result<(), &'static str> {
    let capture = super::native::capture(app, harness, stale_rejected, fresh_session).await?;
    let dom = build_dom(&main_evidence, child_evidence.as_ref());
    let child_expected = !["startup", "closeCleanup", "finalCleanup"].contains(&key);
    let generic_ok = capture_is_hidden(&capture, key, child_expected)
        && dom["mainReady"].as_bool() == Some(true)
        && dom["mainDocumentHidden"].as_bool() == Some(true)
        && dom["mainDocumentHasFocus"].as_bool() == Some(false)
        && dom["childReady"].as_bool() == Some(child_expected)
        && (child_expected
            && dom["childDocumentHidden"].as_bool() == Some(true)
            && dom["childDocumentHasFocus"].as_bool() == Some(false)
            || !child_expected
                && dom["childDocumentHidden"].is_null()
                && dom["childDocumentHasFocus"].is_null());
    let passed = stage_ok && generic_ok;
    let mut errors = Vec::new();
    if !stage_ok {
        errors.push(stage_error);
    }
    if !generic_ok {
        errors.push("settings-input-hidden-presentation-invalid");
    }
    push(
        harness,
        key,
        elapsed_ms(started),
        dom,
        capture,
        stale_rejected,
        fresh_session,
        passed,
        errors.first().copied(),
    );
    for error in errors {
        harness.add_error(error);
    }
    super::material::record_stage(app, harness, started, key).await;
    if passed {
        Ok(())
    } else {
        Err(stage_error)
    }
}

pub(super) fn push(
    harness: &Harness,
    key: &'static str,
    elapsed: u64,
    dom: Value,
    capture: Capture,
    stale_rejected: Option<bool>,
    fresh_session: Option<bool>,
    passed: bool,
    error: Option<&'static str>,
) {
    let mut native = capture.native.clone();
    native["staleInputRejected"] = stale_rejected.map_or(Value::Null, Value::Bool);
    native["freshSession"] = fresh_session.map_or(Value::Null, Value::Bool);
    let errors = error.into_iter().collect::<Vec<_>>();
    harness.push_stage(report::stage(
        key,
        passed,
        elapsed.max(1),
        dom,
        native,
        capture.activation,
        capture.presentation,
        &errors,
    ));
}

pub(super) fn build_dom(main: &Value, child: Option<&Value>) -> Value {
    let main_ready = main["inputFound"].as_bool() == Some(true);
    let absent = child.is_none();
    let empty = report::empty_dom();
    let child = child.unwrap_or(&empty);
    json!({
        "mainReady": main_ready,
        "childReady": !absent,
        "routeValid": if absent { Value::Null } else { child["routeValid"].clone() },
        "matchedCount": if absent { Value::Null } else { child["matchedCount"].clone() },
        "restoredCount": if absent { Value::Null } else { child["restoredCount"].clone() },
        "inputEmpty": main["inputEmpty"].as_bool().unwrap_or(false),
        "queryMatches": if absent { Value::Null } else { child["queryMatches"].clone() },
        "baselineCount": if absent { Value::Null } else { child["baselineCount"].clone() },
        "filteredCount": if absent { Value::Null } else { child["filteredCount"].clone() },
        "mainDocumentHidden": main["documentHidden"].as_bool().unwrap_or(false),
        "mainDocumentHasFocus": main["documentHasFocus"].as_bool().unwrap_or(true),
        "childDocumentHidden": if absent { Value::Null } else { child["documentHidden"].clone() },
        "childDocumentHasFocus": if absent { Value::Null } else { child["documentHasFocus"].clone() },
    })
}

pub(super) fn capture_is_hidden(capture: &Capture, key: &str, child_expected: bool) -> bool {
    let native = &capture.native;
    let activation = &capture.activation;
    let presentation = &capture.presentation;
    let final_stage = key == "finalCleanup";
    native["windowVisible"].as_bool() == Some(false)
        && native["windowFocused"].as_bool() == Some(false)
        && native["focusGainedEvents"].as_u64() == Some(0)
        && native["mainDataStorePersistent"].as_bool() == Some(false)
        && native["pendingCalls"].as_u64() == Some(0)
        && native["pendingWrites"].as_u64() == Some(0)
        && native["sessionCount"].as_u64() == Some(u64::from(child_expected))
        && native["childCount"].as_u64() == Some(u64::from(child_expected))
        && native["layoutCount"].as_u64() == Some(u64::from(child_expected))
        && if child_expected {
            native["inputVisible"].as_bool() == Some(true)
                && native["generation"].as_u64().is_some_and(|value| value > 0)
                && native["valueVersion"].as_u64().is_some()
                && native["childDataStorePersistent"].as_bool() == Some(false)
                && native["opaqueSessionId"].as_str().is_some()
        } else {
            native["inputVisible"].as_bool() == Some(false)
                && native["generation"].is_null()
                && native["valueVersion"].is_null()
                && native["childDataStorePersistent"].is_null()
                && native["opaqueSessionId"].is_null()
                && native["valueBytes"].as_u64() == Some(0)
        }
        && activation["known"].as_bool() == Some(true)
        && activation["installed"].as_bool() == Some(!final_stage)
        && activation["registered"].as_u64() == Some(2)
        && activation["removed"].as_u64() == Some(if final_stage { 2 } else { 0 })
        && activation["appActive"].as_bool() == Some(false)
        && activation["frontmostIsSelf"].as_bool() == Some(false)
        && activation["appActivationEvents"].as_u64() == Some(0)
        && activation["mainKeyEvents"].as_u64() == Some(0)
        && presentation["hiddenSmoke"].as_bool() == Some(true)
        && presentation["suppressedFocusRequests"]
            .as_u64()
            .is_some_and(|count| focus_suppression_valid(key, count))
}

fn focus_suppression_valid(key: &str, count: u64) -> bool {
    match key {
        "startup" => count == 0,
        "finalCleanup" => true,
        _ => count > 0,
    }
}

pub(super) fn cleanup_snapshot(capture: &Capture) -> Value {
    json!({
        "sessionCount": capture.native["sessionCount"],
        "childCount": capture.native["childCount"],
        "layoutCount": capture.native["layoutCount"],
        "pendingCalls": capture.native["pendingCalls"],
        "pendingWrites": capture.native["pendingWrites"],
        "observerRemoved": capture.activation["removed"],
        "observerRegistered": capture.activation["registered"],
        "activationKnown": capture.activation["known"],
        "appActive": capture.activation["appActive"],
        "frontmostIsSelf": capture.activation["frontmostIsSelf"],
        "focusGainedEvents": capture.native["focusGainedEvents"],
        "appActivationEvents": capture.activation["appActivationEvents"],
        "mainKeyEvents": capture.activation["mainKeyEvents"],
    })
}

pub(super) fn failed_capture() -> Capture {
    Capture {
        native: report::empty_native(),
        activation: json!({
            "installed": false, "registered": 0, "removed": 0,
            "appActive": true, "frontmostIsSelf": true,
            "appActivationEvents": 0, "mainKeyEvents": 0, "known": false,
        }),
        presentation: json!({"hiddenSmoke": false, "suppressedFocusRequests": 0}),
    }
}

pub(super) fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::super::native::Capture;
    use super::{capture_is_hidden, focus_suppression_valid};
    use serde_json::json;

    fn cleaned_capture(suppressed_focus_requests: u64) -> Capture {
        Capture {
            native: json!({
                "sessionCount": 0,
                "childCount": 0,
                "layoutCount": 0,
                "pendingCalls": 0,
                "pendingWrites": 0,
                "controlSequence": 0,
                "userSequence": 0,
                "valueBytes": 0,
                "inputVisible": false,
                "windowVisible": false,
                "windowFocused": false,
                "focusGainedEvents": 0,
                "generation": null,
                "valueVersion": null,
                "mainDataStorePersistent": false,
                "childDataStorePersistent": null,
                "staleInputRejected": null,
                "freshSession": null,
                "opaqueSessionId": null
            }),
            activation: json!({
                "installed": false,
                "registered": 2,
                "removed": 2,
                "appActive": false,
                "frontmostIsSelf": false,
                "appActivationEvents": 0,
                "mainKeyEvents": 0,
                "known": true
            }),
            presentation: json!({
                "hiddenSmoke": true,
                "suppressedFocusRequests": suppressed_focus_requests
            }),
        }
    }

    #[test]
    fn final_cleanup_accepts_zero_without_a_child_but_keeps_cleanup_gates() {
        let capture = cleaned_capture(0);
        assert!(capture_is_hidden(&capture, "finalCleanup", false));

        let mut pending_call = cleaned_capture(0);
        pending_call.native["pendingCalls"] = json!(1);
        assert!(!capture_is_hidden(&pending_call, "finalCleanup", false));

        let mut visible_window = cleaned_capture(0);
        visible_window.native["windowVisible"] = json!(true);
        assert!(!capture_is_hidden(&visible_window, "finalCleanup", false));

        let mut active_observer = cleaned_capture(0);
        active_observer.activation["installed"] = json!(true);
        assert!(!capture_is_hidden(&active_observer, "finalCleanup", false));
    }

    #[test]
    fn startup_stays_zero_and_all_successful_stages_still_require_suppression() {
        assert!(focus_suppression_valid("startup", 0));
        assert!(!focus_suppression_valid("startup", 1));
        for key in [
            "openAllCommands",
            "mainMatch",
            "mainNoMatch",
            "mainClear",
            "childValueReturn",
            "ownerRotation",
            "closeCleanup",
            "freshReopen",
        ] {
            assert!(!focus_suppression_valid(key, 0), "{key}");
            assert!(focus_suppression_valid(key, 1), "{key}");
        }
        assert!(focus_suppression_valid("finalCleanup", 0));
        assert!(focus_suppression_valid("finalCleanup", 1));
    }
}
