//! Cancellation never copies private request/result details into TaskRun.
use super::{types::Owner, Sessions};
use atools_core::{task_run::TaskRunStatus, Database};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub(super) fn cancel_pending(app: &AppHandle, db: &Database, id: &str) {
    if cancel_with(db, id, || {
        crate::permission_requests::remove_for_run(app, id);
    }) {
        let _ = app.emit("task-run-updated", id);
    }
}
pub(super) fn cancel_with(db: &Database, id: &str, remove_request: impl FnOnce()) -> bool {
    let changed = cancel_run(db, id);
    // A previously terminal/missing run can still have a stale permission row.
    remove_request();
    changed
}
fn cancel_run(db: &Database, id: &str) -> bool {
    let Ok(Some(mut run)) = db.get_task_run(id) else {
        return false;
    };
    if run.status.is_terminal() {
        return false;
    }
    let was_running = run.status == TaskRunStatus::Running;
    run.summary = Some("Plugin data session closed; no operation is replayed and any completed database effect remains".into());
    run.transition(TaskRunStatus::Cancelled).is_ok()
        && if was_running {
            db.finish_running_task_run(&run).unwrap_or(false)
        } else {
            db.update_pending_task_run(&run).unwrap_or(false)
        }
}
pub(super) async fn close(
    app: &AppHandle,
    db: &Database,
    runtime: &Arc<Sessions>,
    owner: Option<&Owner>,
    plugin: Option<&str>,
    window: Option<&str>,
    stop: bool,
) {
    for run in runtime.close(owner, plugin, window, stop) {
        cancel_pending(app, db, &run);
    }
    super::prune_web_storage_events(app, runtime);
    runtime.idle().await;
}
pub(super) struct InvocationLease {
    pub runtime: Arc<Sessions>,
    pub ticket: String,
    pub app: AppHandle,
    pub db: Arc<Database>,
    pub completed: bool,
}
pub(super) struct OpeningLease {
    pub runtime: Arc<Sessions>,
    pub owner: Owner,
    pub app: AppHandle,
    pub db: Arc<Database>,
    pub committed: bool,
}
impl Drop for OpeningLease {
    fn drop(&mut self) {
        if !self.committed {
            let runtime = self.runtime.clone();
            let owner = self.owner.clone();
            let app = self.app.clone();
            let db = self.db.clone();
            tauri::async_runtime::spawn(async move {
                close(&app, &db, &runtime, Some(&owner), None, None, false).await;
            });
        }
    }
}
impl Drop for InvocationLease {
    fn drop(&mut self) {
        let invocation = self.runtime.store.lock().invocations.remove(&self.ticket);
        if !self.completed {
            if let Some(invocation) = invocation {
                if let Some(run) = invocation.run.lock().clone() {
                    cancel_pending(&self.app, &self.db, &run);
                }
                if let Ok(session) = self.runtime.get(&invocation.session) {
                    let runtime = self.runtime.clone();
                    let app = self.app.clone();
                    let db = self.db.clone();
                    tauri::async_runtime::spawn(async move {
                        close(&app, &db, &runtime, Some(&session.owner), None, None, false).await;
                    });
                }
            }
        }
    }
}
