use crate::renderer_desktop_smoke::profile::Profile;
use tauri::{AppHandle, Webview, Window, Wry};

pub(super) fn valid_token(token: &str) -> bool {
    token.len() == 32
        && token
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && uuid::Uuid::parse_str(token)
            .is_ok_and(|uuid| uuid.get_version_num() == 4 && uuid.simple().to_string() == token)
}

pub(super) fn validate_caller(
    app: &AppHandle<Wry>,
    webview: &Webview<Wry>,
    window: &Window<Wry>,
    operation: &str,
    profile: &Profile,
) -> Result<String, &'static str> {
    let caller = caller_context(window, webview, operation)?;
    if caller == "settings" {
        if !super::login_cross_entry_journey::profile_enabled(profile)
            || !super::login_cross_entry_journey::is_active(app)
            || !super::login_cross_entry_window::valid_current(app, webview)
        {
            return Err("settings-input-probe-protocol-rejected");
        }
        return Ok(caller);
    }
    if caller == "main" {
        let url = webview
            .url()
            .map_err(|_| "settings-input-probe-protocol-rejected")?;
        if !super::super::controller::is_local_root_url(&url) {
            return Err("settings-input-probe-protocol-rejected");
        }
        let actual = crate::window::main_webview(app)
            .map_err(|_| "settings-input-probe-protocol-rejected")?;
        if actual.label() != "main" {
            return Err("settings-input-probe-protocol-rejected");
        }
        return Ok(caller);
    }

    let url = webview
        .url()
        .map_err(|_| "settings-input-probe-protocol-rejected")?;
    if !operation.starts_with("child")
        || !super::child_probe_url::is_expected_child_probe_url(&caller, &url)
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    let runtime = crate::renderer_settings_view::snapshot(app);
    if runtime["stateAvailable"].as_bool() != Some(true)
        || runtime["runtimeInitialized"].as_bool() != Some(true)
        || runtime["sessionCount"].as_u64() != Some(1)
        || runtime["ready"].as_bool() != Some(true)
        || runtime["childPresent"].as_bool() != Some(true)
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    let parent =
        crate::window::main_window(app).map_err(|_| "settings-input-probe-protocol-rejected")?;
    let children = parent
        .webviews()
        .into_iter()
        .filter(|view| {
            view.label()
                .strip_prefix("ztools-settings-")
                .is_some_and(valid_token)
        })
        .collect::<Vec<_>>();
    if children.len() != 1 || children[0].label() != webview.label() {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(webview.label().to_owned())
}

pub(super) fn caller_context(
    window: &Window<Wry>,
    webview: &Webview<Wry>,
    operation: &str,
) -> Result<String, &'static str> {
    let webview_window = webview.window();
    if window.label() == "settings"
        && webview_window.label() == "settings"
        && webview.label() == "settings"
        && super::login_cross_entry_schema::valid_operation(operation, "settings")
    {
        return Ok("settings".to_owned());
    }
    if window.label() != "main" || webview_window.label() != "main" {
        return Err("settings-input-probe-protocol-rejected");
    }
    if webview.label() == "main" {
        if !operation.starts_with("main") {
            return Err("settings-input-probe-protocol-rejected");
        }
        return Ok("main".to_owned());
    }
    let id = webview
        .label()
        .strip_prefix("ztools-settings-")
        .filter(|id| valid_token(id))
        .ok_or("settings-input-probe-protocol-rejected")?;
    if !operation.starts_with("child") || !valid_token(id) {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(webview.label().to_owned())
}
