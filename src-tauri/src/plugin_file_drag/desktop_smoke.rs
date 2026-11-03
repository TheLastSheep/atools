//! Isolated, opt-in native file-drag acceptance fixture.
//!
//! This fixture exercises the OS drag implementation directly. It does not
//! initialize the normal app, load plugins, or create TaskRuns.

use super::native::{self, DragOutcome};
use evidence::{actual_window, safe_error, unix_time_ms, Attempt, FixtureState};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

mod evidence;
mod page;

const SCHEME: &str = "atools-native-file-drag-smoke";
const SOURCE_LABEL: &str = "source";
const TARGET_LABEL: &str = "target";
const PRODUCT_NAME: &str = "ATools Native File Drag Smoke";
const FIXED_UUID: &str = "123e4567-e89b-12d3-a456-426614174000";
const FIXED_CONTENT: &str = "123e4567-e89b-12d3-a456-426614174000\n";
const COMPLETION_TIMEOUT: Duration = Duration::from_secs(180);

#[tauri::command]
async fn prepare_native_file_drag_smoke(
    app: AppHandle,
    state: State<'_, Arc<FixtureState>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    let _guard = state.prepare_lock.lock().await;
    if state.prepared.load(Ordering::Acquire) {
        return Ok(());
    }
    if let Err(error) = native::prepare(&app).await {
        let _ = state.record(
            "native_monitor_prepare_failed",
            json!({"reason": safe_error(&error)}),
            |_| {},
        );
        return Err(error);
    }
    state.prepared.store(true, Ordering::Release);
    state.record("native_monitor_prepared", json!({}), |report| {
        report.native_monitor_installed = true;
    })
}

#[tauri::command]
async fn begin_native_file_drag_smoke(
    app: AppHandle,
    state: State<'_, Arc<FixtureState>>,
) -> Result<Value, String> {
    let state = state.inner().clone();
    if !state.prepared.load(Ordering::Acquire) {
        return Err("Wait until the native mouse monitor is ready".into());
    }
    if state
        .drag_active
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return Err("A native drag is already active".into());
    }
    if let Err(error) = state.record("start_requested", json!({}), |_| {}) {
        state.drag_active.store(false, Ordering::Release);
        return Err(error);
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    let started = match native::begin(
        &app,
        SOURCE_LABEL,
        vec![state.input_file.clone()],
        cancelled,
    )
    .await
    {
        Ok(started) => started,
        Err(error) => {
            state.drag_active.store(false, Ordering::Release);
            let reason = safe_error(&error);
            state.record("start_rejected", json!({"reason": reason}), |report| {
                report.start_rejection_count += 1;
                report.last_start_rejection = Some(reason);
            })?;
            return Err(error);
        }
    };

    let attempt_id = {
        let report = state.report.lock();
        report.attempts.len() as u64 + 1
    };
    state.current_attempt.store(attempt_id, Ordering::Release);
    state.record("start_ack", json!({"attemptId": attempt_id}), |report| {
        report.attempts.push(Attempt {
            id: attempt_id,
            start_ack: true,
            outcome: None,
            ended_at_unix_ms: None,
        });
    })?;

    let completion_state = state.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = match tokio::time::timeout(COMPLETION_TIMEOUT, started.completion).await {
            Ok(Ok(DragOutcome::Dropped)) => "Dropped",
            Ok(Ok(DragOutcome::Cancelled)) => "Cancelled",
            Ok(Err(_)) => "CompletionUnavailable",
            Err(_) => "TimedOut",
        };
        let ended_at_unix_ms = unix_time_ms();
        let _ = completion_state.record(
            "ended_outcome",
            json!({"attemptId": attempt_id, "outcome": outcome}),
            |report| {
                if let Some(attempt) = report
                    .attempts
                    .iter_mut()
                    .find(|item| item.id == attempt_id)
                {
                    attempt.outcome = Some(outcome.to_owned());
                    attempt.ended_at_unix_ms = Some(ended_at_unix_ms);
                }
            },
        );
        completion_state.drag_active.store(false, Ordering::Release);
    });

    Ok(json!({"attemptId": attempt_id, "startAck": true}))
}

#[tauri::command]
fn native_file_drag_smoke_status(state: State<'_, Arc<FixtureState>>) -> Value {
    state.status()
}

