//! Main-WebView-only current clipboard request routed through the shared permission pipeline.
use crate::{launcher_app_catalog, pasteboard_runtime::LastCopiedContent, state::AppState};
use tauri::{AppHandle, State, Webview, Wry};

const CALLER_REJECTED: &str =
    "Current clipboard access is available only from the trusted Main window";

#[tauri::command]
pub(crate) async fn get_renderer_last_copied_content(
    webview: Webview<Wry>,
    app: AppHandle,
    state: State<'_, AppState>,
    time_limit: Option<f64>,
) -> Result<Option<LastCopiedContent>, String> {
    validate_main_caller(&app, &webview)?;
    crate::pasteboard_runtime::validate_time_limit(time_limit).map_err(str::to_owned)?;
    let result =
        crate::launcher_clipboard_context::read_for_main(&app, &state.db, time_limit).await;
    // A navigation/window replacement while the shared permission and TaskRun
    // pipeline was running invalidates this one-use raw response.
    validate_main_caller(&app, &webview)?;
    result
}

fn validate_main_caller(app: &AppHandle, webview: &Webview<Wry>) -> Result<(), String> {
    if launcher_app_catalog::ensure_main_webview(webview.label()).is_err()
        || webview.window().label() != "main"
    {
        return Err(CALLER_REJECTED.into());
    }
    let url = webview.url().map_err(|_| CALLER_REJECTED)?;
    if trusted_main_source(&url) {
        let current = crate::window::main_webview(app).map_err(|_| CALLER_REJECTED)?;
        if current.label() == webview.label()
            && current.window().label() == "main"
            && current.url().ok().as_ref() == Some(&url)
        {
            Ok(())
        } else {
            Err(CALLER_REJECTED.into())
        }
    } else {
        Err(CALLER_REJECTED.into())
    }
}

fn trusted_main_source(url: &tauri::Url) -> bool {
    let own_app_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        _ => false,
    };
    own_app_origin
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.path(), "/" | "/index.html")
        && url.query().is_none()
        && url.fragment().is_none()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_clipboard_source_accepts_only_the_local_root_document() {
        for raw in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "https://tauri.localhost/",
        ] {
            assert!(
                trusted_main_source(&tauri::Url::parse(raw).unwrap()),
                "{raw}"
            );
        }
        for raw in [
            "https://example.com/",
            "http://tauri.localhost:1420/",
            "tauri://localhost/plugin/index.html",
            "tauri://localhost/?external=1",
            "tauri://localhost/#/route",
        ] {
            assert!(
                !trusted_main_source(&tauri::Url::parse(raw).unwrap()),
                "{raw}"
            );
        }
    }
}
