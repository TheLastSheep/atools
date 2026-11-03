use serde_json::{json, Value};
use tauri::WebviewWindow;

use crate::plugin_browser_window_native::{
    platform::{skip_taskbar_behavior, SkipTaskbarBehavior},
    snapshot::{native_error, NativeSnapshot},
};

#[derive(Clone, Debug)]
pub(super) enum CapabilityAction {
    IsResizable,
    SetResizable(bool),
    IsAlwaysOnTop,
    SetAlwaysOnTop(bool),
    IsClosable,
    SetClosable(bool),
    IsMinimizable,
    SetMinimizable(bool),
    IsMaximizable,
    SetMaximizable(bool),
    SetSkipTaskbar(bool),
    SetVisibleOnAllWorkspaces(bool),
    SetFocusable(bool),
    SetIgnoreMouseEvents(bool),
    SetHasShadow(bool),
}

pub(super) fn parse(action: &str, args: &[Value]) -> Result<Option<CapabilityAction>, String> {
    let parsed = match action {
        "isResizable" => no_args(args).map(|_| CapabilityAction::IsResizable),
        "setResizable" => parse_bool(args, action).map(CapabilityAction::SetResizable),
        "isAlwaysOnTop" => no_args(args).map(|_| CapabilityAction::IsAlwaysOnTop),
        "setAlwaysOnTop" => parse_always_on_top(args).map(CapabilityAction::SetAlwaysOnTop),
        "isClosable" => no_args(args).map(|_| CapabilityAction::IsClosable),
        "setClosable" => parse_bool(args, action).map(CapabilityAction::SetClosable),
        "isMinimizable" => no_args(args).map(|_| CapabilityAction::IsMinimizable),
        "setMinimizable" => parse_bool(args, action).map(CapabilityAction::SetMinimizable),
        "isMaximizable" => no_args(args).map(|_| CapabilityAction::IsMaximizable),
        "setMaximizable" => parse_bool(args, action).map(CapabilityAction::SetMaximizable),
        "setSkipTaskbar" => parse_bool(args, action).map(CapabilityAction::SetSkipTaskbar),
        "setVisibleOnAllWorkspaces" => {
            parse_bool(args, action).map(CapabilityAction::SetVisibleOnAllWorkspaces)
        }
        "setFocusable" => parse_bool(args, action).map(CapabilityAction::SetFocusable),
        "setIgnoreMouseEvents" => {
            parse_bool(args, action).map(CapabilityAction::SetIgnoreMouseEvents)
        }
        "setHasShadow" => parse_bool(args, action).map(CapabilityAction::SetHasShadow),
        "isFocusable" | "hasShadow" | "isVisibleOnAllWorkspaces" => {
            return Err(unsupported(format!(
                "{action} has no native getter in Tauri 2.11.2"
            )));
        }
        _ => return Ok(None),
    };
    validate_platform(&parsed)?;
    parsed.map(Some)
}

fn validate_platform(action: &Result<CapabilityAction, String>) -> Result<(), String> {
    let action = match action {
        Ok(action) => action,
        Err(error) => return Err(error.clone()),
    };
    #[cfg(target_os = "linux")]
    if matches!(
        action,
        CapabilityAction::SetMinimizable(_)
            | CapabilityAction::SetMaximizable(_)
            | CapabilityAction::IsMinimizable
            | CapabilityAction::IsMaximizable
            | CapabilityAction::IsClosable
    ) {
        return Err(unsupported("native button state is unsupported on Linux"));
    }
    #[cfg(target_os = "linux")]
    if matches!(action, CapabilityAction::SetHasShadow(_)) {
        return Err(unsupported("setHasShadow is unsupported on Linux"));
    }
    Ok(())
}

pub(super) fn apply(
    window: &WebviewWindow,
    action: &CapabilityAction,
) -> Result<Option<Value>, String> {
    let value = match action {
        CapabilityAction::SetResizable(value) => {
            window.set_resizable(*value).map_err(native_error)?;
            Some(json!({"resizable": value}))
        }
        CapabilityAction::SetAlwaysOnTop(value) => {
            window.set_always_on_top(*value).map_err(native_error)?;
            Some(json!({"alwaysOnTop": value}))
        }
        CapabilityAction::SetClosable(value) => {
            window.set_closable(*value).map_err(native_error)?;
            Some(json!({"closable": value}))
        }
        CapabilityAction::SetMinimizable(value) => {
            window.set_minimizable(*value).map_err(native_error)?;
            Some(json!({"minimizable": value}))
        }
        CapabilityAction::SetMaximizable(value) => {
            window.set_maximizable(*value).map_err(native_error)?;
            Some(json!({"maximizable": value}))
        }
        CapabilityAction::SetSkipTaskbar(value) => {
            match skip_taskbar_behavior(*value) {
                SkipTaskbarBehavior::Noop => {
                    // Electron's macOS setter is a no-op; do not change the
                    // process activation or Dock policy to emulate it.
                }
                SkipTaskbarBehavior::Native(enabled) => {
                    window.set_skip_taskbar(enabled).map_err(native_error)?;
                }
            }
            Some(json!({"skipTaskbar": value}))
        }
        CapabilityAction::SetVisibleOnAllWorkspaces(value) => {
            window
                .set_visible_on_all_workspaces(*value)
                .map_err(native_error)?;
            Some(json!({"visibleOnAllWorkspaces": value}))
        }
        CapabilityAction::SetFocusable(value) => {
            window.set_focusable(*value).map_err(native_error)?;
            Some(json!({"focusable": value}))
        }
        CapabilityAction::SetIgnoreMouseEvents(value) => {
            window
                .set_ignore_cursor_events(*value)
                .map_err(native_error)?;
            Some(json!({"ignoreMouseEvents": value}))
        }
        CapabilityAction::SetHasShadow(value) => {
            window.set_shadow(*value).map_err(native_error)?;
            Some(json!({"hasShadow": value}))
        }
        _ => None,
    };
    Ok(value)
}

