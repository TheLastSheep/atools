use super::{probe::js_string, state::Harness};
use tauri::{
    webview::{PageLoadEvent, PageLoadPayload},
    Manager, Webview, Wry,
};

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = webview.app_handle();
    let Some(state) = app.try_state::<Harness>() else {
        return;
    };
    let harness = (*state).clone();
    let Ok(url) = webview.url() else {
        harness.add_error("settings-input-probe-protocol-rejected");
        return;
    };
    if webview.label() == "main" {
        if !super::super::controller::is_local_root_url(&url) {
            return;
        }
        let token = js_string(harness.token());
        let script = format!(
            "window.__ATOOLS_SETTINGS_INPUT_TOKEN__={token};\n{}\n{}\n{}",
            include_str!("main-probe.js"),
            include_str!("material-probe.js"),
            include_str!("plugin-inventory-probe.js"),
        );
        if webview.eval(script).is_err() {
            harness.add_error("settings-input-main-probe-injection-failed");
        }
        return;
    }

    if webview.label() == "settings" {
        if !super::login_cross_entry_journey::profile_enabled(harness.profile())
            || !super::login_cross_entry_window::valid_current(&app, webview)
        {
            return;
        }
        let token = js_string(harness.token());
        let script = format!(
            "window.__ATOOLS_SETTINGS_INPUT_TOKEN__={token};\n{}",
            include_str!("login-cross-entry-probe.js"),
        );
        if webview.eval(script).is_err() {
            harness.add_error(super::login_cross_entry_schema::FALLBACK_OPEN_FAILED);
        }
        return;
    }

    if !webview.label().starts_with("ztools-settings-") {
        return;
    }
    let token = js_string(harness.token());
    let script = format!(
        "window.__ATOOLS_SETTINGS_INPUT_TOKEN__={token};\n{}\n{}",
        include_str!("child-probe.js"),
        include_str!("material-probe.js"),
    );
    if webview.eval(script).is_err() {
        harness.add_error("settings-input-child-probe-injection-failed");
    }
}
