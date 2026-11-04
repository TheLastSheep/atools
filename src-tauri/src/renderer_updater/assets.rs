//! Source-bound fixed local protocol. A document grant belongs to one native popup only.
use super::*;
use std::sync::{atomic::Ordering, Arc};
use tauri::http::{Method, Request, Response, StatusCode};
const CSP:&str="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
pub(super) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(Arc::new(runtime::Runtime::default()))
        .register_uri_scheme_protocol("atools-updater", |context, request| {
            respond(context.app_handle(), context.webview_label(), &request)
        })
}
fn respond(app: &AppHandle, label: &str, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let head = request.method() == Method::HEAD;
    let fail = |status| {
        response(
            status,
            "text/plain",
            b"Updater resource unavailable".to_vec(),
            head,
        )
    };
    if !matches!(*request.method(), Method::GET | Method::HEAD) || !request.body().is_empty() {
        return fail(StatusCode::BAD_REQUEST);
    }
    let uri = request.uri();
    if uri.scheme_str() != Some("atools-updater")
        || uri.authority().map(|a| a.as_str()) != Some("localhost")
        || uri.query().is_some()
    {
        return fail(StatusCode::FORBIDDEN);
    }
    let Some((id, path)) = uri.path().strip_prefix('/').and_then(|p| p.split_once('/')) else {
        return fail(StatusCode::BAD_REQUEST);
    };
    if !crate::updater::entry::valid_id(id) || label != format!("renderer-updater-{id}") {
        return fail(StatusCode::FORBIDDEN);
    }
    let Ok(runtime) = runtime(app) else {
        return fail(StatusCode::GONE);
    };
    let _delivery = runtime.delivery.lock();
    let mut sessions = runtime.session.lock();
    let Some(session) = sessions.as_mut().filter(|s| {
        s.id == id
            && s.label == label
            && s.alive.load(Ordering::Acquire)
            && !s.closing.load(Ordering::Acquire)
    }) else {
        return fail(StatusCode::GONE);
    };
    let Some((bytes, mime)) = session.bundle.assets.get(path) else {
        return fail(StatusCode::NOT_FOUND);
    };
    if path == "updater.html" && !head {
        if session.index_served {
            return fail(StatusCode::GONE);
        }
        session.index_served = true;
    }
    response(StatusCode::OK, mime, bytes.to_vec(), head)
}
fn response(status: StatusCode, mime: &str, body: Vec<u8>, head: bool) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Content-Security-Policy", CSP)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("X-Frame-Options", "DENY")
        .body(if head { Vec::new() } else { body })
        .expect("fixed updater response headers")
}
