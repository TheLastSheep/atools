//! Closed legacy command arguments and exact native top-level document identity.
use super::{coordinator::failure, UpdateCommandError};
use serde_json::Value;
use tauri::{
    ipc::{InvokeBody, Request},
    Manager, WebviewWindow,
};

pub(super) fn authorize(window: &WebviewWindow) -> Result<(), UpdateCommandError> {
    super::ensure_updater_window(window.label())?;
    let url = window.url().map_err(|_| failure("forbidden_window"))?;
    if window.label() != AsRef::<tauri::Webview>::as_ref(window).window().label()
        || !legacy_document(
            window.label(),
            &url,
            window.app_handle().config().build.dev_url.as_ref(),
        )
    {
        return Err(failure("forbidden_window"));
    }
    Ok(())
}
pub(super) fn body(request: &Request<'_>, keys: &[&str]) -> Result<(), UpdateCommandError> {
    let InvokeBody::Json(value) = request.body() else {
        return Err(failure("invalid_request"));
    };
    exact(value, keys)
}
fn exact(value: &Value, keys: &[&str]) -> Result<(), UpdateCommandError> {
    let object = value
        .as_object()
        .filter(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
        .ok_or_else(|| failure("invalid_request"))?;
    if !keys.is_empty() {
        let version = object
            .get("expectedVersion")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty() && s.len() <= 128)
            .ok_or_else(|| failure("invalid_request"))?;
        if semver::Version::parse(version).is_err()
            || !object
                .get("expectedCandidateId")
                .and_then(Value::as_str)
                .is_some_and(super::coordinator::valid_id)
        {
            return Err(failure("invalid_request"));
        }
    }
    Ok(())
}
pub(super) fn legacy_document(label: &str, url: &tauri::Url, dev: Option<&tauri::Url>) -> bool {
    if !matches!(label, "main" | "settings")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || !matches!(url.path(), "/" | "/index.html")
    {
        return false;
    }
    let fragment = match label {
        "main" => url.fragment().is_none_or(|s| s.is_empty() || s == "/"),
        "settings" => url.fragment() == Some("/settings"),
        _ => false,
    };
    let dev_origin = cfg!(debug_assertions)
        && dev.is_some_and(|dev| {
            matches!(dev.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
                && url.origin() == dev.origin()
        });
    let origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            (url.host_str() == Some("tauri.localhost") && url.port().is_none()) || dev_origin
        }
        _ => false,
    };
    fragment && origin
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn legacy_requires_candidate_and_exact_source() {
        assert!(exact(
            &json!({"expectedVersion":"1.2.3","expectedCandidateId":"a".repeat(32)}),
            &["expectedVersion", "expectedCandidateId"]
        )
        .is_ok());
        for value in [
            json!({"expectedVersion":"1.2.3"}),
            json!({"expectedVersion":"1.2.3","expectedCandidateId":"a".repeat(32),"bytes":[]}),
        ] {
            assert!(exact(&value, &["expectedVersion", "expectedCandidateId"]).is_err())
        }
        assert!(legacy_document(
            "main",
            &"tauri://localhost/index.html".parse().unwrap(),
            None
        ));
        assert!(legacy_document(
            "settings",
            &"tauri://localhost/#/settings".parse().unwrap(),
            None
        ));
        for (label, url) in [
            ("plugin", "tauri://localhost/"),
            ("main", "https://evil.example/"),
            ("settings", "tauri://localhost/"),
            ("main", "atools-settings://localhost/index.html"),
            ("main", "tauri://localhost/?bytes=1"),
        ] {
            assert!(!legacy_document(label, &url.parse().unwrap(), None));
        }
    }
}
#[cfg(test)]
mod entry_compatibility_tests {
    #[test]
    fn both_trusted_main_entries_share_local_root_admission_without_weakening_other_sources() {
        for root in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
        ] {
            assert!(super::legacy_document("main", &root.parse().unwrap(), None));
        }
        for root in [
            "tauri://localhost/#/settings",
            "https://tauri.localhost/index.html#/settings",
        ] {
            assert!(super::legacy_document(
                "settings",
                &root.parse().unwrap(),
                None
            ));
        }
        for (label, url) in [
            ("renderer-updater-abc", "tauri://localhost/"),
            ("plugin-detach-1", "tauri://localhost/"),
            ("main", "https://example.com/"),
            ("main", "tauri://localhost/other.html"),
        ] {
            assert!(!super::legacy_document(label, &url.parse().unwrap(), None));
        }
    }
}
