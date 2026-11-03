//! Isolated Tauri probe for an app-owned related WebView and opaque plugin frame.
//!
//! This example deliberately has no Node runtime, AppState, database, or ATools
//! library startup. It reports one JSON line to stdout and exits after 20 seconds
//! if the browser-side handshake does not finish.

#[path = "native_related_window_probe/state.rs"]
mod state;

use serde_json::{json, Value};
use state::{Completion, ProbeState};
use std::io::Write;
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    http::{Method, Request, Response, StatusCode},
    Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const SCHEME: &str = "atools-native-probe";
const PARENT_URL: &str = "atools-native-probe://localhost/parent";
const CHILD_URL: &str = "atools-native-probe://localhost/child";
const PARENT_LABEL: &str = "probe-parent";
const CHILD_LABEL: &str = "probe-child";
const PARENT_HTML: &str = include_str!("native_related_window_probe/parent.html");
const CHILD_HTML: &str = include_str!("native_related_window_probe/child.html");

#[tauri::command]
fn report_native_related_window_probe(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: State<'_, ProbeState>,
    nonce: String,
    stage: String,
    details: Value,
) -> Result<Value, String> {
    if window.label() != PARENT_LABEL
        || window.url().map_err(|e| e.to_string())?.as_str() != PARENT_URL
    {
        return Err("Probe reports are accepted only from the fixed parent window".into());
    }
    if !state.matches_nonce(&nonce) {
        return Err("Probe nonce mismatch".into());
    }
    if details.to_string().len() > 4096 {
        return Err("Probe detail exceeds the 4 KiB report limit".into());
    }

    let evidence = if stage == "native_window_properties" {
        match child_window_properties(&app) {
            Ok(evidence) => evidence,
            Err(error) => json!({"ok": false, "error": error}),
        }
    } else {
        details.clone()
    };
    let ok = evidence.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let outcome = state.record(&stage, ok, evidence.clone())?;
    if let Some(completion) = outcome.completion {
        finish_probe(&app, completion);
    }
    if stage == "native_window_properties" {
        Ok(evidence)
    } else {
        Ok(json!({"ok": outcome.accepted}))
    }
}

fn child_window_properties(app: &tauri::AppHandle) -> Result<Value, String> {
    let child = app
        .get_webview_window(CHILD_LABEL)
        .ok_or("Native child window is unavailable")?;
    let decorated = child.is_decorated().map_err(|e| e.to_string())?;
    let always_on_top = child.is_always_on_top().map_err(|e| e.to_string())?;
    let visible = child.is_visible().map_err(|e| e.to_string())?;
    let scale_factor = child.scale_factor().map_err(|e| e.to_string())?;
    let inner_size = child.inner_size().map_err(|e| e.to_string())?;
    let logical_width = inner_size.width as f64 / scale_factor;
    let logical_height = inner_size.height as f64 / scale_factor;
    let size_matches =
        (logical_width - 320.0).abs() <= 2.0 && (logical_height - 240.0).abs() <= 2.0;
    let ok = !decorated && always_on_top && !visible && size_matches;
    Ok(json!({
        "ok": ok,
        "label": child.label(),
        "decorated": decorated,
        "alwaysOnTop": always_on_top,
        "visible": visible,
        "innerSizePhysical": {"width": inner_size.width, "height": inner_size.height},
        "scaleFactor": scale_factor,
        "innerSizeLogical": {"width": logical_width, "height": logical_height},
        "transparentRequested": true,
        "transparentGetterAvailable": false
    }))
}

fn finish_probe(app: &tauri::AppHandle, completion: Completion) {
    let exit_code = completion.exit_code;
    let report = json!({
        "probe": "tauri-native-related-window-v1",
        "status": completion.status,
        "lastStage": completion.last_stage,
        "events": completion.events,
        "limitations": [
            "Window visibility and geometry were checked through Tauri getters; no screenshot or visual-rendering claim is made.",
            "Tauri 2.11.2 has no public transparency getter; transparentRequested records the builder setting only."
        ]
    });
    let mut stdout = std::io::stdout().lock();
    let _ = writeln!(stdout, "{}", report);
    let _ = stdout.flush();

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        if let Some(child) = app.get_webview_window(CHILD_LABEL) {
            let _ = child.close();
        }
        if let Some(parent) = app.get_webview_window(PARENT_LABEL) {
            let _ = parent.close();
        }
        app.exit(exit_code);
    });
}

