use super::{FrameNavigation, FrameSnapshot, SecurityOrigin};
use objc2_foundation::{NSNumber, NSString, NSURLRequest, NSURL};
use objc2_web_kit::{WKFrameInfo, WKNavigationAction};

const MAX_URL_UTF16: usize = 8192;
const MAX_SCHEME_UTF16: usize = 32;
const MAX_HOST_UTF16: usize = 1024;

#[derive(Default)]
struct RequestSnapshot {
    url: Option<String>,
    oversized: bool,
    origin: Option<SecurityOrigin>,
}

pub(super) fn navigation(action: &WKNavigationAction) -> FrameNavigation {
    // SAFETY: The delegate receives these objects synchronously on the main
    // thread. Only bounded owned values escape the callback.
    unsafe {
        FrameNavigation {
            requested_url: action.request().URL().and_then(|url| full_url(&url).0),
            source_frame: action.sourceFrame().as_deref().map(frame),
            target_frame: action.targetFrame().as_deref().map(frame),
        }
    }
}

fn bounded_copy(value: &NSString, budget: usize) -> Option<String> {
    // NSString.length is UTF-16 units. Check before allocating/converting the
    // Rust copy; querying or measuring the UTF-8 representation first is unsafe.
    copy_with_budget(value.length(), budget, || value.to_string())
}

fn copy_with_budget(length: usize, budget: usize, copy: impl FnOnce() -> String) -> Option<String> {
    (length <= budget).then(copy)
}

fn request(request: &NSURLRequest) -> RequestSnapshot {
    let Some(url) = request.URL() else {
        return RequestSnapshot::default();
    };
    let (full, oversized) = full_url(&url);
    RequestSnapshot {
        oversized,
        url: full,
        // Native component getters do not parse or copy the entire URL in Rust.
        origin: request_origin(&url),
    }
}

fn full_url(url: &NSURL) -> (Option<String>, bool) {
    let Some(full) = url.absoluteString() else {
        return (None, false);
    };
    let length = full.length();
    (
        copy_with_budget(length, MAX_URL_UTF16, || full.to_string()),
        length > MAX_URL_UTF16,
    )
}

fn request_origin(url: &NSURL) -> Option<SecurityOrigin> {
    // Presence checks preserve the caller's userinfo exclusion even when the
    // bounded full URL is omitted. Do not copy either native credential string.
    if url.user().is_some() || url.password().is_some() {
        return None;
    }
    let native_scheme = url.scheme()?;
    let scheme = bounded_copy(&native_scheme, MAX_SCHEME_UTF16)?;
    let host = url
        .host()
        .map(|host| bounded_copy(&host, MAX_HOST_UTF16))
        .unwrap_or_else(|| Some(String::new()))?;
    let port = match url.port() {
        Some(number) => number_port(&number)?,
        None => 0,
    };
    normalize_origin(&scheme, &host, port)
}

fn number_port(number: &NSNumber) -> Option<i64> {
    let port = u16::try_from(number.longLongValue()).ok()?;
    // NSNumber conversion alone can truncate fractions or wrap unsigned values.
    // Compare with the bounded integer before accepting it as a native port.
    number
        .isEqualToNumber(&NSNumber::new_u16(port))
        .then_some(i64::from(port))
}

fn frame(frame: &WKFrameInfo) -> FrameSnapshot {
    // SAFETY: Called only with a frame retained during the native callback.
    unsafe {
        let current = request(&frame.request());
        let origin = frame.securityOrigin();
        let security_origin = bounded_copy(&origin.protocol(), MAX_SCHEME_UTF16)
            .zip(bounded_copy(&origin.host(), MAX_HOST_UTF16))
            .and_then(|(scheme, host)| normalize_origin(&scheme, &host, origin.port() as i64));
        FrameSnapshot {
            request_url: current.url,
            request_url_oversized: current.oversized,
            request_origin: current.origin,
            security_origin,
            is_main_frame: frame.isMainFrame(),
        }
    }
}

