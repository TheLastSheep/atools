//! Closed, hidden Settings-height measurement; no foreground or input controller.
mod commands;
mod geometry;
mod journey;
mod main_entry;
mod report;
mod source;
mod startup;

use super::{profile::Profile, DisabledClipboard};
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, AtomicI32},
        Arc, Mutex,
    },
    time::Instant,
};
use tauri::{AppHandle, Manager};

pub(super) use startup::run;
pub(super) const DEADLINE_SECONDS: u64 = 165;

struct Session {
    profile: Arc<Profile>,
    sources: source::Sources,
    clipboard: Arc<DisabledClipboard>,
    report: Mutex<Value>,
    started: Instant,
    reported: AtomicBool,
    result_code: AtomicI32,
}

pub(crate) fn validate(app: &AppHandle) -> Result<(), String> {
    let session = app
        .try_state::<Session>()
        .ok_or("height fixture is not managed")?;
    if app.config().identifier != session.profile.identifier {
        return Err("height app identifier mismatch".into());
    }
    session.sources.validate(&session.profile)
}

/// Presence of a managed fixture always fails closed; a bad owner never falls through to OS.
pub(crate) fn fixture_login_status(app: &AppHandle) -> Option<(Option<bool>, bool)> {
    let session = app.try_state::<Session>()?;
    if let Err(error) = validate(app) {
        report::error(&session, &error);
    }
    Some((None, false))
}

fn start(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let remaining = std::time::Duration::from_secs(DEADLINE_SECONDS)
            .saturating_sub(app.state::<Session>().started.elapsed());
        let result = tokio::time::timeout(remaining, journey::run(&app)).await;
        match result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => report::error(&app.state::<Session>(), &error),
            Err(_) => report::error(&app.state::<Session>(), "height-native-deadline"),
        }
        // Cleanup is independently bounded and its observations remain pre-host-teardown facts.
        if crate::renderer_settings_view::snapshot(&app)["sessionCount"].as_u64() == Some(1) {
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                journey::close_current(&app),
            )
            .await;
            if !matches!(result, Ok(Ok(()))) {
                report::error(&app.state::<Session>(), "height-final-cleanup-incomplete");
            }
        }
        let code = report::finish(&app);
        app.exit(code);
    });
}
