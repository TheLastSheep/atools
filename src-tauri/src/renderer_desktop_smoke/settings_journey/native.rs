use super::state::{owned_child_count, owned_children};
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview, Wry};
use tokio::sync::oneshot;

const SESSION_TIMEOUT: Duration = Duration::from_secs(18);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(30);
const FIXED_PLACEHOLDER: &str = "atools-native-settings-fixed";
const GENERAL_RAW_LIMIT: usize = 64 * 1024;
const EXPECTED_HEADER_LOGICAL: f64 = 58.0;

pub(super) async fn wait_for_active_child(
    app: &AppHandle<Wry>,
) -> Result<(Webview<Wry>, String), &'static str> {
    let deadline = tokio::time::Instant::now() + SESSION_TIMEOUT;
    loop {
        let diagnostics = crate::renderer_settings_view::snapshot(app);
        if diagnostics["stateAvailable"].as_bool() == Some(true)
            && diagnostics["runtimeInitialized"].as_bool() == Some(true)
            && diagnostics["sessionCount"].as_u64() == Some(1)
            && diagnostics["ready"].as_bool() == Some(true)
            && diagnostics["childPresent"].as_bool() == Some(true)
        {
            let window =
                crate::window::main_window(app).map_err(|_| "settings-main-window-unavailable")?;
            let children = owned_children(&window);
            if children.len() == 1 {
                let child = children
                    .into_iter()
                    .next()
                    .ok_or("settings-child-missing")?;
                let id = child
                    .label()
                    .strip_prefix("ztools-settings-")
                    .ok_or("settings-child-label-invalid")?
                    .to_owned();
                if child_identity_matches(app, &child, &id) {
                    return Ok((child, id));
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-child-native-session-readiness-timeout");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) async fn wait_for_closed_session(app: &AppHandle<Wry>) -> Result<bool, &'static str> {
    let deadline = tokio::time::Instant::now() + CLOSE_TIMEOUT;
    loop {
        let diagnostics = crate::renderer_settings_view::snapshot(app);
        let window = crate::window::main_window(app)
            .map_err(|_| "settings-main-window-unavailable-after-close")?;
        let absent = diagnostics["stateAvailable"].as_bool() == Some(true)
            && diagnostics["runtimeInitialized"].as_bool() == Some(true)
            && diagnostics["sessionCount"].as_u64() == Some(0)
            && diagnostics["childPresent"].as_bool() == Some(false)
            && owned_child_count(&window) == 0;
        let layout = crate::window::main_child_layout_active_count(app).ok();
        let drained = diagnostics["pendingCalls"].as_u64() == Some(0)
            && diagnostics["pendingWrites"].as_u64() == Some(0);
        if absent && layout == Some(0) && drained {
            return Ok(true);
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok(false);
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) async fn wait_for_saved_raw(app: &AppHandle<Wry>) -> Result<String, &'static str> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(18);
    loop {
        let raw = raw_general(app)?;
        if parse_general(&raw)
            .and_then(|value| {
                value
                    .get("placeholder")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .as_deref()
            == Some(FIXED_PLACEHOLDER)
        {
            return Ok(raw);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-general-database-commit-timeout");
        }
        tokio::time::sleep(POLL_INTERVAL).await;
    }
}

pub(super) fn raw_general(app: &AppHandle<Wry>) -> Result<String, &'static str> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or("settings-fixture-app-state-unavailable")?;
    state
        .db
        .read_renderer_general_settings()
        .map_err(|_| "settings-fixture-database-read-failed")?
        .ok_or("settings-fixture-general-missing")
}

pub(super) fn parse_general(raw: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(raw).ok()?;
    value.as_object()?;
    Some(value)
}

pub(super) fn fixture_is_valid(raw: &str, value: &Value, auto_clear: &str) -> bool {
    let terminal = value.get("terminalCustomCommand").and_then(Value::as_str);
    raw.len() <= GENERAL_RAW_LIMIT
        && value.get("placeholder").and_then(Value::as_str)
            == Some("atools-native-settings-initial")
        && value.get("theme").and_then(Value::as_str) == Some("dark")
        && value.get("primaryColor").and_then(Value::as_str) == Some("blue")
        && value.get("customColor").and_then(Value::as_str) == Some("#db2777")
        && value.get("autoClear").and_then(Value::as_str) == Some(auto_clear)
        && value.get("showRecentInSearch").and_then(Value::as_bool) == Some(false)
        && value.get("recentRows").and_then(Value::as_u64) == Some(2)
        && value.get("pinnedRows").and_then(Value::as_u64) == Some(2)
        && value.get("searchMode").and_then(Value::as_str) == Some("list")
        && value
            .get("showMatchRecommendation")
            .and_then(Value::as_bool)
            == Some(true)
        && value.get("tabKeyFunction").and_then(Value::as_str) == Some("navigate")
        && value.get("spaceOpenCommand").and_then(Value::as_bool) == Some(false)
        && value
            .get("tabTargetCommand")
            .and_then(Value::as_str)
            .map(str::len)
            == Some(2049)
        && value.get("windowDefaultHeight").and_then(Value::as_i64) == Some(2001)
        && terminal.is_some_and(|command| command.len() > 4 * 1024)
        && value.get("aiApiKey").and_then(Value::as_str)
            == Some("ATools-Fake-AI-Secret-Do-Not-Expose")
        && value.get("webdavPassword").and_then(Value::as_str)
            == Some("ATools-Fake-WebDAV-Password-Do-Not-Expose")
        && value.get("proxyUrl").and_then(Value::as_str)
            == Some("ATools-Fake-Proxy-URL-Do-Not-Expose")
        && value["unknownNested"]["marker"].as_str()
            == Some("ATools-Fake-Unknown-Nested-Secret-Do-Not-Expose")
}

pub(super) fn unknown_fields_preserved(before: &Value, after: &Value) -> bool {
    [
        "aiApiKey",
        "webdavPassword",
        "unknownNested",
        "proxyUrl",
        "terminalCustomCommand",
        "tabTargetCommand",
        "windowDefaultHeight",
    ]
    .into_iter()
    .all(|key| before.get(key) == after.get(key))
}

pub(super) fn child_identity_matches(app: &AppHandle<Wry>, child: &Webview<Wry>, id: &str) -> bool {
    let expected_label = format!("ztools-settings-{id}");
    let expected_url = format!("atools-settings://{id}.localhost/index.html#/generalSetting");
    let actual = app.get_webview(&expected_label);
    child.label() == expected_label
        && child.window().label() == "main"
        && child.url().is_ok_and(|url| url.as_str() == expected_url)
        && actual.is_some_and(|view| view.label() == child.label())
}

pub(super) fn child_url(child: &Webview<Wry>) -> Result<String, &'static str> {
    child
        .url()
        .map(|url| url.to_string())
        .map_err(|_| "settings-child-url-unavailable")
}

pub(super) fn inspect_native_child_bounds(child: &Webview<Wry>) -> Result<Value, &'static str> {
    let position = child
        .position()
        .map_err(|_| "settings-child-bounds-position-unavailable")?;
    let size = child
        .size()
        .map_err(|_| "settings-child-bounds-size-unavailable")?;
    let parent = child.window();
    let parent_size = parent
        .inner_size()
        .map_err(|_| "settings-parent-bounds-size-unavailable")?;
    let scale = parent
        .scale_factor()
        .map_err(|_| "settings-parent-bounds-scale-unavailable")?;
    if !scale.is_finite() || scale <= 0.0 || parent_size.width == 0 || parent_size.height == 0 {
        return Err("settings-parent-bounds-invalid");
    }

    let parent_height_logical = f64::from(parent_size.height) / scale;
    if parent_height_logical <= EXPECTED_HEADER_LOGICAL {
        return Err("settings-parent-viewport-insufficient");
    }
    let right = i64::from(position.x) + i64::from(size.width);
    let bottom = i64::from(position.y) + i64::from(size.height);
    let fits_parent = position.x >= 0
        && position.y >= 0
        && right <= i64::from(parent_size.width) + 2
        && bottom <= i64::from(parent_size.height) + 2;
    let x_origin_verified = i64::from(position.x).abs() as f64 <= scale * 3.0;
    let width_fills_parent =
        (i64::from(size.width) - i64::from(parent_size.width)).abs() as f64 <= scale * 3.0;
    let observed_header_logical = f64::from(position.y) / scale;
    let header_reservation_verified =
        (observed_header_logical - EXPECTED_HEADER_LOGICAL).abs() <= 3.0;
    let content_height_fills_parent =
        (bottom - i64::from(parent_size.height)).abs() as f64 <= 3.0 * scale;
    let height_positive = size.height > 0;
    let bounds_verified = fits_parent
        && x_origin_verified
        && width_fills_parent
        && header_reservation_verified
        && content_height_fills_parent
        && height_positive;

    Ok(json!({
        "x": position.x,
        "y": position.y,
        "width": size.width,
        "height": size.height,
        "parentWidth": parent_size.width,
        "parentHeight": parent_size.height,
        "scaleFactor": scale,
        "expectedHeaderLogical": EXPECTED_HEADER_LOGICAL,
        "observedHeaderLogical": observed_header_logical,
        "fitsParent": fits_parent,
        "xOriginVerified": x_origin_verified,
        "widthFillsParent": width_fills_parent,
        "headerReservationVerified": header_reservation_verified,
        "contentHeightFillsParent": content_height_fills_parent,
        "boundsVerified": bounds_verified,
    }))
}

pub(super) fn trusted_child_source(diagnostics: &Value, child: &Webview<Wry>, id: &str) -> bool {
    diagnostics["stateAvailable"].as_bool() == Some(true)
        && diagnostics["runtimeInitialized"].as_bool() == Some(true)
        && diagnostics["sessionCount"].as_u64() == Some(1)
        && diagnostics["ready"].as_bool() == Some(true)
        && diagnostics["bundleCached"].as_bool() == Some(true)
        && diagnostics["bundleRevisionPresent"].as_bool() == Some(true)
        && diagnostics["bundleResourceCount"]
            .as_u64()
            .is_some_and(|count| count > 0)
        && diagnostics["bundleBytes"]
            .as_u64()
            .is_some_and(|bytes| bytes > 0)
        && child_identity_matches(&child.app_handle(), child, id)
}

pub(super) fn record_probe_error(
    harness: &super::state::Harness,
    evidence: &Value,
    error: &'static str,
) {
    if evidence
        .as_object()
        .is_none_or(|object| object.values().any(|value| value == &Value::Bool(false)))
    {
        harness.record_error(error);
    }
}

pub(super) fn native_main_window_state(app: &AppHandle<Wry>) -> (bool, bool) {
    crate::window::main_window(app)
        .map(|window| {
            (
                window.is_visible().unwrap_or(false),
                window.is_focused().unwrap_or(false),
            )
        })
        .unwrap_or((false, false))
}

pub(super) fn option_count(value: Option<usize>) -> Value {
    value.map_or(Value::Null, |value| Value::from(value as u64))
}

pub(super) async fn child_incognito_data_store_persistent(
    child: &Webview<Wry>,
) -> Result<bool, &'static str> {
    let (sender, receiver) = oneshot::channel();
    #[cfg(target_os = "macos")]
    {
        child
            .with_webview(move |platform| {
                use objc2::MainThreadMarker;
                use objc2_web_kit::WKWebView;

                let persistent = if MainThreadMarker::new().is_some() {
                    let pointer = platform.inner();
                    if pointer.is_null() {
                        None
                    } else {
                        let native = unsafe { &*pointer.cast::<WKWebView>() };
                        let configuration = unsafe { native.configuration() };
                        let store = unsafe { configuration.websiteDataStore() };
                        Some(unsafe { store.isPersistent() })
                    }
                } else {
                    None
                };
                let _ = sender.send(persistent);
            })
            .map_err(|_| "settings-child-native-webview-observation-failed")?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (child, sender);
        return Err("settings-child-incognito-observation-requires-macos");
    }
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "settings-child-incognito-observation-timeout")?
        .map_err(|_| "settings-child-incognito-observation-interrupted")?
        .ok_or("settings-child-incognito-state-unavailable")
}
