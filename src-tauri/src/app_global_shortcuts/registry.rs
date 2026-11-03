//! Typed AppBinding OS ownership; shared algorithm, separate FeatureCode collection.
use super::{BindingTarget, Runtime};
use crate::general_settings_runtime::app_shortcut_registry::{
    parse_shortcut, DesiredShortcut, OwnedAppShortcutRegistry, OwnedAppShortcutSnapshot,
    ShortcutPort,
};
use std::collections::BTreeMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcut, Shortcut, ShortcutState};

pub(super) type Registry = OwnedAppShortcutRegistry<BindingTarget>;
pub(super) type Snapshot = OwnedAppShortcutSnapshot<BindingTarget>;
pub(super) struct Port<'a> {
    pub app: &'a AppHandle,
    pub runtime: &'a std::sync::Arc<Runtime>,
}
impl ShortcutPort<BindingTarget> for Port<'_> {
    fn is_registered(&self, key: Shortcut) -> Result<bool, String> {
        Ok(self
            .app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or("Shortcut plugin unavailable")?
            .inner()
            .is_registered(key))
    }
    fn register(&mut self, key: Shortcut, target: &BindingTarget) -> Result<(), String> {
        let runtime = self.runtime.clone();
        let target = target.clone();
        let receipt = super::recording::gate(self.app)?.receipt(Some(capture_label(key)))?;
        let callback = receipt.clone();
        self.app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or("Shortcut plugin unavailable")?
            .inner()
            .on_shortcut(key, move |_, _, event| {
                let pressed = event.state == ShortcutState::Pressed;
                let epoch = callback.edge(pressed);
                if !pressed {
                    runtime.signal(&target, false);
                }
                if let Some(epoch) = epoch {
                    runtime.signal_at(&target, true, epoch);
                }
            })
            .map_err(|e| e.to_string())?;
        if !self.is_registered(key)? {
            return Err("App registration readback unavailable".into());
        }
        receipt.publish();
        Ok(())
    }
    fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
        self.app
            .try_state::<GlobalShortcut<tauri::Wry>>()
            .ok_or("Shortcut plugin unavailable")?
            .inner()
            .unregister(key)
            .map_err(|e| e.to_string())
    }
}
pub(super) fn desired(
    rows: &[atools_core::db::AppGlobalShortcutBinding],
    epoch: u64,
) -> Result<BTreeMap<u32, DesiredShortcut<BindingTarget>>, String> {
    if rows.len() > 64 {
        return Err("App binding limit exceeded".into());
    }
    let mut result = BTreeMap::new();
    for row in rows.iter().filter(|r| r.enabled && r.public_matches) {
        let key = validated_key(&row.shortcut)?;
        let target = BindingTarget {
            row_id: row.row_id.clone(),
            epoch,
            config_generation: row.generation.clone(),
            shortcut: row.shortcut.clone(),
            path: row.path.clone(),
            name: row.name.clone(),
        };
        if result
            .insert(
                key.id(),
                DesiredShortcut {
                    id: key.id(),
                    parsed: key,
                    shortcut: row.shortcut.clone(),
                    target_code: target,
                },
            )
            .is_some()
        {
            return Err("Duplicate App binding shortcut".into());
        }
    }
    Ok(result)
}
pub(super) fn validated_key(value: &str) -> Result<Shortcut, String> {
    if value.is_empty() || value.len() > 256 {
        return Err("Invalid shortcut length".into());
    }
    let key = parse_shortcut(value)?;
    for reserved in ["CmdOrCtrl+W", "CmdOrCtrl+Q", "CmdOrCtrl+V"] {
        if key.id() == parse_shortcut(reserved)?.id() {
            return Err("Shortcut is reserved".into());
        }
    }
    Ok(key)
}

/// Render the parsed physical accelerator rather than replaying a configuration alias.
fn capture_label(key: Shortcut) -> String {
    key.to_string()
        .split('+')
        .map(|part| match part {
            "shift" => "Shift".to_owned(),
            "control" => "Ctrl".to_owned(),
            "alt" => if cfg!(target_os = "macos") {
                "Option"
            } else {
                "Alt"
            }
            .to_owned(),
            "super" => if cfg!(target_os = "macos") {
                "Cmd"
            } else {
                "Super"
            }
            .to_owned(),
            value => value
                .strip_prefix("Key")
                .or_else(|| value.strip_prefix("Digit"))
                .unwrap_or(value)
                .to_owned(),
        })
        .collect::<Vec<_>>()
        .join("+")
}
