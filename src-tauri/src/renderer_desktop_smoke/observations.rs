use serde_json::Value;
use tauri::{Manager, Window};

#[path = "window_event_observations.rs"]
mod window_events;
pub(in crate::renderer_desktop_smoke) use window_events::{window_event_flow_errors, EventLedger};

pub(super) const QUERY: &str = "ATools native focus fixture";
pub(super) const MAX_WINDOW_EVENTS: usize = 64;
pub(super) const FOCUS_TARGET_LABEL: &str = "renderer-smoke-focus-target";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Stage {
    Shown,
    Prepared,
    Hidden,
    Reshown,
    PreparedBlur,
    BlurHidden,
    BlurReturn,
    Disposed,
    DisposedReturn,
}

impl Stage {
    pub(super) const ALL: [Self; 9] = [
        Self::Shown,
        Self::Prepared,
        Self::Hidden,
        Self::Reshown,
        Self::PreparedBlur,
        Self::BlurHidden,
        Self::BlurReturn,
        Self::Disposed,
        Self::DisposedReturn,
    ];

    pub(super) fn as_str(self) -> &'static str {
        match self {
            Self::Shown => "shown",
            Self::Prepared => "prepared",
            Self::Hidden => "hidden",
            Self::Reshown => "reshown",
            Self::PreparedBlur => "prepared-blur",
            Self::BlurHidden => "blur-hidden",
            Self::BlurReturn => "blur-return",
            Self::Disposed => "disposed",
            Self::DisposedReturn => "disposed-return",
        }
    }

    pub(super) fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|stage| stage.as_str() == value)
    }

    pub(super) fn requires_foreground(self) -> bool {
        matches!(
            self,
            Self::Shown
                | Self::Prepared
                | Self::Reshown
                | Self::PreparedBlur
                | Self::BlurReturn
                | Self::Disposed
                | Self::DisposedReturn
        )
    }

    pub(super) fn requires_hidden(self) -> bool {
        matches!(self, Self::Hidden | Self::BlurHidden)
    }

    pub(super) fn requires_query(self) -> bool {
        matches!(self, Self::Prepared | Self::PreparedBlur)
    }

    pub(super) fn is_return(self) -> bool {
        matches!(self, Self::Reshown | Self::BlurReturn)
    }

    pub(super) fn requires_disposed(self) -> bool {
        matches!(self, Self::Disposed | Self::DisposedReturn)
    }
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct NativeObservation {
    pub(super) visible: Option<bool>,
    pub(super) focused: Option<bool>,
    pub(super) application_active: Option<bool>,
    pub(super) application_hidden: Option<bool>,
    pub(super) frontmost_is_self: Option<bool>,
    pub(super) window_occlusion_visible: Option<bool>,
    pub(super) main_bundle_identifier: Option<String>,
    pub(super) running_application_bundle_identifier: Option<String>,
    pub(super) incognito_data_store_persistent: Option<bool>,
}

impl NativeObservation {
    pub(super) fn capture(window: &Window, incognito_data_store_persistent: Option<bool>) -> Self {
        let mut result = Self {
            visible: window.is_visible().ok(),
            focused: window.is_focused().ok(),
            incognito_data_store_persistent,
            ..Self::default()
        };

        #[cfg(target_os = "macos")]
        {
            use objc2::MainThreadMarker;
            use objc2_app_kit::{
                NSApplication, NSRunningApplication, NSWindow, NSWindowOcclusionState, NSWorkspace,
            };
            use objc2_foundation::NSBundle;

            if let Some(marker) = MainThreadMarker::new() {
                let running = NSRunningApplication::currentApplication();
                let application = NSApplication::sharedApplication(marker);
                let main_bundle = NSBundle::mainBundle();
                result.application_active = Some(application.isActive());
                result.application_hidden = Some(application.isHidden());
                result.main_bundle_identifier = main_bundle
                    .bundleIdentifier()
                    .map(|identifier| identifier.to_string());
                result.running_application_bundle_identifier = running
                    .bundleIdentifier()
                    .map(|identifier| identifier.to_string());
                let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication();
                result.frontmost_is_self = Some(frontmost.is_some_and(|application| {
                    application.processIdentifier() == std::process::id() as i32
                }));

                if let Ok(pointer) = window.ns_window() {
                    if !pointer.is_null() {
                        let native_window = unsafe { &*pointer.cast::<NSWindow>() };
                        result.window_occlusion_visible = Some(
                            native_window
                                .occlusionState()
                                .contains(NSWindowOcclusionState::Visible),
                        );
                    }
                }
            }
        }

        result
    }

