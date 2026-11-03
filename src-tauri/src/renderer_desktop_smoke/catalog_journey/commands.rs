use super::{driver, factory, report::Stage, schema, Harness};
use serde_json::Value;
use tauri::{
    ipc::Invoke,
    webview::{PageLoadEvent, PageLoadPayload},
    AppHandle, Manager, State, Webview, Window, WindowEvent, Wry,
};

#[path = "../window_drag_probe.rs"]
mod window_drag_probe;

const MAIN_LABEL: &str = "main";

pub(in crate::renderer_desktop_smoke) fn handler(
) -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        catalog_probe_ready,
        catalog_probe_observe,
        catalog_probe_stale_launch,
        window_drag_probe::window_drag_probe_observe,
        window_drag_probe::window_drag_probe_finish,
        window_drag_probe::window_drag_probe_navigate
    ]
}

pub(in crate::renderer_desktop_smoke) fn handles(command: &str) -> bool {
    matches!(
        command,
        "catalog_probe_ready"
            | "catalog_probe_observe"
            | "catalog_probe_stale_launch"
            | "window_drag_probe_observe"
            | "window_drag_probe_finish"
            | "window_drag_probe_navigate"
    )
}

pub(in crate::renderer_desktop_smoke) fn on_page_load(
    webview: &Webview<Wry>,
    payload: &PageLoadPayload<'_>,
) {
    if webview.label() != MAIN_LABEL
        || webview.window().label() != MAIN_LABEL
        || !super::super::controller::is_local_root_url(payload.url())
    {
        return;
    }
    let app = webview.app_handle();
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    if payload.event() == PageLoadEvent::Started {
        if harness.profile().window_drag {
            if let Some(drag) = app.try_state::<window_drag_probe::Harness>() {
                if let Err(error) = drag.page_load_started() {
                    drag.write_failure_report(error);
                    harness.fail_ready(error);
                }
            }
        }
        return;
    }
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let common = app.try_state::<super::super::controller::Harness>();
    if let Some(common) = common {
        if crate::renderer_desktop_smoke::observations::incognito_data_store_persistent(webview)
            .is_err()
        {
            common.record_incognito(None);
        }
    } else {
        harness.record_error("catalog-common-data-store-observation-unavailable");
        harness.fail_ready("catalog-common-data-store-observation-unavailable");
        return;
    }

    if harness.profile().window_drag {
        if let Some(drag) = app.try_state::<window_drag_probe::Harness>() {
            let document_id = match drag.page_load_finished() {
                Ok(document_id) => document_id,
                Err(error) => {
                    drag.write_failure_report(error);
                    harness.fail_ready(error);
                    return;
                }
            };
            if !drag.mark_resume_probe_injected() {
                drag.write_failure_report("window-drag-resume-injection-rejected");
                harness.fail_ready("window-drag-resume-injection-rejected");
                return;
            }
            if !harness.mark_probe_injected() {
                return;
            }
            let (position, size) = match drag.baseline_geometry() {
                Ok(geometry) => geometry,
                Err(error) => {
                    drag.write_failure_report(error);
                    harness.fail_ready(error);
                    return;
                }
            };
            let primary = match primary_webview(&app) {
                Ok(primary) => primary,
                Err(error) => {
                    drag.write_failure_report(error);
                    harness.fail_ready(error);
                    return;
                }
            };
            let script = resume_catalog_script(&harness, &drag, &document_id, position, size);
            if primary.eval(script).is_err() {
                drag.write_failure_report("window-drag-resume-eval-failed");
                harness.fail_ready("window-drag-resume-eval-failed");
            }
            return;
        }

        let drag_harness = match window_drag_probe::Harness::new(harness.profile()) {
            Ok(drag_harness) => drag_harness,
            Err(error) => {
                harness.record_error(error);
                harness.fail_ready(error);
                return;
            }
        };
        if !drag_harness.mark_initial_probe_injected() {
            harness.record_error("window-drag-initial-injection-rejected");
            drag_harness.write_failure_report("window-drag-initial-injection-rejected");
            harness.fail_ready("window-drag-initial-injection-rejected");
            return;
        }
        let token = drag_harness.token().to_owned();
        let document_id = drag_harness.document_id();
        if !app.manage(drag_harness) {
            harness.record_error("window-drag-probe-state-unavailable");
            harness.fail_ready("window-drag-probe-state-unavailable");
            return;
        }
        let primary = match primary_webview(&app) {
            Ok(primary) => primary,
            Err(error) => {
                if let Some(drag) = app.try_state::<window_drag_probe::Harness>() {
                    drag.write_failure_report(error);
                }
                harness.fail_ready(error);
                return;
            }
        };
        let token = serde_json::to_string(&token).unwrap_or_else(|_| "null".into());
        let document_id = serde_json::to_string(&document_id).unwrap_or_else(|_| "null".into());
        let script = include_str!("../window_drag_probe.js")
            .replace("\"__ATOOLS_RENDERER_WINDOW_DRAG_TOKEN__\"", &token)
            .replace(
                "\"__ATOOLS_RENDERER_WINDOW_DRAG_DOCUMENT_ID__\"",
                &document_id,
            );
        if primary.eval(script).is_err() {
            if let Some(drag) = app.try_state::<window_drag_probe::Harness>() {
                drag.write_failure_report("window-drag-initial-eval-failed");
            }
            harness.fail_ready("window-drag-initial-eval-failed");
        }
        return;
    }

    if !harness.mark_probe_injected() {
        return;
    }
    let primary = match crate::window::main_webview(&app) {
        Ok(primary) if primary.label() == MAIN_LABEL && primary.window().label() == MAIN_LABEL => {
            primary
        }
        _ => {
            harness.fail_ready("catalog-main-webview-unavailable");
            return;
        }
    };
    let token = serde_json::to_string(harness.token()).unwrap_or_else(|_| "null".into());
    let catalog_probe =
        include_str!("probe.js").replace("\"__ATOOLS_RENDERER_CATALOG_TOKEN__\"", &token);
    if primary.eval(catalog_probe).is_err() {
        harness.fail_ready("catalog-probe-injection-failed");
    }
}

