#![cfg(all(target_os = "macos", feature = "macos-main-panel-prototype"))]

mod layout;
mod native;
mod runtime_methods;

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};

use objc2::{runtime::NSObjectProtocol, ClassType, MainThreadMarker, Message};
use serde::Serialize;
use tauri::{AppHandle, Manager, Wry};
use tauri_nspanel::{ManagerExt, Panel, WebviewPanelManager, WebviewWindowExt};

use layout::OriginalClassAssessment;
use native::OriginalWindowSnapshot;

tauri_nspanel::panel! {
    AToolsMainPanel {
        config: {
            can_become_key_window: true,
            can_become_main_window: false
        }
    }
}

const MAIN_PANEL_MAIN_THREAD_REQUIRED: &str = "MAIN_PANEL_MAIN_THREAD_REQUIRED";
const MAIN_PANEL_SCOPE_REJECTED: &str = "MAIN_PANEL_SCOPE_REJECTED";
const MAIN_PANEL_WINDOW_UNAVAILABLE: &str = "MAIN_PANEL_WINDOW_UNAVAILABLE";
const MAIN_PANEL_LAYOUT_REJECTED: &str = "MAIN_PANEL_LAYOUT_REJECTED";
const MAIN_PANEL_ALREADY_ACTIVE: &str = "MAIN_PANEL_ALREADY_ACTIVE";
const MAIN_PANEL_CONVERSION_FAILED: &str = "MAIN_PANEL_CONVERSION_FAILED";
const MAIN_PANEL_RECOVERY_FAILED: &str = "MAIN_PANEL_RECOVERY_FAILED";
const MAIN_PANEL_STATE_UNAVAILABLE: &str = "MAIN_PANEL_STATE_UNAVAILABLE";
const MAIN_PANEL_DIAGNOSTIC_ERROR_REJECTED: &str = "MAIN_PANEL_DIAGNOSTIC_ERROR_REJECTED";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConversionFacts {
    pub(crate) scoped_identifier_matches: bool,
    pub(crate) main_window_hidden_before_conversion: bool,
    pub(crate) same_native_window: bool,
    pub(crate) original_class: String,
    pub(crate) original_class_assessment: OriginalClassAssessment,
    pub(crate) panel_class: String,
    pub(crate) original_instance_size: usize,
    pub(crate) panel_instance_size: usize,
    pub(crate) tao_focusable_offset: usize,
    pub(crate) ns_panel_own_ivar_count: usize,
    pub(crate) focusable_layout_safe: bool,
    pub(crate) is_panel: bool,
    pub(crate) panel_class_matches: bool,
    pub(crate) nonactivating_style: bool,
    pub(crate) selector_available: bool,
    pub(crate) can_become_key: bool,
    pub(crate) can_become_main: bool,
    pub(crate) still_hidden: bool,
    pub(crate) original_delegate_unchanged: bool,
    pub(crate) content_view_and_parent_unchanged: bool,
    pub(crate) collection_behavior_unchanged: bool,
    pub(crate) released_when_closed_unchanged: bool,
    pub(crate) subview_masks_adjusted: bool,
    pub(crate) level: i64,
    pub(crate) floating: bool,
    pub(crate) hides_on_deactivate: bool,
    pub(crate) becomes_key_only_if_needed: bool,
    pub(crate) subview_count: usize,
    pub(crate) text_input_method_added: Option<bool>,
    pub(crate) runtime_method_lifetime: &'static str,
    pub(crate) runtime_method_removal_supported: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestorationFacts {
    pub(crate) same_native_window: bool,
    pub(crate) original_class_restored: bool,
    pub(crate) original_delegate_restored: bool,
    pub(crate) released_when_closed_restored: bool,
    pub(crate) subview_masks_restored: bool,
    pub(crate) content_view_restored: bool,
    pub(crate) style_mask_restored: bool,
    pub(crate) level_restored: bool,
    pub(crate) collection_behavior_restored: bool,
    pub(crate) hides_on_deactivate_restored: bool,
    pub(crate) can_become_key_restored: bool,
    pub(crate) can_become_main_restored: bool,
    pub(crate) panel_floating_baseline_restored: bool,
    pub(crate) panel_becomes_key_baseline_restored: bool,
    pub(crate) window_restored: bool,
    pub(crate) text_input_method_remains: Option<bool>,
    pub(crate) runtime_method_lifetime: &'static str,
    pub(crate) runtime_method_removal_supported: bool,
}

#[derive(Default)]
struct AppState {
    active: AtomicBool,
    lifecycle: Mutex<Lifecycle>,
}

#[derive(Default)]
struct Lifecycle {
    phase: Phase,
    expected_identifier: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Phase {
    #[default]
    Idle,
    Installing,
    Active,
    Restoring,
    RecoveryRequired,
}

fn app_state(app: &AppHandle) -> Result<tauri::State<'_, AppState>, &'static str> {
    if app.try_state::<AppState>().is_none() {
        let _ = app.manage(AppState::default());
    }
    app.try_state::<AppState>()
        .ok_or(MAIN_PANEL_STATE_UNAVAILABLE)
}

fn ensure_main_thread() -> Result<MainThreadMarker, &'static str> {
    MainThreadMarker::new().ok_or(MAIN_PANEL_MAIN_THREAD_REQUIRED)
}

fn expected_identifier(run_id: &str) -> Result<String, &'static str> {
    if run_id.len() != 32
        || !run_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(MAIN_PANEL_SCOPE_REJECTED);
    }
    Ok(format!("dev.atools.renderer-smoke.{run_id}"))
}

