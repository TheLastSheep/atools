use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tauri::{menu::ContextMenu, AppHandle, Emitter, EventTarget, Manager, Webview};

#[path = "renderer_context_menu_native.rs"]
mod native;

const MAIN_LABEL: &str = "main";
const EVENT_NAME: &str = "atools://renderer-context-menu";
const NATIVE_ID_PREFIX: &str = "atools-renderer-context-";
const MAX_MENU_ROWS: usize = 64;
const MAX_PAYLOAD_BYTES: usize = 128 * 1024;
const MAX_LABEL_BYTES: usize = 512;
const MAX_ACTION_ID_BYTES: usize = 16 * 1024;
const MAX_APP_SHORTCUT_ACTION_ID_BYTES: usize = 128 * 1024;
const SESSION_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Debug, Deserialize, Serialize)]
#[serde(untagged)]
pub(crate) enum RendererMenuItem {
    Action(RendererActionMenuItem),
    More(RendererMoreMenuItem),
    Separator(RendererSeparatorMenuItem),
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RendererMoreMenuItem {
    label: String,
    submenu: Vec<RendererActionMenuItem>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RendererActionMenuItem {
    id: String,
    label: String,
    #[serde(
        default,
        deserialize_with = "deserialize_enabled_if_present",
        skip_serializing_if = "Option::is_none"
    )]
    enabled: Option<bool>,
}

fn deserialize_enabled_if_present<'de, D>(deserializer: D) -> Result<Option<bool>, D::Error>
where
    D: Deserializer<'de>,
{
    bool::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RendererSeparatorMenuItem {
    #[serde(rename = "type")]
    kind: RendererSeparatorKind,
}

#[derive(Debug, Deserialize, Serialize)]
enum RendererSeparatorKind {
    #[serde(rename = "separator")]
    Separator,
}

#[derive(Debug)]
enum PreparedMenuRow {
    Separator,
    More {
        label: String,
        items: Vec<PreparedMenuRow>,
    },
    Item {
        native_id: String,
        label: String,
        enabled: bool,
    },
}

#[derive(Debug, Clone)]
struct MenuSession {
    nonce: String,
    expires_at: Option<Instant>,
    action_ids_by_native_id: HashMap<String, String>,
}

#[derive(Default)]
struct RendererContextMenuState {
    menu_reserved: AtomicBool,
    popup_active: AtomicBool,
    session: Mutex<Option<MenuSession>>,
}

struct ResetFlag<'a>(&'a AtomicBool);

impl Drop for ResetFlag<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// Installs one app-wide native menu selection listener and its bounded state.
pub(crate) fn setup(app: &AppHandle) {
    if !app.manage(RendererContextMenuState::default()) {
        return;
    }

    app.on_menu_event(|app, event| {
        let Some(state) = app.try_state::<RendererContextMenuState>() else {
            return;
        };
        let selected = state.session.lock().ok().and_then(|mut session| {
            resolve_selection(&mut session, event.id().as_ref(), Instant::now())
        });

        if let Some(original_id) = selected {
            let _ = app.emit_to(EventTarget::window(MAIN_LABEL), EVENT_NAME, original_id);
        }
    });
}

/// Returns true only during the native popup call, for the main window blur guard.
pub(crate) fn popup_active(app: &AppHandle) -> bool {
    app.try_state::<RendererContextMenuState>()
        .is_some_and(|state| state.popup_active.load(Ordering::Acquire))
}

#[tauri::command]
pub(crate) async fn show_renderer_context_menu(
    webview: Webview,
    app: AppHandle,
    items: Vec<RendererMenuItem>,
) -> Result<(), String> {
    if !is_main_context(webview.label(), webview.window().label()) {
        return Err("renderer context menus are available only in the main window".into());
    }
    if items.is_empty() {
        return Ok(());
    }

    validate_menu_items(&items)?;
    let state = app
        .try_state::<RendererContextMenuState>()
        .ok_or_else(|| "renderer context menu state is not initialized".to_string())?;

    if state
        .menu_reserved
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("a renderer context menu is already being shown".into());
    }
    let _reservation = ResetFlag(&state.menu_reserved);
    clear_session(&state.session);

    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let (rows, session) = prepare_menu_items(&items, &nonce)?;
    let menu = native::build_native_menu(&app, &rows)?;
    replace_session(&state.session, session)?;

    state.popup_active.store(true, Ordering::Release);
    let popup_guard = ResetFlag(&state.popup_active);
    let popup_result = menu.popup(webview.window());

    if popup_result.is_ok() {
        extend_session_expiry(&state.session, &nonce);
    } else {
        clear_matching_session(&state.session, &nonce);
    }
    drop(popup_guard);

    popup_result.map_err(|error| format!("failed to show renderer context menu: {error}"))
}