fn primary_webview(app: &AppHandle<Wry>) -> Result<Webview<Wry>, &'static str> {
    crate::window::main_webview(app)
        .map_err(|_| "catalog-main-webview-unavailable")
        .and_then(|primary| {
            if primary.label() == MAIN_LABEL && primary.window().label() == MAIN_LABEL {
                Ok(primary)
            } else {
                Err("catalog-main-webview-unavailable")
            }
        })
}

fn resume_catalog_script(
    catalog: &Harness,
    drag: &window_drag_probe::Harness,
    document_id: &str,
    position: window_drag_probe::Point,
    size: window_drag_probe::Dimensions,
) -> String {
    let catalog_token = serde_json::to_string(catalog.token()).unwrap_or_else(|_| "null".into());
    let catalog_probe =
        include_str!("probe.js").replace("\"__ATOOLS_RENDERER_CATALOG_TOKEN__\"", &catalog_token);
    let drag_token = serde_json::to_string(drag.token()).unwrap_or_else(|_| "null".into());
    let document_id = serde_json::to_string(document_id).unwrap_or_else(|_| "null".into());
    let baseline_position = serde_json::to_string(&position).unwrap_or_else(|_| "null".into());
    let baseline_size = serde_json::to_string(&size).unwrap_or_else(|_| "null".into());
    let resume = include_str!("../window_drag_probe_resume.js")
        .replace("\"__ATOOLS_RENDERER_WINDOW_DRAG_TOKEN__\"", &drag_token)
        .replace(
            "\"__ATOOLS_RENDERER_WINDOW_DRAG_DOCUMENT_ID__\"",
            &document_id,
        )
        .replace(
            "__ATOOLS_RENDERER_WINDOW_DRAG_BASELINE_POSITION__",
            &baseline_position,
        )
        .replace(
            "__ATOOLS_RENDERER_WINDOW_DRAG_BASELINE_SIZE__",
            &baseline_size,
        );
    format!(
        "(async()=>{{try{{await {}; {catalog_probe}}}catch(_e){{}}}})()",
        resume.trim()
    )
}

