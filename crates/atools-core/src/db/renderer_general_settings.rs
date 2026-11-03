//! Strict persistence adapter for the original renderer's General page.

use std::collections::BTreeMap;

use serde_json::Value;

use super::Database;
use crate::error::{AToolsError, Result};

#[cfg(test)]
const SETTINGS_KEY: &str = "settings-general";
#[cfg(test)]
const MAX_GENERAL_BYTES: usize = 64 * 1024;
const MAX_PLACEHOLDER_BYTES: usize = 512;

/// Writable fields exposed by the General settings child, in contract order.
pub const RENDERER_GENERAL_SETTINGS_FIELDS: [&str; 24] = [
    "placeholder",
    "theme",
    "primaryColor",
    "customColor",
    "autoClear",
    "showRecentInSearch",
    "recentRows",
    "pinnedRows",
    "searchMode",
    "showMatchRecommendation",
    "tabKeyFunction",
    "tabTargetCommand",
    "spaceOpenCommand",
    "localAppSearch",
    "opacity",
    "showTrayIcon",
    "hotkey",
    "windowPositionStrategy",
    "clipboardRetentionDays",
    "autoBackToSearch",
    "autoPaste",
    "builtinAppShortcutsEnabled",
    "windowDefaultHeight",
    "autoCheckUpdate",
];

impl Database {
    /// Reads the exact stored snapshot using the shared JSON and wire bounds.
    pub fn read_renderer_general_settings(&self) -> Result<Option<String>> {
        super::general_settings_write::read_current_general_settings(self)
    }

    /// Applies the typed General child preferences through the shared CAS seam.
    pub fn mutate_renderer_general_settings(
        &self,
        expected: Option<&str>,
        changes: &BTreeMap<String, Value>,
    ) -> Result<String> {
        let plan = self.prepare_renderer_general_settings_write(expected, changes)?;
        self.commit_general_settings_write(plan)
    }

    /// Prepares one strictly validated renderer-owned General settings patch without writing it.
    pub fn prepare_renderer_general_settings_write(
        &self,
        expected: Option<&str>,
        changes: &BTreeMap<String, Value>,
    ) -> Result<super::GeneralSettingsWritePlan> {
        let normalized_changes = normalize_renderer_general_settings_changes(changes)?;
        validate_renderer_general_settings_patch(&normalized_changes)?;
        if normalized_changes.contains_key("builtinAppShortcutsEnabled") {
            super::general_settings_write::prepare_renderer_shortcut_patch(
                self,
                expected,
                &normalized_changes,
            )
        } else {
            self.prepare_general_settings_write(expected, &normalized_changes)
        }
    }
}

fn normalize_renderer_general_settings_changes(
    changes: &BTreeMap<String, Value>,
) -> Result<BTreeMap<String, Value>> {
    let mut normalized_changes = changes.clone();
    for key in ["recentRows", "pinnedRows", "clipboardRetentionDays"] {
        if let Some(value) = normalized_changes.get(key) {
            let count = if key == "clipboardRetentionDays" {
                renderer_general_settings_clipboard_retention_days(value).ok_or_else(|| {
                    invalid("General settings clipboard retention period is invalid")
                })?
            } else {
                renderer_general_settings_row_count(value)
                    .ok_or_else(|| invalid("General settings row count is invalid"))?
            };
            normalized_changes.insert(key.to_owned(), Value::from(count));
        }
    }
    Ok(normalized_changes)
}

/// Validates one non-empty patch against the General child writable-field contract.
///
/// This is the shared, side-effect-free gate used by Core persistence and Native
/// settings-view validation. Row counts accept only integral JSON numbers in range.
pub fn validate_renderer_general_settings_patch(changes: &BTreeMap<String, Value>) -> Result<()> {
    if changes.is_empty() {
        return Err(invalid("General settings patch must not be empty"));
    }
    if changes.len() > RENDERER_GENERAL_SETTINGS_FIELDS.len() {
        return Err(invalid(
            "General settings patch exceeds the supported field count",
        ));
    }
    if changes.contains_key("autoCheckUpdate") && changes.len() != 1 {
        return Err(invalid("Automatic update preference must be written alone"));
    }
    for (key, value) in changes {
        validate_renderer_change(key, value)?;
    }
    Ok(())
}

/// Returns a canonical integer for a General row-count value within `0..=20`.
///
/// Integral JSON floating-point values are accepted to match `JSON.parse` on the
/// renderer side; callers that persist the result should write the returned integer.
pub fn renderer_general_settings_row_count(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || !(0.0..=20.0).contains(&number) {
        return None;
    }
    Some(number as u64)
}

/// Returns a canonical integer for the clipboard retention period in `1..=3650` days.
///
/// Integral JSON floats are accepted like row counts, then normalized to a `u64` before
/// persistence so the stored representation is stable.
pub fn renderer_general_settings_clipboard_retention_days(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 || !(1.0..=3650.0).contains(&number) {
        return None;
    }
    Some(number as u64)
}

