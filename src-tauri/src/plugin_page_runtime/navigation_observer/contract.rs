//! Exact adapter contract for the locally inspected, locked Wry version.
use objc2::{runtime::ProtocolObject, sel};
use objc2_foundation::NSObjectProtocol;
use objc2_web_kit::WKNavigationDelegate;

// Wry 0.55.1 does not set #[name]. objc2 0.6.4 __define_class_name! uses
// concat!(module_path!(), "::", stringify!(Class), env!("CARGO_PKG_VERSION")),
// rather than the Rust short class name. Keep this exact version boundary.
const WRY_RUNTIME_CLASS: &[u8] =
    b"wry::wkwebview::class::wry_navigation_delegate::WryNavigationDelegate0.55.1";
const ALL_REQUIRED: u8 = 0b111_1111;

pub(super) fn validate_original(
    original: &ProtocolObject<dyn WKNavigationDelegate>,
) -> Result<(), String> {
    // Bit positions follow Wry's seven declarations, not untrusted inputs.
    let selectors = [
        sel!(webView:decidePolicyForNavigationAction:decisionHandler:),
        sel!(webView:decidePolicyForNavigationResponse:decisionHandler:),
        sel!(webView:didFinishNavigation:),
        sel!(webView:didCommitNavigation:),
        sel!(webView:navigationAction:didBecomeDownload:),
        sel!(webView:navigationResponse:didBecomeDownload:),
        sel!(webViewWebContentProcessDidTerminate:),
    ];
    let required = selectors
        .into_iter()
        .enumerate()
        .fold(0, |mask, (index, selector)| {
            mask | (u8::from(original.respondsToSelector(selector)) << index)
        });
    let preferences = original.respondsToSelector(
        sel!(webView:decidePolicyForNavigationAction:preferences:decisionHandler:),
    );
    let object: &objc2::runtime::AnyObject = original.as_ref();
    validate_contract(object.class().name().to_bytes(), required, preferences)
}

fn validate_contract(class: &[u8], required: u8, preferences: bool) -> Result<(), String> {
    let reason = if class != WRY_RUNTIME_CLASS {
        "CLASS_MISMATCH"
    } else if required != ALL_REQUIRED {
        "MISSING_REQUIRED_SELECTORS"
    } else if preferences {
        "PREFERENCES_OVERLOAD"
    } else {
        return Ok(());
    };
    // Only fixed reason codes and bounded native boolean/mask values leave
    // validation. Never include runtime class text, frame URLs or credentials.
    Err(format!(
        "Native navigation observer delegate is unsupported [{reason}; required={}; preferences={}]",
        required & ALL_REQUIRED,
        u8::from(preferences)
    ))
}

#[cfg(test)]
mod tests {
    use super::{validate_contract, ALL_REQUIRED, WRY_RUNTIME_CLASS};

    #[test]
    fn locked_wry_uses_objc2_qualified_versioned_runtime_name() {
        assert!(validate_contract(WRY_RUNTIME_CLASS, ALL_REQUIRED, false).is_ok());
        let short = validate_contract(b"WryNavigationDelegate", ALL_REQUIRED, false).unwrap_err();
        assert!(short.contains("CLASS_MISMATCH; required=127; preferences=0"));
        assert!(validate_contract(
            b"wry::wkwebview::class::wry_navigation_delegate::WryNavigationDelegate0.55.2",
            ALL_REQUIRED,
            false,
        )
        .unwrap_err()
        .contains("CLASS_MISMATCH"));
    }

    #[test]
    fn each_original_selector_and_absence_of_preferences_overload_are_required() {
        for index in 0..7 {
            let missing = validate_contract(WRY_RUNTIME_CLASS, ALL_REQUIRED ^ (1 << index), false)
                .unwrap_err();
            assert!(missing.contains("MISSING_REQUIRED_SELECTORS"));
        }
        let overload = validate_contract(WRY_RUNTIME_CLASS, ALL_REQUIRED, true).unwrap_err();
        assert!(overload.contains("PREFERENCES_OVERLOAD; required=127; preferences=1"));
    }

    #[test]
    fn unknown_class_text_is_never_returned_in_diagnostics() {
        let diagnostic = validate_contract(b"private-arbitrary-class-value", 0, true).unwrap_err();
        assert_eq!(diagnostic, "Native navigation observer delegate is unsupported [CLASS_MISMATCH; required=0; preferences=1]");
    }
}
