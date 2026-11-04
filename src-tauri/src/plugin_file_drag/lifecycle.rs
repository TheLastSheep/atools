//! Revocation and cancellation that preserve the native OS drag completion edge.
use super::{types::Owner, Sessions};
use crate::plugin_page_runtime::DocumentBinding;
use atools_core::{task_run::TaskRunStatus, Database};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

pub(super) async fn close(
    app: &AppHandle,
    db: &Database,
    runtime: &Arc<Sessions>,
    owner: Option<&Owner>,
    plugin: Option<&str>,
    window: Option<&str>,
    document: Option<&str>,
    stop: bool,
) {
    for run in runtime.close(owner, plugin, window, document, stop) {
        cancel_pending(app, db, &run);
    }
    runtime.idle(app).await;
}

pub(super) fn close_now(app: &AppHandle, db: &Database, runtime: &Arc<Sessions>) {
    for run in runtime.close(None, None, None, None, true) {
        cancel_pending(app, db, &run);
    }
    let runtime = runtime.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move { runtime.idle(&app).await });
}

pub(super) fn cancel_pending(app: &AppHandle, db: &Database, id: &str) {
    if cancel_run(app, db, id, "File-drag authorization or session closed") {
        let _ = app.emit("task-run-updated", id);
    }
}

pub(super) fn cancel_run(app: &AppHandle, db: &Database, id: &str, reason: &str) -> bool {
    let Ok(Some(mut run)) = db.get_task_run(id) else {
        crate::permission_requests::remove_for_run(app, id);
        return false;
    };
    if run.status.is_terminal() {
        crate::permission_requests::remove_for_run(app, id);
        return false;
    }
    let was_running = run.status == TaskRunStatus::Running;
    run.summary = Some(reason.to_owned());
    let changed = run.transition(TaskRunStatus::Cancelled).is_ok()
        && if was_running {
            db.finish_running_task_run(&run).unwrap_or(false)
        } else {
            db.update_pending_task_run(&run).unwrap_or(false)
        };
    crate::permission_requests::remove_for_run(app, id);
    changed
}

pub(super) fn expire_intent(app: &AppHandle, runtime: &Arc<Sessions>, id: &str) {
    let expired = {
        let intent = runtime.get_intent(id).ok();
        intent.is_some_and(|intent| intent.created.elapsed() >= super::types::SESSION_TTL)
    };
    if !expired {
        return;
    }
    let Some(intent) = runtime.remove_intent(id) else {
        return;
    };
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        if let Some(run) = intent.run.lock().clone() {
            cancel_pending(app, &state.db, &run);
        }
    }
    let runtime = runtime.clone();
    let app = app.clone();
    tauri::async_runtime::spawn(async move { runtime.idle(&app).await });
}

pub(super) fn expire_session(app: &AppHandle, runtime: &Arc<Sessions>, id: &str) {
    let session = runtime.store.lock().sessions.get(id).cloned();
    let Some(session) = session else {
        return;
    };
    if !session.expired() {
        return;
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        let runtime = runtime.clone();
        let app = app.clone();
        let db = state.db.clone();
        let owner = session.owner.clone();
        tauri::async_runtime::spawn(async move {
            close(&app, &db, &runtime, Some(&owner), None, None, None, false).await;
        });
    }
}

pub(super) struct OpeningIntent {
    pub runtime: Arc<Sessions>,
    pub app: AppHandle,
    pub intent_id: String,
    pub committed: bool,
}

impl Drop for OpeningIntent {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        self.runtime.remove_intent(&self.intent_id);
        let runtime = self.runtime.clone();
        let app = self.app.clone();
        tauri::async_runtime::spawn(async move { runtime.idle(&app).await });
    }
}

