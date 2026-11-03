//! Postcommit receipt completion: auto-only CAS does not re-read unrelated fallible Native state.
use super::*;
use crate::general_settings_runtime::commands::GeneralSettingsPatchReceipt;
pub(super) fn complete(
    opening: &mut OpeningSnapshot,
    next_revision: String,
    receipt: GeneralSettingsPatchReceipt,
    auto_only: bool,
    read_hotkey: impl FnOnce() -> Result<String, String>,
) -> Result<Value, String> {
    let shortcut = if auto_only {
        // This single-field CAS protected the full raw baseline and did not modify hotkeys.
        opening
            .value
            .get("hotkey")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    } else {
        read_hotkey()?
    };
    let value = project_general_settings(Some(&receipt.raw), &shortcut)?;
    let mut out = json!({"revision":next_revision,"value":value,"notificationDelivered":receipt.notification_delivered});
    if auto_only {
        let effect = receipt.auto_check.ok_or("GENERAL_SETTINGS_PATCH_FAILED")?;
        out["runtimeApplied"] = json!(effect.runtime_applied);
        out["runtimeError"] = json!(effect.runtime_error);
    }
    opening.raw = Some(receipt.raw);
    opening.revision = next_revision;
    opening.value = value;
    Ok(out)
}
#[cfg(test)]
#[path = "preferences_auto_receipt_tests.rs"]
mod tests;
