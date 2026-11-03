use super::{registry::Registry, PARENT_ORIGIN};
use crate::plugin_asset_protocol::{parse_page_asset, read_page_asset, reserve_page_asset};
use std::sync::Arc;
use tauri::{
    http::{Method, Request, Response, StatusCode},
    AppHandle, Manager,
};

const BOOTSTRAP: &str = include_str!("bootstrap.html");
// This fixed policy contains no per-session endpoint, credential or plugin HTML.
const BOOTSTRAP_CSP: &str = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost; font-src 'self' data:; media-src 'self' data: blob:; frame-src 'self' about:; connect-src 'self' http://127.0.0.1:*; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
const ERROR_CSP: &str = "default-src 'none'; sandbox; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

pub(super) fn error(status: StatusCode, head: bool) -> Response<Vec<u8>> {
    response(status, b"Plugin page unavailable".to_vec(), ERROR_CSP, head)
}

fn response(status: StatusCode, body: Vec<u8>, csp: &str, head: bool) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("content-type", "text/html; charset=utf-8")
        .header("content-security-policy", csp)
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("x-content-type-options", "nosniff")
        .header("content-length", body.len().to_string())
        .body(if head { Vec::new() } else { body })
        .unwrap()
}

pub(super) fn canonical_origin(request: &Request<Vec<u8>>) -> Result<String, StatusCode> {
    let uri = request.uri();
    let host = uri.host().ok_or(StatusCode::BAD_REQUEST)?;
    if uri.scheme_str() != Some("atools-page")
        || uri.to_string().len() > 8192
        || uri
            .authority()
            .is_none_or(|authority| authority.as_str() != host)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = host
        .strip_suffix(".localhost")
        .ok_or(StatusCode::BAD_REQUEST)?;
    let uuid = uuid::Uuid::parse_str(id).map_err(|_| StatusCode::BAD_REQUEST)?;
    if uuid.get_version_num() != 4 || uuid.simple().to_string() != id {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(format!("atools-page://{host}"))
}

pub(super) fn bootstrap(
    registry: &Registry,
    document: &super::registry::Document,
    request: &Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    if request.method() != Method::GET
        || !request.body().is_empty()
        || request.uri().query().is_some()
    {
        return error(StatusCode::BAD_REQUEST, request.method() == Method::HEAD);
    }
    if !registry.consume(&document.binding, request.uri().path()) {
        return error(StatusCode::GONE, false);
    }
    // Escaped JSON is the only substitution. This identity is public and confers
    // no native capability; all private configuration travels over the port.
    let config = serde_json::json!({"id":document.binding.id(), "parentOrigin":PARENT_ORIGIN})
        .to_string()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    response(
        StatusCode::OK,
        BOOTSTRAP
            .replace("__ATOOLS_BOOTSTRAP_CONFIG__", &config)
            .into_bytes(),
        BOOTSTRAP_CSP,
        false,
    )
}

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder.register_asynchronous_uri_scheme_protocol(
        "atools-page",
        |context, request: Request<Vec<u8>>, responder| {
            let app: AppHandle = context.app_handle().clone();
            let head = request.method() == Method::HEAD;
            if !super::enabled(&app) {
                responder.respond(error(StatusCode::FORBIDDEN, head));
                return;
            }
            let window = context.webview_label().to_string();
            if super::parent_origin(&app, &window).is_err() {
                responder.respond(error(StatusCode::FORBIDDEN, head));
                return;
            }
            let origin = match canonical_origin(&request) {
                Ok(origin) => origin,
                Err(status) => {
                    responder.respond(error(status, head));
                    return;
                }
            };
            let Some(registry) = app
                .try_state::<Arc<Registry>>()
                .map(|state| state.inner().clone())
            else {
                responder.respond(error(StatusCode::GONE, head));
                return;
            };
            let Some(document) = registry.for_origin(&origin, &window) else {
                responder.respond(error(StatusCode::GONE, head));
                return;
            };
            if !request.uri().path().starts_with("/assets/") {
                let response = bootstrap(&registry, &document, &request);
                handoff(&registry, &document.binding, responder, response, head);
                return;
            }
            let asset = match parse_page_asset(&request) {
                Ok(asset) => asset,
                Err(status) => {
                    responder.respond(error(status, head));
                    return;
                }
            };
            let pending = match reserve_page_asset(&app) {
                Ok(pending) => pending,
                Err(status) => {
                    responder.respond(error(status, head));
                    return;
                }
            };
            tauri::async_runtime::spawn(async move {
                let active = document.binding.clone();
                let response = read_page_asset(
                    app,
                    document.owner.plugin,
                    document.authorization,
                    asset,
                    pending,
                    move || active.is_active(),
                )
                .await;
                handoff(&registry, &document.binding, responder, response, head);
            });
        },
    )
}

fn handoff(
    registry: &Registry,
    binding: &super::DocumentBinding,
    responder: tauri::UriSchemeResponder,
    response: Response<Vec<u8>>,
    head: bool,
) {
    let mut responder = Some(responder);
    let mut response = Some(response);
    if registry
        .if_current(binding, || {
            responder.take().unwrap().respond(response.take().unwrap())
        })
        .is_none()
    {
        responder
            .take()
            .unwrap()
            .respond(error(StatusCode::GONE, head));
    }
}
