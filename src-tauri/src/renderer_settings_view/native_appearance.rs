use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Theme};

use super::preferences::SettingsPreferences;

#[cfg(target_os = "macos")]
const LAUNCH_AT_LOGIN_READ_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

pub(crate) async fn bootstrap(
    app: &AppHandle,
    prefs: &SettingsPreferences,
) -> Result<Value, String> {
    let snapshot = prefs.snapshot().await;
    let value = snapshot
        .get("value")
        .ok_or_else(|| "General settings snapshot is unavailable".to_owned())?;
    let theme = value
        .get("theme")
        .and_then(Value::as_str)
        .ok_or_else(|| "Committed General theme is unavailable".to_owned())?;
    let opacity = value
        .get("opacity")
        .and_then(Value::as_f64)
        .filter(|opacity| opacity.is_finite() && (0.3..=1.0).contains(opacity))
        .ok_or_else(|| "Committed General opacity is unavailable".to_owned())?;
    let current_shortcut = super::preferences::current_hotkey_display(app)?;

    set_main_theme(app, theme)?;
    let (launch_at_login, launch_at_login_available, applied_opacity, opacity_applied) = {
        #[cfg(target_os = "macos")]
        {
            let (launch_at_login, launch_at_login_available) = get_launch_at_login(app).await;
            let actual_opacity = crate::native_window_opacity::read_apply(
                crate::window::main_window(app).map_err(|_| "Main window is unavailable")?,
                Some(opacity),
            )
            .await?;
            (
                launch_at_login,
                launch_at_login_available,
                actual_opacity,
                true,
            )
        }
        #[cfg(not(target_os = "macos"))]
        {
            // The General record's opacity is a configured target only on these
            // platforms. Keep the page usable and report the unsupported action.
            (None, false, opacity, false)
        }
    };

    Ok(json!({
        "platform": platform_name()?,
        "currentShortcut": current_shortcut,
        "launchAtLogin": launch_at_login,
        "launchAtLoginAvailable": launch_at_login_available,
        "opacity": applied_opacity,
        "theme": theme,
        "themeApplied": true,
        "opacityApplied": opacity_applied,
    }))
}

pub(crate) struct PreparedAppearance {
    theme: String,
    opacity: f64,
    platform: &'static str,
    current_shortcut: String,
    launch_at_login: Option<bool>,
    launch_at_login_available: bool,
}

pub(crate) async fn prepare(
    app: &AppHandle,
    prefs: &SettingsPreferences,
) -> Result<PreparedAppearance, String> {
    let snapshot = prefs.snapshot().await;
    let value = snapshot
        .get("value")
        .ok_or("General settings snapshot is unavailable")?;
    let theme = value
        .get("theme")
        .and_then(Value::as_str)
        .ok_or("Committed General theme is unavailable")?
        .to_owned();
    let opacity = value
        .get("opacity")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.3..=1.0).contains(value))
        .ok_or("Committed General opacity is unavailable")?;
    let current_shortcut = super::preferences::current_hotkey_display(app)?;
    let (launch_at_login, launch_at_login_available) = get_launch_at_login(app).await;
    Ok(PreparedAppearance {
        theme,
        opacity,
        platform: platform_name()?,
        current_shortcut,
        launch_at_login,
        launch_at_login_available,
    })
}

pub(crate) fn apply_on_main(
    window: &tauri::Window,
    prepared: PreparedAppearance,
    validate: impl Fn() -> Result<(), String>,
) -> Result<Value, String> {
    let theme = match prepared.theme.as_str() {
        "system" => None,
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => return Err("Committed General theme is invalid".into()),
    };
    window
        .set_theme(theme)
        .map_err(|_| "Main window theme could not be applied")?;
    validate()?;
    #[cfg(target_os = "macos")]
    let (opacity, opacity_applied) = (
        crate::native_window_opacity::read_apply_on_main(window, Some(prepared.opacity))?,
        true,
    );
    #[cfg(not(target_os = "macos"))]
    let (opacity, opacity_applied) = (prepared.opacity, false);
    Ok(
        json!({ "platform": prepared.platform, "currentShortcut": prepared.current_shortcut,
        "launchAtLogin": prepared.launch_at_login, "launchAtLoginAvailable": prepared.launch_at_login_available,
        "opacity": opacity, "theme": prepared.theme, "themeApplied": true, "opacityApplied": opacity_applied }),
    )
}

pub(crate) async fn set_theme(
    app: &AppHandle,
    prefs: &SettingsPreferences,
    theme: &str,
) -> Result<(), String> {
    let snapshot = prefs.snapshot().await;
    let committed_theme = snapshot
        .get("value")
        .and_then(|value| value.get("theme"))
        .and_then(Value::as_str)
        .ok_or_else(|| "Committed General theme is unavailable".to_owned())?;
    if theme != committed_theme {
        return Err("Theme changes must be committed before native application".into());
    }
    set_main_theme(app, theme)
}