    pub(super) fn foreground_verified(&self, dom: &Value, expected_identifier: &str) -> bool {
        self.visible == Some(true)
            && self.focused == Some(true)
            && self.application_active == Some(true)
            && self.application_hidden == Some(false)
            && self.frontmost_is_self == Some(true)
            && self.window_occlusion_visible == Some(true)
            && self.main_bundle_identifier.as_deref() == Some(expected_identifier)
            && self.running_application_bundle_identifier.as_deref() == Some(expected_identifier)
            && dom.get("documentVisibility").and_then(Value::as_str) == Some("visible")
            && dom.get("documentHasFocus").and_then(Value::as_bool) == Some(true)
    }
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct StageObservation {
    pub(super) stage: &'static str,
    pub(super) elapsed_ms: f64,
    pub(super) dom: Value,
    pub(super) native: NativeObservation,
    pub(super) errors: Vec<&'static str>,
}

pub(super) fn verify_stage(
    stage: Stage,
    auto_clear: &str,
    expected_identifier: &str,
    dom: &Value,
    native: &NativeObservation,
    pre_dispose_counters: Option<&Value>,
) -> Vec<&'static str> {
    let mut errors = Vec::new();
    if dom.get("inputFound").and_then(Value::as_bool) != Some(true) {
        errors.push("original-search-input-missing-at-stage");
    }
    if !stage.requires_disposed()
        && dom
            .get("adapter")
            .and_then(|adapter| adapter.get("disposed"))
            .and_then(Value::as_bool)
            == Some(true)
    {
        errors.push("production-adapter-disposed-before-dispose-stage");
    }
    if dom.get("stageReady").and_then(Value::as_bool) != Some(true) {
        errors.push("renderer-stage-readiness-timeout");
    }

    if stage.requires_foreground() && !native.foreground_verified(dom, expected_identifier) {
        errors.push("foreground-native-dom-or-app-identity-evidence-incomplete");
    }
    if stage.requires_hidden() {
        if native.visible != Some(false) {
            errors.push("main-window-native-visibility-did-not-become-hidden");
        }
        if native.focused != Some(false) {
            errors.push("main-window-native-focus-did-not-become-lost");
        }
        if dom.get("documentVisibility").and_then(Value::as_str) != Some("hidden") {
            errors.push("main-document-did-not-become-hidden");
        }
        if dom.get("documentHasFocus").and_then(Value::as_bool) != Some(false) {
            errors.push("main-document-retained-focus-after-blur");
        }
    }
    if stage.requires_query() && dom.get("inputValue").and_then(Value::as_str) != Some(QUERY) {
        errors.push("programmatic-query-was-not-retained");
    }
    if stage.is_return() {
        if dom.get("inputFocused").and_then(Value::as_bool) != Some(true) {
            errors.push("search-input-not-focused-after-window-return");
        }
        let value = dom.get("inputValue").and_then(Value::as_str);
        let selection_start = dom.get("selectionStart").and_then(Value::as_u64);
        let selection_end = dom.get("selectionEnd").and_then(Value::as_u64);
        let expected = if auto_clear == "immediately" {
            value == Some("")
        } else {
            value == Some(QUERY)
                && selection_start == Some(0)
                && selection_end == Some(QUERY.len() as u64)
        };
        if !expected {
            errors.push("auto-clear-return-search-state-mismatch");
        }
    }
    if stage.requires_disposed() {
        verify_disposed_adapter(dom, &mut errors);
    }
    if stage == Stage::Disposed || stage == Stage::DisposedReturn {
        if stage == Stage::DisposedReturn && dom.get("preDisposeCounters") != pre_dispose_counters {
            errors.push("pre-dispose-counter-baseline-changed");
        }
        let baseline = if stage == Stage::Disposed {
            dom.get("preDisposeCounters")
        } else {
            pre_dispose_counters
        };
        verify_post_dispose_counters(dom.get("adapter"), baseline, &mut errors);
    }
    errors
}

