use super::{
    report,
    state::{valid_evidence, valid_operation, Evidence, Harness},
};
use serde_json::Value;
use std::collections::BTreeSet;
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    AppHandle, Manager, State, Webview, Wry,
};

pub(super) const COMMAND: &str = "renderer_clipboard_context_probe";
const MAX_EVIDENCE_BYTES: usize = 16 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const EVIDENCE_KEYS: &[&str] = &[
    "schemaVersion",
    "operation",
    "probeId",
    "documentRoot",
    "documentVisibility",
    "documentHasFocus",
    "searchInputCount",
    "clipboardGetterAvailable",
    "pasteCanceled",
    "inputEmpty",
    "inputValueMatches",
    "selectionMatches",
    "textChipMatches",
    "imageChipMatches",
    "fileChipMatches",
    "fileNameMatches",
    "launchContextObserved",
    "launchContextUnchanged",
    "uiUnchanged",
    "getterReturnedNull",
    "getterRejected",
    "naturalWidth",
    "naturalHeight",
    "adapterOutstandingNativeCalls",
];

const PROBE_JS: &str = include_str!("probe.js");

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished
        || webview.label() != "main"
        || webview.window().label() != "main"
        || !super::super::controller::is_local_root_url(payload.url())
    {
        return;
    }
    let app = webview.app_handle();
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    if !harness.profile().clipboard_context_journey {
        return;
    }
    if validate_main_source(&app, webview).is_err() {
        harness.note_error(report::PROBE_INVALID);
        return;
    }
    if !harness.mark_injected() {
        return;
    }
    if let Err(code) = inject(webview, &harness) {
        harness.note_error(code);
    }
}

fn inject(webview: &Webview<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let token = js_string(harness.token())?;
    let run_id = js_string(&harness.profile().run_id)?;
    let fixture_text = js_string(crate::pasteboard_native::clipboard_fixture::FIXTURE_TEXT)?;
    let file_name = js_string(crate::pasteboard_native::clipboard_fixture::FIXTURE_FILE_NAME)?;
    let script = PROBE_JS
        .replace("\"__ATOOLS_CLIPBOARD_TOKEN__\"", &token)
        .replace("\"__ATOOLS_CLIPBOARD_RUN_ID__\"", &run_id)
        .replace("__ATOOLS_CLIPBOARD_PID__", &std::process::id().to_string())
        .replace("\"__ATOOLS_CLIPBOARD_FIXTURE_TEXT__\"", &fixture_text)
        .replace("\"__ATOOLS_CLIPBOARD_FIXTURE_FILE_NAME__\"", &file_name);
    webview
        .eval(&script)
        .map_err(|_| report::PROBE_INJECTION_FAILED)
}

