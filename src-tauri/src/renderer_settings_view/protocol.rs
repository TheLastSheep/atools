use std::sync::Arc;
use std::time::Duration;

use tauri::{
    http::{Method, Request, Response, StatusCode},
    AppHandle, Manager, UriSchemeResponder,
};
use tokio::time::Instant;

use super::{identity::is_valid_session_id, session::SettingsViewRuntime, SETTINGS_SCHEME};

const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
const ERROR_BODY: &[u8] = b"Settings view resource unavailable";
const OPENED_BARRIER_TIMEOUT: Duration = Duration::from_secs(4);

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(Arc::new(SettingsViewRuntime::default()))
        .register_asynchronous_uri_scheme_protocol(
            SETTINGS_SCHEME,
            |context, request: Request<Vec<u8>>, responder: UriSchemeResponder| {
                let app = context.app_handle().clone();
                let webview_label = context.webview_label().to_owned();
                tauri::async_runtime::spawn(async move {
                    let head = request.method() == Method::HEAD;
                    let response = respond_to_request(&app, &webview_label, &request).await;
                    let response = if head {
                        let (parts, _) = response.into_parts();
                        Response::from_parts(parts, Vec::new())
                    } else {
                        response
                    };
                    responder.respond(response);
                });
            },
        )
}

async fn respond_to_request(
    app: &AppHandle,
    webview_label: &str,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let method = request.method();
    let head = *method == Method::HEAD;
    if *method != Method::GET && !head {
        return error(StatusCode::METHOD_NOT_ALLOWED, head);
    }
    if !request.body().is_empty() || request.uri().query().is_some() {
        return error(StatusCode::BAD_REQUEST, head);
    }
    let Some((origin, path)) = request_identity(request) else {
        return error(StatusCode::BAD_REQUEST, head);
    };
    let Some(runtime) = app
        .try_state::<Arc<SettingsViewRuntime>>()
        .map(|state| Arc::clone(state.inner()))
    else {
        return error(StatusCode::GONE, head);
    };
    let Some(session) = wait_for_opened_document(&runtime, webview_label, &origin).await else {
        return error(StatusCode::GONE, head);
    };
    let Some(webview) = app.get_webview(webview_label) else {
        return error(StatusCode::GONE, head);
    };
    if webview.window().label() != "main" {
        return error(StatusCode::FORBIDDEN, head);
    }
    let (bytes, mime) = if path == "index.html" {
        if head {
            // HEAD is observational only and never consumes the one-time document grant.
            let Some(asset) = session.bundle.asset("index.html") else {
                return error(StatusCode::GONE, true);
            };
            (Arc::clone(&asset.bytes), asset.mime)
        } else {
            let Some(bytes) = runtime.note_index_request(webview_label, &origin) else {
                return error(StatusCode::GONE, false);
            };
            let Some(asset) = session.bundle.asset("index.html") else {
                return error(StatusCode::GONE, false);
            };
            (bytes, asset.mime)
        }
    } else {
        let Some((bytes, mime)) = runtime.asset_for_document(webview_label, &origin, &path) else {
            return error(StatusCode::NOT_FOUND, head);
        };
        (bytes, mime)
    };
    response(StatusCode::OK, mime, bytes, head)
}

async fn wait_for_opened_document(
    runtime: &SettingsViewRuntime,
    webview_label: &str,
    origin: &str,
) -> Option<super::session::SessionView> {
    let deadline = Instant::now() + OPENED_BARRIER_TIMEOUT;
    let mut session = runtime.current_for_label(webview_label).ok()?;
    if session.origin != origin || session.is_revoked() {
        return None;
    }
    let mut signals = session.subscribe();
    loop {
        let current = signals.borrow().clone();
        if current.opened {
            session = runtime.current_for_label(webview_label).ok()?;
            return (session.origin == origin && !session.is_revoked()).then_some(session);
        }
        if current.phase == super::phase::SessionPhase::Closing || session.is_revoked() {
            return None;
        }
        match tokio::time::timeout_at(deadline, signals.changed()).await {
            Err(_) | Ok(Err(_)) => return None,
            Ok(Ok(())) => {}
        }
    }
}

fn request_identity(request: &Request<Vec<u8>>) -> Option<(String, String)> {
    let uri = request.uri();
    let host = uri.host()?;
    if uri.scheme_str() != Some(SETTINGS_SCHEME)
        || uri.to_string().len() > 8192
        || uri.query().is_some()
        || uri.authority()?.as_str() != host
        || !host.ends_with(".localhost")
    {
        return None;
    }
    let id = host.strip_suffix(".localhost")?;
    if !is_valid_session_id(id) {
        return None;
    }
    let path = uri.path().strip_prefix('/')?;
    if path.is_empty()
        || path.contains(['%', '\\', '?', '#', ':'])
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|segment| segment.is_empty() || segment == "." || segment == "..")
    {
        return None;
    }
    Some((
        format!("{SETTINGS_SCHEME}://{id}.localhost"),
        path.to_owned(),
    ))
}

fn response(status: StatusCode, mime: &str, bytes: Arc<[u8]>, head: bool) -> Response<Vec<u8>> {
    let length = bytes.len();
    let body = if head {
        Vec::new()
    } else {
        bytes.as_ref().to_vec()
    };
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("content-security-policy", CSP)
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff")
        .header("content-length", length.to_string())
        .body(body)
        .unwrap_or_else(|_| Response::new(ERROR_BODY.to_vec()))
}

fn error(status: StatusCode, head: bool) -> Response<Vec<u8>> {
    response(
        status,
        "text/plain; charset=utf-8",
        Arc::<[u8]>::from(ERROR_BODY),
        head,
    )
}

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod tests;