pub(in crate::renderer_desktop_smoke) fn record_window_event(
    window: &Window<Wry>,
    event: &WindowEvent,
) {
    if window.label() != MAIN_LABEL || !matches!(event, WindowEvent::Focused(true)) {
        return;
    }
    if let Some(harness) = window.app_handle().try_state::<Harness>() {
        harness.record_focus_gained();
    }
}

#[tauri::command]
fn catalog_probe_ready(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    dom: Value,
) -> Result<(), String> {
    validate_main_webview(&app, &webview).map_err(str::to_owned)?;
    let harness = (*harness).clone();
    harness.begin_ready(&token).map_err(str::to_owned)?;
    let dom = match schema::parse_dom(dom) {
        Ok(dom) => dom,
        Err(error) => {
            harness.fail_ready(error);
            return Err(error.to_owned());
        }
    };
    tauri::async_runtime::spawn(async move {
        let result = driver::capture_native(&app, &harness).await;
        match result {
            Ok(native) => {
                if let Err(error) = harness.complete_ready(dom, native) {
                    harness.fail_ready(error);
                }
            }
            Err(error) => harness.fail_ready(error),
        }
    });
    Ok(())
}

#[tauri::command]
async fn catalog_probe_observe(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    stage: String,
    dom: Value,
) -> Result<(), String> {
    validate_main_webview(&app, &webview).map_err(str::to_owned)?;
    let harness = (*harness).clone();
    if !harness.token_matches(&token) {
        return Err("catalog-probe-token-rejected".to_owned());
    }
    let stage = Stage::parse(&stage).ok_or("catalog-stage-name-rejected")?;
    let dom = match schema::parse_dom(dom) {
        Ok(dom) => dom,
        Err(error) => {
            harness.cancel_stage(stage, error);
            return Err(error.to_owned());
        }
    };
    let native = match driver::capture_native(&app, &harness).await {
        Ok(native) => native,
        Err(error) => {
            harness.cancel_stage(stage, error);
            return Err(error.to_owned());
        }
    };
    harness
        .accept_stage(stage, dom, native)
        .map_err(str::to_owned)
}

#[tauri::command]
async fn catalog_probe_stale_launch(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    harness: State<'_, Harness>,
    token: String,
    rejected: bool,
) -> Result<(), String> {
    validate_main_webview(&app, &webview).map_err(str::to_owned)?;
    if !harness.token_matches(&token) {
        return Err("catalog-probe-token-rejected".to_owned());
    }
    let database = harness.database();
    let counts = tauri::async_runtime::spawn_blocking(move || factory::database_counts(&database))
        .await
        .map_err(|_| {
            harness.fail_stale_launch("catalog-post-launch-db-read-failed");
            "catalog-post-launch-db-read-failed".to_owned()
        })?
        .map_err(|_| {
            harness.fail_stale_launch("catalog-post-launch-db-read-failed");
            "catalog-post-launch-db-read-failed".to_owned()
        })?;
    harness
        .complete_stale_launch(&token, rejected, counts.0, counts.1)
        .map_err(str::to_owned)
}

fn validate_main_webview(app: &AppHandle<Wry>, webview: &Webview<Wry>) -> Result<(), &'static str> {
    if webview.label() != MAIN_LABEL || webview.window().label() != MAIN_LABEL {
        return Err("catalog-command-source-rejected");
    }
    let url = webview
        .url()
        .map_err(|_| "catalog-command-source-rejected")?;
    if !super::super::controller::is_local_root_url(&url) {
        return Err("catalog-command-source-rejected");
    }
    let primary =
        crate::window::main_webview(app).map_err(|_| "catalog-command-source-rejected")?;
    if primary.label() != MAIN_LABEL || primary.window().label() != MAIN_LABEL {
        return Err("catalog-command-source-rejected");
    }
    Ok(())
}