pub(super) fn read(
    window: &WebviewWindow,
    snapshot: &NativeSnapshot,
    action: &CapabilityAction,
) -> Result<Option<Value>, String> {
    let value = match action {
        CapabilityAction::IsResizable => Some(Value::Bool(snapshot.resizable)),
        CapabilityAction::IsAlwaysOnTop => Some(Value::Bool(snapshot.always_on_top)),
        CapabilityAction::IsClosable => {
            Some(Value::Bool(window.is_closable().map_err(native_error)?))
        }
        CapabilityAction::IsMinimizable => {
            Some(Value::Bool(window.is_minimizable().map_err(native_error)?))
        }
        CapabilityAction::IsMaximizable => {
            Some(Value::Bool(window.is_maximizable().map_err(native_error)?))
        }
        _ => None,
    };
    Ok(value)
}

fn parse_bool(args: &[Value], name: &str) -> Result<bool, String> {
    if args.len() != 1 {
        return Err(invalid(format!("{name} expects one boolean")));
    }
    args[0]
        .as_bool()
        .ok_or_else(|| invalid(format!("{name} expects one boolean")))
}

fn parse_always_on_top(args: &[Value]) -> Result<bool, String> {
    let Some(enabled) = args.first().and_then(Value::as_bool) else {
        return Err(invalid("setAlwaysOnTop expects a boolean first argument"));
    };
    if args.len() == 1 {
        return Ok(enabled);
    }
    if !(2..=3).contains(&args.len()) {
        return Err(invalid(
            "setAlwaysOnTop accepts boolean, optional level, and optional relativeLevel",
        ));
    }
    if args.get(1).and_then(Value::as_str) != Some("floating") {
        return Err(unsupported(
            "setAlwaysOnTop supports only the Electron floating level",
        ));
    }
    if args.len() == 3
        && !args
            .get(2)
            .and_then(Value::as_f64)
            .is_some_and(|relative_level| relative_level == 0.0)
    {
        return Err(unsupported("setAlwaysOnTop supports only relativeLevel 0"));
    }
    Ok(enabled)
}

fn no_args(args: &[Value]) -> Result<(), String> {
    if args.is_empty() {
        Ok(())
    } else {
        Err(invalid("action does not accept arguments"))
    }
}

fn invalid(message: impl AsRef<str>) -> String {
    format!(
        "ERR_ATOOLS_NATIVE_WINDOW_INVALID_OPTIONS: {}",
        message.as_ref()
    )
}

fn unsupported(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED: {}", message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_original_snipaste_floating_always_on_top_call() {
        assert!(matches!(
            parse("setAlwaysOnTop", &[json!(true), json!("floating")]),
            Ok(Some(CapabilityAction::SetAlwaysOnTop(true)))
        ));
        assert!(matches!(
            parse(
                "setAlwaysOnTop",
                &[json!(true), json!("floating"), json!(0)]
            ),
            Ok(Some(CapabilityAction::SetAlwaysOnTop(true)))
        ));
    }

    #[test]
    fn rejects_unmapped_always_on_top_levels_and_relative_offsets() {
        assert!(
            parse("setAlwaysOnTop", &[json!(true), json!("screen-saver")])
                .unwrap_err()
                .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED")
        );
        assert!(parse(
            "setAlwaysOnTop",
            &[json!(true), json!("floating"), json!(1)]
        )
        .unwrap_err()
        .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED"));
        assert!(parse("setAlwaysOnTop", &[json!(true), json!(false)])
            .unwrap_err()
            .contains("ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED"));
    }

    #[test]
    fn accepts_taskbar_toggle_for_electron_compatibility() {
        assert!(matches!(
            parse("setSkipTaskbar", &[json!(true)]),
            Ok(Some(CapabilityAction::SetSkipTaskbar(true)))
        ));
    }
}
