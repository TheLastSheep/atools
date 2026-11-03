#[path = "report_writer.rs"]
mod writer;
use super::{Session, DEADLINE_SECONDS};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

pub(super) fn initial(
    profile: &super::super::profile::Profile,
    seed: Value,
    sources: Value,
) -> Value {
    json!({"schemaVersion":1,"kind":"settings-height","runId":profile.run_id,"pid":std::process::id(),
        "root":profile.root,"identifier":profile.identifier,"heightCase":profile.settings_height_case.unwrap().as_str(),
        "deadlineSeconds":DEADLINE_SECONDS,"lifecyclePhase":"journey-complete-before-host-teardown",
        "status":"failed","errors":[],"rawGeneral":{"before":null,"after":null},"seed":seed,"sources":sources,
        "openings":[],"closes":[],"stagesCompleted":[],"elapsedMs":0,"elapsedSamplePhase":"before-report-serialization-and-fsync","processExit":null,"guiAcceptance":"unverified",
        "hostSetup":{"windowPath":"production-create-main-from-config","materialPath":"production-install-configured",
            "resizePath":"production-settings-lifecycle-f64-workarea","macosMainPanelPrototype":cfg!(feature="macos-main-panel-prototype"),
            "excludedStartupServices":["desktop-plugins","catalog-watcher","tray","login-item-probe","clipboard-monitor","mcp","node","launch-probes"]},
        "isolation":{"loginItemStatus":"fixture-unavailable","shortcutPluginInstalled":false,
            "clipboardReads":0,"clipboardWrites":0,"clipboardPastes":0}})
}
pub(super) fn error(session: &Session, error: &str) {
    if let Ok(mut value) = session.report.lock() {
        let errors = value["errors"].as_array_mut().unwrap();
        if errors.len() < 32 {
            errors.push(Value::String(error.chars().take(256).collect()));
        } else if errors.len() == 32 {
            errors.push(json!("height-error-overflow"));
        }
    }
}
pub(super) fn update(app: &AppHandle, edit: impl FnOnce(&mut Value)) {
    edit(&mut app.state::<Session>().report.lock().unwrap());
}
pub(super) fn stage(app: &AppHandle, name: &str) {
    update(app, |report| {
        report["stagesCompleted"]
            .as_array_mut()
            .unwrap()
            .push(json!(name))
    });
}
pub(super) fn finish(app: &AppHandle) -> i32 {
    let session = app.state::<Session>();
    if session.reported.swap(true, Ordering::AcqRel) {
        return 1;
    }
    if let Err(message) = super::validate(app) {
        error(&session, &message);
    }
    if !within_producer_limit(session.started.elapsed()) {
        error(&session, "height-native-total-limit-exceeded");
    }
    let mut value = session.report.lock().unwrap();
    let reads = session.clipboard.reads.load(Ordering::Relaxed);
    let writes = session.clipboard.writes.load(Ordering::Relaxed);
    let pastes = session.clipboard.pastes.load(Ordering::Relaxed);
    value["isolation"]["clipboardReads"] = json!(reads);
    value["isolation"]["clipboardWrites"] = json!(writes);
    value["isolation"]["clipboardPastes"] = json!(pastes);
    let shortcut = app
        .try_state::<tauri_plugin_global_shortcut::GlobalShortcut<tauri::Wry>>()
        .is_some();
    value["isolation"]["shortcutPluginInstalled"] = json!(shortcut);
    if !facts_complete(session.profile.settings_height_case.unwrap(), &value) {
        value["errors"]
            .as_array_mut()
            .unwrap()
            .push(json!("height-stages-incomplete"));
    }
    if reads + writes + pastes != 0 || shortcut {
        value["errors"]
            .as_array_mut()
            .unwrap()
            .push(json!("height-isolation-violation"));
    }
    let passed = receipt_passed(session.profile.settings_height_case.unwrap(), &value);
    value["status"] = json!(if passed { "passed" } else { "failed" });
    value["elapsedMs"] = json!(session.started.elapsed().as_millis() as u64);
    let emission = writer::write_owned(
        &session.profile,
        &value,
        || session.started.elapsed(),
        |profile, value| profile.write_report(value),
    );
    if let Err(error) = &emission {
        eprintln!("height report emission failed: {error}");
    }
    let code = writer::exit_code(passed, &emission);
    session.result_code.store(code, Ordering::Release);
    code
}

