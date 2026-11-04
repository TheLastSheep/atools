//! Main-renderer commands for the durable ZTools app history and pin records.

#[cfg(test)]
#[path = "renderer_app_state_tests.rs"]
mod tests;

use crate::{
    launcher_app_catalog::{self, LauncherApp},
    launcher_app_catalog_source::LauncherAppCatalogSource,
    state::AppState,
};
use atools_core::db::{
    RendererAppIdentity, RendererAppStateMutation, RendererAppStateSnapshot, RendererDirectSubtype,
    RendererLocalShortcut,
};
use serde::Deserialize;
use serde_json::Value;
use std::{
    future::Future,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, State, Webview, Window};

const EVENT_NAME: &str = "atools://renderer-app-state";
const APP_LAUNCHED_EVENT_NAME: &str = "atools://renderer-app-launched";
const MAX_PATH_BYTES: usize = 16 * 1024;
const MAX_NAME_BYTES: usize = 4096;
const MAX_REORDER_ITEMS: usize = 4096;
const OPEN_FAILED: &str = "应用未能启动，最近使用未记录";
const OPEN_PERMISSION_DENIED: &str = "应用启动被权限策略拒绝，最近使用未记录";
const RECORD_FAILED: &str = "应用已启动，但最近使用未保存";

/// Mutations exposed to the main renderer. RecordLaunch is deliberately absent:
/// history is written only after the native launch pipeline succeeds.
#[derive(Debug, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum RendererAppMutationRequest {
    Pin { app: RendererAppIdentity },
    Unpin { path: String, name: Option<String> },
    RemoveHistory { path: String, name: Option<String> },
    ReorderPins { apps: Vec<RendererAppIdentity> },
    ClearPins {},
    ClearHistory {},
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum OpenFailure {
    Failed,
    PermissionDenied,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum LaunchStageError {
    Open,
    Permission,
    Record,
}

impl LaunchStageError {
    pub(crate) fn message(self) -> &'static str {
        match self {
            Self::Open => OPEN_FAILED,
            Self::Permission => OPEN_PERMISSION_DENIED,
            Self::Record => RECORD_FAILED,
        }
    }
}

#[tauri::command]
pub(crate) async fn launch_renderer_app(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    target: RendererAppIdentity,
) -> Result<RendererAppStateSnapshot, String> {
    ensure_main_webview(webview.label())?;
    validate_identity(&target)?;

    let catalog = Arc::clone(&state.launcher_app_catalog);
    if !target_is_registered(catalog, Arc::clone(&state.db), &target).await? {
        return Err(match target.sub_type {
            RendererDirectSubtype::App => "Application is not in the native launcher catalog",
            RendererDirectSubtype::LocalShortcut => "Local shortcut is not registered",
        }
        .into());
    }

    crate::app_launch_service::launch_main_app(app, Arc::clone(&state.db), target).await
}

/// Main-renderer reveal requests are revalidated against Native state on every use.
#[tauri::command]
pub(crate) async fn reveal_renderer_target(
    webview: Webview,
    window: Window,
    app: AppHandle,
    state: State<'_, AppState>,
    target: RendererAppIdentity,
) -> Result<Value, String> {
    ensure_main_command_context(&app, &webview, &window)?;
    validate_identity(&target)?;
    if !target_is_registered(
        Arc::clone(&state.launcher_app_catalog),
        Arc::clone(&state.db),
        &target,
    )
    .await?
    {
        return Err("Renderer reveal target is no longer registered".into());
    }

    let audit_db = Arc::clone(&state.db);
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &audit_db,
        "atools-ui",
        "open_or_reveal_path",
        serde_json::json!({"path":target.path,"reveal":true}),
        true,
    )
    .await;
    if result.is_error {
        return Err("The registered target could not be revealed".into());
    }
    Ok(serde_json::json!({"ok":true}))
}

