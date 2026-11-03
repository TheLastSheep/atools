use std::str::FromStr;

use tauri_plugin_global_shortcut::Shortcut;

const HOTKEY_REJECTED: &str = "SETTINGS_HOTKEY_REJECTED";

pub(crate) fn validate_main_hotkey_label(label: &str) -> Result<(), String> {
    crate::hotkey::main_binding::parse_main_binding(label).map(|_| ())
}

pub(in crate::hotkey) fn parse_main_hotkey(label: &str) -> Result<Shortcut, String> {
    if label.is_empty()
        || label.trim() != label
        || label.len() > 256
        || label.chars().any(char::is_control)
    {
        return Err(HOTKEY_REJECTED.into());
    }

    let mut seen = 0_u8;
    for token in label.split('+') {
        let bit = modifier_bit(token.trim());
        if bit == 0 {
            continue;
        }
        if seen & bit != 0 {
            return Err(HOTKEY_REJECTED.into());
        }
        seen |= bit;
    }
    if seen == 0
        && !matches!(
            label.to_ascii_uppercase().as_str(),
            "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
        )
    {
        return Err(HOTKEY_REJECTED.into());
    }

    let normalized = crate::hotkey::normalize_shortcut(label);
    Shortcut::from_str(&normalized).map_err(|_| HOTKEY_REJECTED.to_owned())
}

fn modifier_bit(token: &str) -> u8 {
    match token.to_ascii_uppercase().as_str() {
        "OPTION" | "ALT" => 1,
        "CONTROL" | "CTRL" => 2,
        "COMMAND" | "CMD" | "SUPER" => 4,
        "SHIFT" => 8,
        #[cfg(target_os = "macos")]
        "COMMANDORCONTROL" | "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" => 4,
        #[cfg(not(target_os = "macos"))]
        "COMMANDORCONTROL" | "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" => 2,
        _ => 0,
    }
}
