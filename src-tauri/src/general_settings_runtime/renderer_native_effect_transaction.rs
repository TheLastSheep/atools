use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

use atools_core::{db::GeneralSettingsWritePlan, Database};
use serde_json::Value;
use tauri::AppHandle;

#[cfg(test)]
use super::renderer_native_hotkey_effect::UnusedHotkeyEffectPort;
use super::{
    commands::GeneralSettingsPatchReceipt,
    renderer_native_hotkey_effect::{MainHotkeyEffectPort, RendererNativeHotkeyEffect},
};
use crate::hotkey::OwnedMainHotkeyStateSnapshot;

const MAX_NATIVE_OPACITY_DELTA: f64 = 0.005;
const OPACITY_RECOVERY_FAILED: &str = "SETTINGS_OPACITY_RECOVERY_FAILED";
const NATIVE_RECOVERY_FAILED: &str = "SETTINGS_NATIVE_RECOVERY_FAILED";
const HOTKEY_REJECTED: &str = "SETTINGS_HOTKEY_REJECTED";

type OpacityFuture = Pin<Box<dyn Future<Output = Result<f64, String>> + Send + 'static>>;
pub(super) type ReadApplyOpacity = Box<dyn FnMut(Option<f64>) -> OpacityFuture + Send + 'static>;
pub(super) type ReadApplyTray =
    Box<dyn FnMut(Option<bool>) -> Result<bool, String> + Send + 'static>;

#[derive(Clone)]
enum StartedNativeEffect {
    Opacity(f64),
    TrayVisibility(bool),
    MainHotkey(OwnedMainHotkeyStateSnapshot),
}

pub(super) async fn run_renderer_patch(
    app: AppHandle,
    db: Arc<Database>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
) -> Result<GeneralSettingsPatchReceipt, String> {
    let has_opacity = changes.contains_key("opacity");
    #[cfg(not(target_os = "macos"))]
    let has_tray_visibility = changes.contains_key("showTrayIcon");
    #[cfg(not(target_os = "macos"))]
    if has_opacity || has_tray_visibility {
        return Err(if has_opacity {
            "Window opacity application is unsupported on this platform".into()
        } else {
            "Tray visibility readback is unsupported on this platform".into()
        });
    }

    let opacity_window = if has_opacity {
        Some(crate::window::main_window(&app).map_err(|_| "Main window is unavailable")?)
    } else {
        None
    };
    let coordinator = super::commands::get_coordinator(&app)?;
    let emit_app = app.clone();
    let tray_app = app.clone();
    let hotkey_app = app.clone();

    coordinator
        .run(move || async move {
            let mut read_apply_opacity: ReadApplyOpacity = Box::new(move |target| {
                let window = opacity_window.clone();
                Box::pin(async move {
                    let window = window.ok_or_else(|| "Main window is unavailable".to_owned())?;
                    crate::native_window_opacity::read_apply(window, target).await
                })
            });
            let mut read_apply_tray: ReadApplyTray = Box::new(move |target| {
                crate::native_tray_visibility::read_apply(&tray_app, target)
            });
            let mut read_apply_hotkey = MainHotkeyEffectPort::new(hotkey_app);
            let menu_app = app.clone();
            let menu_db = Arc::clone(&db);
            let menu_changes = changes.clone();
            super::close_shortcut_effect::wrap(
                &menu_app,
                &menu_db,
                &menu_changes,
                execute_renderer_patch_with_hotkey_port(
                    db,
                    expected,
                    changes,
                    &mut read_apply_opacity,
                    &mut read_apply_tray,
                    &mut read_apply_hotkey,
                    move |raw| super::emit_projected_general_settings(&emit_app, &raw),
                ),
            )
            .await
        })
        .await
}

#[cfg(test)]
async fn execute_renderer_patch<N>(
    db: Arc<Database>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
    read_apply_opacity: &mut ReadApplyOpacity,
    read_apply_tray: &mut ReadApplyTray,
    notify: N,
) -> Result<GeneralSettingsPatchReceipt, String>
where
    N: FnOnce(String) -> bool + Send + 'static,
{
    let mut hotkey = UnusedHotkeyEffectPort;
    execute_renderer_patch_with_hotkey_port(
        db,
        expected,
        changes,
        read_apply_opacity,
        read_apply_tray,
        &mut hotkey,
        notify,
    )
    .await
}