impl Sessions {
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn existing_owners(&self, document_id: &str) -> Vec<Owner> {
        let state = self.store.lock();
        let mut owners = state
            .sessions
            .values()
            .filter(|session| {
                session
                    .document
                    .as_ref()
                    .is_some_and(|document| document.id() == document_id)
            })
            .map(|session| session.owner.clone())
            .chain(state.intents.values().filter_map(|intent| {
                intent
                    .document
                    .as_ref()
                    .is_some_and(|document| document.id() == document_id)
                    .then(|| intent.owner.clone())
            }))
            .collect::<Vec<_>>();
        owners.sort_by(|left, right| left.key().cmp(&right.key()));
        owners.dedup();
        owners
    }

    pub fn close(
        &self,
        owner: Option<&Owner>,
        plugin: Option<&str>,
        window: Option<&str>,
        document: Option<&str>,
        stop: bool,
    ) -> Vec<String> {
        let mut state = self.store.lock();
        state.stopped |= stop;
        let owner_matches = |candidate: &Owner| {
            owner.is_none_or(|wanted| candidate == wanted)
                && plugin.is_none_or(|wanted| candidate.plugin == wanted)
                && window.is_none_or(|wanted| candidate.window == wanted)
        };
        let document_matches = |binding: &Option<DocumentBinding>| {
            document.is_none_or(|wanted| {
                binding
                    .as_ref()
                    .is_some_and(|candidate| candidate.id() == wanted)
            })
        };
        let mut runs = Vec::new();

        let intent_ids = state
            .intents
            .iter()
            .filter(|(_, intent)| {
                owner_matches(&intent.owner) && document_matches(&intent.document)
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in intent_ids {
            if let Some(timer) = state.intent_timers.remove(&id) {
                timer.abort();
            }
            if let Some(intent) = state.intents.remove(&id) {
                intent
                    .cancelled
                    .store(true, std::sync::atomic::Ordering::Release);
                if let Some(run) = intent.run.lock().clone() {
                    runs.push(run);
                }
            }
        }

        state.preparations.retain(|_, preparation| {
            !(owner_matches(&preparation.owner)
                && document.is_none_or(|wanted| preparation.document_id.as_deref() == Some(wanted)))
        });

        let closing_session_ids = state
            .sessions
            .iter()
            .filter(|(_, session)| {
                owner_matches(&session.owner) && document_matches(&session.document)
            })
            .map(|(id, _)| id.clone())
            .collect::<std::collections::HashSet<_>>();
        for id in &closing_session_ids {
            if let Some(timer) = state.session_timers.remove(id) {
                timer.abort();
            }
            if let Some(session) = state.sessions.remove(id) {
                session
                    .active
                    .store(false, std::sync::atomic::Ordering::Release);
            }
        }

        let invocation_ids = state
            .invocations
            .iter()
            .filter(|(_, invocation)| {
                closing_session_ids.contains(&invocation.session)
                    || (owner_matches(&invocation.owner) && document_matches(&invocation.document))
            })
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        for id in invocation_ids {
            if let Some(invocation) = state.invocations.remove(&id) {
                let cancelled_before_start = invocation.cancel_before_start();
                invocation.paths.lock().take();
                if cancelled_before_start {
                    if let Some(run) = invocation.run.lock().clone() {
                        runs.push(run);
                    }
                }
                invocation.acknowledge(Err("File-drag session closed before native start".into()));
            }
        }
        runs.sort();
        runs.dedup();
        runs
    }

    pub async fn idle(&self, app: &AppHandle) {
        let _control = self.control.lock().await;
        let idle = {
            let state = self.store.lock();
            state.sessions.is_empty() && state.intents.is_empty() && state.preparations.is_empty()
        };
        if !idle {
            return;
        }
        self.server.lock().await.take();
        let _ = super::native::shutdown(app).await;
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn counts(&self) -> (usize, usize, usize, usize) {
        let state = self.store.lock();
        (
            state.sessions.len(),
            state.intents.len(),
            state.invocations.len(),
            state.preparations.len(),
        )
    }
}
