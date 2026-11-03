//! Closed Main/popup commands. Popup confirmations own their task through actual terminal state.
use super::*;
use std::sync::atomic::Ordering;
use tauri::{
    ipc::{InvokeBody, Request},
    Manager, WebviewWindow,
};
fn json(request: &Request<'_>) -> Result<serde_json::Value, Error> {
    let InvokeBody::Json(body) = request.body() else {
        return Err(error("invalid_request"));
    };
    let outer = body
        .as_object()
        .filter(|o| o.len() == 1)
        .ok_or_else(|| error("invalid_request"))?;
    let fields = outer
        .get("request")
        .and_then(serde_json::Value::as_object)
        .filter(|o| !o.is_empty() && o.len() <= 4)
        .ok_or_else(|| error("invalid_request"))?;
    for (key, value) in fields {
        let maximum = match key.as_str() {
            "op" => 32,
            "windowId" | "candidateId" => 32,
            "href" => 8192,
            _ => return Err(error("invalid_request")),
        };
        if !value.as_str().is_some_and(|s| s.len() <= maximum) {
            return Err(error("invalid_request"));
        }
    }
    if serde_json::to_vec(body).map_or(true, |bytes| bytes.len() > 16 * 1024) {
        return Err(error("invalid_request"));
    }
    Ok(body.clone())
}
#[tauri::command]
pub(crate) async fn renderer_updater_main(
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<serde_json::Value, Error> {
    identity::main(&window)?;
    super::initialize(window.app_handle())?;
    let op = protocol::main(&json(&request)?)?;
    let app = window.app_handle();
    match op {
        protocol::MainRequest::Status => value(coordinator(app)?.view()?),
        protocol::MainRequest::Check => {
            crate::updater::entry::check(app, &coordinator(app)?).await?;
            value(coordinator(app)?.view()?)
        }
        protocol::MainRequest::Startup => {
            crate::updater::entry::startup(app, &coordinator(app)?);
            value(coordinator(app)?.view()?)
        }
        protocol::MainRequest::Show => {
            let id = manager::show(app).await?;
            Ok(serde_json::json!({"windowId":id}))
        }
    }
}
#[tauri::command]
pub(crate) async fn renderer_updater_window(
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<serde_json::Value, Error> {
    use protocol::WindowRequest::*;
    let op = protocol::window(&json(&request)?)?;
    let id = match &op {
        Ready(id) | Status(id) | Close(id) | Drag(id) | Appearance(id) => id,
        Confirm { window, .. } | OpenLink { window, .. } => window,
    };
    let session = identity::popup(&window, id, matches!(&op, Close(_)))?;
    let app = window.app_handle();
    match op {
        Ready(id) | Status(id) => value(publisher::handshake(app, &id)?),
        Close(id) => {
            manager::close(app, &id).await?;
            Ok(serde_json::json!({"closed":true}))
        }
        Drag(_) => {
            window.start_dragging().map_err(|_| error("internal"))?;
            Ok(serde_json::json!({"started":true}))
        }
        Appearance(_) => value(native_appearance::observed(&session).await?),
        Confirm {
            candidate,
            cache_only,
            ..
        } => confirm(app, session, candidate, cache_only)
            .await
            .and_then(value),
        OpenLink {
            candidate, href, ..
        } => open_link(app, session, candidate, href).await,
    }
}
fn value(value: impl serde::Serialize) -> Result<serde_json::Value, Error> {
    serde_json::to_value(value).map_err(|_| error("internal"))
}
fn authorize_candidate(
    app: &AppHandle,
    session: &runtime::Session,
    candidate: &str,
) -> Result<String, Error> {
    let state = coordinator(app)?;
    let runtime = runtime(app)?;
    runtime.authorize_displayed(&session.id, candidate, || {
        let selected = state
            .view()?
            .candidate
            .ok_or_else(|| error("stale_candidate"))?;
        Ok((selected.candidate_id, selected.version))
    })
}
async fn confirm(
    app: &AppHandle,
    session: runtime::Session,
    candidate: String,
    cache_only: bool,
) -> Result<crate::updater::snapshot::Snapshot, Error> {
    let version = authorize_candidate(app, &session, &candidate)?;
    let runtime = runtime(app)?;
    let permit = runtime.reserve_confirmation(&session.id, &candidate)?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let state = coordinator(&app)?;
        let principal = session.clone();
        let auth_app = app.clone();
        let id = candidate.clone();
        crate::updater::entry::confirm(
            &app,
            &state,
            &version,
            &candidate,
            cache_only,
            move || authorize_candidate(&auth_app, &principal, &id).is_ok(),
            |_| {},
        )
        .await?;
        state.view()
    })
    .await
    .map_err(|_| error("internal"))?
}

async fn open_link(
    app: &AppHandle,
    session: runtime::Session,
    candidate: String,
    href: String,
) -> Result<serde_json::Value, Error> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or_else(|| error("state_unavailable"))?;
    if app.config().identifier != "dev.atools.desktop" || state.release_smoke.lock().is_some() {
        return Err(error("provider_disabled"));
    }
    let accepted = links::Accepted::accept(&session.id, &candidate, &href, || {
        authorize_candidate(app, &session, &candidate).map(|_| ())
    })?;
    let db = state.db.clone();
    let app = app.clone();
    let runtime = runtime(&app)?;
    tauri::async_runtime::spawn(async move {
        if runtime.stopped.load(Ordering::Acquire) {
            return Err(error("operation_interrupted"));
        }
        let execute_app = app.clone();
        let completed = accepted
            .execute(move |href| async move {
                let result = crate::agent_tools::call_tool_with_audit(
                    &execute_app,
                    &db,
                    "atools-ui",
                    "open_url",
                    serde_json::json!({"url":href}),
                    true,
                )
                .await;
                if result.is_error {
                    Err(error("internal"))
                } else {
                    Ok(())
                }
            })
            .await?;
        if completed.window != session.id
            || authorize_candidate(&app, &session, &completed.candidate).is_err()
        {
            return Err(error("forbidden_window"));
        }
        Ok(serde_json::json!({"opened":true}))
    })
    .await
    .map_err(|_| error("internal"))?
}
