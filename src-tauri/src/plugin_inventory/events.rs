use tauri::{AppHandle, Emitter, EventTarget, Manager};

pub(crate) const EVENT_NAME: &str = "atools://renderer-plugins-changed";
const MAIN_WEBVIEW_LABEL: &str = "main";

/// Notify only the launcher WebView after plugin inventory metadata changes.
pub(crate) fn notify(app: &AppHandle) {
    let result = notify_with(
        || {
            let webview = crate::window::main_webview(app).map_err(|_| ())?;
            ensure_main_webview(webview.window().label())
        },
        |target, event, payload| app.emit_to(target, event, payload).map_err(|_| ()),
    );
    if result.is_err() {
        tracing::warn!("Plugin inventory notification failed for the main webview");
    }
}

fn notify_with(
    confirm_main: impl FnOnce() -> Result<(), ()>,
    emit: impl FnOnce(EventTarget, &'static str, ()) -> Result<(), ()>,
) -> Result<(), ()> {
    confirm_main()?;
    emit(
        EventTarget::webview(MAIN_WEBVIEW_LABEL),
        EVENT_NAME,
        payload(),
    )
}

fn ensure_main_webview(label: &str) -> Result<(), ()> {
    if label == MAIN_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err(())
    }
}

const fn payload() {}

#[cfg(test)]
mod tests {
    use super::{ensure_main_webview, notify_with, EVENT_NAME};
    use serde_json::Value;
    use tauri::EventTarget;

    #[test]
    fn notification_uses_main_webview_event_and_null_payload() {
        let mut delivered = None;
        notify_with(
            || ensure_main_webview("main"),
            |target, event, payload| {
                delivered = Some((target, event, serde_json::to_value(payload).unwrap()));
                Ok(())
            },
        )
        .unwrap();

        let (target, event, payload) = delivered.unwrap();
        assert_eq!(
            target,
            EventTarget::Webview {
                label: "main".into()
            }
        );
        assert_eq!(event, EVENT_NAME);
        assert_eq!(payload, Value::Null);
    }

    #[test]
    fn missing_or_non_main_webview_never_sends_the_event() {
        assert!(ensure_main_webview("plugin-panel").is_err());
        let mut sent = false;
        let result = notify_with(
            || Err(()),
            |_, _, _| {
                sent = true;
                Ok(())
            },
        );
        assert!(result.is_err());
        assert!(!sent);
    }
}
