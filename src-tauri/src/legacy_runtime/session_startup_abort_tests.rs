use super::session_tests::{
    assert_listener_closed, assert_stopped, fixture, intent, listener, open,
};
use super::sessions::Sessions;
use std::future::poll_fn;
use std::future::Future;
use std::sync::atomic::Ordering;
use std::task::Poll;
use std::time::Duration;
use tempfile::TempDir;

#[cfg(unix)]
pub(super) fn fixture_child_pid(directory: &TempDir) -> Option<u32> {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

    let cwd = directory.path().canonicalize().ok()?;
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_cwd(UpdateKind::Always)
            .without_tasks(),
    );
    system.processes().iter().find_map(|(pid, process)| {
        (process
            .parent()
            .is_some_and(|parent| parent.as_u32() == std::process::id())
            && process
                .cwd()
                .and_then(|path| path.canonicalize().ok())
                .as_ref()
                == Some(&cwd))
        .then_some(pid.as_u32())
    })
}

#[cfg(unix)]
pub(super) async fn wait_for_child_reap(pid: u32) {
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let exists = unsafe { libc::kill(pid as i32, 0) };
            if exists == -1 {
                let error = std::io::Error::last_os_error();
                if error.raw_os_error() == Some(libc::ESRCH) {
                    break;
                }
                panic!("checking the startup child failed: {error}");
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("cancelling startup must kill and reap the real child");
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn aborting_real_node_startup_removes_the_opening_and_preserves_its_pending_run_for_close() {
    let runtime = Sessions::default();
    let (directory, plugin) = fixture();
    let pending = intent(&runtime, "window:main:aborted-start", &plugin);
    *pending.run_id.lock() = Some("run-aborted-start".into());
    let cancelled = pending.cancelled.clone();
    let origin = listener(&runtime).await;
    let mut opening = Box::pin(runtime.open(&plugin, "tool".into(), pending));

    // Manually poll the real open future once per loop. SidecarProcess spawns
    // the child synchronously, then waits for its run_process Tokio task to mark
    // it running. This current-thread test cannot schedule that task until this
    // poll returns, so the following synchronous process snapshot sees a live
    // child while startup is still pending and before initialize can complete.
    let child_pid = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let open_poll = poll_fn(|context| Poll::Ready(opening.as_mut().poll(context))).await;
            assert!(
                matches!(open_poll, Poll::Pending),
                "the startup future must still be pending when its child is observed"
            );
            if let Some(pid) = fixture_child_pid(&directory) {
                break pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("startup must expose its real child before initialization completes");

    assert!(unsafe { libc::kill(child_pid as i32, 0) } == 0);
    assert!(runtime
        .openings
        .lock()
        .contains_key("window:main:aborted-start"));
    assert!(runtime.sessions.read().is_empty());
    assert!(!cancelled.load(Ordering::Acquire));
    let pending_run = runtime
        .intents
        .lock()
        .values()
        .find(|intent| intent.owner == "window:main:aborted-start")
        .and_then(|intent| intent.run_id.lock().clone());
    assert_eq!(pending_run.as_deref(), Some("run-aborted-start"));

    // Dropping the still-pending open future exercises startup cancellation;
    // no initialized Session has been returned or dropped here.
    drop(opening);
    assert!(cancelled.load(Ordering::Acquire));
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.server.lock().await.is_none());
    assert_listener_closed(&origin).await;
    wait_for_child_reap(child_pid).await;

    assert_eq!(
        runtime.close_owner("window:main:aborted-start", None).await,
        vec!["run-aborted-start"]
    );
    assert!(runtime.intents.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());

    // The cancelled startup consumes no process slot: all four real slots can
    // be filled again, and the fifth open is rejected by the normal quota.
    let mut sessions = Vec::new();
    for index in 0..4 {
        let owner = format!("window:main:after-abort-{index}");
        sessions.push((owner.clone(), open(&runtime, &owner, &plugin).await));
    }
    assert_eq!(runtime.sessions.read().len(), 4);
    let fifth_owner = "window:main:after-abort-fifth";
    let fifth = runtime
        .open(
            &plugin,
            "tool".into(),
            intent(&runtime, fifth_owner, &plugin),
        )
        .await
        .err()
        .expect("the fifth real session must be rejected by the four-process quota");
    assert!(fifth.contains("limit 4"));
    assert_eq!(runtime.sessions.read().len(), 4);
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.close_owner(fifth_owner, None).await.is_empty());

    for (owner, session) in &sessions {
        runtime.close_owner(owner, None).await;
        assert_stopped(session).await;
    }
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.intents.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
    drop(directory);
}
