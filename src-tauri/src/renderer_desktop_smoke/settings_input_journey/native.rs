use super::{schema, state::Harness};
use crate::state::AppState;
use serde_json::{json, Value};
use std::{path::Path, time::Duration};
use tauri::{AppHandle, Manager, Webview, Wry};

pub(super) struct Capture {
    pub(super) native: Value,
    pub(super) activation: Value,
    pub(super) presentation: Value,
}

pub(super) async fn select_real_catalog_target(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<(), &'static str> {
    let state = app
        .try_state::<AppState>()
        .ok_or("settings-input-catalog-unavailable")?;
    let source = std::sync::Arc::clone(&state.launcher_app_catalog);
    let apps = tauri::async_runtime::spawn_blocking(move || source.snapshot())
        .await
        .map_err(|_| "settings-input-catalog-unavailable")?
        .map_err(|_| "settings-input-catalog-unavailable")?;
    if apps.is_empty() {
        return Err("settings-input-catalog-unavailable");
    }

    let rows = apps
        .iter()
        .filter_map(|app| {
            let value = serde_json::to_value(app).ok()?;
            let name = value.get("name")?.as_str()?.trim();
            let path = value.get("path")?.as_str()?.trim();
            if name.is_empty() || path.is_empty() || !Path::new(path).is_absolute() {
                return None;
            }
            let metadata = std::fs::metadata(path).ok()?;
            if !metadata.is_dir() || std::fs::canonicalize(path).is_err() {
                return None;
            }
            Some((name.to_owned(), path.to_owned()))
        })
        .collect::<Vec<_>>();
    if rows.is_empty() {
        return Err("settings-input-catalog-target-unavailable");
    }

    for (name, path) in &rows {
        let query = name.to_lowercase();
        let hits = rows
            .iter()
            .filter(|(other_name, other_path)| {
                other_name.to_lowercase().contains(&query)
                    || other_path.to_lowercase().contains(&query)
            })
            .count();
        if hits == 1 {
            harness.set_target(name.clone(), path.clone());
            return Ok(());
        }
    }
    Err("settings-input-catalog-target-not-unique")
}

pub(super) async fn active_child(
    app: &AppHandle<Wry>,
    timeout: Duration,
) -> Result<(Webview<Wry>, String), &'static str> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let diagnostics = crate::renderer_settings_view::snapshot(app);
        if diagnostics["stateAvailable"].as_bool() == Some(true)
            && diagnostics["runtimeInitialized"].as_bool() == Some(true)
            && diagnostics["sessionCount"].as_u64() == Some(1)
            && diagnostics["ready"].as_bool() == Some(true)
            && diagnostics["childPresent"].as_bool() == Some(true)
        {
            let window = crate::window::main_window(app)
                .map_err(|_| "settings-input-child-identity-invalid")?;
            let children = owned_children(&window);
            if children.len() == 1 {
                let child = children
                    .into_iter()
                    .next()
                    .ok_or("settings-input-child-identity-invalid")?;
                let id = child
                    .label()
                    .strip_prefix("ztools-settings-")
                    .filter(|id| valid_session_id(id))
                    .ok_or("settings-input-child-identity-invalid")?
                    .to_owned();
                if child_matches(app, &child, &id) {
                    return Ok((child, id));
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-input-child-not-ready");
        }
        tokio::time::sleep(schema::POLL_INTERVAL).await;
    }
}

pub(super) async fn wait_for_closed(app: &AppHandle<Wry>) -> Result<(), &'static str> {
    let deadline = tokio::time::Instant::now() + schema::CLOSE_TIMEOUT;
    loop {
        let diagnostics = crate::renderer_settings_view::snapshot(app);
        let window =
            crate::window::main_window(app).map_err(|_| "settings-input-close-not-drained")?;
        let layout = crate::window::main_child_layout_active_count(app).ok();
        let closed = diagnostics["stateAvailable"].as_bool() == Some(true)
            && diagnostics["runtimeInitialized"].as_bool() == Some(true)
            && diagnostics["sessionCount"].as_u64() == Some(0)
            && diagnostics["childPresent"].as_bool() == Some(false)
            && owned_children(&window).is_empty()
            && layout == Some(0)
            && diagnostics["pendingCalls"].as_u64() == Some(0)
            && diagnostics["pendingWrites"].as_u64() == Some(0);
        if closed {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-input-close-not-drained");
        }
        tokio::time::sleep(schema::POLL_INTERVAL).await;
    }
}