pub(super) fn terminal_code(code: i32, elapsed: std::time::Duration) -> i32 {
    if code == 0 && within_producer_limit(elapsed) {
        0
    } else {
        1
    }
}
fn within_producer_limit(elapsed: std::time::Duration) -> bool {
    elapsed <= std::time::Duration::from_secs(175)
}
fn receipt_passed(case: super::super::profile::HeightCase, value: &Value) -> bool {
    facts_complete(case, value)
        && value["errors"]
            .as_array()
            .is_some_and(|errors| errors.is_empty())
}
fn stages_complete(case: super::super::profile::HeightCase, stages: &Value) -> bool {
    *stages == json!(case.stages())
}
fn facts_complete(case: super::super::profile::HeightCase, value: &Value) -> bool {
    if !stages_complete(case, &value["stagesCompleted"]) {
        return false;
    }
    let Some(openings) = value["openings"].as_array() else {
        return false;
    };
    let Some(closes) = value["closes"].as_array() else {
        return false;
    };
    let expected = if case == super::super::profile::HeightCase::D {
        (1, 1)
    } else {
        (3, 2)
    };
    if (openings.len(), closes.len()) != expected {
        return false;
    }
    if openings.iter().any(|opening| {
        !super::main_entry::receipt_healthy(
            &opening["mainClient"],
            &opening["mainWindowNotifications"],
            "loaded",
        ) || opening["stability"]["before"] != opening["stability"]["after"]
            || !opening["stability"]["before"].is_object()
            || opening["stability"]["attempts"]
                .as_u64()
                .is_none_or(|attempt| !(1..=3).contains(&attempt))
            || opening["hidden"] != true
            || opening["unfocused"] != true
            || opening["checks"].as_object().is_none_or(|checks| {
                checks.len() != 10 || checks.values().any(|check| check != true)
            })
    }) {
        return false;
    }
    if closes.iter().any(|close| {
        if !super::main_entry::receipt_healthy(
            &close["mainClient"],
            &close["mainWindowNotifications"],
            "back-to-search",
        ) {
            return true;
        }
        [
            "childAbsent",
            "layoutAbsent",
            "pendingDrained",
            "hidden",
            "unfocused",
        ]
        .iter()
        .any(|key| close[*key] != true)
    }) {
        return false;
    }
    let Some(first) = openings[0]["sessionId"].as_str() else {
        return false;
    };
    if first.is_empty() || closes[0]["sessionId"] != first {
        return false;
    }
    if expected.0 == 3 {
        let Some(reopened) = openings[2]["sessionId"].as_str() else {
            return false;
        };
        if reopened.is_empty()
            || reopened == first
            || openings[1]["sessionId"] != first
            || closes[1]["sessionId"] != reopened
        {
            return false;
        }
        if openings[0]["bundleRevision"] != openings[2]["bundleRevision"] {
            return false;
        }
    } else if openings[0]["parentClipped"] != true {
        return false;
    }
    value["rawGeneral"]["before"].is_string() && value["rawGeneral"]["after"].is_string()
}
#[cfg(test)]
mod tests {
    use super::super::super::profile::HeightCase;
    use super::*;
    #[test]
    fn producer_limit_includes_setup_and_cleanup_without_accepting_a_late_success() {
        assert!(within_producer_limit(std::time::Duration::from_secs(170)));
        assert!(within_producer_limit(std::time::Duration::from_secs(175)));
        assert!(!within_producer_limit(std::time::Duration::from_millis(
            175001
        )));
        assert_eq!(
            terminal_code(0, std::time::Duration::from_millis(175001)),
            1
        );
        assert_eq!(terminal_code(0, std::time::Duration::from_secs(175)), 0);
        assert_eq!(terminal_code(1, std::time::Duration::ZERO), 1);
    }
    #[test]
    fn missing_duplicated_late_or_timed_out_stages_never_form_complete_receipt() {
        assert!(stages_complete(
            HeightCase::A,
            &json!(HeightCase::A.stages())
        ));
        assert!(stages_complete(
            HeightCase::D,
            &json!(HeightCase::D.stages())
        ));
        for stages in [
            json!([]),
            json!(["initial-open"]),
            json!(["initial-open", "initial-open", "initial-closed"]),
            json!(["initial-closed", "initial-open"]),
        ] {
            assert!(!stages_complete(HeightCase::A, &stages));
            assert!(!stages_complete(HeightCase::D, &stages));
        }
    }
}

