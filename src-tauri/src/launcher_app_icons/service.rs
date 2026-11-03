use crate::{launcher_app_catalog_source::LauncherAppCatalogSource, state::AppState};
use parking_lot::Mutex;
use sha2::{Digest, Sha256};
#[cfg(target_os = "macos")]
use std::path::Path;
use std::{
    collections::HashMap,
    sync::{Arc, LazyLock},
    time::{Duration, Instant},
};
use tauri::{
    http::{Method, Request, Response, StatusCode},
    AppHandle, Manager, UriSchemeResponder,
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use url::Url;

const SCHEME: &str = "atools-app-icon";
const ICON_ERROR_BODY: &[u8] = b"Application icon unavailable";
const MAX_PENDING_REQUESTS: usize = 128;
const MAX_ICON_WORKERS: usize = 2;
const MAX_CACHE_ENTRIES: usize = 256;
const MAX_CACHE_BYTES: usize = 8 * 1024 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const PRIVATE_CACHE_CONTROL: &str = "private, max-age=300";
static ICON_HASH_SALT: LazyLock<[u8; 32]> = LazyLock::new(|| {
    use rand::RngCore;
    let mut salt = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut salt);
    salt
});

pub(crate) fn icon_url(path: &str) -> String {
    format!("{SCHEME}://localhost/{}.png", icon_id(path))
}

pub(crate) fn register(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    let service = Arc::new(IconService::default());
    builder.register_asynchronous_uri_scheme_protocol(
        SCHEME,
        move |context, request: Request<Vec<u8>>, responder: UriSchemeResponder| {
            let app = context.app_handle().clone();
            let webview_label = context.webview_label().to_owned();
            let cors_origin = match authorize_request_context(&app, &webview_label, &request) {
                Ok(origin) => origin,
                Err(status) => {
                    responder.respond(error_response(status, None));
                    return;
                }
            };
            let id = match parse_icon_request(&request) {
                Ok(id) => id,
                Err(status) => {
                    responder.respond(error_response(status, cors_origin.as_deref()));
                    return;
                }
            };
            let Some(catalog) = app
                .try_state::<AppState>()
                .map(|state| Arc::clone(&state.launcher_app_catalog))
            else {
                responder.respond(error_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    cors_origin.as_deref(),
                ));
                return;
            };
            let pending = match service.try_admit() {
                Ok(permit) => permit,
                Err(status) => {
                    responder.respond(error_response(status, cors_origin.as_deref()));
                    return;
                }
            };

            let service = Arc::clone(&service);
            tauri::async_runtime::spawn(async move {
                let response = service
                    .respond_to_request(catalog, id, Arc::clone(&pending), cors_origin)
                    .await;
                responder.respond(response);
                drop(pending);
            });
        },
    )
}

