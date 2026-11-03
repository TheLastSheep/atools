//! Main bindings add one narrow gesture syntax to the existing accelerator parser.
use tauri_plugin_global_shortcut::Shortcut;

use super::double_tap::Modifier;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum MainBinding {
    Accelerator(Shortcut),
    DoubleTap(Modifier),
}

pub(crate) fn parse_main_binding(label: &str) -> Result<MainBinding, String> {
    // Do not relax the old label envelope or accept whitespace around tokens
    // for the new gesture syntax. All other inputs use the original parser.
    if label.len() <= 256 && !label.chars().any(char::is_control) {
        if let Some((first, second)) = label.split_once('+') {
            if let (Some(left), Some(right)) = (modifier(first), modifier(second)) {
                if left == right {
                    return Ok(MainBinding::DoubleTap(left));
                }
            }
        }
    }
    super::owned_main::parse_main_hotkey(label).map(MainBinding::Accelerator)
}

fn modifier(token: &str) -> Option<Modifier> {
    match token.to_ascii_uppercase().as_str() {
        "CMD" | "COMMAND" | "SUPER" => Some(Modifier::Command),
        "CTRL" | "CONTROL" => Some(Modifier::Control),
        "ALT" | "OPTION" => Some(Modifier::Alt),
        "SHIFT" => Some(Modifier::Shift),
        _ => None,
    }
}

#[cfg(test)]
#[path = "main_binding_tests.rs"]
mod tests;