#[tauri::command]
pub(crate) async fn mutate_renderer_app_state(
    webview: Webview,
    app: AppHandle,
    state: State<'_, AppState>,
    request: RendererAppMutationRequest,
) -> Result<RendererAppStateSnapshot, String> {
    ensure_main_webview(webview.label())?;
    let catalog = Arc::clone(&state.launcher_app_catalog);
    let mutation = match request {
        RendererAppMutationRequest::Pin { app } => {
            validate_identity(&app)?;
            if !target_is_registered(Arc::clone(&catalog), Arc::clone(&state.db), &app).await? {
                return Err(match app.sub_type {
                    RendererDirectSubtype::App => {
                        "Application is not in the native launcher catalog"
                    }
                    RendererDirectSubtype::LocalShortcut => "Local shortcut is not registered",
                }
                .into());
            }
            RendererAppStateMutation::Pin { app }
        }
        RendererAppMutationRequest::Unpin { path, name } => {
            validate_filter(&path, name.as_deref())?;
            RendererAppStateMutation::Unpin { path, name }
        }
        RendererAppMutationRequest::RemoveHistory { path, name } => {
            validate_filter(&path, name.as_deref())?;
            RendererAppStateMutation::RemoveHistory { path, name }
        }
        RendererAppMutationRequest::ReorderPins { apps } => {
            if apps.len() > MAX_REORDER_ITEMS {
                return Err("Pinned application list exceeds the item limit".into());
            }
            for identity in &apps {
                validate_identity(identity)?;
            }
            RendererAppStateMutation::ReorderPins { apps }
        }
        RendererAppMutationRequest::ClearPins {} => RendererAppStateMutation::ClearPins,
        RendererAppMutationRequest::ClearHistory {} => RendererAppStateMutation::ClearHistory,
    };

    let snapshot = apply_mutation(Arc::clone(&state.db), mutation).await?;
    emit_changed_snapshot(&app, &snapshot);
    Ok(snapshot)
}

pub(crate) async fn coordinate_launch<T, OpenFuture, RecordFuture>(
    open: impl FnOnce() -> OpenFuture,
    record: impl FnOnce() -> RecordFuture,
    after_record: impl FnOnce(&T),
) -> Result<T, LaunchStageError>
where
    OpenFuture: Future<Output = Result<(), OpenFailure>>,
    RecordFuture: Future<Output = Result<T, ()>>,
{
    match open().await {
        Ok(()) => {}
        Err(OpenFailure::Failed) => return Err(LaunchStageError::Open),
        Err(OpenFailure::PermissionDenied) => return Err(LaunchStageError::Permission),
    }
    let result = record().await.map_err(|_| LaunchStageError::Record)?;
    after_record(&result);
    Ok(result)
}

pub(crate) fn classify_open_result(
    is_error: bool,
    status: Option<&str>,
    error: Option<&str>,
) -> Result<(), OpenFailure> {
    if !is_error {
        return Ok(());
    }
    if status == Some("cancelled") && error == Some("Permission denied") {
        Err(OpenFailure::PermissionDenied)
    } else {
        Err(OpenFailure::Failed)
    }
}

async fn apply_mutation(
    db: Arc<atools_core::db::Database>,
    mutation: RendererAppStateMutation,
) -> Result<RendererAppStateSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || db.apply_renderer_app_state(mutation))
        .await
        .map_err(|_| "Renderer app state worker failed".to_owned())?
        .map_err(|_| "Renderer app state could not be updated".to_owned())
}

pub(crate) async fn catalog_contains_identity(
    catalog: Arc<LauncherAppCatalogSource>,
    identity: &RendererAppIdentity,
) -> Result<bool, String> {
    let path = identity.path.clone();
    let apps = tauri::async_runtime::spawn_blocking(move || catalog.snapshot())
        .await
        .map_err(|_| "Launcher app catalog worker failed".to_owned())??;
    Ok(catalog_contains_path(
        apps.iter().map(LauncherApp::path),
        &path,
    ))
}

pub(crate) async fn target_is_registered(
    catalog: Arc<LauncherAppCatalogSource>,
    db: Arc<atools_core::db::Database>,
    identity: &RendererAppIdentity,
) -> Result<bool, String> {
    match identity.sub_type {
        RendererDirectSubtype::App => catalog_contains_identity(catalog, identity).await,
        RendererDirectSubtype::LocalShortcut => {
            local_shortcut_contains_identity(db, identity).await
        }
    }
}

pub(crate) async fn local_shortcut_contains_identity(
    db: Arc<atools_core::db::Database>,
    identity: &RendererAppIdentity,
) -> Result<bool, String> {
    let path = identity.path.clone();
    let name = identity.name.clone();
    let shortcuts =
        tauri::async_runtime::spawn_blocking(move || db.read_renderer_local_shortcuts())
            .await
            .map_err(|_| "Local shortcut registry worker failed".to_owned())?
            .map_err(|_| "Local shortcut registry is unavailable".to_owned())?;
    let target = RendererAppIdentity {
        path,
        name,
        sub_type: RendererDirectSubtype::LocalShortcut,
    };
    Ok(shortcuts
        .iter()
        .any(|shortcut| local_shortcut_matches_identity(shortcut, &target)))
}

