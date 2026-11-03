use super::retired_session::ReplayPlan;
use super::{schema, state::Harness};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview, Wry};

#[path = "probe_assets.rs"]
mod probe_assets;
use probe_assets::action_script;
#[path = "probe_pending.rs"]
mod probe_pending;
use probe_pending::await_probe;

#[path = "material_probe.rs"]
mod material_probe;
pub(super) use material_probe::{
    child_paint_diagnostic, child_snapshot_ready, child_theme_inspect, child_theme_navigate,
    child_theme_select, main_theme_inspect,
};

#[path = "command_availability_probe.rs"]
mod command_availability_probe;
pub(super) use command_availability_probe::{
    child_availability_baseline, child_availability_disable, child_availability_disabled_read_back,
    child_availability_enable, child_availability_enabled_read_back, main_command_availability,
};

#[path = "local_app_search_probe.rs"]
mod local_app_search_probe;
pub(super) use local_app_search_probe::{
    child_local_app_search_inspect, child_local_app_search_toggle, main_local_app_search,
};

#[path = "plugin_inventory_probe.rs"]
mod plugin_inventory_probe;
pub(super) use plugin_inventory_probe::main_plugin_inventory;

#[path = "command_aliases_probe.rs"]
mod command_aliases_probe;
pub(super) use command_aliases_probe::{
    child_alias_add_save, child_alias_delete, child_alias_edit_save, child_alias_open_add,
    child_alias_open_add_diagnostic, child_alias_read_back, main_alias_inspect, main_alias_search,
};

#[path = "window_opacity_probe.rs"]
mod window_opacity_probe;
pub(super) use window_opacity_probe::{child_window_opacity_inspect, child_window_opacity_set};

#[path = "tray_visibility_probe.rs"]
mod tray_visibility_probe;
pub(in crate::renderer_desktop_smoke::settings_input_journey) use tray_visibility_probe::{
    child_tray_visibility_inspect, child_tray_visibility_set,
};

#[path = "main_hotkey_probe.rs"]
mod main_hotkey_probe;
pub(in crate::renderer_desktop_smoke::settings_input_journey) use main_hotkey_probe::{
    child_main_hotkey_inspect, child_main_hotkey_raw_mutation, child_main_hotkey_record,
    main_hotkey_raw_mutation,
};

#[path = "main_hotkey_startup/probe.rs"]
mod hotkey_startup_probe;
pub(in crate::renderer_desktop_smoke::settings_input_journey) use hotkey_startup_probe::{
    edit_placeholder as child_hotkey_startup_edit_placeholder,
    inspect as child_hotkey_startup_inspect,
};

pub(super) fn on_page_load(webview: &Webview<Wry>, payload: &tauri::webview::PageLoadPayload<'_>) {
    super::probe_page_load::on_page_load(webview, payload);
}

pub(super) async fn main_updater(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    main_call(app, harness, "mainUpdater", "updaterStatus", &[]).await
}

pub(super) async fn main_open_settings(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    main_call(app, harness, "mainOpenSettings", "openSettings", &[]).await
}

pub(super) async fn main_open_state(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    main_call(app, harness, "mainOpenState", "openState", &[]).await
}

pub(super) async fn main_inspect(
    app: &AppHandle<Wry>,
    harness: &Harness,
) -> Result<Value, &'static str> {
    main_call(app, harness, "mainInspect", "inspect", &[]).await
}

pub(super) async fn main_input(
    app: &AppHandle<Wry>,
    harness: &Harness,
    query: &str,
) -> Result<Value, &'static str> {
    let query =
        serde_json::to_string(query).map_err(|_| "settings-input-probe-protocol-rejected")?;
    main_call(app, harness, "mainInput", "input", &[query.as_str()]).await
}

pub(super) async fn main_value_matches(
    app: &AppHandle<Wry>,
    harness: &Harness,
    expected: &str,
) -> Result<Value, &'static str> {
    let expected = js_string(expected);
    main_call(
        app,
        harness,
        "mainValue",
        "valueMatches",
        &[expected.as_str()],
    )
    .await
}

