use super::{
    manager,
    types::{Owner, Request},
};
use atools_core::{db::Database, task_run::TaskRunStatus};
use tauri::{AppHandle, Emitter, Manager};

pub(super) async fn close(
    app: &AppHandle,
    plugin: Option<&str>,
    window: Option<&str>,
    instance: Option<&str>,
    document: Option<&str>,
    stop: bool,
) {
    let Ok(runtime) = manager(app) else {
        return;
    };
    let removed = {
        let mut store = runtime.store.lock();
        if stop {
            store.stopped = true;
        }
        if stop {
            store.selections.clear();
            abort_all(&mut store.selection_timers);
            abort_all(&mut store.request_timers);
        } else if plugin.is_none() && instance.is_none() && document.is_none() {
            if let Some(window) = window {
                let ids: Vec<_> = store
                    .selections
                    .iter()
                    .filter(|(_, s)| s.window == window)
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    store.selections.remove(&id);
                    abort_one(&mut store.selection_timers, &id);
                }
            }
        }
        let ids: Vec<_> = store
            .requests
            .iter()
            .filter(|(_, r)| matches(r, plugin, window, instance, document))
            .map(|(id, _)| id.clone())
            .collect();
        ids.into_iter()
            .filter_map(|id| {
                abort_one(&mut store.request_timers, &id);
                store.requests.remove(&id)
            })
            .collect::<Vec<_>>()
    };
    cancel_removed(app, removed);
}

fn matches(
    request: &Request,
    plugin: Option<&str>,
    window: Option<&str>,
    instance: Option<&str>,
    document: Option<&str>,
) -> bool {
    owner_matches(&request.owner, plugin, window, instance)
        && document_matches(request.document.as_ref().map(|b| b.id()), document)
}
fn owner_matches(
    owner: &Owner,
    plugin: Option<&str>,
    window: Option<&str>,
    instance: Option<&str>,
) -> bool {
    plugin.is_none_or(|p| owner.plugin == p)
        && window.is_none_or(|w| owner.window == w)
        && instance.is_none_or(|i| owner.instance == i)
}
fn document_matches(actual: Option<&str>, expected: Option<&str>) -> bool {
    expected.is_none_or(|id| actual == Some(id))
}
fn abort_one(timers: &mut std::collections::HashMap<String, super::TimerHandle>, id: &str) {
    if let Some(handle) = timers.remove(id) {
        handle.abort();
    }
}
fn abort_all(timers: &mut std::collections::HashMap<String, super::TimerHandle>) {
    for (_, handle) in timers.drain() {
        handle.abort();
    }
}
fn cancel_removed(app: &AppHandle, removed: Vec<std::sync::Arc<Request>>) {
    let Some(state) = app.try_state::<crate::state::AppState>() else {
        return;
    };
    for request in removed {
        if let Some(run) = request.run_id.lock().clone() {
            cancel_run(app, &state.db, &run);
        }
    }
}
pub(super) fn cancel_run(app: &AppHandle, db: &Database, id: &str) {
    let Ok(Some(mut run)) = db.get_task_run(id) else {
        crate::permission_requests::remove_for_run(app, id);
        return;
    };
    if !matches!(
        run.status,
        TaskRunStatus::Created | TaskRunStatus::AwaitingPermission | TaskRunStatus::Running
    ) {
        crate::permission_requests::remove_for_run(app, id);
        return;
    }
    let running = run.status == TaskRunStatus::Running;
    run.summary = Some("Native file-drop request closed before delivery".into());
    if run.transition(TaskRunStatus::Cancelled).is_ok() {
        let _ = if running {
            db.finish_running_task_run(&run)
        } else {
            db.update_pending_task_run(&run)
        };
    }
    crate::permission_requests::remove_for_run(app, id);
    let _ = app.emit("task-run-updated", id);
}
pub(super) fn expire_selection(app: &AppHandle, id: &str) {
    if let Ok(runtime) = manager(app) {
        let mut store = runtime.store.lock();
        if store
            .selections
            .get(id)
            .is_some_and(|s| s.created.elapsed() >= super::types::LEASE)
        {
            store.selections.remove(id);
            abort_one(&mut store.selection_timers, id);
        }
    }
}
pub(super) fn expire_request(app: &AppHandle, id: &str) {
    let Ok(runtime) = manager(app) else {
        return;
    };
    let request = {
        let mut store = runtime.store.lock();
        let request = if store.requests.get(id).is_some_and(|r| !r.valid()) {
            store.requests.remove(id)
        } else {
            None
        };
        abort_one(&mut store.request_timers, id);
        request
    };
    if let Some(request) = request {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            if let Some(run) = request.run_id.lock().clone() {
                cancel_run(app, &state.db, &run);
            }
        }
    }
}
fn remove_owned_requests(
    store: &mut super::store::Store,
    owner: &Owner,
) -> Vec<std::sync::Arc<Request>> {
    let ids: Vec<_> = store
        .requests
        .iter()
        .filter(|(_, request)| request.owner == *owner)
        .map(|(id, _)| id.clone())
        .collect();
    ids.into_iter()
        .filter_map(|id| {
            abort_one(&mut store.request_timers, &id);
            store.requests.remove(&id)
        })
        .collect()
}
pub(super) fn close_owner(app: &AppHandle, owner: &Owner) {
    let Ok(runtime) = manager(app) else {
        return;
    };
    let removed = {
        let mut store = runtime.store.lock();
        remove_owned_requests(&mut store, owner)
    };
    cancel_removed(app, removed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::agent::PermissionDecision;
    use parking_lot::Mutex;
    use std::{path::PathBuf, time::Instant};

    #[test]
    fn closing_one_instance_removes_only_its_request_not_a_sibling() {
        let owner = Owner::new("main", "plugin-a", "11111111-1111-4111-8111-111111111111").unwrap();
        let sibling =
            Owner::new("main", "plugin-a", "22222222-2222-4222-8222-222222222222").unwrap();
        let make = |id: &str, owner: Owner| {
            std::sync::Arc::new(Request {
                id: id.into(),
                selection_id: format!("sel-{id}"),
                owner,
                binding: super::super::types::Binding {
                    path: "plugin".into(),
                    version: "1".into(),
                    revision: None,
                },
                document: None,
                generation: 1,
                nonce: "nonce".into(),
                tool: "tool".into(),
                permission_at_prepare: PermissionDecision::Confirm,
                created: Instant::now(),
                selection: Mutex::new(Some(vec![PathBuf::from("/unused")])),
                run_id: Mutex::new(Some(format!("run-{id}"))),
                read_started: Mutex::new(false),
                payload: Mutex::new(None),
            })
        };
        let first = make("one", owner.clone());
        let second = make("two", sibling);
        let mut store = super::super::store::Store::default();
        store.requests.insert(first.id.clone(), first.clone());
        store.requests.insert(second.id.clone(), second.clone());
        let removed = remove_owned_requests(&mut store, &owner);
        assert_eq!(removed.len(), 1);
        assert!(std::sync::Arc::ptr_eq(&removed[0], &first));
        assert_eq!(removed[0].run_id.lock().as_deref(), Some("run-one"));
        assert!(!store.requests.contains_key("one"));
        assert!(std::sync::Arc::ptr_eq(
            store.requests.get("two").unwrap(),
            &second
        ));
        assert_eq!(
            store.requests.get("two").unwrap().run_id.lock().as_deref(),
            Some("run-two")
        );
        assert!(document_matches(Some("new-document"), Some("new-document")));
        assert!(!document_matches(
            Some("new-document"),
            Some("old-document")
        ));
    }
}
