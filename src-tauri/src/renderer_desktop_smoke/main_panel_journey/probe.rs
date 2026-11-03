use super::{
    report,
    state::{DomFacts, Harness, Stage, StageFacts},
};
use serde::Deserialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State, Webview, Wry};

const PROBE_JS: &str = include_str!("probe.js");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Evidence {
    schema_version: u8,
    stage: String,
    document_visibility: String,
    document_has_focus: bool,
    input_found: bool,
    input_focused: bool,
}

pub(super) fn inject(webview: &Webview<Wry>, harness: &Harness) -> Result<(), &'static str> {
    if !harness.mark_probe_injected() {
        return Ok(());
    }
    let token = js_string(&harness.0.token)?;
    let run_id = js_string(&harness.0.profile.run_id)?;
    let pid = std::process::id().to_string();
    let script = PROBE_JS
        .replace("\"__ATOOLS_MAIN_PANEL_TOKEN__\"", &token)
        .replace("\"__ATOOLS_MAIN_PANEL_RUN_ID__\"", &run_id)
        .replace("__ATOOLS_MAIN_PANEL_PID__", &pid);
    webview
        .eval(&script)
        .map_err(|_| report::PROBE_INJECTION_FAILED)
}

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &tauri::webview::PageLoadPayload<'_>) {
    if webview.label() != "main"
        || webview.window().label() != "main"
        || payload.event() != tauri::webview::PageLoadEvent::Finished
        || !super::super::controller::is_local_root_url(payload.url())
    {
        return;
    }
    let Some(harness) = webview.app_handle().try_state::<Harness>() else {
        return;
    };
    if let Err(error) = inject(webview, &harness) {
        harness.note_error(error);
    }
}

pub(super) fn begin_stage(
    webview: &Webview<Wry>,
    harness: &Harness,
    stage: Stage,
) -> Result<
    (
        u64,
        tokio::sync::oneshot::Receiver<Result<StageFacts, &'static str>>,
    ),
    &'static str,
> {
    let (probe_id, receiver) = harness.begin_stage(stage)?;
    let stage_arg = js_string(stage.as_str())?;
    let script = format!("window.__ATOOLS_MAIN_PANEL_PROBE__?.capture({stage_arg},{probe_id});");
    if webview.eval(script).is_err() {
        harness.cancel_stage(probe_id);
        return Err(report::PROBE_INJECTION_FAILED);
    }
    Ok((probe_id, receiver))
}

