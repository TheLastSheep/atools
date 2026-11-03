//! One derived menu effect around the existing General CAS, shared by both write entrances.
use crate::renderer_close_shortcut::Snapshot;
use serde_json::Value;
use std::{collections::BTreeMap, future::Future};
use tauri::AppHandle;
pub(super) trait Port {
    fn read(&mut self) -> Result<Snapshot, String>;
    fn apply(&mut self, target: bool) -> Result<Snapshot, String>;
    fn restore(&mut self, before: Snapshot, applied: Snapshot) -> Result<(), String>;
}
struct NativePort(AppHandle);
impl Port for NativePort {
    fn read(&mut self) -> Result<Snapshot, String> {
        crate::renderer_close_shortcut::read(&self.0)
    }
    fn apply(&mut self, target: bool) -> Result<Snapshot, String> {
        crate::renderer_close_shortcut::apply(&self.0, target)
    }
    fn restore(&mut self, before: Snapshot, applied: Snapshot) -> Result<(), String> {
        crate::renderer_close_shortcut::restore(&self.0, before, applied)
    }
}
pub(super) async fn wrap<T>(
    app: &AppHandle,
    db: &atools_core::Database,
    changes: &BTreeMap<String, Value>,
    action: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let target = changes
        .get("builtinAppShortcutsEnabled")
        .and_then(|value| value.get("closePlugin"))
        .and_then(Value::as_bool);
    if target.is_none() || !crate::renderer_close_shortcut::is_original(app) {
        return action.await;
    }
    atools_core::db::validate_renderer_general_settings_patch(changes)
        .map_err(|error| error.to_string())?;
    let raw = db
        .get_setting("settings-general")
        .map_err(|error| error.to_string())?;
    let before = crate::renderer_close_shortcut::enabled_from_raw(raw.as_deref());
    execute(&mut NativePort(app.clone()), before, target, action).await
}
pub(super) async fn execute<T>(
    port: &mut impl Port,
    before_config: bool,
    target: Option<bool>,
    action: impl Future<Output = Result<T, String>>,
) -> Result<T, String> {
    let Some(target) = target.filter(|target| *target != before_config) else {
        return action.await;
    };
    let before = port.read()?;
    if before.enabled != before_config {
        return Err("SETTINGS_NATIVE_RECOVERY_FAILED".into());
    }
    let applied = port.apply(target)?;
    if applied.enabled != target {
        let _ = port.restore(before, applied);
        return Err("SETTINGS_NATIVE_RECOVERY_FAILED".into());
    }
    match action.await {
        Ok(result) => Ok(result),
        Err(error) => match port.restore(before, applied) {
            Ok(()) => Err(error),
            Err(_) => Err("SETTINGS_NATIVE_RECOVERY_FAILED".into()),
        },
    }
}
#[cfg(test)]
#[path = "close_shortcut_effect_tests.rs"]
mod tests;
