//! The pending map is authoritative across every launcher/plugin window.
//! Notifications carry no request contents and are emitted after releasing its lock.
use atools_core::agent::PendingAgentToolRequest;
use parking_lot::Mutex;
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter, Manager};

type PendingMap = BTreeMap<String, PendingAgentToolRequest>;
const CHANGED_EVENT: &str = "permission-requests-changed";

fn mutate<T>(
    requests: &Mutex<PendingMap>,
    update: impl FnOnce(&mut PendingMap) -> (T, bool),
    notify: impl FnOnce(),
) -> T {
    let (result, changed) = update(&mut requests.lock());
    if changed {
        notify();
    }
    result
}

fn notify(app: &AppHandle) {
    let _ = app.emit(CHANGED_EVENT, ());
}

pub(crate) fn upsert_if_awaiting(
    app: &AppHandle,
    request: PendingAgentToolRequest,
) -> Result<bool, String> {
    let state = app.state::<crate::state::AppState>();
    upsert_for_run(
        &state.pending_agent_requests,
        request,
        |request| matches_awaiting(&state.db, request),
        || notify(app),
    )
}

fn matches_awaiting(
    db: &atools_core::Database,
    request: &PendingAgentToolRequest,
) -> Result<bool, String> {
    let Some(id) = request.run_id.as_deref() else {
        return Ok(false);
    };
    let Some(run) = db
        .get_task_run(id)
        .map_err(|_| "Unable to verify pending permission task")?
    else {
        return Ok(false);
    };
    Ok(
        run.status == atools_core::task_run::TaskRunStatus::AwaitingPermission
            && run.capability_id == request.tool_name
            && run.initiator.client_id.as_deref() == Some(request.client_id.as_str())
            && run.input == request.arguments
            && run.output["permission_required"] == true
            && run.output["request_id"] == request.id
            && run.output["client_id"] == request.client_id
            && run.output["tool"] == request.tool_name
            && run.output["arguments"] == request.arguments
            && run.output["scopes"]
                == serde_json::to_value(&request.scopes).map_err(|_| "Invalid permission scope")?,
    )
}

fn upsert_for_run(
    requests: &Mutex<PendingMap>,
    request: PendingAgentToolRequest,
    eligible: impl FnOnce(&PendingAgentToolRequest) -> Result<bool, String>,
    notify: impl FnOnce(),
) -> Result<bool, String> {
    // Close performs its DB CAS before taking this map lock. Checking the DB
    // under the same lock as insertion prevents a cancelled run being republished.
    let mut pending = requests.lock();
    if !eligible(&request)? {
        return Ok(false);
    }
    if let Some(run_id) = request.run_id.as_deref() {
        pending.retain(|_, current| current.run_id.as_deref() != Some(run_id));
    }
    pending.insert(request.id.clone(), request);
    drop(pending);
    notify();
    Ok(true)
}

pub(crate) fn remove(app: &AppHandle, id: &str) -> Option<PendingAgentToolRequest> {
    let state = app.state::<crate::state::AppState>();
    remove_from(&state.pending_agent_requests, id, || notify(app))
}

fn remove_from(
    requests: &Mutex<PendingMap>,
    id: &str,
    notify: impl FnOnce(),
) -> Option<PendingAgentToolRequest> {
    mutate(
        requests,
        |requests| {
            let request = requests.remove(id);
            let changed = request.is_some();
            (request, changed)
        },
        notify,
    )
}

pub(crate) fn remove_for_run(app: &AppHandle, run_id: &str) -> usize {
    let state = app.state::<crate::state::AppState>();
    remove_run_from(&state.pending_agent_requests, run_id, || notify(app))
}

fn remove_run_from(requests: &Mutex<PendingMap>, run_id: &str, notify: impl FnOnce()) -> usize {
    mutate(
        requests,
        |requests| {
            let before = requests.len();
            requests.retain(|_, request| request.run_id.as_deref() != Some(run_id));
            let removed = before - requests.len();
            (removed, removed > 0)
        },
        notify,
    )
}

pub(crate) fn find_for_run(app: &AppHandle, run_id: &str) -> Option<PendingAgentToolRequest> {
    let state = app.try_state::<crate::state::AppState>()?;
    let requests = state.pending_agent_requests.lock();
    let mut matches = requests
        .values()
        .filter(|request| request.run_id.as_deref() == Some(run_id));
    let found = matches.next()?.clone();
    if matches.next().is_some() {
        return None;
    }
    Some(found)
}

