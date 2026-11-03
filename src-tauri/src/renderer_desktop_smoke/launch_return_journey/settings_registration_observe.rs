use super::{protocol::Harness, settings_registration_transport::Transport};
use atools_core::db::RendererLocalShortcut;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, Webview, Wry};

pub(super) async fn child(app: &AppHandle<Wry>) -> Result<(Webview<Wry>, String), &'static str> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let snapshot = crate::renderer_settings_view::snapshot(app);
        let window = crate::window::main_window(app)
            .map_err(|_| "settings-registration-main-unavailable")?;
        let children: Vec<_> = window
            .webviews()
            .into_iter()
            .filter(|view| view.label().starts_with("ztools-settings-"))
            .collect();
        if snapshot["sessionCount"] == 1
            && snapshot["phase"] == "open"
            && snapshot["ready"] == true
            && snapshot["documentAuthorized"] == true
            && snapshot["childPresent"] == true
            && children.len() == 1
        {
            let view = children
                .into_iter()
                .next()
                .ok_or("settings-registration-child-invalid")?;
            let id = view
                .label()
                .strip_prefix("ztools-settings-")
                .ok_or("settings-registration-child-invalid")?
                .to_owned();
            let url = view
                .url()
                .map_err(|_| "settings-registration-child-invalid")?;
            if crate::renderer_settings_view::is_expected_settings_url(&url, &id)
                && app.get_webview(view.label()).is_some()
            {
                return Ok((view, id));
            }
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-registration-child-not-ready");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) async fn closed(app: &AppHandle<Wry>) -> Result<Value, &'static str> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot = crate::renderer_settings_view::snapshot(app);
        let window = crate::window::main_window(app)
            .map_err(|_| "settings-registration-close-incomplete")?;
        let child_count = window
            .webviews()
            .iter()
            .filter(|view| view.label().starts_with("ztools-settings-"))
            .count();
        let layout = crate::window::main_child_layout_active_count(app).ok();
        let binding_active = crate::renderer_settings_view::fixture_binding_active(app);
        let value = json!({"sessionCount":snapshot["sessionCount"],"childCount":child_count,"layoutCount":layout,
            "pendingCalls":snapshot["pendingCalls"],"pendingWrites":snapshot["pendingWrites"],"bindingActive":binding_active});
        if snapshot["stateAvailable"] == true
            && snapshot["runtimeInitialized"] == true
            && value["sessionCount"] == 0
            && value["childCount"] == 0
            && value["layoutCount"] == 0
            && value["pendingCalls"] == 0
            && value["pendingWrites"] == 0
            && !binding_active
        {
            return Ok(value);
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("settings-registration-close-incomplete");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) fn rows(harness: &Harness) -> Result<(Vec<RendererLocalShortcut>, u64), &'static str> {
    let db = harness.database();
    let rows = db
        .read_renderer_local_shortcuts()
        .map_err(|_| "settings-registration-rows-unavailable")?;
    let raw = db
        .get_setting("ztools-renderer:local-shortcuts-revision")
        .map_err(|_| "settings-registration-revision-unavailable")?;
    let revision = match raw {
        Some(value) => value
            .parse()
            .map_err(|_| "settings-registration-revision-invalid")?,
        None => 0,
    };
    Ok((rows, revision))
}

pub(super) async fn wait_rows(
    harness: &Harness,
    count: usize,
    revision: u64,
) -> Result<Vec<RendererLocalShortcut>, &'static str> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let (rows, observed) = rows(harness)?;
        if rows.len() == count && observed == revision {
            return Ok(rows);
        }
        if observed > revision || tokio::time::Instant::now() >= deadline {
            return Err("settings-registration-database-state-invalid");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

pub(super) async fn main_counters(
    transport: &mut Transport,
    app: &AppHandle<Wry>,
    main: &Webview<Wry>,
    delivered: Option<u64>,
    revision: Option<u64>,
) -> Result<Value, &'static str> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let observation = transport
            .call(app, main, None, "inspect", json!({}))
            .await?;
        let counters = &observation["result"]["counters"];
        let valid = counters["launchCalls"] == 0
            && counters["outstandingNativeCalls"] == 0
            && counters["deliveredEvents"].as_u64().is_some()
            && delivered.is_none_or(|count| counters["deliveredEvents"] == count)
            && revision.is_none_or(|revision| counters["latestRevision"] == revision);
        if valid {
            return Ok(counters.clone());
        }
        if counters["launchCalls"] != 0
            || delivered.is_some_and(|count| {
                counters["deliveredEvents"]
                    .as_u64()
                    .is_some_and(|value| value > count)
            })
            || tokio::time::Instant::now() >= deadline
        {
            return Err("settings-registration-main-counters-invalid");
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}