#[tauri::command(rename_all = "camelCase")]
pub(super) async fn main_panel_probe(
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
    if validate_source(&app, &webview).is_err() {
        harness.note_error(report::PROBE_INVALID);
        return Err(report::PROBE_INVALID.to_owned());
    }
    if token != harness.0.token
        || run_id != harness.0.profile.run_id
        || pid != std::process::id()
        || harness
            .0
            .finished
            .load(std::sync::atomic::Ordering::Acquire)
    {
        harness.note_error(report::PROBE_INVALID);
        return Err(report::PROBE_INVALID.to_owned());
    }
    let evidence: Evidence = serde_json::from_value(evidence).map_err(|_| {
        harness.note_error(report::PROBE_INVALID);
        report::PROBE_INVALID.to_owned()
    })?;
    if evidence.schema_version != 1
        || !matches!(evidence.document_visibility.as_str(), "visible" | "hidden")
        || evidence.input_focused && !evidence.input_found
    {
        harness.note_error(report::PROBE_INVALID);
        return Err(report::PROBE_INVALID.to_owned());
    }
    let stage_name = match evidence.stage.as_str() {
        "ready" | "baseline" | "shown" | "hidden" | "reshown" => evidence.stage.as_str(),
        _ => {
            harness.note_error(report::PROBE_INVALID);
            return Err(report::PROBE_INVALID.to_owned());
        }
    };
    let dom = DomFacts {
        stage: match stage_name {
            "ready" => "ready",
            "baseline" => "baseline",
            "shown" => "shown",
            "hidden" => "hidden",
            "reshown" => "reshown",
            _ => unreachable!("validated probe stage"),
        },
        document_visible: evidence.document_visibility == "visible",
        document_has_focus: evidence.document_has_focus,
        input_found: evidence.input_found,
        input_focused: evidence.input_focused,
    };
    if dom.stage == "ready" {
        if !dom.input_found || !harness.accept_ready(&token, probe_id, dom) {
            harness.note_error(report::PROBE_INVALID);
            return Err(report::PROBE_INVALID.to_owned());
        }
        return Ok(());
    }
    let stage = Stage::parse(dom.stage).ok_or_else(|| {
        harness.note_error(report::PROBE_INVALID);
        report::PROBE_INVALID.to_owned()
    })?;
    if !harness.claim_stage(probe_id, stage) {
        harness.note_error(report::PROBE_INVALID);
        return Err(report::PROBE_INVALID.to_owned());
    }

    let native = match super::operations::capture_window(&app, &harness.0.operations).await {
        Ok(native) => native,
        Err(_) => {
            harness.note_error(report::NATIVE_OPERATION_TIMEOUT);
            harness.fail_stage(probe_id, report::NATIVE_OPERATION_TIMEOUT);
            return Err(report::NATIVE_OPERATION_TIMEOUT.to_owned());
        }
    };
    if stage == Stage::Baseline {
        harness.set_frontmost_baseline(native.frontmost_pid);
    }
    let activation = super::operations::activation_observation(&app, &harness.0.operations).await;
    if stage == Stage::Baseline {
        if let Some(value) = activation.as_ref() {
            let mut state = harness.0.state.lock();
            state.activation.observer_registered = value.get("registered").and_then(Value::as_u64);
            state.activation.observer_removed = value.get("removed").and_then(Value::as_u64);
            state.activation.observer_installed = value.get("installed").and_then(Value::as_bool);
        }
    }
    let facts = stage_facts(&harness, stage, dom, native, activation);
    if !harness.complete_stage(probe_id, stage, facts) {
        harness.note_error(report::PROBE_INVALID);
        return Err(report::PROBE_INVALID.to_owned());
    }
    Ok(())
}

fn stage_facts(
    harness: &Harness,
    _stage: Stage,
    dom: DomFacts,
    native: super::operations::NativeWindowEvidence,
    activation: Option<Value>,
) -> StageFacts {
    let app_activation_events = activation
        .as_ref()
        .and_then(|value| value.get("appActivationEvents"))
        .and_then(Value::as_u64);
    let main_key_events = activation
        .as_ref()
        .and_then(|value| value.get("mainKeyEvents"))
        .and_then(Value::as_u64);
    StageFacts {
        foreground: native.snapshot,
        frontmost_matches_baseline: harness.frontmost_matches_baseline(native.frontmost_pid),
        input_found: Some(dom.input_found),
        input_focused: Some(dom.input_focused),
        content_view_stable: native.content_view_stable,
        document_visible: dom.document_visible,
        document_has_focus: dom.document_has_focus,
        app_activation_events,
        app_activation_event_delta: None,
        main_key_events,
        main_key_event_delta: None,
    }
}

fn validate_source(app: &AppHandle<Wry>, webview: &Webview<Wry>) -> Result<(), &'static str> {
    if webview.label() != "main"
        || webview.window().label() != "main"
        || !super::super::controller::is_local_root_url(
            &webview.url().map_err(|_| report::PROBE_INVALID)?,
        )
        || crate::window::main_webview(app)
            .map(|main| main.label() != webview.label())
            .unwrap_or(true)
    {
        return Err(report::PROBE_INVALID);
    }
    Ok(())
}

fn js_string(value: &str) -> Result<String, &'static str> {
    serde_json::to_string(value).map_err(|_| report::PROBE_INVALID)
}