fn normalize_origin(scheme: &str, host: &str, native_port: i64) -> Option<SecurityOrigin> {
    let port = u16::try_from(native_port).ok()?;
    let scheme = scheme.to_ascii_lowercase();
    if scheme.len() > MAX_SCHEME_UTF16
        || !scheme
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        || !scheme
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'-' | b'.'))
    {
        return None;
    }
    let host = if host.is_empty() {
        String::new()
    } else if let Ok(address) = host.parse::<std::net::Ipv6Addr>() {
        url::Host::<String>::Ipv6(address).to_string()
    } else {
        url::Host::parse(host)
            .ok()?
            .to_string()
            .to_ascii_lowercase()
    };
    if host.len() > MAX_HOST_UTF16 {
        return None;
    }
    let default_port = match scheme.as_str() {
        "http" | "ws" => Some(80),
        "https" | "wss" => Some(443),
        "ftp" => Some(21),
        _ => None,
    };
    Some(SecurityOrigin {
        scheme,
        host,
        port: (port != 0 && Some(port) != default_port).then_some(port),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native_request(value: &str) -> objc2::rc::Retained<NSURLRequest> {
        let url = NSURL::URLWithString(&NSString::from_str(value)).expect("synthetic URL is valid");
        NSURLRequest::requestWithURL(&url)
    }

    #[test]
    fn origin_normalization_preserves_nondefault_ports_and_rejects_invalid_ports() {
        let native = normalize_origin("ATOOLS-PAGE", "Example.COM", 4123).unwrap();
        assert_eq!(native.scheme, "atools-page");
        assert_eq!(native.host, "example.com");
        assert_eq!(native.port, Some(4123));
        assert_eq!(
            normalize_origin("https", "EXAMPLE.COM", 443).unwrap().port,
            None
        );
        assert_eq!(
            normalize_origin("atools-page", "localhost", 0)
                .unwrap()
                .port,
            None
        );
        assert!(normalize_origin("https", "localhost", -1).is_none());
        assert!(normalize_origin("https", "localhost", 65536).is_none());
        assert!(normalize_origin("bad scheme", "localhost", 0).is_none());
        assert_eq!(
            normalize_origin("https", "2001:0db8::1", 0).unwrap().host,
            "[2001:db8::1]"
        );
    }

    #[test]
    fn oversized_strings_do_not_run_the_copy_and_native_budget_is_utf16_units() {
        let mut conversions = 0;
        assert!(copy_with_budget(MAX_URL_UTF16 + 1, MAX_URL_UTF16, || {
            conversions += 1;
            String::new()
        })
        .is_none());
        assert_eq!(conversions, 0);
        let native = NSString::from_str("🙂");
        assert_eq!(native.length(), 2);
        assert!(bounded_copy(&native, 1).is_none());
        assert_eq!(bounded_copy(&native, 2).as_deref(), Some("🙂"));
        let boundary = NSString::from_str(&"x".repeat(MAX_URL_UTF16));
        assert_eq!(
            bounded_copy(&boundary, MAX_URL_UTF16).unwrap().len(),
            MAX_URL_UTF16
        );
    }

    #[test]
    fn long_query_omits_full_url_but_keeps_the_native_request_origin() {
        let current = request(&native_request(&format!(
            "atools-page://fixture.example/content?value={}",
            "x".repeat(MAX_URL_UTF16)
        )));
        assert!(current.oversized);
        assert!(current.url.is_none());
        let origin = current
            .origin
            .expect("bounded native origin survives the long query");
        assert_eq!(origin.scheme, "atools-page");
        assert_eq!(origin.host, "fixture.example");
        assert_eq!(origin.port, None);
        let about = request(&native_request("about:blank")).origin.unwrap();
        assert_ne!(about.scheme, origin.scheme);
    }

    #[test]
    fn long_query_with_userinfo_never_returns_a_request_origin() {
        let current = request(&native_request(&format!(
            "atools-page://synthetic-user:synthetic-value@fixture.example/content?value={}",
            "x".repeat(MAX_URL_UTF16)
        )));
        assert!(current.oversized);
        assert!(current.url.is_none());
        assert!(current.origin.is_none());
    }

    #[test]
    fn invalid_or_oversized_native_origins_are_not_returned() {
        let over_scheme = format!("{}://fixture.example/", "x".repeat(MAX_SCHEME_UTF16 + 1));
        assert!(request(&native_request(&over_scheme)).origin.is_none());
        let over_host = format!("atools-page://{}/", "x".repeat(MAX_HOST_UTF16 + 1));
        assert!(request(&native_request(&over_host)).origin.is_none());
        for number in [
            NSNumber::new_i64(-1),
            NSNumber::new_i64(65536),
            NSNumber::new_u64(u64::MAX),
            NSNumber::new_f64(0.5),
        ] {
            assert!(number_port(&number).is_none());
        }
        assert_eq!(number_port(&NSNumber::new_u16(65535)), Some(65535));
    }
}