pub(super) async fn capture(
    app: &AppHandle<Wry>,
    harness: &Harness,
    stale_rejected: Option<bool>,
    fresh_session: Option<bool>,
) -> Result<Capture, &'static str> {
    let diagnostics = crate::renderer_settings_view::snapshot(app);
    if diagnostics["stateAvailable"].as_bool() != Some(true)
        || diagnostics["runtimeInitialized"].as_bool() != Some(true)
    {
        return Err("settings-input-native-state-invalid");
    }
    let window = crate::window::main_window(app)
        .map_err(|_| "settings-input-window-became-visible-or-focused")?;
    let window_visible = window
        .is_visible()
        .map_err(|_| "settings-input-window-became-visible-or-focused")?;
    let window_focused = window
        .is_focused()
        .map_err(|_| "settings-input-window-became-visible-or-focused")?;
    let child_views = owned_children(&window);
    let session_count = diagnostics["sessionCount"]
        .as_u64()
        .ok_or("settings-input-native-state-invalid")?;
    if (session_count == 0 && !child_views.is_empty())
        || (session_count == 1 && child_views.len() != 1)
        || session_count > 1
    {
        return Err("settings-input-native-state-invalid");
    }
    let child = child_views.into_iter().next();
    let session_id = match child.as_ref() {
        Some(view) => Some(
            view.label()
                .strip_prefix("ztools-settings-")
                .filter(|id| valid_session_id(id))
                .ok_or("settings-input-child-identity-invalid")?
                .to_owned(),
        ),
        None => None,
    };
    let sub_input = &diagnostics["subInput"];
    let layout_count = crate::window::main_child_layout_active_count(app)
        .map_err(|_| "settings-input-native-state-invalid")?;
    let main_data_store_persistent = data_store_persistent(
        &crate::window::main_webview(app)
            .map_err(|_| "settings-input-main-store-observation-unavailable")?,
    )
    .await?;
    let child_data_store_persistent = match child.as_ref() {
        Some(view) => Some(data_store_persistent(view).await?),
        None => None,
    };
    let snapshot = json!({
        "sessionCount": session_count,
        "childCount": child_views_count(&window),
        "layoutCount": layout_count,
        "pendingCalls": required_count(&diagnostics, "pendingCalls")?,
        "pendingWrites": required_count(&diagnostics, "pendingWrites")?,
        "controlSequence": required_count(sub_input, "controlSequence")?,
        "userSequence": required_count(sub_input, "userSequence")?,
        "valueBytes": required_count(sub_input, "valueBytes")?,
        "inputVisible": sub_input["visible"].as_bool().ok_or("settings-input-native-state-invalid")?,
        "windowVisible": window_visible,
        "windowFocused": window_focused,
        "focusGainedEvents": harness.focus_gained_events(),
        "generation": if session_count == 1 { sub_input["generation"].clone() } else { Value::Null },
        "valueVersion": if session_count == 1 { sub_input["valueVersion"].clone() } else { Value::Null },
        "mainDataStorePersistent": main_data_store_persistent,
        "childDataStorePersistent": child_data_store_persistent,
        "staleInputRejected": stale_rejected,
        "freshSession": fresh_session,
        "opaqueSessionId": session_id,
    });
    let activation = crate::renderer_desktop_smoke::settings_input_activation::sample(app)
        .await
        .map_err(|_| "settings-input-activation-invalid")?;
    let presentation = crate::renderer_settings_view::presentation::snapshot(app);
    Ok(Capture {
        native: snapshot,
        activation,
        presentation,
    })
}

pub(super) async fn native_updater_snapshot(app: &AppHandle<Wry>) -> Result<Value, &'static str> {
    let coordinator = app
        .try_state::<crate::updater::UpdateCoordinator>()
        .ok_or("settings-input-updater-native-snapshot-invalid")?;
    let status = coordinator
        .status()
        .await
        .map_err(|_| "settings-input-updater-native-snapshot-invalid")?;
    serde_json::to_value(status).map_err(|_| "settings-input-updater-native-snapshot-invalid")
}

pub(super) fn child_matches(app: &AppHandle<Wry>, child: &Webview<Wry>, id: &str) -> bool {
    let url = format!("atools-settings://{id}.localhost/index.html#");
    child.label() == format!("ztools-settings-{id}")
        && child.window().label() == "main"
        && child
            .url()
            .is_ok_and(|actual| actual.as_str().starts_with(&url))
        && app
            .get_webview(&format!("ztools-settings-{id}"))
            .is_some_and(|view| view.label() == child.label())
}

pub(super) fn owned_children(window: &tauri::Window<Wry>) -> Vec<Webview<Wry>> {
    window
        .webviews()
        .into_iter()
        .filter(|webview| {
            webview
                .label()
                .strip_prefix("ztools-settings-")
                .is_some_and(valid_session_id)
        })
        .collect()
}

fn child_views_count(window: &tauri::Window<Wry>) -> usize {
    owned_children(window).len()
}

fn valid_session_id(id: &str) -> bool {
    id.len() == 32
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && uuid::Uuid::parse_str(id)
            .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.simple().to_string() == id)
}

fn required_count(value: &Value, key: &str) -> Result<u64, &'static str> {
    value[key]
        .as_u64()
        .ok_or("settings-input-native-state-invalid")
}

async fn data_store_persistent(webview: &Webview<Wry>) -> Result<bool, &'static str> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    #[cfg(target_os = "macos")]
    {
        webview
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
            .map_err(|_| "settings-input-main-store-observation-unavailable")?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (webview, sender);
        return Err("settings-input-data-store-not-nonpersistent");
    }
    tokio::time::timeout(Duration::from_secs(3), receiver)
        .await
        .map_err(|_| "settings-input-main-store-observation-unavailable")?
        .map_err(|_| "settings-input-main-store-observation-unavailable")?
        .ok_or("settings-input-main-store-observation-unavailable")
}
