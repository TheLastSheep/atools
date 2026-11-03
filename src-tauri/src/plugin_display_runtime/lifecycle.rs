use super::Sessions;
use atools_core::{db::Database, task_run::TaskRunStatus};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

pub fn cancel_pending(app: &AppHandle, db: &Database, id: &str) {
    let Ok(Some(mut run)) = db.get_task_run(id) else {
        return;
    };
    if run.status.is_terminal() {
        return;
    }
    run.summary = Some("Plugin closed before display authorization completed".into());
    let running = run.status == TaskRunStatus::Running;
    if run.transition(TaskRunStatus::Cancelled).is_ok()
        && (if running {
            db.finish_running_task_run(&run)
        } else {
            db.update_pending_task_run(&run)
        })
        .unwrap_or(false)
    {
        crate::permission_requests::remove_for_run(app, id);
        let _ = app.emit("task-run-updated", id);
    }
}
pub async fn close(
    app: &AppHandle,
    db: &Database,
    runtime: &Arc<Sessions>,
    owner: Option<&str>,
    plugin: Option<&str>,
    stop: bool,
) {
    for id in runtime.close(owner, plugin, stop).await {
        cancel_pending(app, db, &id);
    }
}
pub struct InvocationLease {
    pub runtime: Arc<Sessions>,
    pub db: Arc<Database>,
    pub ticket: String,
    pub completed: bool,
}
impl Drop for InvocationLease {
    fn drop(&mut self) {
        let invocation = self.runtime.store.lock().invocations.remove(&self.ticket);
        if !self.completed {
            if let Some(invocation) = invocation {
                // Native I/O is synchronous and linearized with close. An aborted
                // future cannot replay it; close only prevents subsequent calls.
                let runtime = self.runtime.clone();
                let id = invocation.session.clone();
                tauri::async_runtime::spawn(async move {
                    runtime.remove(&id).await;
                });
                if let Some(id) = invocation.run.lock().clone() {
                    if let Ok(Some(mut run)) = self.db.get_task_run(&id) {
                        if run.status == TaskRunStatus::Running {
                            run.summary =
                                Some("Display transport closed during the operation".into());
                            let _ = run.transition(TaskRunStatus::Cancelled);
                            let _ = self.db.finish_running_task_run(&run);
                        }
                    }
                }
            }
        }
    }
}