pub(super) async fn main_pinned_search(
    app: &AppHandle<Wry>,
    harness: &Harness,
    name: &str,
    should_be_present: bool,
    expected_revision: u64,
) -> Result<Value, &'static str> {
    let name = js_string(name);
    let expected_revision = expected_revision.to_string();
    main_call(
        app,
        harness,
        "mainPinnedSearch",
        "pinnedSearch",
        &[
            name.as_str(),
            if should_be_present { "true" } else { "false" },
            expected_revision.as_str(),
        ],
    )
    .await
}

pub(super) async fn child_baseline(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
    operation: &'static str,
) -> Result<Value, &'static str> {
    let operation_arg = js_string(operation);
    let name = js_string(&target.0);
    let path = js_string(&target.1);
    child_call(
        app,
        harness,
        child,
        operation,
        "inspectBaseline",
        &[operation_arg.as_str(), name.as_str(), path.as_str()],
    )
    .await
}

pub(super) async fn child_target(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
) -> Result<Value, &'static str> {
    let name = js_string(&target.0);
    let path = js_string(&target.1);
    child_call(
        app,
        harness,
        child,
        "childTarget",
        "inspectTarget",
        &[name.as_str(), path.as_str()],
    )
    .await
}

pub(super) async fn child_pin_search(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
) -> Result<Value, &'static str> {
    child_search_pin_action(app, harness, child, target, "childPinSearch", "pin").await
}

pub(super) async fn child_unpin_search(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
) -> Result<Value, &'static str> {
    child_search_pin_action(app, harness, child, target, "childUnpinSearch", "unpin").await
}

async fn child_search_pin_action(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
    operation: &'static str,
    action: &'static str,
) -> Result<Value, &'static str> {
    let action = js_string(action);
    let name = js_string(&target.0);
    let path = js_string(&target.1);
    child_call(
        app,
        harness,
        child,
        operation,
        "changeSearchPin",
        &[action.as_str(), name.as_str(), path.as_str()],
    )
    .await
}

pub(super) async fn child_no_match(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    child_call(app, harness, child, "childNoMatch", "inspectNoMatch", &[]).await
}

pub(super) async fn child_clear(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    child_call(app, harness, child, "childClear", "inspectClear", &[]).await
}

pub(super) async fn child_owner_route(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    target: &(String, String),
) -> Result<Value, &'static str> {
    let name = js_string(&target.0);
    let path = js_string(&target.1);
    child_call(
        app,
        harness,
        child,
        "childOwnerRoute",
        "rotateOwner",
        &[name.as_str(), path.as_str()],
    )
    .await
}

pub(super) async fn child_value(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    value: &str,
) -> Result<Value, &'static str> {
    let value = js_string(value);
    child_call(
        app,
        harness,
        child,
        "childValue",
        "setValue",
        &[value.as_str()],
    )
    .await
}

pub(super) async fn child_stale(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    old_generation: u64,
    current_generation: u64,
    control_sequence: u64,
    revision: u64,
    value_version: u64,
) -> Result<Value, &'static str> {
    let args = [
        old_generation.to_string(),
        current_generation.to_string(),
        control_sequence.to_string(),
        revision.to_string(),
        value_version.to_string(),
    ];
    child_call(
        app,
        harness,
        child,
        "childStale",
        "sendStaleControl",
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
    )
    .await
}

pub(super) async fn child_retired_session(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    retired_session_id: &str,
    plan: ReplayPlan,
) -> Result<Value, &'static str> {
    let retired_session_id = js_string(retired_session_id);
    let generation = plan.generation.to_string();
    let sequence = plan.next_sequence.to_string();
    child_call(
        app,
        harness,
        child,
        "childRetiredSession",
        "replayRetiredSession",
        &[
            retired_session_id.as_str(),
            generation.as_str(),
            sequence.as_str(),
        ],
    )
    .await
}

pub(super) async fn child_out_available(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) -> Result<Value, &'static str> {
    child_call(app, harness, child, "childOut", "outAvailable", &[]).await
}

pub(super) fn trigger_out(child: &Webview<Wry>) -> Result<(), &'static str> {
    child
        .eval("window.ztools.outPlugin();")
        .map_err(|_| "settings-input-out-plugin-unavailable")
}

