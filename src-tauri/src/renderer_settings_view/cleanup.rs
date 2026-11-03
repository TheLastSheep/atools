use std::time::Duration;

use tauri::{AppHandle, Manager, Wry};
use tokio::time::Instant;

use super::{
    lifecycle::{self, emit_phase},
    phase::SessionPhase,
};

const OUT_ACK_TIMEOUT: Duration = Duration::from_secs(1);
const CHILD_ABSENCE_TIMEOUT: Duration = Duration::from_secs(1);
const CHILD_ABSENCE_POLL: Duration = Duration::from_millis(10);

pub(crate) async fn close_session(
    app: &AppHandle<Wry>,
    session_id: &str,
    reason: &str,
) -> Result<(), String> {
    if !valid_reason(reason) {
        return Err("Settings view close reason is invalid".into());
    }
    let runtime = super::runtime(app)?;
    let Some(candidate) = runtime
        .current()?
        .filter(|session| session.id == session_id)
    else {
        // A repeated close for the same, already-removed generation is safe.
        return Ok(());
    };
    let _close_guard = candidate.close_gate.lock().await;
    let Some(current) = runtime
        .current()?
        .filter(|session| session.id == session_id)
    else {
        return Ok(());
    };
    crate::app_global_shortcuts::recording::cancel(app, Some(&current.id));
    let recording_cleanup =
        crate::hotkey::recording_runtime::cancel_session(app, Some(&current.id));
    let session = runtime.mark_closing(&current.id, reason)?;

    let key = super::open_claims::SessionKey {
        id: session.id.clone(),
        revoked_identity: std::sync::Arc::as_ptr(&session.revoked) as usize,
    };
    if let Some(mut signal) = runtime.open_activity_signal(&key) {
        while runtime.open_busy(&key) {
            signal
                .changed()
                .await
                .map_err(|_| "Settings open quiescence could not be confirmed")?;
        }
    } else if runtime.open_busy(&key) {
        return Err("Settings open quiescence signal is unavailable".into());
    }

    let mut failures = Vec::new();
    if recording_cleanup.is_err() {
        failures.push("Hotkey recording release was not confirmed before close");
    }
    let mut acknowledgement_ok = true;
    let mut close_call_failed = false;
    if let Some(child) = app.get_webview(&session.label) {
        if child.hide().is_err() {
            failures.push("Settings view child could not be hidden before close");
        }
        let mut signals = session.subscribe();
        if !signals.borrow().out_acknowledged {
            let eval_ok = child
                .eval("if (typeof window.__ATOOLS_SETTINGS_DELIVER_OUT__ === 'function') { window.__ATOOLS_SETTINGS_DELIVER_OUT__(); }")
                .is_ok();
            acknowledgement_ok = eval_ok && wait_for_out_ack(&mut signals).await;
        }
        if !acknowledgement_ok {
            failures.push("Settings view out callback did not acknowledge within one second");
        }
        close_call_failed = child.close().is_err();
    }

    if !wait_for_child_absence(app, &session.label).await {
        failures.push("Settings view child remained registered after close");
        return Err(failures.join("; "));
    }
    // A commit whose Core Immediate guard already passed is detached from the child lifetime.
    // Wait asynchronously so its result and targeted invalidation are accounted before teardown.
    let accounting = runtime.accounting();
    accounting.wait_for_writes_to_finish().await;
    if close_call_failed {
        failures.push("Settings view child close request returned an error");
    }

    // Keep a revoked Closing tombstone and its layout lease until native
    // lookup confirms absence and the main renderer receives the final phases.
    super::session_material::release_for_close(&runtime, &session.id).await?;
    let key = super::open_claims::SessionKey {
        id: session.id.clone(),
        revoked_identity: std::sync::Arc::as_ptr(&session.revoked) as usize,
    };
    let captured = runtime.open_main(&key);
    runtime.emit_close_phases(&session.id, reason != "main-hide", |current, phase| {
        if let Some(main) = captured.as_ref() {
            if main.validate(app).is_err() {
                return Ok(());
            }
            use tauri::Emitter;
            let payload = super::event_payload::build_event_payload(&current.id, phase, None)?;
            main.webview
                .emit(super::SETTINGS_EVENT, payload)
                .map_err(|_| "Main renderer did not accept settings lifecycle".to_owned())
        } else {
            emit_phase(app, current, phase, None)
        }
    })?;
    if runtime
        .take_if_with(session_id, |current_id| {
            crate::renderer_close_shortcut::settings_close_completed(
                app,
                session_id,
                current_id,
                reason,
                failures.is_empty(),
            );
        })
        .is_none()
    {
        return Err("Settings view session changed during final cleanup".into());
    }

    runtime.retire_open(&super::open_claims::SessionKey {
        id: session.id.clone(),
        revoked_identity: std::sync::Arc::as_ptr(&session.revoked) as usize,
    });

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

async fn wait_for_out_ack(
    signals: &mut tokio::sync::watch::Receiver<super::phase::SessionSignal>,
) -> bool {
    let deadline = Instant::now() + OUT_ACK_TIMEOUT;
    loop {
        let current = signals.borrow().clone();
        if current.out_acknowledged {
            return true;
        }
        if current.phase != SessionPhase::Closing {
            return false;
        }
        match tokio::time::timeout_at(deadline, signals.changed()).await {
            Err(_) | Ok(Err(_)) => return false,
            Ok(Ok(())) => {}
        }
    }
}

async fn wait_for_child_absence(app: &AppHandle<Wry>, label: &str) -> bool {
    let deadline = Instant::now() + CHILD_ABSENCE_TIMEOUT;
    loop {
        if app.get_webview(label).is_none() {
            return true;
        }
        if tokio::time::timeout_at(deadline, tokio::time::sleep(CHILD_ABSENCE_POLL))
            .await
            .is_err()
        {
            return false;
        }
    }
}

pub(crate) fn on_window_destroyed(app: &AppHandle<Wry>, label: &str) {
    let Ok(runtime) = super::runtime(app) else {
        return;
    };
    if label == "main" {
        let Some(session) = revoke_current_session(app, &runtime, "failed") else {
            return;
        };
        close_child_synchronously(app, &runtime, &session);
        return;
    }

    let Ok(current) = runtime.current_for_label(label) else {
        return;
    };
    let reason = current
        .closing_reason
        .as_deref()
        .unwrap_or("child-out")
        .to_owned();
    crate::app_global_shortcuts::recording::cancel(app, Some(&current.id));
    let _ = crate::hotkey::recording_runtime::cancel_session(app, Some(&current.id));
    let Ok(session) = runtime.mark_closing(&current.id, &reason) else {
        return;
    };
    if app.get_webview("main").is_none() {
        close_child_synchronously(app, &runtime, &session);
        return;
    }
    let app = app.clone();
    let session_id = session.id;
    tauri::async_runtime::spawn(async move {
        let _ = close_session(&app, &session_id, &reason).await;
    });
}

pub(crate) fn stop(app: &AppHandle<Wry>) {
    let Ok(runtime) = super::runtime(app) else {
        return;
    };
    let Some(session) = revoke_current_session(app, &runtime, "failed") else {
        return;
    };
    close_child_synchronously(app, &runtime, &session);
}

fn revoke_current_session(
    app: &AppHandle<Wry>,
    runtime: &super::session::SettingsViewRuntime,
    fallback_reason: &str,
) -> Option<super::session::SessionView> {
    let current = runtime.current().ok().flatten()?;
    let reason = current
        .closing_reason
        .as_deref()
        .unwrap_or(fallback_reason)
        .to_owned();
    crate::app_global_shortcuts::recording::cancel(app, Some(&current.id));
    let _ = crate::hotkey::recording_runtime::cancel_session(app, Some(&current.id));
    runtime.mark_closing(&current.id, &reason).ok()
}

fn close_child_synchronously(
    app: &AppHandle<Wry>,
    runtime: &super::session::SettingsViewRuntime,
    session: &super::session::SessionView,
) {
    if let Some(child) = app.get_webview(&session.label) {
        let _ = child.hide();
        let _ = child.close();
    }
    if app.get_webview(&session.label).is_none() {
        let key = super::open_claims::SessionKey {
            id: session.id.clone(),
            revoked_identity: std::sync::Arc::as_ptr(&session.revoked) as usize,
        };
        if runtime.take_for_shutdown(&session.id).is_some() {
            runtime.retire_open(&key);
        } else if !runtime.open_busy(&key) {
            // Keep the Closing tombstone and let the asynchronous owner confirm
            // material release before removing it. Failure leaves it observable.
            let app = app.clone();
            let id = session.id.clone();
            let reason = session
                .closing_reason
                .clone()
                .unwrap_or_else(|| "failed".into());
            tauri::async_runtime::spawn(async move {
                if let Err(error) = close_session(&app, &id, &reason).await {
                    tracing::warn!(%error, "Settings shutdown cleanup remains pending");
                }
            });
        }
    }
}

pub(crate) fn valid_reason(reason: &str) -> bool {
    matches!(reason, "main-hide" | "child-out" | "escape" | "failed")
}
