use serde_json::Value;
use tauri::AppHandle;

use super::{
    effects::{NativeSettingEffectPort, NativeSettingField},
    renderer_native_hotkey_effect::{MainHotkeyEffectPort, RendererNativeHotkeyEffect},
};

pub(super) struct TauriNativeSettings {
    app: AppHandle,
    active_hotkey: String,
    hotkey_port: MainHotkeyEffectPort,
    hotkey_rollback: Option<crate::hotkey::OwnedMainHotkeyStateSnapshot>,
    launch_at_login_rollback: Option<LaunchAtLoginRollback>,
    app_shortcut_snapshot: Option<super::app_shortcut_registry::OwnedAppShortcutSnapshot>,
}

const HOTKEY_REJECTED: &str = "SETTINGS_HOTKEY_REJECTED";
const NATIVE_RECOVERY_FAILED: &str = "SETTINGS_NATIVE_RECOVERY_FAILED";
const LAUNCH_AT_LOGIN_UNAVAILABLE: &str = "SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE";
const LAUNCH_AT_LOGIN_RECOVERY_FAILED: &str = "SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LaunchAtLoginRollback {
    previous_actual: bool,
    applied_target: bool,
}

impl TauriNativeSettings {
    pub(super) fn new(app: AppHandle) -> Self {
        let configured_hotkey = crate::hotkey::configured_hotkey(&app);
        let mut hotkey_port = MainHotkeyEffectPort::new(app.clone());
        let active_hotkey = match hotkey_port.read() {
            Ok(state) => match state.active_label() {
                Some(label) => label.to_owned(),
                None if state.startup_attempted() => String::new(),
                None => configured_hotkey,
            },
            Err(_) => String::new(),
        };
        Self {
            app,
            active_hotkey,
            hotkey_port,
            hotkey_rollback: None,
            launch_at_login_rollback: None,
            app_shortcut_snapshot: None,
        }
    }

    pub(super) fn active_hotkey(&self) -> &str {
        &self.active_hotkey
    }
}

impl NativeSettingEffectPort for TauriNativeSettings {
    fn apply(&mut self, field: NativeSettingField, value: &Value) -> Result<(), String> {
        match field {
            NativeSettingField::Hotkey => {
                let requested = value
                    .as_str()
                    .ok_or_else(|| "Hotkey effect requires a string".to_owned())?;
                apply_main_hotkey_effect(
                    &mut self.hotkey_port,
                    &mut self.hotkey_rollback,
                    &mut self.active_hotkey,
                    requested,
                )
            }
            NativeSettingField::TrayIconVisible => {
                crate::commands::set_tray_icon_visible(self.app.clone(), bool_value(field, value)?)
            }
            NativeSettingField::LaunchAtLogin => {
                let app_for_read = self.app.clone();
                let app_for_write = self.app.clone();
                apply_launch_at_login_effect(
                    &mut self.launch_at_login_rollback,
                    bool_value(field, value)?,
                    move || crate::general_settings_runtime::login_items::read(&app_for_read),
                    move |expected, target| {
                        crate::general_settings_runtime::login_items::read_apply(
                            &app_for_write,
                            expected,
                            target,
                        )
                    },
                )
            }
            NativeSettingField::SuperPanelVisible => crate::commands::set_super_panel_visible(
                self.app.clone(),
                bool_value(field, value)?,
            ),
            NativeSettingField::FloatingBallVisible => crate::commands::set_floating_ball_visible(
                self.app.clone(),
                bool_value(field, value)?,
            ),
            NativeSettingField::AppShortcuts => {
                let shortcuts = serde_json::from_value::<
                    Vec<crate::commands::SyncAppShortcutPayload>,
                >(value.clone())
                .map_err(|_| "App shortcut setting has an invalid shape".to_owned())?;
                let snapshot =
                    crate::general_settings_runtime::replace_app_shortcuts(&self.app, &shortcuts)?;
                self.app_shortcut_snapshot = Some(snapshot);
                Ok(())
            }
        }
    }

    fn rollback(&mut self, field: NativeSettingField, value: &Value) -> Result<(), String> {
        match field {
            NativeSettingField::Hotkey => restore_main_hotkey_effect(
                &mut self.hotkey_port,
                &mut self.hotkey_rollback,
                &mut self.active_hotkey,
            ),
            NativeSettingField::AppShortcuts => {
                let snapshot = self.app_shortcut_snapshot.take().ok_or_else(|| {
                    "Owned app shortcut snapshot is unavailable for rollback".to_owned()
                })?;
                crate::general_settings_runtime::restore_app_shortcuts(&self.app, snapshot)
            }
            NativeSettingField::LaunchAtLogin => {
                let app = self.app.clone();
                restore_launch_at_login_effect(
                    &mut self.launch_at_login_rollback,
                    move |expected, target| {
                        crate::general_settings_runtime::login_items::read_apply(
                            &app, expected, target,
                        )
                    },
                )
            }
            _ => self.apply(field, value),
        }
    }
}

