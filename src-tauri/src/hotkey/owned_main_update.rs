//! Compare-and-set uses the same owned identity and operation lease as mutation.
use super::*;
impl OwnedMainHotkeyRegistry {
    pub(super) fn set_from<P: ShortcutPort>(
        &mut self,
        port: &mut P,
        previous: MainBinding,
        label: &str,
    ) -> Result<(), String> {
        self.ensure_usable()?;
        let current = self.verify_current(port)?;
        if current.binding != previous {
            return Err("Main hotkey changed before the requested update".into());
        }
        self.set(port, label)
    }
}