async fn execute_renderer_patch_with_hotkey_port<N>(
    db: Arc<Database>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
    read_apply_opacity: &mut ReadApplyOpacity,
    read_apply_tray: &mut ReadApplyTray,
    read_apply_hotkey: &mut dyn RendererNativeHotkeyEffect,
    notify: N,
) -> Result<GeneralSettingsPatchReceipt, String>
where
    N: FnOnce(String) -> bool + Send + 'static,
{
    let has_opacity = changes.contains_key("opacity");
    let has_tray_visibility = changes.contains_key("showTrayIcon");
    let has_hotkey = changes.contains_key("hotkey");
    if !has_opacity && !has_tray_visibility && !has_hotkey {
        let patch_db = Arc::clone(&db);
        let raw = tauri::async_runtime::spawn_blocking(move || {
            patch_db
                .mutate_renderer_general_settings(expected.as_deref(), &changes)
                .map_err(|error| error.to_string())
        })
        .await
        .map_err(|_| "Renderer General settings worker failed".to_owned())??;
        return Ok(receipt(raw, notify));
    }

    let target_opacity = if has_opacity {
        Some(
            changes
                .get("opacity")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && (0.3..=1.0).contains(value))
                .ok_or_else(|| "Window opacity is outside its supported range".to_owned())?,
        )
    } else {
        None
    };
    let target_tray_visibility = if has_tray_visibility {
        Some(
            changes
                .get("showTrayIcon")
                .and_then(Value::as_bool)
                .ok_or_else(|| "Tray visibility setting must be a boolean".to_owned())?,
        )
    } else {
        None
    };
    let target_hotkey = changes
        .get("hotkey")
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or_else(|| "Primary shortcut must be a string".to_owned())
        })
        .transpose()?;

    let prepare_db = Arc::clone(&db);
    let plan = tauri::async_runtime::spawn_blocking(move || {
        prepare_db
            .prepare_renderer_general_settings_write(expected.as_deref(), &changes)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Renderer General settings worker failed".to_owned())??;

    if let Some(target) = target_hotkey.as_deref() {
        crate::hotkey::validate_main_hotkey_label(target)?;
    }

    // Observe every native value before applying any effect so a mixed patch
    // has a complete recovery snapshot before the first setter can be partial.
    let previous_opacity = match target_opacity {
        Some(_) => {
            let value = read_apply_opacity(None).await?;
            validate_native_opacity(value)?;
            Some(value)
        }
        None => None,
    };
    let previous_tray_visibility = match target_tray_visibility {
        Some(_) => Some(read_apply_tray(None)?),
        None => None,
    };
    let previous_hotkey = if target_hotkey.is_some() {
        Some(read_apply_hotkey.read()?)
    } else {
        None
    };

    let mut started = Vec::with_capacity(3);
    if let (Some(target), Some(previous)) = (target_opacity, previous_opacity) {
        if !opacity_matches(previous, target) {
            started.push(StartedNativeEffect::Opacity(previous));
            if let Err(error) = apply_opacity(read_apply_opacity, target).await {
                return Err(fail_and_compensate(
                    read_apply_opacity,
                    read_apply_tray,
                    read_apply_hotkey,
                    &started,
                    has_tray_visibility || has_hotkey,
                    "Window opacity application failed",
                    error,
                )
                .await);
            }
        }
    }
    if let (Some(target), Some(previous)) = (target_tray_visibility, previous_tray_visibility) {
        if target != previous {
            started.push(StartedNativeEffect::TrayVisibility(previous));
            if let Err(error) = apply_tray_visibility(read_apply_tray, target) {
                return Err(fail_and_compensate(
                    read_apply_opacity,
                    read_apply_tray,
                    read_apply_hotkey,
                    &started,
                    has_tray_visibility || has_hotkey,
                    "Tray visibility application failed",
                    error,
                )
                .await);
            }
        }
    }
    if let (Some(target), Some(previous)) = (target_hotkey.as_deref(), previous_hotkey.as_ref()) {
        if previous.label() != Some(target) || !previous.healthy() {
            started.push(StartedNativeEffect::MainHotkey(previous.clone()));
            if let Err(error) = read_apply_hotkey.apply(target) {
                // The owned-hotkey setter returns this code only when its
                // same-lease operation left the primary shortcut unchanged
                // or fully compensated its partial registration. Do not
                // reacquire the lease to restore that already-safe snapshot.
                let started_to_restore = if crate::hotkey::known_hotkey_rejection(&error)
                    && matches!(started.last(), Some(StartedNativeEffect::MainHotkey(_)))
                {
                    &started[..started.len() - 1]
                } else {
                    &started
                };
                return Err(fail_and_compensate(
                    read_apply_opacity,
                    read_apply_tray,
                    read_apply_hotkey,
                    started_to_restore,
                    has_tray_visibility || has_hotkey,
                    "Primary shortcut application failed",
                    error,
                )
                .await);
            }
        }
    }

    match commit_plan(Arc::clone(&db), plan).await {
        Ok(committed_raw) => Ok(receipt(committed_raw, notify)),
        Err(commit_error) => {
            match compensate_started(
                read_apply_opacity,
                read_apply_tray,
                read_apply_hotkey,
                &started,
            )
            .await
            {
                Ok(()) => Err(commit_error),
                Err(recovery_error) => {
                    tracing::error!(
                        %commit_error,
                        %recovery_error,
                        "Renderer native settings recovery failed after commit error"
                    );
                    Err(recovery_error_code(has_tray_visibility || has_hotkey).into())
                }
            }
        }
    }
}

async fn apply_opacity(read_apply: &mut ReadApplyOpacity, target: f64) -> Result<(), String> {
    let actual = read_apply(Some(target)).await?;
    if opacity_matches(actual, target) {
        Ok(())
    } else {
        Err("native window opacity readback did not match the requested value".into())
    }
}

fn apply_tray_visibility(read_apply: &mut ReadApplyTray, target: bool) -> Result<(), String> {
    if read_apply(Some(target))? == target {
        Ok(())
    } else {
        Err("native tray visibility readback did not match the requested value".into())
    }
}

async fn fail_and_compensate(
    read_apply_opacity: &mut ReadApplyOpacity,
    read_apply_tray: &mut ReadApplyTray,
    read_apply_hotkey: &mut dyn RendererNativeHotkeyEffect,
    started: &[StartedNativeEffect],
    has_native_recovery_code: bool,
    label: &str,
    primary_error: String,
) -> String {
    match compensate_started(
        read_apply_opacity,
        read_apply_tray,
        read_apply_hotkey,
        started,
    )
    .await
    {
        Ok(())
            if crate::hotkey::known_hotkey_rejection(&primary_error)
                || primary_error == NATIVE_RECOVERY_FAILED =>
        {
            primary_error
        }
        Ok(()) => format!("{label}: {primary_error}"),
        Err(recovery_error) => {
            tracing::error!(
                %primary_error,
                %recovery_error,
                "Renderer native settings recovery failed after effect error"
            );
            recovery_error_code(has_native_recovery_code).into()
        }
    }
}

async fn compensate_started(
    read_apply_opacity: &mut ReadApplyOpacity,
    read_apply_tray: &mut ReadApplyTray,
    read_apply_hotkey: &mut dyn RendererNativeHotkeyEffect,
    started: &[StartedNativeEffect],
) -> Result<(), String> {
    let mut failures = Vec::new();
    for effect in started.iter().rev() {
        let result = match effect {
            StartedNativeEffect::Opacity(previous) => {
                apply_opacity(read_apply_opacity, *previous).await
            }
            StartedNativeEffect::TrayVisibility(previous) => {
                apply_tray_visibility(read_apply_tray, *previous)
            }
            StartedNativeEffect::MainHotkey(previous) => read_apply_hotkey.restore(previous),
        };
        if let Err(error) = result {
            failures.push(error);
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

fn recovery_error_code(use_native_recovery_code: bool) -> &'static str {
    if use_native_recovery_code {
        NATIVE_RECOVERY_FAILED
    } else {
        OPACITY_RECOVERY_FAILED
    }
}

fn receipt<N>(raw: String, notify: N) -> GeneralSettingsPatchReceipt
where
    N: FnOnce(String) -> bool,
{
    let notification_delivered = notify(raw.clone());
    GeneralSettingsPatchReceipt {
        version: 1,
        raw,
        notification_delivered,
        auto_check: None,
    }
}

async fn commit_plan(db: Arc<Database>, plan: GeneralSettingsWritePlan) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        db.commit_general_settings_write(plan)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|_| "Renderer General settings worker failed".to_owned())?
}

fn validate_native_opacity(value: f64) -> Result<(), String> {
    if value.is_finite() && (0.0..=1.0).contains(&value) {
        Ok(())
    } else {
        Err("Main native window returned an invalid opacity".into())
    }
}

fn opacity_matches(actual: f64, expected: f64) -> bool {
    validate_native_opacity(actual).is_ok() && (actual - expected).abs() <= MAX_NATIVE_OPACITY_DELTA
}

#[cfg(test)]
#[path = "renderer_native_effect_opacity_tests.rs"]
mod opacity_tests;

#[cfg(test)]
#[path = "renderer_native_effect_tray_tests.rs"]
mod tray_tests;

#[cfg(test)]
#[path = "renderer_native_effect_hotkey_tests.rs"]
mod hotkey_tests;
