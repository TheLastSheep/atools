use atools_core::{db::Database, task_run::TaskRunStatus};
use std::collections::HashSet;
use tauri::{AppHandle, Emitter};

pub fn cancel_pending(app: &AppHandle, db: &Database, id: &str) {
    let Ok(Some(mut run)) = db.get_task_run(id) else {
        return;
    };
    if !matches!(
        run.status,
        TaskRunStatus::Created | TaskRunStatus::AwaitingPermission
    ) {
        return;
    }
    run.summary = Some("Plugin closed before Node authorization completed".into());
    if run.transition(TaskRunStatus::Cancelled).is_ok()
        && db.update_pending_task_run(&run).unwrap_or(false)
    {
        crate::permission_requests::remove_for_run(app, id);
        let _ = app.emit("task-run-updated", id);
    }
}

pub async fn close_owner(app: &AppHandle, db: &Database, owner: &str, plugin: Option<&str>) {
    let _ = close_owner_inner(app, db, owner, plugin, None).await;
}
pub async fn close_owner_strict(
    app: &AppHandle,
    db: &Database,
    owner: &str,
    plugin: Option<&str>,
) -> Result<(), String> {
    close_owner_inner(app, db, owner, plugin, None).await
}
pub async fn close_document_owner(
    app: &AppHandle,
    db: &Database,
    owner: &str,
    plugin: &str,
    page_id: &str,
) {
    let _ = close_owner_inner(app, db, owner, Some(plugin), Some(page_id)).await;
}
async fn close_owner_inner(
    app: &AppHandle,
    db: &Database,
    owner: &str,
    plugin: Option<&str>,
    page_id: Option<&str>,
) -> Result<(), String> {
    let runtime = super::manager(app);
    let ids: Vec<_> = runtime
        .sessions
        .read()
        .values()
        .filter(|s| {
            s.owner == owner
                && plugin.is_none_or(|id| id == s.plugin_id)
                && page_id.is_none_or(|id| s.document.as_ref().is_some_and(|d| d.id() == id))
        })
        .map(|s| s.id.clone())
        .collect();
    for id in ids {
        super::cancel_inflight(db, &runtime, &id);
    }
    let report = runtime.close_owner_report(owner, plugin, page_id).await;
    for id in report.runs {
        cancel_pending(app, db, &id);
    }
    report.result
}

/// Policy changes terminate active one-time authorizations as well as saved grants.
/// This also stops autonomous Node timers and children without requiring another RPC.
pub async fn invalidate(app: &AppHandle, db: &Database, plugin: Option<&str>) {
    crate::host_runtime::invalidate(app, db, plugin).await;
    let runtime = super::manager(app);
    let mut owners: HashSet<_> = runtime
        .sessions
        .read()
        .values()
        .filter(|s| plugin.is_none_or(|id| id == s.plugin_id))
        .map(|s| s.owner.clone())
        .collect();
    owners.extend(
        runtime
            .intents
            .lock()
            .values()
            .filter(|s| plugin.is_none_or(|id| id == s.plugin_id))
            .map(|s| s.owner.clone()),
    );
    owners.extend(
        runtime
            .openings
            .lock()
            .iter()
            .filter(|(_, (id, _, _))| plugin.is_none_or(|plugin| plugin == id))
            .map(|(owner, _)| owner.clone()),
    );
    for owner in owners {
        close_owner(app, db, &owner, plugin).await;
    }
}

/// A dropped HTTP handler (deadline or window close) must release its ephemeral
/// payload and stop work whose result can no longer be delivered.
pub struct InvocationLease {
    pub runtime: std::sync::Arc<super::Sessions>,
    pub db: std::sync::Arc<Database>,
    pub ticket: String,
    pub session_id: String,
    pub completed: bool,
}
impl Drop for InvocationLease {
    fn drop(&mut self) {
        if !self.completed {
            super::cancel_inflight(&self.db, &self.runtime, &self.session_id);
        }
        self.runtime.invocations.lock().remove(&self.ticket);
        if !self.completed {
            let runtime = self.runtime.clone();
            let id = self.session_id.clone();
            tauri::async_runtime::spawn(async move {
                runtime.remove(&id).await;
            });
        }
    }
}
