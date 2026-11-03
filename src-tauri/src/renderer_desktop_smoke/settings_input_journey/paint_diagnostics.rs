#[path = "paint_report.rs"]
mod paint_report;
#[path = "paint_schema.rs"]
mod paint_schema;

use super::{material::MaterialRun, probe, state::Harness};
use serde_json::{json, Value};
use tauri::{AppHandle, Webview, Wry};

pub(super) fn empty_paint_diagnostics() -> Value {
    paint_report::empty_diagnostics()
}

pub(super) fn validate_probe_evidence(value: &Value) -> Result<(), &'static str> {
    paint_schema::validate_evidence(value)
}

pub(super) async fn collect(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &Webview<Wry>,
    theme: &str,
    run: &MaterialRun,
) {
    let record = if matches!(theme, "light" | "dark") {
        let (policy, observations) = tokio::join!(
            super::child_background::inactive_scheduling_policy(child),
            probe::child_paint_diagnostic(app, harness, child, theme),
        );
        match (policy, observations) {
            (Ok(policy), Ok(observations)) => Some(json!({
                "nativeSchedulingPolicy": policy,
                "observations": observations,
            })),
            _ => None,
        }
    } else {
        None
    };
    paint_report::set_diagnostic(&mut run.report.lock(), theme, record);
}