fn check_scope(app: &AppHandle, expected: &str) -> Result<(), &'static str> {
    if app.config().identifier != expected || !native::running_bundle_matches(expected) {
        return Err(MAIN_PANEL_SCOPE_REJECTED);
    }
    Ok(())
}

fn check_panel_manager(app: &AppHandle) -> Result<(), &'static str> {
    let state = app
        .try_state::<WebviewPanelManager<Wry>>()
        .ok_or(MAIN_PANEL_STATE_UNAVAILABLE)?;
    if state.0.is_poisoned() {
        return Err(MAIN_PANEL_STATE_UNAVAILABLE);
    }
    Ok(())
}

fn reserve_install(state: &AppState, expected: &str) -> Result<(), &'static str> {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE)?;
    if lifecycle.phase != Phase::Idle {
        return Err(MAIN_PANEL_ALREADY_ACTIVE);
    }
    lifecycle.phase = Phase::Installing;
    lifecycle.expected_identifier = Some(expected.to_owned());
    state.active.store(true, Ordering::Release);
    Ok(())
}

fn finish_install(state: &AppState) -> Result<(), &'static str> {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE)?;
    lifecycle.phase = Phase::Active;
    Ok(())
}

fn mark_recovery_required(state: &AppState) {
    if let Ok(mut lifecycle) = state.lifecycle.lock() {
        lifecycle.phase = Phase::RecoveryRequired;
    }
    state.active.store(true, Ordering::Release);
}

fn finish_restore(state: &AppState) -> Result<(), &'static str> {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE)?;
    lifecycle.phase = Phase::Idle;
    lifecycle.expected_identifier = None;
    state.active.store(false, Ordering::Release);
    Ok(())
}

fn begin_restore(state: &AppState) -> Result<(), &'static str> {
    let mut lifecycle = state
        .lifecycle
        .lock()
        .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE)?;
    match lifecycle.phase {
        Phase::Active | Phase::RecoveryRequired | Phase::Installing => {
            lifecycle.phase = Phase::Restoring;
            Ok(())
        }
        Phase::Idle | Phase::Restoring => Err(MAIN_PANEL_ALREADY_ACTIVE),
    }
}

fn restore_native(
    app: &AppHandle,
    snapshot: &OriginalWindowSnapshot,
) -> Result<RestorationFacts, &'static str> {
    let window = app
        .get_webview_window("main")
        .ok_or(MAIN_PANEL_WINDOW_UNAVAILABLE)?;
    native::restore(app, &window, snapshot)
}