fn is_main_context(webview_label: &str, window_label: &str) -> bool {
    webview_label == MAIN_LABEL && window_label == MAIN_LABEL
}

fn validate_menu_items(items: &[RendererMenuItem]) -> Result<(), String> {
    if items.len() > MAX_MENU_ROWS {
        return Err(format!(
            "renderer context menu exceeds {MAX_MENU_ROWS} rows"
        ));
    }

    let payload_bytes = serde_json::to_vec(items)
        .map_err(|error| format!("failed to measure renderer context menu: {error}"))?
        .len();
    if payload_bytes > MAX_PAYLOAD_BYTES {
        return Err(format!(
            "renderer context menu exceeds the {MAX_PAYLOAD_BYTES}-byte payload budget"
        ));
    }

    let mut total = items.len();
    for item in items {
        let actions: Vec<&RendererActionMenuItem> = match item {
            RendererMenuItem::Action(item) => vec![item],
            RendererMenuItem::Separator(_) => vec![],
            RendererMenuItem::More(more) => {
                total += more.submenu.len();
                if more.label != "更多"
                    || more.submenu.len() != 1
                    || more.submenu.iter().any(|a| !app_shortcut_action_id(&a.id))
                {
                    return Err("Only the App shortcut More submenu is allowed".into());
                }
                more.submenu.iter().collect()
            }
        };
        for item in actions {
            let id_limit = if app_shortcut_action_id(&item.id) {
                MAX_APP_SHORTCUT_ACTION_ID_BYTES
            } else {
                MAX_ACTION_ID_BYTES
            };
            if item.label.is_empty()
                || item.label.len() > MAX_LABEL_BYTES
                || item.id.is_empty()
                || item.id.len() > id_limit
            {
                return Err("Invalid context menu action budget".into());
            }
        }
    }
    if total > MAX_MENU_ROWS {
        return Err("Context menu exceeds flattened row budget".into());
    }

    Ok(())
}

fn prepare_menu_items(
    items: &[RendererMenuItem],
    nonce: &str,
) -> Result<(Vec<PreparedMenuRow>, MenuSession), String> {
    let mut rows = Vec::with_capacity(items.len());
    let mut action_ids_by_native_id = HashMap::new();

    let mut index = 0;
    for item in items {
        match item {
            RendererMenuItem::Separator(_) => rows.push(PreparedMenuRow::Separator),
            RendererMenuItem::Action(item) => {
                rows.push(prepare_action(
                    item,
                    nonce,
                    index,
                    &mut action_ids_by_native_id,
                ));
                index += 1;
            }
            RendererMenuItem::More(more) => {
                let mut children = Vec::new();
                for action in &more.submenu {
                    children.push(prepare_action(
                        action,
                        nonce,
                        index,
                        &mut action_ids_by_native_id,
                    ));
                    index += 1;
                }
                rows.push(PreparedMenuRow::More {
                    label: more.label.clone(),
                    items: children,
                });
            }
        }
    }

    Ok((
        rows,
        MenuSession {
            nonce: nonce.to_string(),
            expires_at: None,
            action_ids_by_native_id,
        },
    ))
}

fn prepare_action(
    item: &RendererActionMenuItem,
    nonce: &str,
    index: usize,
    actions: &mut HashMap<String, String>,
) -> PreparedMenuRow {
    let native_id = native_menu_item_id(nonce, index);
    let enabled = item.enabled != Some(false) && supported_action_id(&item.id);
    if enabled {
        actions.insert(native_id.clone(), item.id.clone());
    }
    PreparedMenuRow::Item {
        native_id,
        label: item.label.clone(),
        enabled,
    }
}

