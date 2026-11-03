use serde::Serialize;
use tauri::{AppHandle, Webview, Window};

use super::{LegacyLoginChoice, LegacyLoginInspection};

const SCOPE_ERROR: &str = "Launch at login is available only to the main or settings window";

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LaunchAtLoginState {
    enabled: bool,
}

#[tauri::command]
pub(crate) async fn read_launch_at_login(
    app: AppHandle,
    webview: Webview,
    window: Window,
) -> Result<LaunchAtLoginState, String> {
    authorize_caller(&webview, &window)?;
    let coordinator = crate::general_settings_runtime::commands::get_coordinator(&app)?;
    coordinator
        .run(move || async move {
            let worker_app = app.clone();
            let enabled = tauri::async_runtime::spawn_blocking(move || {
                super::read_apply(&worker_app, None, None)
            })
            .await
            .map_err(|_| super::UNAVAILABLE.to_owned())??;
            Ok(LaunchAtLoginState { enabled })
        })
        .await
}

#[tauri::command]
pub(crate) async fn change_launch_at_login(
    app: AppHandle,
    webview: Webview,
    window: Window,
    expected: bool,
    enabled: bool,
) -> Result<LaunchAtLoginState, String> {
    authorize_caller(&webview, &window)?;
    let coordinator = crate::general_settings_runtime::commands::get_coordinator(&app)?;
    coordinator
        .run(move || async move {
            let worker_app = app.clone();
            let actual = tauri::async_runtime::spawn_blocking(move || {
                super::read_apply(&worker_app, Some(expected), Some(enabled))
            })
            .await
            .map_err(|_| super::RECOVERY_FAILED.to_owned())??;
            if actual != enabled {
                return Err(super::UNAVAILABLE.to_owned());
            }
            Ok(LaunchAtLoginState { enabled: actual })
        })
        .await
}

#[tauri::command]
pub(crate) async fn inspect_legacy_launch_at_login(
    app: AppHandle,
    webview: Webview,
    window: Window,
) -> Result<LegacyLoginInspection, String> {
    authorize_caller(&webview, &window)?;
    let coordinator = super::super::commands::get_coordinator(&app)?;
    coordinator
        .run(move || async move {
            let worker_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                super::inspect_legacy_launch_at_login(&worker_app)
            })
            .await
            .map_err(|_| super::RECOVERY_FAILED.to_owned())?
        })
        .await
}

#[tauri::command]
pub(crate) async fn resolve_legacy_launch_at_login(
    app: AppHandle,
    webview: Webview,
    window: Window,
    choice: LegacyLoginChoice,
    expected_modern: bool,
    revision: String,
) -> Result<LaunchAtLoginState, String> {
    authorize_caller(&webview, &window)?;
    if !super::valid_legacy_revision(&revision) {
        return Err(super::CONFLICT.to_owned());
    }
    let coordinator = super::super::commands::get_coordinator(&app)?;
    coordinator
        .run(move || async move {
            let worker_app = app.clone();
            let enabled = tauri::async_runtime::spawn_blocking(move || {
                super::resolve_legacy_launch_at_login(
                    &worker_app,
                    choice,
                    expected_modern,
                    &revision,
                )
            })
            .await
            .map_err(|_| super::RECOVERY_FAILED.to_owned())??;
            confirmed_legacy_resolution(enabled, choice)
        })
        .await
}

fn confirmed_legacy_resolution(
    enabled: bool,
    choice: LegacyLoginChoice,
) -> Result<LaunchAtLoginState, String> {
    if enabled == choice.target_enabled() {
        Ok(LaunchAtLoginState { enabled })
    } else {
        Err(super::UNAVAILABLE.to_owned())
    }
}

fn authorize_caller(webview: &Webview, window: &Window) -> Result<(), String> {
    authorize_labels(webview.label(), webview.window().label(), window.label())
}

fn authorize_labels(webview: &str, parent: &str, window: &str) -> Result<(), String> {
    if ["main", "settings"]
        .iter()
        .any(|expected| webview == *expected && parent == *expected && window == *expected)
    {
        Ok(())
    } else {
        Err(SCOPE_ERROR.to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::{authorize_labels, LaunchAtLoginState, SCOPE_ERROR};
    use super::{confirmed_legacy_resolution, LegacyLoginChoice};

    #[test]
    fn accepts_only_matching_main_or_settings_webview_and_window_labels() {
        assert!(authorize_labels("main", "main", "main").is_ok());
        assert!(authorize_labels("settings", "settings", "settings").is_ok());

        for (webview, parent, window) in [
            ("plugin", "plugin", "plugin"),
            ("main", "settings", "main"),
            ("main", "main", "settings"),
            ("settings", "main", "settings"),
            ("plugin", "main", "main"),
            ("main", "plugin", "main"),
        ] {
            assert_eq!(
                authorize_labels(webview, parent, window),
                Err(SCOPE_ERROR.into())
            );
        }
    }

    #[test]
    fn response_exposes_only_the_confirmed_enabled_fact() {
        let state = LaunchAtLoginState { enabled: true };
        assert_eq!(
            serde_json::to_value(state).unwrap(),
            serde_json::json!({"enabled": true})
        );
    }

    #[test]
    fn legacy_resolution_reply_must_match_the_selected_action() {
        assert_eq!(
            confirmed_legacy_resolution(false, LegacyLoginChoice::TurnOff).unwrap(),
            LaunchAtLoginState { enabled: false }
        );
        assert_eq!(
            confirmed_legacy_resolution(true, LegacyLoginChoice::Migrate).unwrap(),
            LaunchAtLoginState { enabled: true }
        );
        assert_eq!(
            confirmed_legacy_resolution(true, LegacyLoginChoice::TurnOff),
            Err(super::super::UNAVAILABLE.to_owned())
        );
        assert_eq!(
            confirmed_legacy_resolution(false, LegacyLoginChoice::Migrate),
            Err(super::super::UNAVAILABLE.to_owned())
        );
    }
}
