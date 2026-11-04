use super::{types::Owner, Sessions};
use atools_core::{task_run::TaskRunStatus, Database};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub(super) fn cancel_pending(app: &AppHandle, db: &Database, id: &str) {
    if let Ok(Some(mut run)) = db.get_task_run(id) {
        if !run.status.is_terminal() {
            let running = run.status == TaskRunStatus::Running;
            run.summary = Some(
                "Plugin secret storage session closed; private operation was not replayed".into(),
            );
            if run.transition(TaskRunStatus::Cancelled).is_ok() {
                let _ = if running {
                    db.finish_running_task_run(&run)
                } else {
                    db.update_pending_task_run(&run)
                };
            }
        }
    }
    crate::permission_requests::remove_for_run(app, id);
    let _ = app.emit("task-run-updated", id);
}
pub(super) async fn close(
    app: &AppHandle,
    db: &Database,
    rt: &Arc<Sessions>,
    owner: Option<&Owner>,
    plugin: Option<&str>,
    window: Option<&str>,
    stop: bool,
) {
    for id in rt.close(owner, plugin, window, stop) {
        cancel_pending(app, db, &id);
    }
    rt.idle().await;
}
pub(super) async fn close_document(app: &AppHandle, id: &str) {
    if let (Ok(rt), Some(state)) = (
        super::manager(app),
        app.try_state::<crate::state::AppState>(),
    ) {
        for run in rt.close_document(id) {
            cancel_pending(app, &state.db, &run);
        }
        rt.idle().await;
    }
}
#[cfg_attr(not(test), allow(dead_code))]
pub(super) async fn close_window(app: &AppHandle, label: &str) {
    if let (Ok(rt), Some(state)) = (
        super::manager(app),
        app.try_state::<crate::state::AppState>(),
    ) {
        close(app, &state.db, &rt, None, None, Some(label), false).await;
    }
}
pub(super) async fn close_session(
    app: &AppHandle,
    db: &Database,
    rt: &Arc<Sessions>,
    id: &str,
    owner: &Owner,
) {
    if rt.get(id).is_ok_and(|s| &s.owner == owner) {
        close(app, db, rt, Some(owner), None, None, false).await;
    }
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
            let rt = self.runtime.clone();
            let owner = self.owner.clone();
            let app = self.app.clone();
            let db = self.db.clone();
            tauri::async_runtime::spawn(async move {
                close(&app, &db, &rt, Some(&owner), None, None, false).await;
            });
        }
    }
}
pub(super) struct InvocationLease {
    pub runtime: Arc<Sessions>,
    pub ticket: String,
    pub app: AppHandle,
    pub db: Arc<Database>,
    pub completed: bool,
}
impl Drop for InvocationLease {
    fn drop(&mut self) {
        let invocation = self.runtime.invocation(&self.ticket);
        self.runtime.finish_invocation(&self.ticket);
        if !self.completed {
            if let Some(i) = invocation {
                if let Some(run) = i.run.lock().clone() {
                    cancel_pending(&self.app, &self.db, &run);
                }
                if let Ok(session) = self.runtime.get(&i.session) {
                    let rt = self.runtime.clone();
                    let app = self.app.clone();
                    let db = self.db.clone();
                    tauri::async_runtime::spawn(async move {
                        close(&app, &db, &rt, Some(&session.owner), None, None, false).await;
                    });
                }
            }
        }
    }
}