/// Run approval validation and its synchronous DB commit while the request is
/// still the authoritative entry. The callback must not await or re-enter this
/// map; this closes the check-then-dismiss window for saved grants.
pub(crate) fn with_request<T>(
    app: &AppHandle,
    id: &str,
    action: impl FnOnce(&PendingAgentToolRequest) -> Result<T, String>,
) -> Result<T, String> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or("Permission queue is unavailable")?;
    with_request_from(&state.pending_agent_requests, id, action)
}

fn with_request_from<T>(
    requests: &Mutex<PendingMap>,
    id: &str,
    action: impl FnOnce(&PendingAgentToolRequest) -> Result<T, String>,
) -> Result<T, String> {
    let requests = requests.lock();
    let request = requests
        .get(id)
        .ok_or_else(|| "Permission request is no longer available".to_string())?;
    action(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn request() -> PendingAgentToolRequest {
        PendingAgentToolRequest {
            id: "request-1".into(),
            run_id: Some("run-1".into()),
            client_id: "atools-ui".into(),
            tool_name: "fixture".into(),
            arguments: serde_json::json!({}),
            scopes: vec![],
            created_at: "now".into(),
        }
    }

    fn awaiting_task(
        db: &atools_core::Database,
        request: &PendingAgentToolRequest,
    ) -> atools_core::task_run::TaskRun {
        use atools_core::task_run::{TaskRun, TaskRunInitiator, TaskRunStatus};
        let mut run = TaskRun::new(
            request.tool_name.clone(),
            TaskRunInitiator::human(Some(request.client_id.clone())),
            request.arguments.clone(),
        );
        run.id = request.run_id.clone().unwrap();
        run.output = crate::agent_tools::permission_required_payload(request);
        run.transition(TaskRunStatus::AwaitingPermission).unwrap();
        db.upsert_task_run(&run).unwrap();
        run
    }

    #[test]
    fn cancelled_before_publication_cannot_repopulate_permission_queue() {
        use std::sync::{Arc, Barrier};
        let db = atools_core::Database::in_memory().unwrap();
        let pending = request();
        let mut run = awaiting_task(&db, &pending);
        let requests = Arc::new(Mutex::new(PendingMap::new()));
        let held = requests.lock();
        let started = Arc::new(Barrier::new(2));
        let worker_db = db.clone();
        let worker_map = requests.clone();
        let worker_started = started.clone();
        let worker = std::thread::spawn(move || {
            worker_started.wait();
            upsert_for_run(
                &worker_map,
                pending,
                |request| matches_awaiting(&worker_db, request),
                || panic!("Cancelled request must not notify"),
            )
            .unwrap()
        });
        started.wait();
        run.transition(atools_core::task_run::TaskRunStatus::Cancelled)
            .unwrap();
        assert!(db.update_pending_task_run(&run).unwrap());
        drop(held);
        assert!(!worker.join().unwrap());
        assert!(requests.lock().is_empty());
    }

    #[test]
    fn cancellation_after_validation_removes_publication_after_releasing_db_lock() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;
        let db = atools_core::Database::in_memory().unwrap();
        let pending = request();
        let mut run = awaiting_task(&db, &pending);
        let requests = Arc::new(Mutex::new(PendingMap::new()));
        let (checked_tx, checked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let publisher_db = db.clone();
        let publisher_map = requests.clone();
        let publisher = std::thread::spawn(move || {
            upsert_for_run(
                &publisher_map,
                pending,
                |request| {
                    let matches = matches_awaiting(&publisher_db, request)?;
                    checked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    Ok(matches)
                },
                || {},
            )
            .unwrap()
        });
        checked_rx.recv().unwrap();
        let (cancelled_tx, cancelled_rx) = mpsc::channel();
        let (removed_tx, removed_rx) = mpsc::channel();
        let canceller_map = requests.clone();
        let canceller_db = db.clone();
        let canceller = std::thread::spawn(move || {
            run.transition(atools_core::task_run::TaskRunStatus::Cancelled)
                .unwrap();
            assert!(canceller_db.update_pending_task_run(&run).unwrap());
            cancelled_tx.send(()).unwrap();
            let removed = remove_from(&canceller_map, "request-1", || {});
            removed_tx.send(removed.is_some()).unwrap();
        });
        cancelled_rx.recv().unwrap();
        assert!(removed_rx.recv_timeout(Duration::from_millis(20)).is_err());
        release_tx.send(()).unwrap();
        assert!(publisher.join().unwrap());
        assert!(removed_rx.recv().unwrap());
        canceller.join().unwrap();
        assert!(requests.lock().is_empty());
    }

    #[test]
    fn old_request_cannot_replace_persisted_new_request_or_mismatched_identity() {
        let db = atools_core::Database::in_memory().unwrap();
        let old = request();
        let mut current = old.clone();
        current.id = "request-2".into();
        awaiting_task(&db, &current);
        let requests = Mutex::new(PendingMap::new());
        assert!(upsert_for_run(
            &requests,
            current.clone(),
            |request| matches_awaiting(&db, request),
            || {}
        )
        .unwrap());
        assert!(!upsert_for_run(
            &requests,
            old,
            |request| matches_awaiting(&db, request),
            || panic!("Stale request must not notify")
        )
        .unwrap());
        for field in ["client", "tool", "arguments", "scopes", "run"] {
            let mut changed = current.clone();
            match field {
                "client" => changed.client_id = "foreign".into(),
                "tool" => changed.tool_name = "foreign".into(),
                "arguments" => changed.arguments = serde_json::json!({"changed":true}),
                "scopes" => changed
                    .scopes
                    .push(atools_core::agent::PermissionScope::FileRead),
                _ => changed.run_id = Some("missing".into()),
            }
            assert!(!matches_awaiting(&db, &changed).unwrap(), "{field}");
        }
        assert_eq!(
            requests.lock().keys().cloned().collect::<Vec<_>>(),
            vec!["request-2"]
        );
    }

    #[test]
    fn terminal_dismiss_notifies_both_subscribers_after_unlock_without_a_run_update() {
        let requests = Mutex::new(BTreeMap::from([("request-1".into(), request())]));
        let notifications = [Cell::new(0), Cell::new(0)];
        // Dismissing an already terminal TaskRun only removes its pending entry:
        // there is deliberately no TaskRun status change to wake other windows.
        let removed = remove_from(&requests, "request-1", || {
            assert!(
                requests.try_lock().is_some(),
                "emit must run outside the map lock"
            );
            for subscriber in &notifications {
                subscriber.set(subscriber.get() + 1);
            }
        });
        assert!(removed.is_some());
        assert!(requests.lock().is_empty());
        assert_eq!(notifications.map(|count| count.get()), [1, 1]);
    }

    #[test]
    fn missing_removal_does_not_emit() {
        let requests = Mutex::new(PendingMap::new());
        remove_from(&requests, "absent", || panic!("no change"));
    }

    #[test]
    fn consuming_claimed_run_removes_only_its_pending_permission_request() {
        let target = request();
        let mut other_same_capability = target.clone();
        other_same_capability.id = "request-other-run".into();
        other_same_capability.run_id = Some("run-other".into());
        let mut unrelated = target.clone();
        unrelated.id = "request-unrelated".into();
        unrelated.client_id = "another-client".into();
        unrelated.tool_name = "another-tool".into();
        unrelated.run_id = Some("run-unrelated".into());
        let mut unbound = target.clone();
        unbound.id = "request-unbound".into();
        unbound.run_id = None;
        let requests = Mutex::new(BTreeMap::from([
            (target.id.clone(), target.clone()),
            (
                other_same_capability.id.clone(),
                other_same_capability.clone(),
            ),
            (unrelated.id.clone(), unrelated.clone()),
            (unbound.id.clone(), unbound.clone()),
        ]));

        assert_eq!(remove_run_from(&requests, "run-1", || {}), 1);
        let remaining = requests.lock();
        assert!(!remaining.contains_key(&target.id));
        let retained_same_capability = remaining.get(&other_same_capability.id).unwrap();
        assert_eq!(
            retained_same_capability.run_id.as_deref(),
            Some("run-other")
        );
        assert_eq!(retained_same_capability.client_id, target.client_id);
        assert_eq!(retained_same_capability.tool_name, target.tool_name);
        let retained_unrelated = remaining.get(&unrelated.id).unwrap();
        assert_eq!(retained_unrelated.run_id.as_deref(), Some("run-unrelated"));
        assert_eq!(retained_unrelated.client_id, "another-client");
        assert_eq!(retained_unrelated.tool_name, "another-tool");
        assert_eq!(remaining.get(&unbound.id).unwrap().run_id, None);
    }

    #[test]
    fn replacing_a_run_request_keeps_exactly_one_authoritative_entry() {
        let requests = Mutex::new(BTreeMap::new());
        upsert_for_run(&requests, request(), |_| Ok(true), || {}).unwrap();
        let mut replacement = request();
        replacement.id = "request-2".into();
        replacement
            .scopes
            .push(atools_core::agent::PermissionScope::FileRead);
        upsert_for_run(&requests, replacement.clone(), |_| Ok(true), || {}).unwrap();

        let map = requests.lock();
        assert_eq!(map.len(), 1);
        assert_eq!(
            map.get("request-2").map(|item| item.scopes.clone()),
            Some(replacement.scopes)
        );
        assert!(!map.contains_key("request-1"));
    }

    #[test]
    fn request_commit_holds_map_lock_until_synchronous_action_finishes() {
        use std::sync::{mpsc, Arc};
        use std::time::Duration;

        let requests = Arc::new(Mutex::new(BTreeMap::from([(
            "request-1".into(),
            request(),
        )])));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (dismiss_started_tx, dismiss_started_rx) = mpsc::channel();
        let (removed_tx, removed_rx) = mpsc::channel();
        let commit_map = requests.clone();
        let commit = std::thread::spawn(move || {
            with_request_from(&commit_map, "request-1", |_| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                Ok(())
            })
            .unwrap();
        });
        entered_rx.recv().unwrap();

        let dismiss_map = requests.clone();
        let dismiss = std::thread::spawn(move || {
            dismiss_started_tx.send(()).unwrap();
            let removed = remove_from(&dismiss_map, "request-1", || {});
            removed_tx.send(removed.is_some()).unwrap();
        });
        dismiss_started_rx.recv().unwrap();
        assert!(removed_rx.recv_timeout(Duration::from_millis(20)).is_err());
        release_tx.send(()).unwrap();
        commit.join().unwrap();
        dismiss.join().unwrap();
        assert_eq!(removed_rx.recv().unwrap(), true);
    }

    #[test]
    fn database_cancellation_while_request_is_locked_prevents_grant_insert() {
        use atools_core::{
            db::Database,
            task_run::{TaskRun, TaskRunInitiator, TaskRunStatus},
        };
        use std::sync::{mpsc, Arc};

        let db = Database::in_memory().unwrap();
        let mut run = TaskRun::new(
            "fixture",
            TaskRunInitiator::agent("atools-ui"),
            serde_json::json!({"value":1}),
        );
        run.transition(TaskRunStatus::AwaitingPermission).unwrap();
        db.upsert_task_run(&run).unwrap();
        let mut pending = request();
        pending.run_id = Some(run.id.clone());
        pending.tool_name = run.capability_id.clone();
        pending.client_id = "atools-ui".into();
        pending.arguments = run.input.clone();
        let requests = Arc::new(Mutex::new(BTreeMap::from([(pending.id.clone(), pending)])));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (resume_tx, resume_rx) = mpsc::channel();
        let worker_map = requests.clone();
        let worker_db = db.clone();
        let worker_run = run.clone();
        let worker = std::thread::spawn(move || {
            with_request_from(&worker_map, "request-1", |_| {
                entered_tx.send(()).unwrap();
                resume_rx.recv().unwrap();
                let inserted = worker_db
                    .grant_agent_tool_for_pending_run(&worker_run, "atools-ui", "fixture")
                    .map_err(|error| error.to_string())?;
                assert!(!inserted, "cancelled TaskRuns cannot receive a grant");
                Ok(())
            })
            .unwrap();
        });
        entered_rx.recv().unwrap();

        let mut cancelled = run;
        cancelled.transition(TaskRunStatus::Cancelled).unwrap();
        assert!(db.update_pending_task_run(&cancelled).unwrap());
        resume_tx.send(()).unwrap();
        worker.join().unwrap();
        assert!(!db.is_agent_tool_granted("atools-ui", "fixture").unwrap());
    }
}