pub(crate) fn install_scoped(app: &AppHandle, run_id: &str) -> Result<ConversionFacts, String> {
    let _main_thread = ensure_main_thread().map_err(str::to_owned)?;
    let expected = expected_identifier(run_id).map_err(str::to_owned)?;
    check_scope(app, &expected).map_err(str::to_owned)?;
    check_panel_manager(app).map_err(str::to_owned)?;

    let state = app_state(app).map_err(str::to_owned)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| MAIN_PANEL_WINDOW_UNAVAILABLE.to_owned())?;
    if window.label() != "main"
        || window.is_visible().unwrap_or(true)
        || app.get_webview_panel("main").is_ok()
    {
        return Err(MAIN_PANEL_ALREADY_ACTIVE.to_owned());
    }

    let (mut snapshot, layout) = native::capture_original(&window).map_err(str::to_owned)?;
    if !layout.is_safe {
        return Err(MAIN_PANEL_LAYOUT_REJECTED.to_owned());
    }
    if !native::snapshot_slot_empty() || native::store_snapshot(snapshot.clone()).is_err() {
        return Err(MAIN_PANEL_ALREADY_ACTIVE.to_owned());
    }
    if let Err(error) = reserve_install(&state, &expected) {
        native::clear_snapshot();
        return Err(error.to_owned());
    }

    let panel = match window.to_panel::<AToolsMainPanel<Wry>>() {
        Ok(panel) => panel,
        Err(_) => {
            let original_class = native::current_class_is_original(&window, &snapshot);
            if original_class {
                native::clear_snapshot();
                if finish_restore(&state).is_err() {
                    mark_recovery_required(&state);
                    return Err(MAIN_PANEL_RECOVERY_FAILED.to_owned());
                }
                return Err(MAIN_PANEL_CONVERSION_FAILED.to_owned());
            }
            mark_recovery_required(&state);
            return Err(MAIN_PANEL_RECOVERY_FAILED.to_owned());
        }
    };

    native::capture_panel_baseline(&mut snapshot, &panel);
    if native::replace_snapshot(snapshot.clone()).is_err() {
        mark_recovery_required(&state);
        return Err(MAIN_PANEL_STATE_UNAVAILABLE.to_owned());
    }

    let facts = match native::configure_and_verify(&window, &panel, &snapshot) {
        Ok(facts) => facts,
        Err(_) => {
            mark_recovery_required(&state);
            return Err(MAIN_PANEL_CONVERSION_FAILED.to_owned());
        }
    };

    if finish_install(&state).is_err() {
        mark_recovery_required(&state);
        return Err(MAIN_PANEL_STATE_UNAVAILABLE.to_owned());
    }
    Ok(facts)
}

pub(crate) fn installation_diagnostic(
    app: &AppHandle,
    run_id: &str,
    error_code: &str,
) -> Result<serde_json::Value, String> {
    let _main_thread = ensure_main_thread().map_err(str::to_owned)?;
    let expected = expected_identifier(run_id).map_err(str::to_owned)?;
    check_scope(app, &expected).map_err(str::to_owned)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| MAIN_PANEL_WINDOW_UNAVAILABLE.to_owned())?;
    native::diagnostics::collect(&window, run_id, error_code).map_err(str::to_owned)
}

