//! IPC is limited to the formal renderer's local reads and Settings lifecycle.
use serde_json::Value;
use tauri::{
    ipc::{Invoke, InvokeBody},
    Manager, Wry,
};

pub(super) fn allowed(command: &str, body: &Value) -> bool {
    match command {
        "open_renderer_settings" | "reset_window" => {
            body.as_object().is_some_and(|fields| fields.is_empty())
        }
        "expand_window" => body.as_object().is_some_and(|fields| {
            fields.len() == 1
                && fields
                    .get("height")
                    .and_then(Value::as_u64)
                    .is_some_and(|height| (1..=10_000).contains(&height))
        }),
        "list_launcher_apps"
        | "list_plugins"
        | "get_ztools_renderer_settings"
        | "get_app_update_status" => true,
        "call_renderer_settings" => matches!(
            body["operation"].as_str(),
            Some(
                "ready"
                    | "readGeneral"
                    | "readCommands"
                    | "readCommandSettings"
                    | "readAliases"
                    | "readCommandDataPage"
                    | "readLocalShortcuts"
                    | "updateSubInput"
                    | "outAcknowledged"
            )
        ),
        _ => false,
    }
}

pub(super) fn dispatch(invoke: Invoke<Wry>, production: &impl Fn(Invoke<Wry>) -> bool) -> bool {
    let body = match invoke.message.payload() {
        InvokeBody::Json(body) => body.clone(),
        _ => {
            invoke.resolver.reject("settings-height requires JSON");
            return true;
        }
    };
    let caller = invoke.message.webview();
    let main_only = invoke.message.command() != "call_renderer_settings";
    if main_only && (caller.label() != "main" || caller.window().label() != "main") {
        invoke
            .resolver
            .reject("settings-height requires the real Main");
        return true;
    }
    if super::validate(invoke.message.webview().app_handle()).is_err()
        || !allowed(invoke.message.command(), &body)
    {
        invoke
            .resolver
            .reject("settings-height fixture command rejected");
        return true;
    }
    if crate::renderer_settings_view::handles(invoke.message.command()) {
        crate::renderer_settings_view::dispatch(invoke)
    } else {
        production(invoke)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn height_gate_allows_local_bootstrap_but_rejects_os_actions_arbitrary_js_and_mutating_ipc() {
        assert!(allowed("open_renderer_settings", &json!({})));
        assert!(allowed("reset_window", &json!({})));
        assert!(allowed("expand_window", &json!({"height":599})));
        for body in [
            json!({"height":0}),
            json!({"height":10001}),
            json!({"height":200.5}),
            json!({"height":600,"window":"foreign"}),
        ] {
            assert!(!allowed("expand_window", &body));
        }
        assert!(!allowed(
            "open_renderer_settings",
            &json!({"arbitrary":true})
        ));
        for operation in [
            "ready",
            "readGeneral",
            "readCommands",
            "readAliases",
            "readCommandSettings",
            "readCommandDataPage",
            "readLocalShortcuts",
            "updateSubInput",
            "outAcknowledged",
        ] {
            assert!(allowed(
                "call_renderer_settings",
                &json!({"operation":operation})
            ));
        }
        for operation in [
            "getLaunchAtLogin",
            "setLaunchAtLogin",
            "startHotkeyRecording",
            "stopHotkeyRecording",
            "setTrayIconVisible",
            "patchGeneral",
            "setTheme",
            "close",
            "eval",
        ] {
            assert!(!allowed(
                "call_renderer_settings",
                &json!({"operation":operation})
            ));
        }
        for command in [
            "hide_main_window",
            "close_renderer_settings",
            "execute_plugin",
            "plugin:fs|read_file",
            "open_url",
        ] {
            assert!(!allowed(command, &json!({})));
        }
    }
}
