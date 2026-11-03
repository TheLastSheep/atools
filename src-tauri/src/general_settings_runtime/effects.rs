use serde_json::Value;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum NativeSettingField {
    Hotkey,
    TrayIconVisible,
    LaunchAtLogin,
    SuperPanelVisible,
    FloatingBallVisible,
    AppShortcuts,
}

impl NativeSettingField {
    pub(super) fn label(self) -> &'static str {
        match self {
            Self::Hotkey => "hotkey",
            Self::TrayIconVisible => "showTrayIcon",
            Self::LaunchAtLogin => "launchAtLogin",
            Self::SuperPanelVisible => "superPanelEnabled",
            Self::FloatingBallVisible => "floatingBallEnabled",
            Self::AppShortcuts => "appShortcuts",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct NativeSettingChange {
    pub(super) field: NativeSettingField,
    pub(super) before: Value,
    pub(super) after: Value,
}

pub(super) trait NativeSettingEffectPort {
    fn apply(&mut self, field: NativeSettingField, value: &Value) -> Result<(), String>;

    fn rollback(&mut self, field: NativeSettingField, value: &Value) -> Result<(), String> {
        self.apply(field, value)
    }
}

/// Applies in declaration order and compensates prior successful effects in reverse order.
pub(super) fn apply_all<P: NativeSettingEffectPort>(
    port: &mut P,
    changes: &[NativeSettingChange],
) -> Result<(), String> {
    let mut succeeded = Vec::with_capacity(changes.len());
    for change in changes {
        if let Err(primary) = port.apply(change.field, &change.after) {
            if let Err(rollback) = rollback_all(port, &succeeded) {
                tracing::error!(%primary, %rollback, "Native General effect compensation failed");
                return Err("SETTINGS_NATIVE_RECOVERY_FAILED".into());
            }
            if crate::hotkey::known_hotkey_rejection(&primary)
                || primary == "SETTINGS_NATIVE_RECOVERY_FAILED"
            {
                return Err(primary);
            }
            let mut message = format!(
                "Native General setting effect `{}` failed: {primary}; the failing effect may have partially changed system state",
                change.field.label()
            );
            if !succeeded.is_empty() {
                message.push_str("; earlier successful effects were compensated");
            }
            return Err(message);
        }
        succeeded.push(change.clone());
    }
    Ok(())
}

/// Compensates a completed forward sequence in reverse order, reporting every failure.
pub(super) fn rollback_all<P: NativeSettingEffectPort>(
    port: &mut P,
    changes: &[NativeSettingChange],
) -> Result<(), String> {
    let mut failures = Vec::new();
    for change in changes.iter().rev() {
        if let Err(error) = port.rollback(change.field, &change.before) {
            failures.push(format!("{}: {error}", change.field.label()));
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[cfg(test)]
#[path = "effects_tests.rs"]
mod tests;
