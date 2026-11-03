use super::{material_report, probe, snapshot, state::Harness};
use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, Webview, Wry};
use tokio::time::Instant;

const READINESS_TIMEOUT: &str = "settings-input-presented-paint-readiness-timeout";
const SNAPSHOT_FAILED: &str = "settings-input-presented-paint-snapshot-failed";
const WATCHDOG_EXPIRED: &str = "settings-input-presented-paint-watchdog-expired";
const POLL_INTERVAL: Duration = Duration::from_millis(40);
const READINESS_LIMIT: Duration = Duration::from_secs(2);
const MIN_READINESS_PROBE_BUDGET: Duration = Duration::from_millis(1_100);

pub(super) async fn capture(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
    deadline: Instant,
    theme: &str,
    step: &mut Value,
    report: &mut Value,
) {
    let readiness_deadline = (Instant::now() + READINESS_LIMIT).min(deadline);
    let readiness =
        wait_for_readiness(app, harness, child, lease, readiness_deadline, theme, step).await;
    let readiness = match readiness {
        Ok(readiness) => readiness,
        Err(error) => {
            step["snapshot"] = super::presented_paint_report::unverified_snapshot(error);
            super::presented_paint_report::add_error(report, error);
            return;
        }
    };
    step["readiness"] = readiness;

    match capture_snapshot(harness, child, lease, deadline, theme).await {
        Ok(snapshot) => step["snapshot"] = snapshot,
        Err(error) => {
            step["snapshot"] = super::presented_paint_report::unverified_snapshot(error);
            super::presented_paint_report::add_error(report, error);
        }
    }
}

async fn wait_for_readiness(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
    deadline: Instant,
    theme: &str,
    step: &mut Value,
) -> Result<Value, &'static str> {
    loop {
        if lease.watchdog_expired() {
            return Err(WATCHDOG_EXPIRED);
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining < MIN_READINESS_PROBE_BUDGET {
            return Err(READINESS_TIMEOUT);
        }
        let result = tokio::time::timeout(
            remaining,
            probe::child_snapshot_ready(app, harness, child, theme),
        )
        .await;
        let Ok(Ok(value)) = result else {
            return Err(READINESS_TIMEOUT);
        };
        if material_report::valid_snapshot_readiness(&value) {
            step["readiness"] = value.clone();
            if material_report::snapshot_readiness_settled(&value) {
                return match lease.snapshot().await {
                    Ok(facts) if presentation_valid(&facts) => Ok(value),
                    Ok(facts) => Err(classify_presentation(&facts)),
                    Err(error) => Err(map_window_error(error)),
                };
            }
        }
        match lease.snapshot().await {
            Ok(facts) if presentation_valid(&facts) => {}
            Ok(facts) => return Err(classify_presentation(&facts)),
            Err(error) => return Err(map_window_error(error)),
        }
        tokio::time::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(Instant::now())))
            .await;
    }
}

async fn capture_snapshot(
    harness: &Harness,
    child: &Webview<Wry>,
    lease: &super::presented_paint_window::PresentedWindowLease,
    deadline: Instant,
    theme: &str,
) -> Result<Value, &'static str> {
    if lease.watchdog_expired() {
        return Err(WATCHDOG_EXPIRED);
    }
    match lease.snapshot().await {
        Ok(facts) if presentation_valid(&facts) => {}
        Ok(facts) => return Err(classify_presentation(&facts)),
        Err(error) => return Err(map_window_error(error)),
    }
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err(SNAPSHOT_FAILED);
    }
    let captured = tokio::time::timeout(remaining, snapshot::capture(child))
        .await
        .map_err(|_| SNAPSHOT_FAILED)?
        .map_err(|_| SNAPSHOT_FAILED)?;
    match lease.snapshot().await {
        Ok(facts) if presentation_valid(&facts) => {}
        Ok(facts) => return Err(classify_presentation(&facts)),
        Err(error) => return Err(map_window_error(error)),
    }

    let digest = captured.evidence["sha256"]
        .as_str()
        .ok_or(SNAPSHOT_FAILED)?;
    if !material_report::valid_snapshot_evidence(&captured.evidence, captured.png.len(), digest)
        || !captured.png.starts_with(b"\x89PNG\r\n\x1a\n")
    {
        return Err(SNAPSHOT_FAILED);
    }
    let filename = match theme {
        "light" => "native-presented-general-light.png",
        "dark" => "native-presented-general-dark.png",
        _ => return Err(SNAPSHOT_FAILED),
    };
    super::presented_paint_report::write_snapshot(harness.profile(), filename, &captured.png)
        .map_err(|error| map_window_error(error))?;
    Ok(super::presented_paint_report::captured_snapshot(
        filename,
        captured.evidence,
    ))
}

fn presentation_valid(value: &Value) -> bool {
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
        "settings-input-presented-paint-focus-changed"
    } else {
        "settings-input-presented-paint-visible-state-invalid"
    }
}

fn map_window_error(error: &'static str) -> &'static str {
    match error {
        "settings-input-presented-paint-watchdog-expired" => WATCHDOG_EXPIRED,
        "settings-input-presented-paint-focus-changed" => {
            "settings-input-presented-paint-focus-changed"
        }
        "settings-input-presented-paint-identity-invalid" => {
            "settings-input-presented-paint-identity-invalid"
        }
        "settings-input-presented-paint-visible-state-invalid" => {
            "settings-input-presented-paint-visible-state-invalid"
        }
        "settings-input-presented-paint-hide-failed" => {
            "settings-input-presented-paint-hide-failed"
        }
        _ => SNAPSHOT_FAILED,
    }
}
