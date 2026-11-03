#[path = "constructor_probe_native.rs"]
mod native;

use super::state::Harness;
use serde::Serialize;
use std::{future::Future, time::Duration};
use tauri::{AppHandle, Wry};

const ENV_NAME: &str = "ATOOLS_MAIN_PANEL_CONSTRUCTOR_PROBE";
const LOG_PREFIX: &str = "main-panel-prototype constructor-probe ";
const SCOPE_REJECTED: &str = "CONSTRUCTOR_PROBE_SCOPE_REJECTED";
const MAIN_HIDE_FAILED: &str = "CONSTRUCTOR_PROBE_MAIN_HIDE_FAILED";
const BEFORE_UNAVAILABLE: &str = "CONSTRUCTOR_PROBE_BEFORE_UNAVAILABLE";
const POLICY_NOT_REGULAR: &str = "CONSTRUCTOR_PROBE_POLICY_NOT_REGULAR";
const POLICY_UNAVAILABLE: &str = "CONSTRUCTOR_PROBE_REGULAR_POLICY_UNAVAILABLE";
const CREATE_FAILED: &str = "CONSTRUCTOR_PROBE_CREATE_FAILED";
const SHOW_FAILED: &str = "CONSTRUCTOR_PROBE_SHOW_FAILED";
const AFTER_UNAVAILABLE: &str = "CONSTRUCTOR_PROBE_AFTER_UNAVAILABLE";
const CLEANUP_FAILED: &str = "CONSTRUCTOR_PROBE_CLEANUP_FAILED";
const OPERATION_UNCONFIRMED: &str = "CONSTRUCTOR_PROBE_OPERATION_UNCONFIRMED";
const PRESENTATION_SETTLE: Duration = Duration::from_millis(500);
const CLEANUP_DRAIN_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ConstructorProbeReport {
    schema_version: u8,
    kind: &'static str,
    pid: u32,
    run_id: String,
    full_product_acceptance: bool,
    before: native::AppObservation,
    after: native::PanelObservation,
    cleanup: native::CleanupObservation,
    error_code: Option<&'static str>,
}

pub(super) async fn run_if_requested(app: &AppHandle<Wry>, harness: &Harness) {
    if std::env::var(ENV_NAME).ok().as_deref() != Some("1") {
        return;
    }

    let mut report = ConstructorProbeReport {
        schema_version: 1,
        kind: "main-panel-constructor-probe",
        pid: std::process::id(),
        run_id: harness.0.profile.run_id.clone(),
        full_product_acceptance: false,
        before: native::AppObservation::default(),
        after: native::PanelObservation::default(),
        cleanup: native::CleanupObservation::default(),
        error_code: None,
    };
    if !profile_is_owned(app, harness) {
        report.error_code = Some(SCOPE_REJECTED);
        report.cleanup.native_operations_terminal = harness.0.operations.is_terminal();
        emit(&report);
        return;
    }

    if hide_main(app, harness).await.is_err() {
        report.error_code = Some(MAIN_HIDE_FAILED);
    }
    if report.error_code.is_none() {
        match native::capture_before(app, harness).await {
            Ok(observation) => {
                report.error_code = regular_policy_error(observation.activation_policy_regular);
                report.before = observation;
            }
            Err(_) => report.error_code = Some(BEFORE_UNAVAILABLE),
        }
    }
    if report.error_code.is_none() {
        match native::create_panel(app, harness).await {
            Ok(()) => report.cleanup.panel_created = Some(true),
            Err(_) => {
                // A timed-out create may still finish on the main thread. Keep the
                // creation fact unknown until the tracked cleanup confirms ownership.
                report.cleanup.panel_created = None;
                report.error_code = Some(CREATE_FAILED);
            }
        }
    }

    if report.cleanup.panel_created == Some(true) {
        if native::show_panel(app, harness).await.is_err() && report.error_code.is_none() {
            report.error_code = Some(SHOW_FAILED);
        }
        tokio::time::sleep(PRESENTATION_SETTLE).await;
        match native::capture_panel(app, harness, &report.before).await {
            Ok(observation) => {
                report.error_code = report
                    .error_code
                    .or_else(|| regular_policy_error(observation.activation_policy_regular));
                report.after = observation;
            }
            Err(_) if report.error_code.is_none() => report.error_code = Some(AFTER_UNAVAILABLE),
            Err(_) => {}
        }
    }

    let first_cleanup = native::cleanup_panel(app, harness).await;
    let first_panel_created = first_cleanup.panel_created;
    if !first_cleanup.safe() && report.error_code.is_none() {
        report.error_code = Some(CLEANUP_FAILED);
    }
    let cleanup = cleanup_after_drain_retry(
        first_cleanup,
        harness.0.operations.wait_terminal(CLEANUP_DRAIN_TIMEOUT),
        native::cleanup_panel(app, harness),
    )
    .await;
    report.cleanup.panel_created = panel_created_fact(
        report.cleanup.panel_created,
        first_panel_created,
        cleanup.panel_created,
    );
    report.cleanup.order_out_confirmed = cleanup.order_out_confirmed;
    report.cleanup.close_requested = cleanup.close_requested;
    report.cleanup.owner_cleared = cleanup.owner_cleared;
    report.cleanup.native_operations_terminal = cleanup.native_operations_terminal;
    if !cleanup.safe() {
        harness.0.operations.mark_external_unconfirmed();
        if report.error_code.is_none() {
            report.error_code = Some(CLEANUP_FAILED);
        }
    }
    if !cleanup.native_operations_terminal {
        harness.0.operations.mark_external_unconfirmed();
        if report.error_code.is_none() {
            report.error_code = Some(OPERATION_UNCONFIRMED);
        }
    }
    emit(&report);
}