/// Logical plugin content height, independently of monitor clipping and Svelte limits.
/// Leave room for the 58px header in the signed native geometry range.
pub fn renderer_general_settings_window_default_height(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|height| height.is_finite() && (200.0..=f64::from(i32::MAX - 58)).contains(height))
}

fn validate_renderer_change(key: &str, value: &Value) -> Result<()> {
    if !RENDERER_GENERAL_SETTINGS_FIELDS.contains(&key) {
        return Err(invalid(
            "General settings field is not writable by this adapter",
        ));
    }
    let valid = match key {
        "placeholder" => string_value(value).is_some_and(|candidate| {
            candidate.len() <= MAX_PLACEHOLDER_BYTES && !candidate.chars().any(char::is_control)
        }),
        "theme" => string_value(value)
            .is_some_and(|candidate| matches!(candidate, "system" | "light" | "dark")),
        "primaryColor" => string_value(value).is_some_and(|candidate| {
            matches!(
                candidate,
                "blue" | "purple" | "green" | "orange" | "red" | "pink" | "custom"
            )
        }),
        "customColor" => string_value(value).is_some_and(is_hex_color),
        "autoClear" => string_value(value).is_some_and(|candidate| {
            matches!(
                candidate,
                "immediately" | "1m" | "2m" | "3m" | "5m" | "10m" | "never"
            )
        }),
        "autoBackToSearch" => string_value(value).is_some_and(|candidate| {
            matches!(
                candidate,
                "immediately" | "30s" | "1m" | "3m" | "5m" | "10m" | "never"
            )
        }),
        "autoPaste" => string_value(value)
            .is_some_and(|candidate| matches!(candidate, "off" | "1s" | "3s" | "5s" | "10s")),
        "showRecentInSearch"
        | "showMatchRecommendation"
        | "spaceOpenCommand"
        | "localAppSearch"
        | "showTrayIcon"
        | "autoCheckUpdate" => value.is_boolean(),
        "builtinAppShortcutsEnabled" => value.as_object().is_some_and(|fields| {
            !fields.is_empty()
                && fields.iter().all(|(key, value)| {
                    matches!(key.as_str(), "search" | "esc" | "closePlugin") && value.is_boolean()
                })
        }),
        "windowDefaultHeight" => renderer_general_settings_window_default_height(value).is_some(),
        "opacity" => value
            .as_f64()
            .is_some_and(|opacity| opacity.is_finite() && (0.3..=1.0).contains(&opacity)),
        "hotkey" => string_value(value).is_some_and(|candidate| {
            !candidate.is_empty()
                && candidate.trim() == candidate
                && candidate.len() <= 256
                && !candidate.chars().any(char::is_control)
        }),
        "windowPositionStrategy" => string_value(value).is_some_and(|candidate| {
            matches!(candidate, "remember" | "cursor" | "primary" | "lastActive")
        }),
        "clipboardRetentionDays" => {
            renderer_general_settings_clipboard_retention_days(value).is_some()
        }
        "recentRows" | "pinnedRows" => renderer_general_settings_row_count(value).is_some(),
        "searchMode" => {
            string_value(value).is_some_and(|candidate| matches!(candidate, "aggregate" | "list"))
        }
        "tabKeyFunction" => string_value(value)
            .is_some_and(|candidate| matches!(candidate, "navigate" | "target-command")),
        "tabTargetCommand" => {
            string_value(value).is_some_and(|candidate| !candidate.chars().any(char::is_control))
        }
        _ => {
            return Err(invalid(
                "General settings field is not writable by this adapter",
            ))
        }
    };
    if valid {
        Ok(())
    } else {
        Err(invalid("General settings field value is invalid"))
    }
}

fn string_value(value: &Value) -> Option<&str> {
    value.as_str()
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)
}

fn invalid(message: &str) -> AToolsError {
    AToolsError::Config(message.to_owned())
}

#[cfg(test)]
#[path = "renderer_general_settings_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "renderer_general_settings_opacity_tests.rs"]
mod opacity_tests;

#[cfg(test)]
#[path = "renderer_general_settings_rows_tests.rs"]
mod row_tests;

#[cfg(test)]
#[path = "renderer_general_settings_tray_tests.rs"]
mod tray_tests;

#[cfg(test)]
#[path = "renderer_general_settings_hotkey_tests.rs"]
mod hotkey_tests;

#[cfg(test)]
#[path = "renderer_general_settings_auto_back_tests.rs"]
mod auto_back_tests;

#[cfg(test)]
#[path = "renderer_general_settings_position_tests.rs"]
mod position_tests;

#[cfg(test)]
#[path = "renderer_general_settings_auto_paste_tests.rs"]
mod auto_paste_tests;

#[cfg(test)]
#[path = "renderer_general_settings_builtin_shortcuts_tests.rs"]
mod builtin_shortcuts_tests;

#[cfg(test)]
#[path = "renderer_general_settings_height_tests.rs"]
mod height_tests;

#[cfg(test)]
#[path = "renderer_general_settings_auto_check_tests.rs"]
mod auto_check_tests;
