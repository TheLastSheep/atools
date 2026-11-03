use super::{
    store::Runtime,
    types::{Mode, Request, RESULT_LEASE},
};
use atools_core::{
    task_run::{TaskRun, TaskRunStatus},
    Database,
};
use std::{sync::Arc, time::Instant};
use tauri::{AppHandle, Emitter, Manager};

pub(super) fn schedule_expiry(
    app: &AppHandle,
    runtime: &Arc<Runtime>,
    request: &Arc<Request>,
    delay: std::time::Duration,
) {
    let app = app.clone();
    let rt = runtime.clone();
    let req = request.clone();
    let id = req.id.clone();
    let timer = tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if !rt.contains(&req) {
            return;
        }
        if let Some(expired) = rt.remove(&id) {
            if expired.expires_result.lock().is_none() {
                if let Some(state) = app.try_state::<crate::state::AppState>() {
                    cancel_request(&app, &state.db, expired);
                } else {
                    deactivate(expired);
                }
            } else {
                deactivate(expired);
            }
        }
    });
    let mut store = runtime.store.lock();
    if store.requests.contains_key(&request.id) {
        if let Some(old) = store.timers.insert(request.id.clone(), timer) {
            old.abort();
        }
    } else {
        timer.abort();
    }
}

pub(super) async fn close(
    app: &AppHandle,
    plugin: Option<&str>,
    window: Option<&str>,
    document: Option<&str>,
    stop: bool,
) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let removed = runtime.close_matching(plugin, window, document, stop);
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        for request in removed {
            cancel_request(app, &state.db, request);
        }
    } else {
        for request in removed {
            deactivate(request);
        }
    }
}

pub(super) fn cancel_request(app: &AppHandle, db: &Database, request: Arc<Request>) {
    request.cancel.cancel();
    *request.active.lock() = false;
    if let Some((_, _, notify)) = request.ack.lock().take() {
        notify.notify_waiters();
    }
    if let Some(run_id) = request.run_id.lock().clone() {
        if let Ok(Some(mut run)) = db.get_task_run(&run_id) {
            if !run.status.is_terminal() {
                let was_running = run.status == TaskRunStatus::Running;
                run.summary = Some("Plugin AI request was cancelled".into());
                if run.transition(TaskRunStatus::Cancelled).is_ok() {
                    if was_running {
                        let _ = db.finish_running_task_run(&run);
                    } else {
                        let _ = db.update_pending_task_run(&run);
                    }
                    crate::permission_requests::remove_for_run(app, &run_id);
                    let _ = app.emit("task-run-updated", &run_id);
                }
            }
        }
    }
    deactivate(request);
}

pub(super) fn discard(request: Arc<Request>) {
    deactivate(request);
}

pub(super) fn finalize_task_run(app: &AppHandle, run: &TaskRun) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    if !runtime.tracks_run(&run.id) {
        return;
    }
    let request = runtime
        .store
        .lock()
        .requests
        .values()
        .find(|request| request.run_id.lock().as_deref() == Some(run.id.as_str()))
        .cloned();
    let Some(request) = request else {
        return;
    };
    {
        let mut terminal = request.task_terminal.lock();
        if *terminal {
            return;
        }
        *terminal = true;
    }
    if request.mode == Mode::Collect && run.status == TaskRunStatus::Succeeded {
        if let Some((_, _, notify)) = request.ack.lock().take() {
            notify.notify_waiters();
        }
        *request.channel.lock() = None;
        *request.expires_result.lock() = Some(Instant::now() + RESULT_LEASE);
        schedule_expiry(app, &runtime, &request, RESULT_LEASE);
    } else if let Some(removed) = runtime.remove(&request.id) {
        deactivate(removed);
    }
}

fn deactivate(request: Arc<Request>) {
    request.cancel.cancel();
    *request.active.lock() = false;
    request.request.lock().take();
    request.output.lock().take();
    *request.channel.lock() = None;
    if let Some((_, _, notify)) = request.ack.lock().take() {
        notify.notify_waiters();
    }
}
