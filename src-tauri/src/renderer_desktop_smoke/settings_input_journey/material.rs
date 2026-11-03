use super::{material_report as report, native, state::Harness};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{time::Duration, time::Instant};
use tauri::{AppHandle, Manager, Webview, Wry};
use tokio::sync::oneshot;

const MAX_OBSERVE_AGE: Duration = Duration::from_secs(3);

pub(super) struct MaterialRun {
    pub(super) report: Mutex<Value>,
}

pub(super) async fn record_stage(
    app: &AppHandle<Wry>,
    harness: &Harness,
    started: Instant,
    key: &str,
) {
    let Some(run) = ensure_run(app, harness) else {
        return;
    };
    let observation = match crate::renderer_window_material::observe(app).await {
        Ok(value) => match report::sanitize_observation(&value) {
            Some(value) => Some(value),
            None => {
                report::add_error(
                    &mut run.report.lock(),
                    "settings-input-material-observation-invalid",
                );
                None
            }
        },
        Err(_) => {
            report::add_error(
                &mut run.report.lock(),
                "settings-input-material-observation-unavailable",
            );
            None
        }
    };
    let child_draws_background = if report::expected_child(key) {
        match native::active_child(app, MAX_OBSERVE_AGE).await {
            Ok((child, _session_id)) => {
                super::child_background::draws_background(&child).await.ok()
            }
            Err(_) => None,
        }
    } else {
        None
    };
    report::push_stage(
        &mut run.report.lock(),
        key,
        elapsed_ms(started),
        observation,
        child_draws_background,
    );
}

pub(super) async fn verify_general_theme(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
) {
    let Some(run) = ensure_run(app, harness) else {
        return;
    };
    super::theme::verify_general_theme(app, harness, child, &run).await;
    if harness.profile().paint_presentation
        == super::super::profile::PaintPresentation::VisibleUnfocused
    {
        super::presented_paint::run(app, harness, child, &run).await;
    }
}

pub(super) async fn finalize(app: &AppHandle<Wry>, harness: &Harness, started: Instant) {
    record_stage(app, harness, started, "finalCleanup").await;
    let Some(run) = ensure_run(app, harness) else {
        return;
    };
    let stop_acknowledged = stop_on_main_thread(app).await.is_ok();
    if !stop_acknowledged {
        report::add_error(
            &mut run.report.lock(),
            "settings-input-material-stop-failed",
        );
    }
    let actual = native_observation(app).await;
    let passed = stop_acknowledged
        && actual
            .as_ref()
            .is_some_and(report::released_observation_valid);
    if !passed {
        report::add_error(
            &mut run.report.lock(),
            "settings-input-material-cleanup-observation-invalid",
        );
    }
    report::set_cleanup(
        &mut run.report.lock(),
        json!({
            "stopAcknowledged": stop_acknowledged,
            "actual": actual,
            "passed": passed,
        }),
    );
    let report_value = {
        let mut value = run.report.lock();
        report::finalize(&mut value, elapsed_ms(started));
        value.clone()
    };
    if report::write_report(harness.profile(), &report_value).is_err() {
        report::add_error(
            &mut run.report.lock(),
            "settings-input-material-report-write-failed",
        );
    }
}

fn ensure_run<'a>(
    app: &'a AppHandle<Wry>,
    harness: &Harness,
) -> Option<tauri::State<'a, MaterialRun>> {
    if app.try_state::<MaterialRun>().is_none() {
        let _ = app.manage(MaterialRun {
            report: Mutex::new(report::empty(harness.profile())),
        });
    }
    app.try_state::<MaterialRun>()
}

async fn stop_on_main_thread(app: &AppHandle<Wry>) -> Result<(), &'static str> {
    let (sender, receiver) = oneshot::channel();
    let task_app = app.clone();
    app.run_on_main_thread(move || {
        let result = crate::renderer_window_material::stop(&task_app);
        let _ = sender.send(result);
    })
    .map_err(|_| "settings-input-material-stop-failed")?;
    match tokio::time::timeout(MAX_OBSERVE_AGE, receiver).await {
        Ok(Ok(Ok(()))) => Ok(()),
        _ => Err("settings-input-material-stop-failed"),
    }
}

pub(super) async fn native_observation(app: &AppHandle<Wry>) -> Option<Value> {
    crate::renderer_window_material::observe(app)
        .await
        .ok()
        .and_then(|value| report::sanitize_observation(&value))
}

pub(super) async fn database_theme(harness: &Harness) -> Option<String> {
    let db = harness.database();
    tauri::async_runtime::spawn_blocking(move || {
        let raw = db.get_setting("settings-general").ok().flatten()?;
        let value = serde_json::from_str::<Value>(&raw).ok()?;
        let theme = value.get("theme")?.as_str()?;
        matches!(theme, "system" | "light" | "dark").then(|| theme.to_owned())
    })
    .await
    .ok()
    .flatten()
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}
