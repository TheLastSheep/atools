//! The page host shares the opaque resource reader, concurrency and path policy.
//! Every asset remains an opaque document when navigated to, including SVG/PDF.
use super::{authorization, request, resources, Authorization, MAX_RESOURCE_BYTES};
use crate::state::AppState;
use std::path::PathBuf;
use tauri::{
    http::{Method, Request, Response, StatusCode},
    AppHandle, Manager,
};

pub(crate) struct PageAsset {
    pub relative: PathBuf,
    pub mime: &'static str,
    pub head: bool,
}

pub(crate) fn parse_page_asset(request: &Request<Vec<u8>>) -> Result<PageAsset, StatusCode> {
    if ![Method::GET, Method::HEAD].contains(request.method()) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    if !request.body().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let path = request
        .uri()
        .path()
        .strip_prefix("/assets/")
        .ok_or(StatusCode::NOT_FOUND)?;
    let (relative, mime) = request::relative(path.split('/'))?;
    Ok(PageAsset {
        relative,
        mime,
        head: request.method() == Method::HEAD,
    })
}

pub(super) fn response(
    status: StatusCode,
    mime: &'static str,
    bytes: Vec<u8>,
    head: bool,
) -> Response<Vec<u8>> {
    let length = bytes.len();
    Response::builder().status(status).header("content-type", mime)
        .header("content-security-policy", "sandbox allow-scripts; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'")
        .header("x-content-type-options", "nosniff").header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer").header("content-length", length.to_string())
        .body(if head {Vec::new()} else {bytes}).unwrap()
}

fn error(status: StatusCode, head: bool) -> Response<Vec<u8>> {
    response(
        status,
        "text/plain; charset=utf-8",
        b"Plugin resource unavailable".to_vec(),
        head,
    )
}