pub(super) fn validate_main_source(
    app: &AppHandle<Wry>,
    webview: &Webview<Wry>,
) -> Result<(), &'static str> {
    let profile = app.try_state::<Harness>().ok_or(report::PROBE_INVALID)?;
    let profile = profile.profile();
    let expected_identifier = format!("dev.atools.renderer-clipboard.{}", profile.run_id);
    if !profile.clipboard_context_journey
        || profile.run_id.len() != 32
        || !profile
            .run_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || profile.identifier != expected_identifier
        || app.config().identifier != expected_identifier
        || webview.label() != "main"
        || webview.window().label() != "main"
        || !super::super::controller::is_local_root_url(
            &webview.url().map_err(|_| report::PROBE_INVALID)?,
        )
    {
        return Err(report::PROBE_INVALID);
    }
    let main = crate::window::main_webview(app).map_err(|_| report::PROBE_INVALID)?;
    if main.label() != webview.label() || main.window().label() != webview.window().label() {
        return Err(report::PROBE_INVALID);
    }
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
pub(super) fn renderer_clipboard_context_probe(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    run_id: String,
    pid: u32,
    probe_id: u64,
    evidence: Value,
) -> Result<(), String> {
    let harness = (*harness).clone();
    let invalid = || {
        harness.note_error(report::PROBE_INVALID);
        report::PROBE_INVALID.to_owned()
    };
    validate_main_source(&app, &webview).map_err(|_| invalid())?;
    if !harness.token_matches(&token)
        || run_id != harness.profile().run_id
        || pid != std::process::id()
        || probe_id > MAX_SAFE_INTEGER
        || (harness.probe_disposed() && evidence["operation"] != "dispose")
    {
        return Err(invalid());
    }
    if !has_exact_evidence_shape(&evidence) {
        return Err(invalid());
    }
    let encoded = serde_json::to_vec(&evidence).map_err(|_| invalid())?;
    if encoded.len() > MAX_EVIDENCE_BYTES {
        return Err(invalid());
    }
    let parsed: Evidence = serde_json::from_value(evidence).map_err(|_| invalid())?;
    let operation = parsed.operation.as_str();
    if parsed.probe_id != probe_id || (!valid_operation(operation) && operation != "ready") {
        return Err(invalid());
    }
    if !valid_evidence(&parsed, operation, probe_id) {
        if operation == "ready" {
            harness.note_error(report::PROBE_READY_INVALID);
            return Err(report::PROBE_READY_INVALID.to_owned());
        }
        return Err(invalid());
    }
    validate_main_source(&app, &webview).map_err(|_| invalid())?;
    if operation == "ready" {
        if probe_id != 0 {
            return Err(invalid());
        }
        let window = crate::window::main_window(&app).ok();
        let visible = window.as_ref().and_then(|window| window.is_visible().ok());
        let focused = window.as_ref().and_then(|window| window.is_focused().ok());
        validate_main_source(&app, &webview).map_err(|_| invalid())?;
        harness
            .accept_ready(parsed, visible, focused)
            .map_err(|code| {
                harness.note_error(code);
                code.to_owned()
            })?;
    } else {
        if probe_id == 0 {
            return Err(invalid());
        }
        harness.accept_evidence(parsed).map_err(|_| invalid())?;
    }
    validate_main_source(&app, &webview).map_err(|_| invalid())
}

fn has_exact_evidence_shape(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    if object.len() != EVIDENCE_KEYS.len() {
        return false;
    }
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    if actual.len() != EVIDENCE_KEYS.len() || !EVIDENCE_KEYS.iter().all(|key| actual.contains(key))
    {
        return false;
    }
    let required_bools = [
        "documentRoot",
        "documentHasFocus",
        "clipboardGetterAvailable",
    ];
    let nullable_bools = [
        "pasteCanceled",
        "inputEmpty",
        "inputValueMatches",
        "selectionMatches",
        "textChipMatches",
        "imageChipMatches",
        "fileChipMatches",
        "fileNameMatches",
        "launchContextObserved",
        "launchContextUnchanged",
        "uiUnchanged",
        "getterReturnedNull",
        "getterRejected",
    ];
    let required_counts = ["schemaVersion", "probeId", "searchInputCount"];
    let nullable_counts = [
        "naturalWidth",
        "naturalHeight",
        "adapterOutstandingNativeCalls",
    ];
    let small_string = |key: &str, max: usize| {
        object
            .get(key)
            .and_then(Value::as_str)
            .is_some_and(|value| value.len() <= max)
    };
    required_bools
        .iter()
        .all(|key| object.get(*key).is_some_and(Value::is_boolean))
        && nullable_bools.iter().all(|key| {
            object
                .get(*key)
                .is_some_and(|value| value.is_null() || value.is_boolean())
        })
        && required_counts.iter().all(|key| {
            object
                .get(*key)
                .and_then(Value::as_u64)
                .is_some_and(|value| value <= u32::MAX.into())
        })
        && nullable_counts.iter().all(|key| {
            object.get(*key).is_some_and(|value| {
                value.is_null()
                    || value
                        .as_u64()
                        .is_some_and(|number| number <= u32::MAX.into())
            })
        })
        && small_string("operation", 32)
        && small_string("documentVisibility", 8)
}

fn js_string(value: &str) -> Result<String, &'static str> {
    serde_json::to_string(value).map_err(|_| report::PROBE_INJECTION_FAILED)
}
