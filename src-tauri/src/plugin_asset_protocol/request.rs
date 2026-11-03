use percent_encoding::percent_decode_str;
use std::path::PathBuf;
use tauri::http::{Method, Request, Response, StatusCode};

pub(super) struct ResourceRequest {
    pub session: String,
    pub relative: PathBuf,
    pub mime: &'static str,
    pub head: bool,
    pub options: bool,
    pub window_document: Option<String>,
}

fn mime(path: &str) -> Option<&'static str> {
    let extension = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match extension.as_str() {
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "txt" => "text/plain; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "tsv" => "text/tab-separated-values; charset=utf-8",
        "xml" => "application/xml; charset=utf-8",
        "wasm" => "application/wasm",
        "png" | "apng" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "tif" | "tiff" => "image/tiff",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "eot" => "application/vnd.ms-fontobject",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "m4a" | "aac" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        _ => return None,
    })
}

pub(super) fn parse(request: &Request<Vec<u8>>) -> Result<ResourceRequest, StatusCode> {
    if ![Method::GET, Method::HEAD, Method::OPTIONS].contains(request.method()) {
        return Err(StatusCode::METHOD_NOT_ALLOWED);
    }
    let uri = request.uri();
    let valid_authority = match uri.scheme_str() {
        Some("atools-plugin") => uri
            .authority()
            .is_some_and(|value| value.as_str() == "localhost"),
        Some("http" | "https") => uri
            .authority()
            .is_some_and(|value| value.as_str() == "atools-plugin.localhost"),
        _ => false,
    };
    if !valid_authority || uri.to_string().len() > 8192 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut parts = uri
        .path()
        .strip_prefix('/')
        .ok_or(StatusCode::BAD_REQUEST)?
        .split('/');
    let session = parts.next().ok_or(StatusCode::BAD_REQUEST)?;
    let id = uuid::Uuid::parse_str(session).map_err(|_| StatusCode::BAD_REQUEST)?;
    if id.get_version_num() != 4 || id.to_string() != session {
        return Err(StatusCode::BAD_REQUEST);
    }
    let (relative, mime) = relative(parts)?;
    let window_document = window_document(uri.query())?;
    Ok(ResourceRequest {
        session: session.into(),
        relative,
        mime,
        head: request.method() == Method::HEAD,
        options: request.method() == Method::OPTIONS,
        window_document,
    })
}

fn window_document(query: Option<&str>) -> Result<Option<String>, StatusCode> {
    const KEY: &str = "__atools_window_document";
    let mut document = None;
    for pair in query.unwrap_or_default().split('&') {
        let (raw_key, raw_value) = pair.split_once('=').unwrap_or((pair, ""));
        if percent_decode_str(raw_key).decode_utf8().ok().as_deref() != Some(KEY) {
            continue;
        }
        if document.is_some() {
            return Err(StatusCode::BAD_REQUEST);
        }
        let value = percent_decode_str(raw_value)
            .decode_utf8()
            .map_err(|_| StatusCode::BAD_REQUEST)?
            .into_owned();
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        document = Some(value);
    }
    Ok(document)
}

pub(super) fn relative<'a>(
    parts: impl Iterator<Item = &'a str>,
) -> Result<(PathBuf, &'static str), StatusCode> {
    let mut relative = PathBuf::new();
    let mut count = 0;
    for segment in parts {
        let decoded = percent_decode_str(segment)
            .decode_utf8()
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        count += 1;
        if count > 32
            || decoded.is_empty()
            || decoded.len() > 1024
            || decoded == "."
            || decoded == ".."
            || decoded.chars().any(char::is_control)
            || decoded.contains(['/', '\\', ':'])
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        let lower = decoded.to_ascii_lowercase();
        let stem = lower.split('.').next().unwrap_or_default();
        if lower.starts_with('.')
            || [
                "credential",
                "credentials",
                "secret",
                "secrets",
                "token",
                "tokens",
                "id_rsa",
                "id_ed25519",
            ]
            .contains(&stem)
        {
            return Err(StatusCode::FORBIDDEN);
        }
        // Percent signs remaining after one decode are literal filesystem bytes.
        // The shared reader never URL-decodes them again.
        relative.push(decoded.as_ref());
    }
    if count == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mime = relative
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(mime)
        .ok_or(StatusCode::FORBIDDEN)?;
    Ok((relative, mime))
}

pub(super) fn response(
    status: StatusCode,
    mime: &'static str,
    bytes: Vec<u8>,
    head: bool,
) -> Response<Vec<u8>> {
    let length = bytes.len();
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("access-control-allow-origin", "null")
        .header("vary", "Origin")
        .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .header("content-length", length.to_string())
        .body(if head { Vec::new() } else { bytes })
        .unwrap()
}

pub(super) fn response_slice(
    status: StatusCode,
    mime: &'static str,
    bytes: &[u8],
    head: bool,
) -> Response<Vec<u8>> {
    let length = bytes.len();
    Response::builder()
        .status(status)
        .header("content-type", mime)
        .header("access-control-allow-origin", "null")
        .header("vary", "Origin")
        .header("access-control-allow-methods", "GET, HEAD, OPTIONS")
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "no-store")
        .header("content-length", length.to_string())
        .body(if head { Vec::new() } else { bytes.to_vec() })
        .unwrap()
}

pub(super) fn error(status: StatusCode, head: bool) -> Response<Vec<u8>> {
    response(
        status,
        "text/plain; charset=utf-8",
        b"Plugin resource unavailable".to_vec(),
        head,
    )
}