pub(crate) fn content_view_matches_original(app: &AppHandle) -> Result<bool, String> {
    let _main_thread = ensure_main_thread().map_err(str::to_owned)?;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
    let (expected, phase) = {
        let lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
        (
            lifecycle
                .expected_identifier
                .clone()
                .ok_or_else(|| MAIN_PANEL_ALREADY_ACTIVE.to_owned())?,
            lifecycle.phase,
        )
    };
    check_scope(app, &expected).map_err(str::to_owned)?;
    if phase != Phase::Active || !state.active.load(Ordering::Acquire) {
        return Err(MAIN_PANEL_ALREADY_ACTIVE.to_owned());
    }
    let window =
        crate::window::main_window(app).map_err(|_| MAIN_PANEL_WINDOW_UNAVAILABLE.to_owned())?;
    if window.label() != "main" {
        return Err(MAIN_PANEL_WINDOW_UNAVAILABLE.to_owned());
    }
    let snapshot =
        native::snapshot_clone().ok_or_else(|| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
    native::content_view_matches_original(&window, &snapshot).map_err(str::to_owned)
}

pub(crate) fn show_scoped(app: &AppHandle) -> Result<(), String> {
    let _main_thread = ensure_main_thread().map_err(str::to_owned)?;
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
    let (expected, phase) = {
        let lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
        (
            lifecycle
                .expected_identifier
                .clone()
                .ok_or_else(|| MAIN_PANEL_ALREADY_ACTIVE.to_owned())?,
            lifecycle.phase,
        )
    };
    check_scope(app, &expected).map_err(str::to_owned)?;
    if phase != Phase::Active || !state.active.load(Ordering::Acquire) {
        return Err(MAIN_PANEL_ALREADY_ACTIVE.to_owned());
    }
    check_panel_manager(app).map_err(str::to_owned)?;
    if !content_view_matches_original(app)? {
        return Err(MAIN_PANEL_CONVERSION_FAILED.to_owned());
    }

    let panel = app
        .get_webview_panel("main")
        .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
    if panel.label() != "main" {
        return Err(MAIN_PANEL_WINDOW_UNAVAILABLE.to_owned());
    }

    crate::window::main_webview(app)
        .map_err(|_| MAIN_PANEL_WINDOW_UNAVAILABLE.to_owned())?
        .set_focus()
        .map_err(|_| MAIN_PANEL_CONVERSION_FAILED.to_owned())?;
    panel.order_front_regardless();
    panel.make_key_window();

    if content_view_matches_original(app)? {
        Ok(())
    } else {
        Err(MAIN_PANEL_CONVERSION_FAILED.to_owned())
    }
}

pub(crate) fn snapshot_conversion(app: &AppHandle) -> Result<ConversionFacts, String> {
    let _main_thread = ensure_main_thread().map_err(str::to_owned)?;
    let state = app_state(app).map_err(str::to_owned)?;
    let (expected, phase) = {
        let lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
        (
            lifecycle
                .expected_identifier
                .clone()
                .ok_or_else(|| MAIN_PANEL_ALREADY_ACTIVE.to_owned())?,
            lifecycle.phase,
        )
    };
    check_scope(app, &expected).map_err(str::to_owned)?;
    if !matches!(phase, Phase::Active | Phase::RecoveryRequired) {
        return Err(MAIN_PANEL_ALREADY_ACTIVE.to_owned());
    }
    check_panel_manager(app).map_err(str::to_owned)?;
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| MAIN_PANEL_WINDOW_UNAVAILABLE.to_owned())?;
    let panel = app
        .get_webview_panel("main")
        .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
    let snapshot =
        native::snapshot_clone().ok_or_else(|| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
    native::snapshot_conversion(&window, &panel, &snapshot).map_err(str::to_owned)
}

pub(crate) fn restore_scoped(app: &AppHandle) -> Result<RestorationFacts, String> {
    let _main_thread = ensure_main_thread().map_err(str::to_owned)?;
    let state = app_state(app).map_err(str::to_owned)?;
    let expected = {
        let lifecycle = state
            .lifecycle
            .lock()
            .map_err(|_| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
        lifecycle
            .expected_identifier
            .clone()
            .ok_or_else(|| MAIN_PANEL_ALREADY_ACTIVE.to_owned())?
    };
    check_scope(app, &expected).map_err(str::to_owned)?;
    let snapshot =
        native::snapshot_clone().ok_or_else(|| MAIN_PANEL_STATE_UNAVAILABLE.to_owned())?;
    begin_restore(&state).map_err(str::to_owned)?;

    match restore_native(app, &snapshot) {
        Ok(facts) => {
            if finish_restore(&state).is_err() {
                mark_recovery_required(&state);
                return Err(MAIN_PANEL_RECOVERY_FAILED.to_owned());
            }
            native::clear_snapshot();
            Ok(facts)
        }
        Err(error) => {
            mark_recovery_required(&state);
            Err(error.to_owned())
        }
    }
}

pub(crate) fn is_active(app: &AppHandle) -> bool {
    app.try_state::<AppState>()
        .is_some_and(|state| state.active.load(Ordering::Acquire))
}

#[cfg(test)]
#[path = "test.rs"]
mod tests;