#[tauri::command]
async fn finish_native_file_drag_smoke(
    app: AppHandle,
    state: State<'_, Arc<FixtureState>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    if !state.report.lock().passed {
        return Err("Complete the drop, cancellation, and retry rounds first".into());
    }
    state.record("finish_requested", json!({}), |report| {
        report.finish_requested = true;
    })?;
    native::shutdown(&app).await?;
    app.exit(0);
    Ok(())
}

/// Runs the stand-alone fixture in a new temporary app/profile and leaves its
/// report and event log under `root` for the caller to inspect and clean up.
pub fn run(root: PathBuf) -> Result<(), String> {
    if !native::supported() {
        return Err("Native file-drag smoke requires macOS".into());
    }

    let app_identifier = format!(
        "dev.atools.native-file-drag-smoke.{}",
        uuid::Uuid::new_v4().simple()
    );
    let state = FixtureState::create(root, app_identifier.clone())?;
    let profile = state.root.join("profile");
    let target_state = state.clone();
    let setup_state = state.clone();

    let mut context = tauri::generate_context!();
    context.config_mut().identifier = app_identifier;
    context.config_mut().product_name = Some(PRODUCT_NAME.to_owned());
    context.config_mut().app.windows.clear();
    context.config_mut().app.tray_icon = None;
    context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy(
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; connect-src ipc: http://ipc.localhost".into(),
    ));

    let app = tauri::Builder::default()
        .manage(state.clone())
        .register_uri_scheme_protocol(SCHEME, move |_, request| {
            let (status, body) = if request.method().as_str() != "GET" {
                (tauri::http::StatusCode::METHOD_NOT_ALLOWED, Vec::new())
            } else {
                match request.uri().path() {
                    "/source" => (
                        tauri::http::StatusCode::OK,
                        page::SOURCE_PAGE.as_bytes().to_vec(),
                    ),
                    "/target" => (
                        tauri::http::StatusCode::OK,
                        page::TARGET_PAGE.as_bytes().to_vec(),
                    ),
                    _ => (tauri::http::StatusCode::NOT_FOUND, Vec::new()),
                }
            };
            let content_type = if status == tauri::http::StatusCode::OK {
                "text/html; charset=utf-8"
            } else {
                "text/plain; charset=utf-8"
            };
            tauri::http::Response::builder()
                .status(status)
                .header("content-type", content_type)
                .header("cache-control", "no-store")
                .body(body)
                .unwrap()
        })
        .invoke_handler(tauri::generate_handler![
            prepare_native_file_drag_smoke,
            begin_native_file_drag_smoke,
            native_file_drag_smoke_status,
            finish_native_file_drag_smoke,
        ])
        .on_window_event(move |window, event| {
            if window.label() != TARGET_LABEL {
                return;
            }
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) =
                event
            {
                if let Err(error) = target_state.record_target_drop(paths, position.x, position.y) {
                    tracing::warn!(%error, "Unable to record native file-drop smoke evidence");
                }
            }
        })
        .setup(move |app| {
            let source = WebviewWindowBuilder::new(
                app,
                SOURCE_LABEL,
                WebviewUrl::CustomProtocol(format!("{SCHEME}://localhost/source").parse().unwrap()),
            )
            .title("SOURCE — native file drag")
            .inner_size(450.0, 430.0)
            .position(40.0, 60.0)
            .incognito(true)
            .data_directory(profile.clone())
            .build()?;
            let target = WebviewWindowBuilder::new(
                app,
                TARGET_LABEL,
                WebviewUrl::CustomProtocol(format!("{SCHEME}://localhost/target").parse().unwrap()),
            )
            .title("TARGET — real OS drop")
            .inner_size(450.0, 430.0)
            .position(510.0, 60.0)
            .incognito(true)
            .data_directory(profile)
            .build()?;

            let source_geometry =
                actual_window(SOURCE_LABEL, "SOURCE — native file drag", 40.0, &source);
            let target_geometry =
                actual_window(TARGET_LABEL, "TARGET — real OS drop", 510.0, &target);
            setup_state
                .record_window_layout(source_geometry, target_geometry)
                .map_err(std::io::Error::other)?;
            Ok(())
        })
        .build(context)
        .map_err(|error| format!("Unable to build isolated native drag app: {error}"))?;

    app.run_return(|_, _| {});
    if state.report.lock().passed {
        Ok(())
    } else {
        Err(format!(
            "Native drag fixture exited before acceptance completed; inspect {}",
            state.report_path.display()
        ))
    }
}