fn reserve(resources: &super::Resources) -> Result<tokio::sync::OwnedSemaphorePermit, StatusCode> {
    resources
        .pending
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

/// Reserve synchronously in the native scheme callback, before spawning a task.
/// The budget therefore includes futures the executor has not polled yet.
pub(crate) fn reserve_page_asset(
    app: &AppHandle,
) -> Result<tokio::sync::OwnedSemaphorePermit, StatusCode> {
    reserve(&resources(app))
}

pub(super) fn read(
    db: &atools_core::Database,
    plugin: &str,
    expected: &Authorization,
    asset: &PageAsset,
) -> Response<Vec<u8>> {
    let Ok(current) = authorization(db, plugin) else {
        return error(StatusCode::FORBIDDEN, asset.head);
    };
    if &current != expected {
        return error(StatusCode::FORBIDDEN, asset.head);
    }
    match atools_plugin::package_resolution::read_package_asset_bytes(
        &current.root,
        &asset.relative,
        MAX_RESOURCE_BYTES,
    ) {
        Ok(Some(bytes)) => response(StatusCode::OK, asset.mime, bytes, asset.head),
        Ok(None) => error(StatusCode::NOT_FOUND, asset.head),
        Err(_) => error(StatusCode::FORBIDDEN, asset.head),
    }
}

/// Caller must perform its document membership check atomically with response
/// handoff after this read. A completed revoke must suppress already-read bytes.
pub(crate) async fn read_page_asset(
    app: AppHandle,
    plugin: String,
    expected: Authorization,
    asset: PageAsset,
    pending: tokio::sync::OwnedSemaphorePermit,
    is_active: impl Fn() -> bool + Send + 'static,
) -> Response<Vec<u8>> {
    let head = asset.head;
    if !is_active() {
        return error(StatusCode::GONE, head);
    }
    let resources = resources(&app);
    let permit = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        resources.reads.clone().acquire_owned(),
    )
    .await
    {
        Ok(Ok(permit)) => permit,
        _ => return error(StatusCode::SERVICE_UNAVAILABLE, head),
    };
    let execution = crate::plugin_lifecycle::execution(&app, &plugin).await;
    let db = app.state::<AppState>().db.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (_pending, _permit, _execution) = (pending, permit, execution);
        if is_active() {
            read(&db, &plugin, &expected, &asset)
        } else {
            error(StatusCode::GONE, head)
        }
    })
    .await
    .unwrap_or_else(|_| error(StatusCode::SERVICE_UNAVAILABLE, head))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_assets_charge_unpolled_work_to_the_shared_pending_budget() {
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let resources = super::super::Resources::default();
        let polled = Arc::new(AtomicUsize::new(0));
        let mut queued = Vec::new();
        for _ in 0..64 {
            let permit = reserve(&resources).unwrap();
            let polled = polled.clone();
            queued.push(Box::pin(async move {
                let _permit = permit;
                polled.fetch_add(1, Ordering::AcqRel);
                std::future::pending::<()>().await;
            }));
        }
        // The executor has started none of these reads, but a 65th response
        // cannot enqueue work. Opaque leases share this exact semaphore too.
        assert_eq!(polled.load(Ordering::Acquire), 0);
        assert_eq!(resources.pending.available_permits(), 0);
        assert_eq!(
            reserve(&resources).unwrap_err(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        drop(queued);
        assert_eq!(resources.pending.available_permits(), 64);
        assert!(reserve(&resources).is_ok());
    }

    #[test]
    fn page_assets_share_path_rules_and_cannot_become_same_origin_documents() {
        for path in [
            "index.html",
            "vector.svg",
            "data.xml",
            "document.pdf",
            "entry.js",
        ] {
            let request = Request::builder()
                .uri(format!("atools-page://fixture.localhost/assets/{path}"))
                .body(Vec::new())
                .unwrap();
            let asset = parse_page_asset(&request).unwrap();
            let response = response(StatusCode::OK, asset.mime, b"fixture".to_vec(), false);
            assert!(response.headers()["content-security-policy"]
                .to_str()
                .unwrap()
                .starts_with("sandbox allow-scripts;"));
            assert!(!response
                .headers()
                .contains_key("access-control-allow-origin"));
            assert_eq!(response.headers()["x-content-type-options"], "nosniff");
        }
        for path in [
            "../entry.js",
            "%2e%2e/entry.js",
            "a%2fb.js",
            ".env",
            "token.json",
            "",
            "a//b.js",
        ] {
            let request = Request::builder()
                .uri(format!("atools-page://fixture.localhost/assets/{path}"))
                .body(Vec::new())
                .unwrap();
            assert!(parse_page_asset(&request).is_err(), "{path}");
        }
    }

    #[test]
    fn page_assets_use_the_same_bounded_package_reader_and_revision_authorization() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("entry.js"), b"export const value=42").unwrap();
        std::fs::File::create(root.path().join("oversized.js"))
            .unwrap()
            .set_len(MAX_RESOURCE_BYTES as u64 + 1)
            .unwrap();
        let db = atools_core::Database::in_memory().unwrap();
        let mut plugin: atools_core::Plugin = serde_json::from_value(serde_json::json!({"id":"page-resource", "name":"fixture", "version":"1",
            "path":root.path(), "enabled":true, "manifest":{"name":"fixture","version":"1","main":"entry.js"}, "created_at":"now", "updated_at":"now"})).unwrap();
        db.save_plugin(&plugin).unwrap();
        let expected = authorization(&db, "page-resource").unwrap();
        let asset = |path| {
            parse_page_asset(
                &Request::builder()
                    .uri(format!("atools-page://fixture.localhost/assets/{path}"))
                    .body(Vec::new())
                    .unwrap(),
            )
            .unwrap()
        };
        let response = read(&db, "page-resource", &expected, &asset("entry.js"));
        assert_eq!(response.body(), b"export const value=42");
        assert_eq!(
            response.headers()["content-type"],
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            read(&db, "page-resource", &expected, &asset("oversized.js")).status(),
            StatusCode::FORBIDDEN
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.path().join("entry.js"), root.path().join("linked.js"))
                .unwrap();
            assert_eq!(
                read(&db, "page-resource", &expected, &asset("linked.js")).status(),
                StatusCode::FORBIDDEN
            );
        }
        crate::plugin_code_revision::CodeRevision::begin(&db, "page-resource")
            .unwrap()
            .finish(&db)
            .unwrap();
        assert_eq!(
            read(&db, "page-resource", &expected, &asset("entry.js")).status(),
            StatusCode::FORBIDDEN
        );
        let current = authorization(&db, "page-resource").unwrap();
        plugin.enabled = false;
        db.save_plugin(&plugin).unwrap();
        assert_eq!(
            read(&db, "page-resource", &current, &asset("entry.js")).status(),
            StatusCode::FORBIDDEN
        );
    }
}