fn verify_post_dispose_counters(
    adapter: Option<&Value>,
    baseline: Option<&Value>,
    errors: &mut Vec<&'static str>,
) {
    let Some(baseline) = baseline else {
        errors.push("pre-dispose-counter-baseline-missing");
        return;
    };
    let Some(baseline_native_calls) = baseline.get("nativeCalls").and_then(Value::as_object) else {
        errors.push("pre-dispose-native-call-baseline-invalid");
        return;
    };
    let Some(adapter) = adapter else {
        errors.push("disposed-adapter-snapshot-missing");
        return;
    };
    let Some(native_calls) = adapter.get("nativeCalls").and_then(Value::as_object) else {
        errors.push("post-dispose-native-call-counters-invalid");
        return;
    };
    for (name, value) in native_calls {
        let Some(after) = value.as_u64() else {
            errors.push("post-dispose-native-call-counters-invalid");
            break;
        };
        let before = baseline_native_calls
            .get(name)
            .and_then(Value::as_u64)
            .unwrap_or_default();
        if after > before {
            errors.push("post-dispose-native-call-counter-increased");
            break;
        }
    }
    let Some(baseline_events) = baseline
        .get("eventSourceDeliveredEvents")
        .and_then(Value::as_object)
    else {
        errors.push("pre-dispose-event-delivery-baseline-invalid");
        return;
    };
    for (name, path) in [
        ("focusEvents", ["focusEvents", "deliveredEvents"].as_slice()),
        (
            "appState",
            ["appState", "eventSource", "deliveredEvents"].as_slice(),
        ),
        (
            "contextMenu",
            ["contextMenu", "eventSource", "deliveredEvents"].as_slice(),
        ),
        (
            "appCatalog",
            ["appCatalog", "eventSource", "deliveredEvents"].as_slice(),
        ),
    ] {
        let before = baseline_events.get(name).and_then(Value::as_u64);
        let after = value_at(adapter, path).and_then(Value::as_u64);
        match (before, after) {
            (Some(before), Some(after)) if after <= before => {}
            (Some(_), Some(_)) => errors.push("post-dispose-event-delivery-counter-increased"),
            _ => errors.push("post-dispose-event-delivery-counters-invalid"),
        }
    }
}