fn apply_launch_at_login_effect(
    rollback: &mut Option<LaunchAtLoginRollback>,
    target: bool,
    mut read: impl FnMut() -> Result<bool, String>,
    mut read_apply: impl FnMut(Option<bool>, Option<bool>) -> Result<bool, String>,
) -> Result<(), String> {
    if rollback.is_some() {
        return Err(NATIVE_RECOVERY_FAILED.into());
    }
    let previous_actual = read()?;
    let actual = read_apply(Some(previous_actual), Some(target)).map_err(map_launch_item_error)?;
    if actual != target {
        return match read_apply(Some(actual), Some(previous_actual)) {
            Ok(restored) if restored == previous_actual => Err(LAUNCH_AT_LOGIN_UNAVAILABLE.into()),
            _ => {
                tracing::error!(
                    "Launch-at-login state could not be restored after an unexpected readback"
                );
                Err(NATIVE_RECOVERY_FAILED.into())
            }
        };
    }
    *rollback = Some(LaunchAtLoginRollback {
        previous_actual,
        applied_target: target,
    });
    Ok(())
}

fn restore_launch_at_login_effect(
    rollback: &mut Option<LaunchAtLoginRollback>,
    mut read_apply: impl FnMut(Option<bool>, Option<bool>) -> Result<bool, String>,
) -> Result<(), String> {
    let snapshot = rollback.as_ref().copied().ok_or(NATIVE_RECOVERY_FAILED)?;
    let actual = read_apply(
        Some(snapshot.applied_target),
        Some(snapshot.previous_actual),
    )
    .map_err(|error| {
        if error == LAUNCH_AT_LOGIN_RECOVERY_FAILED {
            NATIVE_RECOVERY_FAILED.to_owned()
        } else {
            error
        }
    })?;
    if actual != snapshot.previous_actual {
        return Err(NATIVE_RECOVERY_FAILED.into());
    }
    *rollback = None;
    Ok(())
}

fn map_launch_item_error(error: String) -> String {
    if error == LAUNCH_AT_LOGIN_RECOVERY_FAILED {
        tracing::error!("Launch-at-login state could not be restored after a failed apply");
        NATIVE_RECOVERY_FAILED.to_owned()
    } else {
        error
    }
}

fn apply_main_hotkey_effect(
    port: &mut dyn RendererNativeHotkeyEffect,
    rollback: &mut Option<crate::hotkey::OwnedMainHotkeyStateSnapshot>,
    active_label: &mut String,
    requested: &str,
) -> Result<(), String> {
    let previous = port.read()?;
    *rollback = Some(previous.clone());
    match port.apply(requested) {
        Ok(()) => {
            *active_label = requested.to_owned();
            Ok(())
        }
        Err(error) if crate::hotkey::known_hotkey_rejection(&error) => {
            *rollback = None;
            Err(error)
        }
        Err(error) => match port.restore(&previous) {
            Ok(()) => {
                *rollback = None;
                Err(error)
            }
            Err(recovery_error) => {
                tracing::error!(%error, %recovery_error, "Owned main hotkey recovery failed after apply error");
                Err(NATIVE_RECOVERY_FAILED.into())
            }
        },
    }
}

fn restore_main_hotkey_effect(
    port: &mut dyn RendererNativeHotkeyEffect,
    rollback: &mut Option<crate::hotkey::OwnedMainHotkeyStateSnapshot>,
    active_label: &mut String,
) -> Result<(), String> {
    let snapshot = rollback
        .take()
        .ok_or_else(|| "Owned main hotkey snapshot is unavailable for rollback".to_owned())?;
    port.restore(&snapshot).map_err(|error| {
        tracing::error!(%error, "Owned main hotkey rollback failed");
        NATIVE_RECOVERY_FAILED.to_owned()
    })?;
    *active_label = snapshot.active_label().unwrap_or_default().to_owned();
    Ok(())
}

fn bool_value(field: NativeSettingField, value: &Value) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| format!("Native effect `{}` requires a boolean", field.label()))
}

#[cfg(test)]
#[path = "system_effects_tests.rs"]
mod tests;