fn serve_probe_page(request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let uri = request.uri();
    let html = if request.method() != Method::GET
        || uri.scheme_str() != Some(SCHEME)
        || uri
            .authority()
            .map_or(true, |authority| authority.as_str() != "localhost")
        || uri.query().is_some()
    {
        return response(StatusCode::NOT_FOUND, "Not found");
    } else {
        match uri.path() {
            "/parent" => PARENT_HTML,
            "/child" => CHILD_HTML,
            _ => return response(StatusCode::NOT_FOUND, "Not found"),
        }
    };
    response(StatusCode::OK, html)
}

fn response(status: StatusCode, body: &str) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header(
            "content-security-policy",
            "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; frame-src 'self' about:srcdoc; object-src 'none'; base-uri 'none'; form-action 'none'",
        )
        .body(body.as_bytes().to_vec())
        .unwrap()
}

fn main() -> tauri::Result<()> {
    let nonce = uuid::Uuid::new_v4().to_string();
    let parent_nonce = nonce.clone();
    let state = ProbeState::new(nonce);
    let mut context = tauri::generate_context!();
    context.config_mut().identifier = "dev.atools.native-related-probe".into();
    context.config_mut().build.dev_url = None;
    context.config_mut().app.windows.clear();
    context.config_mut().app.security.csp = None;

    let app = tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![report_native_related_window_probe])
        .register_uri_scheme_protocol(SCHEME, move |_, request| serve_probe_page(request))
        .setup(move |app| {
            let handle = app.handle().clone();
            let watchdog_app = handle.clone();
            tauri::async_runtime::spawn(async move {
                let deadline = watchdog_app.state::<ProbeState>().deadline();
                tokio::time::sleep_until(tokio::time::Instant::from_std(deadline)).await;
                if let Some(completion) = watchdog_app.state::<ProbeState>().timeout() {
                    finish_probe(&watchdog_app, completion);
                }
            });

            let opener_app = handle.clone();
            let child_app = handle.clone();
            WebviewWindowBuilder::new(
                app,
                PARENT_LABEL,
                WebviewUrl::CustomProtocol(PARENT_URL.parse().unwrap()),
            )
            .title("ATools native window probe")
            .inner_size(640.0, 480.0)
            .visible(false)
            .on_new_window(move |url, features| {
                let state = child_app.state::<ProbeState>();
                let note = state.note("new_window_request");
                if let Some(completion) = note.completion {
                    finish_probe(&child_app, completion);
                }
                if !note.accepted {
                    return NewWindowResponse::Deny;
                }
                if url.as_str() != CHILD_URL || child_app.get_webview_window(CHILD_LABEL).is_some()
                {
                    if let Some(completion) = state
                        .fail_internal("new_window_denied", json!({"ok":false,"url":url.as_str()}))
                    {
                        finish_probe(&child_app, completion);
                    }
                    return NewWindowResponse::Deny;
                }
                let result =
                    WebviewWindowBuilder::new(&child_app, CHILD_LABEL, WebviewUrl::External(url))
                        .window_features(features)
                        .transparent(true)
                        .decorations(false)
                        .always_on_top(true)
                        .visible(false)
                        .inner_size(320.0, 240.0)
                        .title("ATools native child probe")
                        .build();
                match result {
                    Ok(window) => {
                        let note = state.note("child_window_created");
                        if let Some(completion) = note.completion {
                            finish_probe(&child_app, completion);
                        }
                        if note.accepted {
                            NewWindowResponse::Create { window }
                        } else {
                            let _ = window.close();
                            NewWindowResponse::Deny
                        }
                    }
                    Err(error) => {
                        if let Some(completion) = state.fail_internal(
                            "child_window_build_failed",
                            json!({"ok":false,"error":error.to_string()}),
                        ) {
                            finish_probe(&child_app, completion);
                        }
                        NewWindowResponse::Deny
                    }
                }
            })
            .on_page_load(move |window, payload| {
                if window.label() != PARENT_LABEL
                    || payload.event() != PageLoadEvent::Finished
                    || payload.url().as_str() != PARENT_URL
                {
                    return;
                }
                let state = opener_app.state::<ProbeState>();
                let note = state.note("parent_page_loaded");
                if let Some(completion) = note.completion {
                    finish_probe(&opener_app, completion);
                }
                if !note.accepted {
                    return;
                }
                let nonce_json = serde_json::to_string(&parent_nonce).unwrap();
                if let Err(error) = window.eval(&format!(
                    "window.__startNativeRelatedWindowProbe({nonce_json});"
                )) {
                    if let Some(completion) = state.fail_internal(
                        "parent_eval_failed",
                        json!({"ok":false,"error":error.to_string()}),
                    ) {
                        finish_probe(&opener_app, completion);
                    }
                }
            })
            .build()?;
            Ok(())
        })
        .build(context)?;

    app.run(|_, _| {});
    Ok(())
}