fn app_shortcut_action_id(id: &str) -> bool {
    let Some(raw) = id.strip_prefix("add-global-shortcut:") else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    let Some(o) = value.as_object() else {
        return false;
    };
    o.len() == 3
        && o.get("subType").and_then(Value::as_str) == Some("app")
        && o.get("path")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty() && s.len() <= 16 * 1024 && !s.contains('\0'))
        && o.get("name")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty() && s.len() <= 4096 && !s.contains('\0'))
}

fn supported_action_id(id: &str) -> bool {
    if app_shortcut_action_id(id) {
        return true;
    }
    let Some((action, payload)) = id.split_once(':') else {
        return false;
    };
    let recommendation_action = matches!(
        action,
        "pin-recommendation" | "unpin-recommendation" | "move-recommendation-to-front"
    );
    if !recommendation_action
        && !matches!(
            action,
            "pin-app" | "unpin-app" | "remove-from-history" | "reveal-in-finder"
        )
    {
        return false;
    }

    let Ok(payload) = serde_json::from_str::<Value>(payload) else {
        return false;
    };
    let Some(object) = payload.as_object() else {
        return false;
    };
    let Some(path) = object.get("path").and_then(Value::as_str) else {
        return false;
    };
    if path.is_empty() || path.contains('\0') {
        return false;
    }
    if recommendation_action {
        let supported_type = matches!(
            object.get("type").and_then(Value::as_str),
            Some("direct" | "plugin" | "builtin")
        );
        return supported_type
            && atools_core::db::validate_renderer_recommendation_pin(&payload).is_ok();
    }
    if action != "reveal-in-finder"
        && object
            .get("featureCode")
            .is_some_and(|value| !value.is_null() && value.as_str() != Some(""))
    {
        return false;
    }

    if action == "pin-app" {
        let legacy_app = object.get("type").and_then(Value::as_str) == Some("app");
        let direct_app = object.get("type").and_then(Value::as_str) == Some("direct")
            && object.get("subType").and_then(Value::as_str) == Some("app");
        return legacy_app || direct_app;
    }

    true
}

fn native_menu_item_id(nonce: &str, index: usize) -> String {
    format!("{NATIVE_ID_PREFIX}{nonce}-{index}")
}

fn parse_native_menu_item_id(id: &str) -> Option<(&str, usize)> {
    let suffix = id.strip_prefix(NATIVE_ID_PREFIX)?;
    let (nonce, index) = suffix.rsplit_once('-')?;
    if nonce.len() != 32 || !nonce.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let index = index.parse::<usize>().ok()?;
    (index < MAX_MENU_ROWS).then_some((nonce, index))
}

fn resolve_selection(
    session: &mut Option<MenuSession>,
    native_id: &str,
    now: Instant,
) -> Option<String> {
    let current = session.as_ref()?;
    if current
        .expires_at
        .is_some_and(|expires_at| expires_at <= now)
    {
        *session = None;
        return None;
    }

    let (nonce, _) = parse_native_menu_item_id(native_id)?;
    if nonce != current.nonce {
        return None;
    }
    let original_id = current.action_ids_by_native_id.get(native_id)?.clone();
    *session = None;
    Some(original_id)
}

fn replace_session(state: &Mutex<Option<MenuSession>>, session: MenuSession) -> Result<(), String> {
    let mut current = state
        .lock()
        .map_err(|_| "renderer context menu state is unavailable".to_string())?;
    *current = Some(session);
    Ok(())
}

fn clear_session(state: &Mutex<Option<MenuSession>>) {
    if let Ok(mut current) = state.lock() {
        *current = None;
    }
}

fn clear_matching_session(state: &Mutex<Option<MenuSession>>, nonce: &str) {
    if let Ok(mut current) = state.lock() {
        if current
            .as_ref()
            .is_some_and(|session| session.nonce == nonce)
        {
            *current = None;
        }
    }
}

fn extend_session_expiry(state: &Mutex<Option<MenuSession>>, nonce: &str) {
    if let Ok(mut current) = state.lock() {
        if let Some(session) = current.as_mut().filter(|session| session.nonce == nonce) {
            session.expires_at = Some(Instant::now() + SESSION_TTL);
        }
    }
}

#[cfg(test)]
#[path = "renderer_context_menu_tests.rs"]
mod renderer_context_menu_tests;