pub(super) async fn main_call(
    app: &AppHandle<Wry>,
    harness: &Harness,
    operation: &'static str,
    method: &str,
    args: &[&str],
) -> Result<Value, &'static str> {
    main_call_with_timeout(app, harness, operation, method, args, schema::PROBE_TIMEOUT).await
}

async fn main_call_with_timeout(
    app: &AppHandle<Wry>,
    harness: &Harness,
    operation: &'static str,
    method: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Value, &'static str> {
    let caller = "main";
    let (probe_id, receiver) = harness.begin(operation, caller)?;
    let main = match crate::window::main_webview(app) {
        Ok(view) if view.label() == "main" && view.window().label() == "main" => view,
        _ => {
            harness.cancel(probe_id);
            return Err("settings-input-main-webview-unavailable");
        }
    };
    let script = action_script("MAIN", method, probe_id, args);
    if main.eval(script).is_err() {
        harness.cancel(probe_id);
        return Err("settings-input-probe-protocol-rejected");
    }
    await_probe(probe_id, receiver, timeout, |id| harness.cancel(id)).await
}

async fn child_call(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    operation: &'static str,
    method: &str,
    args: &[&str],
) -> Result<Value, &'static str> {
    child_call_with_timeout(
        app,
        harness,
        child,
        operation,
        method,
        args,
        schema::PROBE_TIMEOUT,
    )
    .await
}

pub(super) async fn child_call_with_timeout(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    operation: &'static str,
    method: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<Value, &'static str> {
    if child.window().label() != "main" || child.label() == "main" {
        return Err("settings-input-child-identity-invalid");
    }
    let caller = child.label().to_owned();
    let (probe_id, receiver) = harness.begin(operation, &caller)?;
    if !current_child_matches(app, child) {
        harness.cancel(probe_id);
        return Err("settings-input-child-identity-invalid");
    }
    let script = action_script("CHILD", method, probe_id, args);
    if child.eval(script).is_err() {
        harness.cancel(probe_id);
        return Err("settings-input-probe-protocol-rejected");
    }
    await_probe(probe_id, receiver, timeout, |id| harness.cancel(id)).await
}

pub(super) async fn settings_window_call_with_timeout(
    app: &AppHandle<Wry>,
    harness: &Harness,
    webview: &Webview<Wry>,
    operation: &'static str,
    timeout: Duration,
) -> Result<Value, &'static str> {
    if !super::login_cross_entry_schema::valid_operation(operation, "settings")
        || !super::login_cross_entry_journey::is_active(app)
        || !super::login_cross_entry_window::valid_current(app, webview)
    {
        return Err("settings-input-probe-protocol-rejected");
    }
    let (probe_id, receiver) = harness.begin(operation, "settings")?;
    let token = js_string(harness.token());
    let script = format!(
        "window.__ATOOLS_SETTINGS_INPUT_TOKEN__={token};\n{}\nwindow.__ATOOLS_SETTINGS_INPUT_LOGIN_CROSS_ENTRY__?.{operation}({probe_id});",
        include_str!("login-cross-entry-probe.js"),
    );
    if webview.eval(script).is_err() {
        harness.cancel(probe_id);
        return Err("settings-input-probe-protocol-rejected");
    }
    let evidence = await_probe(probe_id, receiver, timeout, |id| harness.cancel(id)).await?;
    if !super::login_cross_entry_window::valid_current(app, webview) {
        return Err("settings-input-probe-protocol-rejected");
    }
    Ok(evidence)
}

fn current_child_matches(app: &AppHandle<Wry>, child: &Webview<Wry>) -> bool {
    let diagnostics = crate::renderer_settings_view::snapshot(app);
    if diagnostics["sessionCount"].as_u64() != Some(1)
        || diagnostics["childPresent"].as_bool() != Some(true)
        || diagnostics["ready"].as_bool() != Some(true)
    {
        return false;
    }
    let Ok(url) = child.url() else {
        return false;
    };
    let Some(id) = child.label().strip_prefix("ztools-settings-") else {
        return false;
    };
    url.as_str()
        .starts_with(&format!("atools-settings://{id}.localhost/index.html#"))
}

pub(super) fn js_string(value: &str) -> String {
    serde_json::to_string(value)
        .unwrap_or_else(|_| "\"\"".to_owned())
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}