pub(crate) async fn set_opacity(
    app: &AppHandle,
    prefs: &SettingsPreferences,
    opacity: f64,
) -> Result<(), String> {
    if !opacity.is_finite() || !(0.3..=1.0).contains(&opacity) {
        return Err("Window opacity is outside its supported range".into());
    }
    let snapshot = prefs.snapshot().await;
    let committed_opacity = snapshot
        .get("value")
        .and_then(|value| value.get("opacity"))
        .and_then(Value::as_f64)
        .ok_or_else(|| "Committed General opacity is unavailable".to_owned())?;
    if opacity != committed_opacity {
        return Err("Opacity changes are not writable in this settings adapter".into());
    }

    #[cfg(target_os = "macos")]
    {
        crate::native_window_opacity::read_apply(
            crate::window::main_window(app).map_err(|_| "Main window is unavailable")?,
            Some(opacity),
        )
        .await
        .map(|_| ())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Window opacity application is unsupported on this platform".into())
    }
}

/// Reads the actual login-item registration without making bootstrap depend on it.
async fn get_launch_at_login(app: &AppHandle) -> (Option<bool>, bool) {
    #[cfg(feature = "legacy-node-smoke")]
    if let Some(status) = crate::renderer_desktop_smoke::settings_height::fixture_login_status(app)
    {
        return status;
    }
    #[cfg(target_os = "macos")]
    {
        let app = app.clone();
        match tokio::time::timeout(
            LAUNCH_AT_LOGIN_READ_TIMEOUT,
            tauri::async_runtime::spawn_blocking(move || {
                crate::general_settings_runtime::login_items::read(&app)
            }),
        )
        .await
        {
            Ok(Ok(result)) => launch_at_login_projection(
                result
                    .as_ref()
                    .map(|enabled| *enabled)
                    .map_err(String::as_str),
            ),
            Ok(Err(_)) | Err(_) => {
                tracing::warn!("Launch-at-login state is unavailable during settings bootstrap");
                (None, true)
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        (None, false)
    }
}

#[cfg(target_os = "macos")]
fn launch_at_login_projection(result: Result<bool, &str>) -> (Option<bool>, bool) {
    match result {
        Ok(enabled) => (Some(enabled), true),
        Err(crate::general_settings_runtime::login_items::UNSUPPORTED) => (None, false),
        Err(_) => (None, true),
    }
}

#[cfg(all(test, target_os = "macos"))]
mod login_projection_tests {
    use super::launch_at_login_projection;
    use crate::general_settings_runtime::login_items::{
        APPROVAL_REQUIRED, LEGACY_CONFIGURATION, RECOVERY_FAILED, UNAVAILABLE, UNSUPPORTED,
    };

    #[test]
    fn only_unsupported_marks_the_api_unavailable() {
        assert_eq!(launch_at_login_projection(Ok(true)), (Some(true), true));
        assert_eq!(launch_at_login_projection(Ok(false)), (Some(false), true));
        assert_eq!(launch_at_login_projection(Err(UNSUPPORTED)), (None, false));
        for error in [
            LEGACY_CONFIGURATION,
            RECOVERY_FAILED,
            APPROVAL_REQUIRED,
            UNAVAILABLE,
        ] {
            assert_eq!(launch_at_login_projection(Err(error)), (None, true));
        }
    }
}

fn set_main_theme(app: &AppHandle, theme: &str) -> Result<(), String> {
    let tauri_theme = match theme {
        "system" => None,
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => return Err("Committed General theme is invalid".into()),
    };
    crate::window::main_window(app)
        .map_err(|_| "Main window is unavailable")?
        .set_theme(tauri_theme)
        .map_err(|_| "Main window theme could not be applied".to_owned())?;

    // Multi-window visual sync: broadcast theme to all active webview windows
    for (label, window) in app.webview_windows() {
        if label != "main" {
            let _ = window.set_theme(tauri_theme);
        }
    }
    let _ = app.emit("atools://theme-changed", serde_json::json!({ "theme": theme }));
    Ok(())
}

fn platform_name() -> Result<&'static str, String> {
    #[cfg(target_os = "macos")]
    {
        Ok("darwin")
    }
    #[cfg(target_os = "windows")]
    {
        Ok("win32")
    }
    #[cfg(target_os = "linux")]
    {
        Ok("linux")
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        Err("Settings bootstrap is unsupported on this platform".into())
    }
}

#[cfg(test)]
mod tests {
    use super::platform_name;

    #[test]
    fn platform_label_matches_ztools_platform_names() {
        #[cfg(target_os = "macos")]
        assert_eq!(platform_name().unwrap(), "darwin");
        #[cfg(target_os = "windows")]
        assert_eq!(platform_name().unwrap(), "win32");
        #[cfg(target_os = "linux")]
        assert_eq!(platform_name().unwrap(), "linux");
    }
}
