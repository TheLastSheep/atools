//! Classifies copied native frame information, never a plugin message or URL alone.
use super::navigation_observer::FrameSnapshot;
use crate::plugin_loopback::OriginPolicy;

pub(super) fn page_frame_origin(frame: &FrameSnapshot) -> Option<String> {
    if frame.is_main_frame {
        return None;
    }
    let current_origin = frame.request_origin.as_ref()?;
    let native = frame.security_origin.as_ref()?;
    let host = &current_origin.host;
    let origin = format!("atools-page://{host}");
    if current_origin.scheme != "atools-page"
        || current_origin.port.is_some()
        || native.scheme != "atools-page"
        || native.host != *host
        || native.port.is_some()
        || OriginPolicy::exact(&origin).is_err()
    {
        return None;
    }
    if let Some(value) = frame.request_url.as_deref() {
        let current = url::Url::parse(value).ok()?;
        if current.scheme() != current_origin.scheme
            || current.host_str() != Some(host.as_str())
            || current.port().is_some()
            || !current.username().is_empty()
            || current.password().is_some()
        {
            return None;
        }
    } else if !frame.request_url_oversized {
        return None;
    }
    // A nested about:blank/srcdoc request has an about scheme even when its
    // security origin is inherited. Native URL components remain bounded and
    // authoritative when a history URL exceeds the full-copy budget.
    Some(origin)
}

pub(super) fn request_kind(value: Option<&str>) -> &'static str {
    let Some(value) = value else {
        return "missing";
    };
    let Ok(url) = url::Url::parse(value) else {
        return "invalid";
    };
    match (url.scheme(), url.path()) {
        ("about", "blank") => "about-blank",
        ("about", "srcdoc") => "about-srcdoc",
        ("atools-panel", _) => "parent",
        ("atools-page", path) if path.starts_with("/assets/") => "raw-asset",
        ("atools-page", path) if path.ends_with("/bootstrap.html") => "bootstrap",
        ("atools-page", _) => "page-history",
        _ => "other",
    }
}

#[cfg(test)]
mod tests {
    use super::super::navigation_observer::SecurityOrigin;
    use super::*;
    fn frame(url: &str) -> FrameSnapshot {
        FrameSnapshot {
            request_url: Some(url.into()),
            request_url_oversized: false,
            request_origin: url::Url::parse(url).ok().map(|value| SecurityOrigin {
                scheme: value.scheme().into(),
                host: value.host_str().unwrap_or_default().into(),
                port: value.port(),
            }),
            is_main_frame: false,
            security_origin: Some(SecurityOrigin {
                scheme: "atools-page".into(),
                host: "12345678123442349234123456789abc.localhost".into(),
                port: None,
            }),
        }
    }
    const ORIGIN: &str = "atools-page://12345678123442349234123456789abc.localhost";
    #[test]
    fn copied_native_origin_and_current_request_must_agree() {
        for path in [
            "/ticket/bootstrap.html",
            "/logical-route#view",
            "/settings?q=local",
        ] {
            assert_eq!(
                page_frame_origin(&frame(&format!("{ORIGIN}{path}"))),
                Some(ORIGIN.into())
            );
        }
        for url in [
            "about:blank",
            "about:srcdoc",
            "atools-panel://localhost/",
            "https://example.invalid/",
            "atools-page://user@12345678123442349234123456789abc.localhost/index",
            "atools-page://12345678123442349234123456789abc.localhost:1234/index",
        ] {
            assert_eq!(page_frame_origin(&frame(url)), None);
        }
        let mut wrong = frame(&format!("{ORIGIN}/index"));
        wrong.security_origin.as_mut().unwrap().host = "foreign.localhost".into();
        assert_eq!(page_frame_origin(&wrong), None);
        wrong = frame(&format!("{ORIGIN}/index"));
        wrong.security_origin.as_mut().unwrap().port = Some(1234);
        assert_eq!(page_frame_origin(&wrong), None);
        wrong = frame(&format!("{ORIGIN}/index"));
        wrong.is_main_frame = true;
        assert_eq!(page_frame_origin(&wrong), None);
        wrong.is_main_frame = false;
        wrong.security_origin = None;
        assert_eq!(page_frame_origin(&wrong), None);
    }
    #[test]
    fn oversized_history_url_uses_joint_native_origins_without_full_copy() {
        let mut current = frame(&format!("{ORIGIN}/logical-route"));
        current.request_url = None;
        assert_eq!(page_frame_origin(&current), None);
        current.request_url_oversized = true;
        assert_eq!(page_frame_origin(&current), Some(ORIGIN.into()));
        current.request_origin.as_mut().unwrap().scheme = "about".into();
        assert_eq!(page_frame_origin(&current), None);
        current.request_origin = None;
        assert_eq!(page_frame_origin(&current), None);
        current = frame(&format!("{ORIGIN}/logical-route"));
        current.request_origin.as_mut().unwrap().host = "foreign.localhost".into();
        assert_eq!(page_frame_origin(&current), None);
    }
    #[test]
    fn diagnostic_categories_do_not_echo_urls_or_queries() {
        assert_eq!(request_kind(Some("about:blank")), "about-blank");
        assert_eq!(request_kind(Some("about:srcdoc")), "about-srcdoc");
        assert_eq!(
            request_kind(Some(&format!("{ORIGIN}/assets/page.html?private=value"))),
            "raw-asset"
        );
        assert_eq!(
            request_kind(Some("https://secret.invalid/?token=private")),
            "other"
        );
        assert_eq!(request_kind(None), "missing");
    }
}
