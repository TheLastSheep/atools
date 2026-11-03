use super::{
    presented_paint_report as report, presented_paint_window::WindowTrace, state::Harness,
};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Webview, Wry};

const IDENTITY_INVALID: &str = "settings-input-presented-paint-identity-invalid";
const SHOW_FAILED: &str = "settings-input-presented-paint-show-failed";
const FOCUS_CHANGED: &str = "settings-input-presented-paint-focus-changed";
const VISIBLE_INVALID: &str = "settings-input-presented-paint-visible-state-invalid";
const WATCHDOG_EXPIRED: &str = "settings-input-presented-paint-watchdog-expired";
const HIDE_FAILED: &str = "settings-input-presented-paint-hide-failed";
const CYCLE_PHASE_LIMIT: std::time::Duration = std::time::Duration::from_secs(7);
const RESTORE_PHASE_LIMIT: std::time::Duration = std::time::Duration::from_millis(10_500);

pub(super) async fn run(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    material_run: &super::material::MaterialRun,
) {
    let mut started = Instant::now();
    let trace = WindowTrace::new();
    let mut value = report::empty(harness.profile());
    if !legacy_dark_restoration_passed(material_run) {
        report::add_error(&mut value, "settings-input-presented-paint-restore-failed");
        ensure_three_steps(&mut value);
        finalize_and_write(harness, started, &mut value, &trace);
        return;
    }
    let session_id = child
        .label()
        .strip_prefix("ztools-settings-")
        .filter(|id| valid_session_id(id))
        .map(str::to_owned);
    let first_session = harness.first_session_id();
    let active_child = super::native::active_child(app, Duration::from_secs(2)).await;
    let active_matches = active_child.as_ref().is_ok_and(|(active, active_id)| {
        active.label() == child.label() && Some(active_id.as_str()) == session_id.as_deref()
    });
    if session_id.as_deref().is_none()
        || first_session.as_deref().is_none()
        || first_session.as_deref() == session_id.as_deref()
        || !active_matches
        || !harness.profile().settings_input_journey
        || harness.profile().paint_presentation
            != super::super::profile::PaintPresentation::VisibleUnfocused
    {
        report::add_error(&mut value, IDENTITY_INVALID);
        ensure_three_steps(&mut value);
        finalize_and_write(harness, started, &mut value, &trace);
        return;
    }

    started = Instant::now();
    let mut lease =
        match super::presented_paint_window::show(app, &harness.profile().run_id, trace.clone())
            .await
        {
            Ok(lease) => lease,
            Err(error) => {
                report::add_error(&mut value, map_window_error(error));
                ensure_three_steps(&mut value);
                finalize_and_write(harness, started, &mut value, &trace);
                return;
            }
        };
    let presented_at = tokio::time::Instant::now();
    let cycle_deadline = presented_at + CYCLE_PHASE_LIMIT;
    let restore_deadline = presented_at + RESTORE_PHASE_LIMIT;
    let initial = match lease.snapshot().await {
        Ok(facts) => facts,
        Err(error) => {
            report::add_error(&mut value, map_window_error(error));
            match lease.hide().await {
                Ok(cleanup) => report::set_cleanup(&mut value, cleanup),
                Err(_) => {
                    report::set_cleanup(&mut value, report::empty_cleanup());
                    report::add_error(&mut value, HIDE_FAILED);
                }
            }
            ensure_three_steps(&mut value);
            finalize_and_write(harness, started, &mut value, &trace);
            return;
        }
    };
    report::set_presentation(&mut value, initial.clone());
    if !presentation_unfocused(&initial) {
        report::add_error(&mut value, classify_presentation(&initial));
    } else {
        super::presented_paint_theme::run(
            app,
            harness,
            child,
            &lease,
            cycle_deadline,
            restore_deadline,
            &mut value,
        )
        .await;
    }
    if lease.watchdog_expired() {
        report::add_error(&mut value, WATCHDOG_EXPIRED);
    }
    match lease.hide().await {
        Ok(cleanup) => {
            if cleanup["hideConfirmed"].as_bool() != Some(true) {
                report::add_error(&mut value, HIDE_FAILED);
            }
            report::set_cleanup(&mut value, cleanup);
        }
        Err(error) => {
            report::add_error(&mut value, map_window_error(error));
            report::add_error(&mut value, HIDE_FAILED);
            report::set_cleanup(&mut value, report::empty_cleanup());
        }
    }
    finalize_and_write(harness, started, &mut value, &trace);
}

fn finalize_and_write(
    harness: &Harness,
    started: Instant,
    report_value: &mut Value,
    trace: &WindowTrace,
) {
    report::set_window_trace(report_value, trace.snapshot());
    report::finalize(
        report_value,
        started.elapsed().as_millis().min(u64::MAX as u128) as u64,
    );
    if report::write_report(harness.profile(), report_value).is_err() {
        eprintln!("settings-input-presented-paint-report-write-failed");
    }
}

fn map_window_error(error: &'static str) -> &'static str {
    match error {
        IDENTITY_INVALID => IDENTITY_INVALID,
        FOCUS_CHANGED => FOCUS_CHANGED,
        WATCHDOG_EXPIRED => WATCHDOG_EXPIRED,
        VISIBLE_INVALID => VISIBLE_INVALID,
        HIDE_FAILED => HIDE_FAILED,
        _ => SHOW_FAILED,
    }
}

fn ensure_three_steps(report_value: &mut Value) {
    for theme in ["light", "dark", "system"] {
        let exists = report_value["steps"].as_array().is_some_and(|steps| {
            steps
                .iter()
                .any(|step| step["theme"].as_str() == Some(theme))
        });
        if !exists {
            report::push_step(report_value, report::empty_step(theme));
        }
    }
}

fn valid_session_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn legacy_dark_restoration_passed(material_run: &super::material::MaterialRun) -> bool {
    let report = material_run.report.lock();
    report["theme"]["initial"]["databaseTheme"].as_str() == Some("dark")
        && report["theme"]["restoration"]["theme"].as_str() == Some("dark")
        && report["theme"]["restoration"]["passed"].as_bool() == Some(true)
}

fn presentation_unfocused(value: &Value) -> bool {
    value["visible"].as_bool() == Some(true)
        && value["windowFocused"].as_bool() == Some(false)
        && value["windowKey"].as_bool() == Some(false)
        && value["appActive"].as_bool() == Some(false)
        && value["frontmostIsSelf"].as_bool() == Some(false)
}

fn classify_presentation(value: &Value) -> &'static str {
    if value["windowFocused"].as_bool() == Some(true)
        || value["windowKey"].as_bool() == Some(true)
        || value["appActive"].as_bool() == Some(true)
        || value["frontmostIsSelf"].as_bool() == Some(true)
    {
        FOCUS_CHANGED
    } else {
        "settings-input-presented-paint-visible-state-invalid"
    }
}