fn local_shortcut_matches_identity(
    shortcut: &RendererLocalShortcut,
    identity: &RendererAppIdentity,
) -> bool {
    let display_name = shortcut
        .alias
        .as_deref()
        .filter(|alias| !alias.trim().is_empty())
        .unwrap_or(&shortcut.name);
    identity.sub_type == RendererDirectSubtype::LocalShortcut
        && shortcut.path == identity.path
        && display_name == identity.name
}

fn catalog_contains_path<'a>(paths: impl IntoIterator<Item = &'a str>, target: &str) -> bool {
    paths.into_iter().any(|path| path == target)
}

pub(crate) fn validate_identity(identity: &RendererAppIdentity) -> Result<(), String> {
    if !valid_path(&identity.path)
        || (identity.sub_type == RendererDirectSubtype::LocalShortcut
            && !std::path::Path::new(&identity.path).is_absolute())
        || identity.name.trim().is_empty()
        || identity.name.len() > MAX_NAME_BYTES
        || identity.name.chars().any(char::is_control)
    {
        return Err("Invalid renderer application identity".into());
    }
    Ok(())
}

pub(crate) fn validate_filter(path: &str, name: Option<&str>) -> Result<(), String> {
    if !valid_path(path)
        || name.is_some_and(|name| {
            name.is_empty() || name.len() > MAX_NAME_BYTES || name.chars().any(char::is_control)
        })
    {
        return Err("Invalid renderer application filter".into());
    }
    Ok(())
}

fn valid_path(path: &str) -> bool {
    !path.is_empty() && path.len() <= MAX_PATH_BYTES && !path.chars().any(char::is_control)
}

fn ensure_main_webview(label: &str) -> Result<(), String> {
    launcher_app_catalog::ensure_main_webview(label)
}

fn ensure_main_command_context(
    app: &AppHandle,
    webview: &Webview,
    window: &Window,
) -> Result<(), String> {
    if !main_context_labels_match(webview.label(), webview.window().label(), window.label()) {
        return Err("Renderer target command is available only to the main renderer".into());
    }
    let actual_main =
        crate::window::main_webview(app).map_err(|_| "Main renderer is unavailable".to_owned())?;
    if actual_main.label() != webview.label() || actual_main.window().label() != "main" {
        return Err("Renderer target command caller is not the actual main renderer".into());
    }
    Ok(())
}

fn main_context_labels_match(webview: &str, parent: &str, window: &str) -> bool {
    webview == "main" && parent == "main" && window == "main"
}

fn renderer_app_state_event_target() -> tauri::EventTarget {
    tauri::EventTarget::webview("main")
}

fn app_launched_event_target() -> tauri::EventTarget {
    tauri::EventTarget::webview("main")
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub(crate) fn emit_changed_snapshot(app: &AppHandle, snapshot: &RendererAppStateSnapshot) {
    if snapshot.changed.is_empty() {
        return;
    }
    emit_confirmed_snapshot(app, snapshot);
}

/// Emits a Core-confirmed snapshot even when `changed` is empty: a retry can
/// first confirm an earlier unknown write. Consumers compare revision and values.
pub(crate) fn emit_confirmed_snapshot(app: &AppHandle, snapshot: &RendererAppStateSnapshot) {
    if crate::window::main_webview(app).is_err() {
        tracing::warn!("Renderer app-state snapshot cannot be emitted without the main webview");
        return;
    }
    if app
        .emit_to(renderer_app_state_event_target(), EVENT_NAME, snapshot)
        .is_err()
    {
        tracing::warn!("Renderer app-state snapshot event could not be delivered");
    }
}

pub(crate) fn emit_launch_success(app: &AppHandle, snapshot: &RendererAppStateSnapshot) {
    complete_launch_success(
        snapshot,
        |snapshot| emit_changed_snapshot(app, snapshot),
        || app.emit_to(app_launched_event_target(), APP_LAUNCHED_EVENT_NAME, ()),
        || crate::window::hide_main_window(app),
    );
}

fn complete_launch_success<T, NotifyError, HideError>(
    snapshot: &T,
    emit_state: impl FnOnce(&T),
    notify_app_launched: impl FnOnce() -> Result<(), NotifyError>,
    hide_main_window: impl FnOnce() -> Result<(), HideError>,
) {
    emit_state(snapshot);
    if notify_app_launched().is_err() {
        tracing::warn!(
            diagnostic = "renderer-app-launched-notification-failed",
            "Native app-launched notification could not be delivered"
        );
    }
    if hide_main_window().is_err() {
        tracing::warn!(
            diagnostic = "renderer-app-launch-hide-failed",
            "Main window could not be hidden after app launch"
        );
    }
}
