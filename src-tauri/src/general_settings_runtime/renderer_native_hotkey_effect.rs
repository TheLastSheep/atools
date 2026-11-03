use crate::hotkey::OwnedMainHotkeyStateSnapshot;
use tauri::AppHandle;

pub(super) trait RendererNativeHotkeyEffect: Send {
    fn read(&mut self) -> Result<OwnedMainHotkeyStateSnapshot, String>;
    fn apply(&mut self, label: &str) -> Result<(), String>;
    fn restore(&mut self, snapshot: &OwnedMainHotkeyStateSnapshot) -> Result<(), String>;
}

pub(super) struct MainHotkeyEffectPort {
    app: AppHandle,
}

impl MainHotkeyEffectPort {
    pub(super) fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl RendererNativeHotkeyEffect for MainHotkeyEffectPort {
    fn read(&mut self) -> Result<OwnedMainHotkeyStateSnapshot, String> {
        crate::hotkey::read_owned_main_hotkey_state(&self.app)
    }

    fn apply(&mut self, label: &str) -> Result<(), String> {
        // The setter verifies manager registration while holding the owned
        // hotkey lease. A second read would reacquire that lease and could
        // turn a successful update into an ambiguous busy error.
        crate::hotkey::apply_owned_main_hotkey(&self.app, label)?;
        Ok(())
    }

    fn restore(&mut self, snapshot: &OwnedMainHotkeyStateSnapshot) -> Result<(), String> {
        // restore_owned_main_hotkey_state also verifies registration under the
        // same lease; do not issue a separate read after the effect.
        crate::hotkey::restore_owned_main_hotkey_state(&self.app, snapshot)?;
        Ok(())
    }
}

#[cfg(test)]
pub(super) struct UnusedHotkeyEffectPort;

#[cfg(test)]
impl RendererNativeHotkeyEffect for UnusedHotkeyEffectPort {
    fn read(&mut self) -> Result<OwnedMainHotkeyStateSnapshot, String> {
        panic!("non-hotkey General patches must not read the primary shortcut")
    }

    fn apply(&mut self, _label: &str) -> Result<(), String> {
        panic!("non-hotkey General patches must not change the primary shortcut")
    }

    fn restore(&mut self, _snapshot: &OwnedMainHotkeyStateSnapshot) -> Result<(), String> {
        panic!("non-hotkey General patches must not restore the primary shortcut")
    }
}