async fn cleanup_after_drain_retry<Drain, Retry>(
    first: native::CleanupObservation,
    drain: Drain,
    retry: Retry,
) -> native::CleanupObservation
where
    Drain: Future<Output = bool>,
    Retry: Future<Output = native::CleanupObservation>,
{
    if !retryable_cleanup(&first) || !drain.await {
        return first;
    }
    retry.await
}

fn retryable_cleanup(cleanup: &native::CleanupObservation) -> bool {
    !cleanup.safe() && cleanup.owner_cleared == Some(false) && cleanup.panel_created != Some(false)
}

fn panel_created_fact(
    initial: Option<bool>,
    first_cleanup: Option<bool>,
    final_cleanup: Option<bool>,
) -> Option<bool> {
    if initial == Some(true) || first_cleanup == Some(true) || final_cleanup == Some(true) {
        Some(true)
    } else if initial == Some(false) {
        Some(false)
    } else {
        None
    }
}

fn regular_policy_error(policy_is_regular: Option<bool>) -> Option<&'static str> {
    match policy_is_regular {
        Some(true) => None,
        Some(false) => Some(POLICY_NOT_REGULAR),
        None => Some(POLICY_UNAVAILABLE),
    }
}

fn profile_is_owned(app: &AppHandle<Wry>, harness: &Harness) -> bool {
    let profile = &harness.0.profile;
    let expected_identifier = format!("dev.atools.renderer-smoke.{}", profile.run_id);
    profile.main_panel_journey
        && profile.auto_clear == "never"
        && profile.identifier == expected_identifier
        && app.config().identifier == expected_identifier
        && crate::window::macos_main_panel::is_active(app)
        && super::super::fixture_owner::verify(profile).is_ok()
}

async fn hide_main(app: &AppHandle<Wry>, harness: &Harness) -> Result<(), &'static str> {
    let dispatch_app = app.clone();
    let action_app = dispatch_app.clone();
    harness
        .0
        .operations
        .run(&dispatch_app, move || {
            crate::window::hide_main_window(&action_app).map_err(|_| MAIN_HIDE_FAILED)
        })
        .await
        .map(|_| ())
}

fn emit(report: &ConstructorProbeReport) {
    let fallback = || {
        format!(
            "{{\"schemaVersion\":1,\"kind\":\"main-panel-constructor-probe\",\"pid\":{},\"runId\":\"{}\",\"fullProductAcceptance\":false,\"errorCode\":\"CONSTRUCTOR_PROBE_REPORT_SERIALIZATION_FAILED\"}}",
            report.pid, report.run_id
        )
    };
    let serialized = serde_json::to_string(report).unwrap_or_else(|_| fallback());
    if serialized.len() <= 4096 {
        eprintln!("{LOG_PREFIX}{serialized}");
    } else {
        eprintln!(
            "{LOG_PREFIX}{{\"schemaVersion\":1,\"kind\":\"main-panel-constructor-probe\",\"pid\":{},\"runId\":\"{}\",\"fullProductAcceptance\":false,\"errorCode\":\"CONSTRUCTOR_PROBE_REPORT_OVERSIZE\"}}",
            report.pid, report.run_id
        );
    }
}

#[cfg(test)]
#[path = "constructor_probe_tests.rs"]
mod tests;