fn verify_disposed_adapter(dom: &Value, errors: &mut Vec<&'static str>) {
    if dom.get("disposeError").and_then(Value::as_str).is_some() {
        errors.push("production-adapter-dispose-threw");
    }
    let Some(adapter) = dom.get("adapter") else {
        errors.push("disposed-adapter-snapshot-missing");
        return;
    };
    if adapter.get("disposed").and_then(Value::as_bool) != Some(true) {
        errors.push("production-adapter-not-disposed");
    }
    if adapter
        .get("outstandingNativeCalls")
        .and_then(Value::as_u64)
        != Some(0)
    {
        errors.push("adapter-native-calls-remain-outstanding-after-dispose");
    }
    let event_sources = [
        adapter.get("focusEvents"),
        adapter
            .get("appState")
            .and_then(|state| state.get("eventSource")),
        adapter
            .get("contextMenu")
            .and_then(|menu| menu.get("eventSource")),
        adapter
            .get("appCatalog")
            .and_then(|catalog| catalog.get("eventSource")),
    ];
    for source in event_sources.into_iter().flatten() {
        if source.get("subscribers").and_then(Value::as_u64) != Some(0)
            || source.get("registrationErrors").and_then(Value::as_u64) != Some(0)
            || source.get("callbackErrors").and_then(Value::as_u64) != Some(0)
            || source.get("registrationsPending").and_then(Value::as_u64) != Some(0)
            || source.get("cleanupPending").and_then(Value::as_u64) != Some(0)
            || source.get("cleanupErrors").and_then(Value::as_u64) != Some(0)
            || source.get("listenerState").and_then(Value::as_str) != Some("disposed")
        {
            errors.push("production-event-source-not-fully-disposed");
            break;
        }
    }
    if event_sources.into_iter().flatten().count() != 4 {
        errors.push("production-event-source-snapshots-incomplete");
    }
    let catalog = adapter.get("appCatalog");
    if catalog
        .and_then(|value| value.get("cachedApps"))
        .and_then(Value::as_u64)
        != Some(0)
        || catalog
            .and_then(|value| value.get("readPending"))
            .and_then(Value::as_bool)
            != Some(false)
    {
        errors.push("production-app-catalog-work-remains-after-dispose");
    }
    if adapter
        .get("appState")
        .and_then(|state| state.get("disposed"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        errors.push("production-app-state-not-disposed");
    }
    let app_state = adapter.get("appState");
    if app_state
        .and_then(|state| state.get("historySubscribers"))
        .and_then(Value::as_u64)
        != Some(0)
        || app_state
            .and_then(|state| state.get("pinnedSubscribers"))
            .and_then(Value::as_u64)
            != Some(0)
        || app_state
            .and_then(|state| state.get("queuedMutations"))
            .and_then(Value::as_u64)
            != Some(0)
    {
        errors.push("production-app-state-subscribers-or-work-remain-after-dispose");
    }
    if adapter
        .get("contextMenu")
        .and_then(|menu| menu.get("disposed"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        errors.push("production-context-menu-not-disposed");
    }
    if adapter
        .get("contextMenu")
        .and_then(|menu| menu.get("subscribers"))
        .and_then(Value::as_u64)
        != Some(0)
    {
        errors.push("production-context-menu-subscribers-remain-after-dispose");
    }
    if adapter
        .get("settingsSnapshot")
        .and_then(|settings| settings.get("disposed"))
        .and_then(Value::as_bool)
        != Some(true)
    {
        errors.push("production-settings-snapshot-not-disposed");
    }
}

fn value_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
}

#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
pub(super) fn incognito_data_store_persistent(
    webview: &tauri::Webview<tauri::Wry>,
) -> tauri::Result<()> {
    use objc2::MainThreadMarker;
    use objc2_web_kit::WKWebView;

    let state = webview
        .app_handle()
        .try_state::<super::controller::Harness>();
    let Some(state) = state else {
        return Ok(());
    };
    let harness = (*state).clone();
    webview.with_webview(move |platform| {
        let persistent = if MainThreadMarker::new().is_some() {
            let pointer = platform.inner();
            if pointer.is_null() {
                None
            } else {
                let native = unsafe { &*pointer.cast::<WKWebView>() };
                let configuration = unsafe { native.configuration() };
                let data_store = unsafe { configuration.websiteDataStore() };
                Some(unsafe { data_store.isPersistent() })
            }
        } else {
            None
        };
        harness.record_incognito(persistent);
    })
}

#[cfg(not(all(target_os = "macos", feature = "legacy-node-smoke")))]
pub(super) fn incognito_data_store_persistent(
    _webview: &tauri::Webview<tauri::Wry>,
) -> tauri::Result<()> {
    Ok(())
}

#[cfg(test)]
#[path = "observations_tests.rs"]
mod tests;