#[cfg(test)]
mod completion_tests {
    use super::super::super::profile::HeightCase;
    use super::*;
    fn client(phase: &str) -> Value {
        json!({"version":1,"listenerState":"listening","activePhase":phase,"pendingOpen":false,
        "openFailures":0,"closeFailures":0,"invalidPayloads":0,"registrationErrors":0,"lateListenerUnlistens":0,"cleanupErrors":0})
    }
    fn notifications() -> Value {
        json!({"pendingReplies":0,"failures":0,"cancelled":0,"dropped":0})
    }
    fn observation(id: &str) -> Value {
        json!({"sessionId":id,"bundleRevision":"source","hidden":true,"unfocused":true,
            "mainClient":client("loaded"),"mainWindowNotifications":notifications(),"stability":{"attempts":1,"before":{},"after":{}},
            "checks":{"identity":true,"ready":true,"registration":true,"parentHeight":true,"parentWidthPositive":true,
            "childHeight":true,"childHeader":true,"childWidth":true,"hidden":true,"unfocused":true}})
    }
    fn closed(id: &str) -> Value {
        json!({"sessionId":id,"childAbsent":true,"layoutAbsent":true,"pendingDrained":true,"hidden":true,"unfocused":true,
            "mainClient":client("back-to-search"),"mainWindowNotifications":notifications()})
    }
    fn completed() -> Value {
        json!({"stagesCompleted":HeightCase::A.stages(),"rawGeneral":{"before":"{}","after":"{}"},
        "openings":[observation("first"),observation("first"),observation("new")],"closes":[closed("first"),closed("new")]})
    }
    #[test]
    fn apparent_stage_success_cannot_hide_missing_geometry_old_generation_or_duplicate_close() {
        let good = completed();
        assert!(facts_complete(HeightCase::A, &good));
        let mut timed_out = good.clone();
        timed_out["errors"] = json!(["height-native-deadline"]);
        assert!(!receipt_passed(HeightCase::A, &timed_out));
        let mut bad = good.clone();
        bad["openings"][0]["mainClient"] = json!(null);
        assert!(!facts_complete(HeightCase::A, &bad));
        let mut bad = good.clone();
        bad["closes"][0]["mainClient"] = client("loaded");
        assert!(!facts_complete(HeightCase::A, &bad));
        let mut bad = good.clone();
        bad["openings"][0]["stability"]["after"] = json!({"changed":true});
        assert!(!facts_complete(HeightCase::A, &bad));
        let mut bad = good.clone();
        bad["openings"] = json!([]);
        assert!(!facts_complete(HeightCase::A, &bad));
        let mut bad = good.clone();
        bad["openings"][2]["sessionId"] = json!("first");
        assert!(!facts_complete(HeightCase::A, &bad));
        let mut bad = good.clone();
        bad["closes"][1] = closed("first");
        assert!(!facts_complete(HeightCase::A, &bad));
        let mut bad = good.clone();
        bad["closes"][1]["pendingDrained"] = json!(false);
        assert!(!facts_complete(HeightCase::A, &bad));
        let mut bad = good;
        bad["openings"][2]["checks"]["childHeight"] = json!(false);
        assert!(!facts_complete(HeightCase::A, &bad));
    }
}
