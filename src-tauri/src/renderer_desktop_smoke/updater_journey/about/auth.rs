use super::*;
use tauri::{Webview, Window};
pub(super) fn role(stage: &str) -> Option<&'static str> {
    match stage {
        "main-ready" | "main-disposed" => Some("main"),
        "popup-ready" | "popup-disposed" => Some("popup"),
        "about-ready" | "about-manual" | "auto-on" | "auto-off" | "about-reopened" => Some("child"),
        _ => None,
    }
}
pub(super) fn child(
    app: &AppHandle,
    view: &Webview,
    window: &Window,
    ready: bool,
) -> Result<String, String> {
    if window.label() != "main" || view.window().label() != "main" {
        return Err("about-child-source-rejected".into());
    }
    let id = view
        .label()
        .strip_prefix("ztools-settings-")
        .filter(|id| valid_id(id))
        .ok_or("about-child-source-rejected")?;
    let url = view.url().map_err(|_| "about-child-url-rejected")?;
    if !crate::renderer_settings_view::is_expected_settings_url(&url, id)
        || ready && url.fragment() != Some("/about")
    {
        return Err("about-child-url-rejected".into());
    }
    let current = crate::renderer_settings_view::snapshot(app);
    let children = window
        .webviews()
        .into_iter()
        .filter(|v| v.label().starts_with("ztools-settings-"))
        .collect::<Vec<_>>();
    if children.len() != 1
        || children[0].label() != view.label()
        || current["sessionCount"] != 1
        || current["childPresent"] != true
        || current["documentAuthorized"] != true
        || current["bundleRevisionPresent"] != true
        || current["revoked"] != false
        || ready && current["ready"] != true
    {
        return Err("about-child-generation-rejected".into());
    }
    Ok(id.into())
}
pub(super) fn source(
    app: &AppHandle,
    h: &Harness,
    view: &Webview,
    window: &Window,
    stage: &str,
) -> Result<(&'static str, Option<String>), String> {
    h.verify(app)?;
    if !super::super::about_authorized(app) {
        return Err("about-capability-rejected".into());
    }
    let role = role(stage).ok_or("about-page-stage-rejected")?;
    if role == "child" {
        let id = child(app, view, window, true)?;
        if state(h)?.child()?.id != id {
            return Err("about-child-generation-rejected".into());
        }
        return Ok((role, Some(id)));
    }
    if view.label() != window.label() || view.window().label() != window.label() {
        return Err("about-source-rejected".into());
    }
    let actual = app
        .get_webview_window(window.label())
        .ok_or("about-source-rejected")?;
    crate::renderer_updater::fixture_observation::source(&actual, role == "popup")?;
    let id = if role == "popup" {
        Some(
            view.label()
                .strip_prefix("renderer-updater-")
                .filter(|s| valid_id(s))
                .ok_or("about-popup-source-rejected")?
                .to_owned(),
        )
    } else {
        None
    };
    Ok((role, id))
}
pub(super) fn valid_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && uuid::Uuid::parse_str(value)
            .is_ok_and(|id| id.get_version_num() == 4 && id.simple().to_string() == value)
}
