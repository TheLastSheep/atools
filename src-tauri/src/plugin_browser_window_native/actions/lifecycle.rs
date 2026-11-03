use serde_json::{json, Value};
use tauri::WebviewWindow;

use crate::plugin_browser_window_native::snapshot::{native_error, NativeSnapshot};

#[derive(Clone, Debug)]
pub(super) enum LifecycleAction {
    Close,
    Destroy,
    Show,
    Hide,
    Focus,
    GetTitle,
    SetTitle(String),
    IsVisible,
    IsFocused,
    Minimize,
    Unminimize,
    Maximize,
    Unmaximize,
    Restore,
    IsMinimized,
    IsMaximized,
    SetFullScreen(bool),
    IsFullScreen,
}

impl LifecycleAction {
    pub(super) fn is_close(&self) -> bool {
        matches!(self, Self::Close | Self::Destroy)
    }
}

pub(super) fn parse(action: &str, args: &[Value]) -> Result<Option<LifecycleAction>, String> {
    let parsed = match action {
        "close" => no_args(args).map(|_| LifecycleAction::Close),
        "destroy" => no_args(args).map(|_| LifecycleAction::Destroy),
        "show" => no_args(args).map(|_| LifecycleAction::Show),
        "showInactive" => {
            return Err(unsupported(
                "showInactive is not provided by the Tauri native window API",
            ))
        }
        "hide" => no_args(args).map(|_| LifecycleAction::Hide),
        "focus" => no_args(args).map(|_| LifecycleAction::Focus),
        "getTitle" => no_args(args).map(|_| LifecycleAction::GetTitle),
        "setTitle" => parse_title(args),
        "isVisible" => no_args(args).map(|_| LifecycleAction::IsVisible),
        "isFocused" => no_args(args).map(|_| LifecycleAction::IsFocused),
        "minimize" => no_args(args).map(|_| LifecycleAction::Minimize),
        "unminimize" => no_args(args).map(|_| LifecycleAction::Unminimize),
        "maximize" => no_args(args).map(|_| LifecycleAction::Maximize),
        "unmaximize" => no_args(args).map(|_| LifecycleAction::Unmaximize),
        "restore" => no_args(args).map(|_| LifecycleAction::Restore),
        "isMinimized" => no_args(args).map(|_| LifecycleAction::IsMinimized),
        "isMaximized" => no_args(args).map(|_| LifecycleAction::IsMaximized),
        "setFullScreen" => parse_bool(args, "setFullScreen").map(LifecycleAction::SetFullScreen),
        "isFullScreen" => no_args(args).map(|_| LifecycleAction::IsFullScreen),
        _ => return Ok(None),
    };
    parsed.map(Some)
}

pub(super) fn apply(
    window: &WebviewWindow,
    action: &LifecycleAction,
) -> Result<Option<Value>, String> {
    let value = match action {
        LifecycleAction::Close => {
            window.close().map_err(native_error)?;
            Some(json!({"visible": false, "focused": false, "closed": true}))
        }
        LifecycleAction::Destroy => {
            window.destroy().map_err(native_error)?;
            Some(json!({"visible": false, "focused": false, "closed": true}))
        }
        LifecycleAction::Show => {
            window.show().map_err(native_error)?;
            window.set_focus().map_err(native_error)?;
            Some(json!({"visible": true, "focused": true, "closed": false}))
        }
        LifecycleAction::Hide => {
            window.hide().map_err(native_error)?;
            Some(json!({"visible": false, "focused": false, "closed": false}))
        }
        LifecycleAction::Focus => {
            window.show().map_err(native_error)?;
            window.set_focus().map_err(native_error)?;
            Some(json!({"visible": true, "focused": true, "closed": false}))
        }
        LifecycleAction::Minimize => {
            window.minimize().map_err(native_error)?;
            Some(json!({"minimized": true, "maximized": false}))
        }
        LifecycleAction::Unminimize => {
            window.unminimize().map_err(native_error)?;
            Some(json!({"minimized": false}))
        }
        LifecycleAction::Maximize => {
            window.maximize().map_err(native_error)?;
            Some(json!({"minimized": false, "maximized": true}))
        }
        LifecycleAction::Unmaximize => {
            window.unmaximize().map_err(native_error)?;
            Some(json!({"maximized": false}))
        }
        LifecycleAction::Restore => {
            window.unminimize().map_err(native_error)?;
            window.unmaximize().map_err(native_error)?;
            window.set_fullscreen(false).map_err(native_error)?;
            window.show().map_err(native_error)?;
            Some(json!({"minimized": false, "maximized": false}))
        }
        LifecycleAction::SetTitle(title) => {
            window.set_title(title).map_err(native_error)?;
            Some(json!({"title": title}))
        }
        LifecycleAction::SetFullScreen(enabled) => {
            window.set_fullscreen(*enabled).map_err(native_error)?;
            Some(json!({"fullScreen": enabled}))
        }
        LifecycleAction::GetTitle
        | LifecycleAction::IsVisible
        | LifecycleAction::IsFocused
        | LifecycleAction::IsMinimized
        | LifecycleAction::IsMaximized
        | LifecycleAction::IsFullScreen => None,
    };
    Ok(value)
}

pub(super) fn read(snapshot: &NativeSnapshot, action: &LifecycleAction) -> Option<Value> {
    match action {
        LifecycleAction::GetTitle => Some(Value::String(snapshot.title.clone())),
        LifecycleAction::IsVisible => Some(Value::Bool(snapshot.visible)),
        LifecycleAction::IsFocused => Some(Value::Bool(snapshot.focused)),
        LifecycleAction::IsMinimized => Some(Value::Bool(snapshot.minimized)),
        LifecycleAction::IsMaximized => Some(Value::Bool(snapshot.maximized)),
        LifecycleAction::IsFullScreen => Some(Value::Bool(snapshot.full_screen)),
        _ => None,
    }
}

fn parse_title(args: &[Value]) -> Result<LifecycleAction, String> {
    if args.len() != 1 {
        return Err(invalid("setTitle expects one string"));
    }
    let title = args[0]
        .as_str()
        .ok_or_else(|| invalid("title must be a string"))?
        .trim();
    if title.len() > 512 || title.chars().any(char::is_control) {
        return Err(invalid("title must be control-free and at most 512 bytes"));
    }
    Ok(LifecycleAction::SetTitle(title.to_string()))
}

fn parse_bool(args: &[Value], name: &str) -> Result<bool, String> {
    if args.len() != 1 {
        return Err(invalid(format!("{name} expects one boolean")));
    }
    args[0]
        .as_bool()
        .ok_or_else(|| invalid(format!("{name} expects one boolean")))
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
