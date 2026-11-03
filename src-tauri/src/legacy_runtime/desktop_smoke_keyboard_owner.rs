//! Fixture-only pointer identity classification; never changes native focus.
use serde::Serialize;

const MAX_VIEW_NODES: u8 = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum KeyboardOwner {
    EqualMainWebview,
    DescendantOfMainWebview,
    OtherOwnedView,
    ForeignWindowView,
    Nonview,
    NoResponder,
    Unknown,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct KeyboardOwnership {
    classification: KeyboardOwner,
    ancestry_depth: u8,
    inspected_views: u8,
    ancestry_limit: u8,
    ancestry_limit_reached: bool,
}

impl KeyboardOwnership {
    fn new(classification: KeyboardOwner, depth: u8, inspected: u8, limited: bool) -> Self {
        Self {
            classification,
            ancestry_depth: depth,
            inspected_views: inspected,
            ancestry_limit: MAX_VIEW_NODES,
            ancestry_limit_reached: limited,
        }
    }
    pub(super) fn unknown() -> Self {
        Self::new(KeyboardOwner::Unknown, 0, 0, false)
    }
    pub(super) fn verified(&self) -> bool {
        matches!(
            self.classification,
            KeyboardOwner::EqualMainWebview | KeyboardOwner::DescendantOfMainWebview
        )
    }
}

enum Responder<T> {
    NoResponder,
    Nonview,
    View(T),
}
struct ViewStep<T> {
    in_main_window: Option<bool>,
    is_main_webview: bool,
    parent: Option<T>,
}

// The classifier uses only identity and window membership, never class-name heuristics.
fn classify<T>(
    responder: Responder<T>,
    main_webview_in_main_window: bool,
    mut step: impl FnMut(&T) -> ViewStep<T>,
) -> KeyboardOwnership {
    let mut current = match responder {
        Responder::NoResponder => {
            return KeyboardOwnership::new(KeyboardOwner::NoResponder, 0, 0, false)
        }
        Responder::Nonview => return KeyboardOwnership::new(KeyboardOwner::Nonview, 0, 0, false),
        Responder::View(value) => value,
    };
    if !main_webview_in_main_window {
        return KeyboardOwnership::unknown();
    }
    for depth in 0..MAX_VIEW_NODES {
        let node = step(&current);
        let owner = match node.in_main_window {
            Some(false) => Some(KeyboardOwner::ForeignWindowView),
            None => Some(KeyboardOwner::Unknown),
            Some(true) if node.is_main_webview => Some(if depth == 0 {
                KeyboardOwner::EqualMainWebview
            } else {
                KeyboardOwner::DescendantOfMainWebview
            }),
            Some(true) if node.parent.is_none() => Some(KeyboardOwner::OtherOwnedView),
            Some(true) => None,
        };
        if let Some(owner) = owner {
            return KeyboardOwnership::new(owner, depth, depth + 1, false);
        }
        current = node.parent.expect("parent checked above");
    }
    KeyboardOwnership::new(
        KeyboardOwner::Unknown,
        MAX_VIEW_NODES - 1,
        MAX_VIEW_NODES,
        true,
    )
}

#[cfg(target_os = "macos")]
pub(super) fn observe(
    window: &tauri::WebviewWindow,
) -> Result<(Option<String>, KeyboardOwnership), String> {
    use objc2::{rc::Retained, MainThreadMarker};
    use objc2_app_kit::{NSView, NSWindow};
    use parking_lot::Mutex;
    use std::sync::Arc;

    MainThreadMarker::new().ok_or("Keyboard ownership observation requires the main thread")?;
    let output = Arc::new(Mutex::new(None));
    let captured = output.clone();
    let observed_window = window.clone();
    window
        .with_webview(move |webview| {
            let result = (|| {
                MainThreadMarker::new()
                    .ok_or("Keyboard ownership callback requires the main thread")?;
                let expected = observed_window
                    .ns_window()
                    .map_err(|error| error.to_string())?;
                if expected.is_null() {
                    return Err("Fixture native window pointer unavailable".into());
                }
                // Tauri provides these live handles; this callback is synchronous on its UI thread.
                let native_window = unsafe { &*expected.cast::<NSWindow>() };
                let responder = native_window.firstResponder();
                let responder_class = responder.as_ref().map(|value| {
                    let object: &objc2::runtime::AnyObject = value;
                    object
                        .class()
                        .name()
                        .to_string_lossy()
                        .chars()
                        .take(80)
                        .collect::<String>()
                });
                let responder = match responder {
                    None => Responder::NoResponder,
                    Some(value) => match value.downcast::<NSView>() {
                        Ok(view) => Responder::View(view),
                        Err(_) => Responder::Nonview,
                    },
                };
                let main_view = webview.inner().cast::<NSView>();
                let main_view_owned = !main_view.is_null()
                    && webview.ns_window() == expected
                    // WKWebView is an NSView subclass. Tauri retains it throughout this callback.
                    && unsafe { &*main_view }.window().is_some_and(|owner| {
                        Retained::as_ptr(&owner).cast::<std::ffi::c_void>() == expected.cast_const()
                    });
                let ownership = classify(responder, main_view_owned, |view| {
                    let in_main_window = view.window().map(|owner| {
                        Retained::as_ptr(&owner).cast::<std::ffi::c_void>() == expected.cast_const()
                    });
                    let is_main_webview = Retained::as_ptr(view) == main_view.cast_const();
                    // The entire parent chain remains live within this main-thread callback.
                    let parent = if in_main_window == Some(true) && !is_main_webview {
                        unsafe { view.superview() }
                    } else {
                        None
                    };
                    ViewStep {
                        in_main_window,
                        is_main_webview,
                        parent,
                    }
                });
                Ok((responder_class, ownership))
            })();
            *captured.lock() = Some(result);
        })
        .map_err(|error| error.to_string())?;
    // Current cached Wry dispatches with_webview inline on the UI thread. Fail closed if that changes.
    let result = output.lock().take();
    result
        .ok_or_else(|| "Keyboard ownership callback did not complete synchronously".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(own: Option<bool>, main: bool, parent: Option<u8>) -> ViewStep<u8> {
        ViewStep {
            in_main_window: own,
            is_main_webview: main,
            parent,
        }
    }
    #[test]
    fn equal_and_descendant_require_exact_view_identity_in_owned_window() {
        let equal = classify(Responder::View(0), true, |_| view(Some(true), true, None));
        assert_eq!(equal.classification, KeyboardOwner::EqualMainWebview);
        assert!(equal.verified());
        let child = classify(Responder::View(2_u8), true, |n| {
            view(Some(true), *n == 0, n.checked_sub(1))
        });
        assert_eq!(child.classification, KeyboardOwner::DescendantOfMainWebview);
        assert_eq!((child.ancestry_depth, child.inspected_views), (2, 3));
        assert!(child.verified());
    }
    #[test]
    fn absent_nonview_and_other_owned_view_are_distinct_and_unverified() {
        let absent = classify::<u8>(Responder::NoResponder, true, |_| unreachable!());
        let nonview = classify::<u8>(Responder::Nonview, true, |_| unreachable!());
        let other = classify(Responder::View(7), true, |_| view(Some(true), false, None));
        assert_eq!(absent.classification, KeyboardOwner::NoResponder);
        assert_eq!(nonview.classification, KeyboardOwner::Nonview);
        assert_eq!(other.classification, KeyboardOwner::OtherOwnedView);
        assert!([absent, nonview, other]
            .iter()
            .all(|value| !value.verified()));
    }
    #[test]
    fn foreign_and_unknown_windows_never_gain_ownership_even_with_matching_view() {
        for (own, expected) in [
            (Some(false), KeyboardOwner::ForeignWindowView),
            (None, KeyboardOwner::Unknown),
        ] {
            let value = classify(Responder::View(0), true, |_| view(own, true, None));
            assert_eq!(value.classification, expected);
            assert!(!value.verified());
        }
        let invalid_main = classify(Responder::View(0), false, |_| panic!("must not walk"));
        assert_eq!(invalid_main.classification, KeyboardOwner::Unknown);
        assert!(!invalid_main.verified());
    }
    #[test]
    fn cycles_and_overdeep_ancestry_stop_at_64_view_nodes() {
        let mut calls = 0;
        let value = classify(Responder::View(9), true, |node| {
            calls += 1;
            view(Some(true), false, Some(*node))
        });
        assert_eq!(calls, 64);
        assert_eq!((value.ancestry_depth, value.inspected_views), (63, 64));
        assert!(value.ancestry_limit_reached);
        assert!(!value.verified());
        let last = classify(Responder::View(63_u8), true, |n| {
            view(Some(true), *n == 0, n.checked_sub(1))
        });
        assert!(last.verified());
        assert_eq!(last.inspected_views, 64);
    }
    #[test]
    fn serialized_evidence_contains_only_fixed_enum_and_budget_fields() {
        let value = serde_json::to_value(KeyboardOwnership::unknown()).unwrap();
        assert_eq!(
            value,
            serde_json::json!({"classification":"unknown","ancestryDepth":0,
            "inspectedViews":0,"ancestryLimit":64,"ancestryLimitReached":false})
        );
    }
}
