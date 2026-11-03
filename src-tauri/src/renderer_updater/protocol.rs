//! Closed wire requests. No page-supplied package version, path, bytes or endpoint.
use crate::updater::UpdateCommandError;
use serde_json::Value;
pub(super) enum MainRequest {
    Status,
    Check,
    Show,
    Startup,
}
pub(super) enum WindowRequest {
    Ready(String),
    Status(String),
    Close(String),
    Drag(String),
    Appearance(String),
    Confirm {
        window: String,
        candidate: String,
        cache_only: bool,
    },
    OpenLink {
        window: String,
        candidate: String,
        href: String,
    },
}
fn reject() -> UpdateCommandError {
    UpdateCommandError::new("invalid_request", "更新请求无效")
}
fn object(body: &Value) -> Result<&serde_json::Map<String, Value>, UpdateCommandError> {
    let outer = body
        .as_object()
        .filter(|o| o.len() == 1)
        .ok_or_else(reject)?;
    outer
        .get("request")
        .and_then(Value::as_object)
        .ok_or_else(reject)
}
fn id(value: Option<&Value>) -> Result<String, UpdateCommandError> {
    let s = value.and_then(Value::as_str).ok_or_else(reject)?;
    if s.len() != 32
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(reject());
    }
    Ok(s.into())
}
pub(super) fn main(body: &Value) -> Result<MainRequest, UpdateCommandError> {
    let r = object(body)?;
    if r.len() != 1 {
        return Err(reject());
    }
    match r.get("op").and_then(Value::as_str) {
        Some("status") => Ok(MainRequest::Status),
        Some("check") => Ok(MainRequest::Check),
        Some("show") => Ok(MainRequest::Show),
        Some("startup") => Ok(MainRequest::Startup),
        _ => Err(reject()),
    }
}
pub(super) fn window(body: &Value) -> Result<WindowRequest, UpdateCommandError> {
    let r = object(body)?;
    let window = id(r.get("windowId"))?;
    match r.get("op").and_then(Value::as_str) {
        Some(op) if r.len() == 2 => match op {
            "ready" => Ok(WindowRequest::Ready(window)),
            "status" => Ok(WindowRequest::Status(window)),
            "close" => Ok(WindowRequest::Close(window)),
            "drag" => Ok(WindowRequest::Drag(window)),
            "appearance" => Ok(WindowRequest::Appearance(window)),
            _ => Err(reject()),
        },
        Some("start" | "install-downloaded") if r.len() == 3 => Ok(WindowRequest::Confirm {
            window,
            candidate: id(r.get("candidateId"))?,
            cache_only: r["op"] == "install-downloaded",
        }),
        Some("open-link") if r.len() == 4 => Ok(WindowRequest::OpenLink {
            window,
            candidate: id(r.get("candidateId"))?,
            href: link(r.get("href").and_then(Value::as_str).ok_or_else(reject)?)?,
        }),
        _ => Err(reject()),
    }
}
pub(super) fn link(raw: &str) -> Result<String, UpdateCommandError> {
    if raw.len() > 8192 || raw.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}') {
        return Err(reject());
    }
    let url = tauri::Url::parse(raw).map_err(|_| reject())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.as_str().len() > 8192
    {
        return Err(reject());
    }
    Ok(url.into())
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_requests_and_normalized_link_budget() {
        let id = "1".repeat(32);
        assert!(window(
            &json!({"request":{"op":"start","windowId":id,"candidateId":"2".repeat(32)}})
        )
        .is_ok());
        assert!(main(&json!({"request":{"op":"startup","bytes":[]}})).is_err());
        assert!(window(&json!({"request":{"op":"drag","windowId":id,"path":"/x"}})).is_err());
        assert!(link(&format!("https://example.com/{}", "中".repeat(2700))).is_err());
        for s in [
            "file:///x",
            "javascript:alert(1)",
            "https://a:b@example.com",
            "https://example.com/\n",
        ] {
            assert!(link(s).is_err())
        }
        assert_eq!(
            link("https://example.com/ok").unwrap(),
            "https://example.com/ok"
        );
    }
}