fn authorize_request_context(
    app: &AppHandle,
    webview_label: &str,
    request: &Request<Vec<u8>>,
) -> Result<Option<String>, StatusCode> {
    if webview_label != "main" {
        #[cfg(feature = "ztools-multiwebview")]
        {
            return crate::renderer_settings_view::authorize_app_icon_child_request(
                app,
                webview_label,
                request,
            );
        }
        #[cfg(not(feature = "ztools-multiwebview"))]
        {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    let webview = crate::window::main_webview(app).map_err(|_| StatusCode::FORBIDDEN)?;
    if webview.label() != "main" || webview.window().label() != "main" {
        return Err(StatusCode::FORBIDDEN);
    }
    let page_url = webview.url().map_err(|_| StatusCode::FORBIDDEN)?;
    let page_origin = trusted_local_origin(&page_url).ok_or(StatusCode::FORBIDDEN)?;
    authorize_origin_headers(&page_origin, request)
}

fn authorize_origin_headers(
    page_origin: &str,
    request: &Request<Vec<u8>>,
) -> Result<Option<String>, StatusCode> {
    if let Some(origin) = request.headers().get("origin") {
        let origin = origin.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        if origin != page_origin {
            return Err(StatusCode::FORBIDDEN);
        }
        return Ok(Some(page_origin.to_owned()));
    }

    if let Some(referer) = request.headers().get("referer") {
        let referer = referer.to_str().map_err(|_| StatusCode::FORBIDDEN)?;
        let referer_url = Url::parse(referer).map_err(|_| StatusCode::FORBIDDEN)?;
        if trusted_local_origin(&referer_url).as_deref() != Some(page_origin) {
            return Err(StatusCode::FORBIDDEN);
        }
    }
    Ok(None)
}

fn trusted_local_origin(url: &Url) -> Option<String> {
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    match (url.scheme(), url.host_str(), url.port()) {
        ("tauri", Some("localhost"), None) => Some("tauri://localhost".to_owned()),
        ("http", Some("tauri.localhost"), None) => Some("http://tauri.localhost".to_owned()),
        ("https", Some("tauri.localhost"), None) => Some("https://tauri.localhost".to_owned()),
        ("http", Some("localhost"), Some(1420)) => Some("http://localhost:1420".to_owned()),
        _ => None,
    }
}

fn parse_icon_request(request: &Request<Vec<u8>>) -> Result<String, StatusCode> {
    if *request.method() != Method::GET {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    if !request.body().is_empty() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let uri = request.uri();
    let Some(authority) = uri.authority().map(|authority| authority.as_str()) else {
        return Err(StatusCode::BAD_REQUEST);
    };
    let scheme = uri.scheme_str().ok_or(StatusCode::BAD_REQUEST)?;
    let authority_matches = match scheme {
        SCHEME => authority == "localhost",
        "http" | "https" => authority == "atools-app-icon.localhost",
        _ => false,
    };
    if !authority_matches
        || uri.query().is_some()
        || uri.to_string().contains('#')
        || uri.to_string().len() > 256
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let path = uri.path().as_bytes();
    if path.len() != 69 || path[0] != b'/' || &path[65..] != b".png" {
        return Err(StatusCode::BAD_REQUEST);
    }
    let id = &path[1..65];
    if !id
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(std::str::from_utf8(id)
        .map_err(|_| StatusCode::BAD_REQUEST)?
        .to_owned())
}

fn error_response(status: StatusCode, cors_origin: Option<&str>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .header("cache-control", "no-store")
        .header("x-content-type-options", "nosniff")
        .header("vary", "Origin, Referer");
    if let Some(origin) = cors_origin {
        builder = builder.header("access-control-allow-origin", origin);
    }
    builder
        .body(ICON_ERROR_BODY.to_vec())
        .unwrap_or_else(|_| Response::new(ICON_ERROR_BODY.to_vec()))
}

fn png_response(bytes: Arc<[u8]>, cors_origin: Option<&str>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "image/png")
        .header("cache-control", PRIVATE_CACHE_CONTROL)
        .header("x-content-type-options", "nosniff")
        .header("vary", "Origin, Referer");
    if let Some(origin) = cors_origin {
        builder = builder.header("access-control-allow-origin", origin);
    }
    builder
        .body(bytes.as_ref().to_vec())
        .unwrap_or_else(|_| error_response(StatusCode::INTERNAL_SERVER_ERROR, None))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum IconFailure {
    NotFound,
    Unavailable,
    #[cfg(not(target_os = "macos"))]
    Unsupported,
    Internal,
}

impl IconFailure {
    fn status(self) -> StatusCode {
        match self {
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Unavailable => StatusCode::SERVICE_UNAVAILABLE,
            #[cfg(not(target_os = "macos"))]
            Self::Unsupported => StatusCode::NOT_IMPLEMENTED,
            Self::Internal => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

struct IconService {
    pending: Arc<Semaphore>,
    workers: Arc<Semaphore>,
    cache: Mutex<IconCache>,
}

impl Default for IconService {
    fn default() -> Self {
        Self {
            pending: Arc::new(Semaphore::new(MAX_PENDING_REQUESTS)),
            workers: Arc::new(Semaphore::new(MAX_ICON_WORKERS)),
            cache: Mutex::new(IconCache::default()),
        }
    }
}

impl IconService {
    fn try_admit(&self) -> Result<Arc<OwnedSemaphorePermit>, StatusCode> {
        self.pending
            .clone()
            .try_acquire_owned()
            .map(Arc::new)
            .map_err(|_| StatusCode::TOO_MANY_REQUESTS)
    }

    async fn respond_to_request(
        self: Arc<Self>,
        catalog: Arc<LauncherAppCatalogSource>,
        id: String,
        pending: Arc<OwnedSemaphorePermit>,
        cors_origin: Option<String>,
    ) -> Response<Vec<u8>> {
        let service = Arc::clone(&self);
        let result = run_bounded_blocking(self.workers.clone(), pending, move || {
            service.resolve_blocking(&catalog, &id)
        })
        .await;
        match result {
            Ok(Ok(bytes)) => png_response(bytes, cors_origin.as_deref()),
            Ok(Err(failure)) => error_response(failure.status(), cors_origin.as_deref()),
            Err(_) => error_response(StatusCode::SERVICE_UNAVAILABLE, cors_origin.as_deref()),
        }
    }

    fn resolve_blocking(
        &self,
        catalog: &LauncherAppCatalogSource,
        id: &str,
    ) -> Result<Arc<[u8]>, IconFailure> {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (catalog, id);
            Err(IconFailure::Unsupported)
        }

        #[cfg(target_os = "macos")]
        {
            let apps = catalog.snapshot().map_err(|_| IconFailure::Unavailable)?;
            let expected_url = format!("{SCHEME}://localhost/{id}.png");
            let path = apps
                .iter()
                .find(|app| app.icon_url() == Some(expected_url.as_str()))
                .map(|app| app.path().to_owned())
                .ok_or(IconFailure::NotFound)?;
            self.cached_png(id, || super::image::load_icon_png(Path::new(&path)))
        }
    }

    fn cached_png<F>(&self, id: &str, generate: F) -> Result<Arc<[u8]>, IconFailure>
    where
        F: FnOnce() -> Option<Vec<u8>>,
    {
        let now = Instant::now();
        if let Some(cached) = self.cache.lock().get(id, now) {
            return Ok(cached);
        }
        let generated = generate().ok_or(IconFailure::NotFound)?;
        if !has_bounded_png(&generated) {
            return Err(IconFailure::Internal);
        }
        let generated: Arc<[u8]> = Arc::from(generated);
        self.cache
            .lock()
            .insert(id.to_owned(), Arc::clone(&generated), Instant::now());
        Ok(generated)
    }
}

async fn run_bounded_blocking<T, F>(
    workers: Arc<Semaphore>,
    pending: Arc<OwnedSemaphorePermit>,
    operation: F,
) -> Result<T, ()>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let worker = workers.acquire_owned().await.map_err(|_| ())?;
    let pending_for_work = Arc::clone(&pending);
    tauri::async_runtime::spawn_blocking(move || {
        // The closure owns a permit clone so canceling its async waiter cannot
        // release capacity while the blocking catalog or platform work is running.
        let _permits = (worker, pending_for_work);
        operation()
    })
    .await
    .map_err(|_| ())
}

fn icon_id(path: &str) -> String {
    let path_digest = Sha256::digest(path.as_bytes());
    let mut input = [0_u8; 64];
    input[..32].copy_from_slice(&*ICON_HASH_SALT);
    input[32..].copy_from_slice(&path_digest);
    let digest = Sha256::digest(input);
    format!("{digest:x}")
}

fn has_bounded_png(bytes: &[u8]) -> bool {
    const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    bytes.len() <= super::image::MAX_PNG_BYTES
        && bytes.len() >= 24
        && bytes.starts_with(PNG_SIGNATURE)
        && bytes[8..12] == 13_u32.to_be_bytes()
        && &bytes[12..16] == b"IHDR"
        && bytes[16..20] == super::image::ICON_EDGE.to_be_bytes()
        && bytes[20..24] == super::image::ICON_EDGE.to_be_bytes()
}

#[derive(Default)]
struct IconCache {
    entries: HashMap<String, CacheEntry>,
    total_bytes: usize,
    use_sequence: u64,
}

struct CacheEntry {
    bytes: Arc<[u8]>,
    inserted_at: Instant,
    last_used: u64,
}

impl IconCache {
    fn get(&mut self, id: &str, now: Instant) -> Option<Arc<[u8]>> {
        self.remove_expired(now);
        self.use_sequence = self.use_sequence.wrapping_add(1);
        let entry = self.entries.get_mut(id)?;
        entry.last_used = self.use_sequence;
        Some(Arc::clone(&entry.bytes))
    }

    fn insert(&mut self, id: String, bytes: Arc<[u8]>, now: Instant) {
        if bytes.is_empty() || bytes.len() > MAX_CACHE_BYTES {
            return;
        }
        self.remove_expired(now);
        self.remove(&id);
        while self.entries.len() >= MAX_CACHE_ENTRIES
            || self.total_bytes.saturating_add(bytes.len()) > MAX_CACHE_BYTES
        {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(id, _)| id.as_str().to_owned())
            else {
                break;
            };
            self.remove(&oldest);
        }
        self.use_sequence = self.use_sequence.wrapping_add(1);
        self.total_bytes = self.total_bytes.saturating_add(bytes.len());
        self.entries.insert(
            id,
            CacheEntry {
                bytes,
                inserted_at: now,
                last_used: self.use_sequence,
            },
        );
    }

    fn remove_expired(&mut self, now: Instant) {
        let expired = self
            .entries
            .iter()
            .filter_map(|(id, entry)| {
                let fresh = now
                    .checked_duration_since(entry.inserted_at)
                    .is_some_and(|age| age < CACHE_TTL);
                (!fresh).then(|| id.as_str().to_owned())
            })
            .collect::<Vec<_>>();
        for id in expired {
            self.remove(&id);
        }
    }

    fn remove(&mut self, id: &str) {
        if let Some(entry) = self.entries.remove(id) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.bytes.len());
        }
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod service_tests;

#[cfg(test)]
#[path = "protocol_tests.rs"]
mod protocol_tests;
