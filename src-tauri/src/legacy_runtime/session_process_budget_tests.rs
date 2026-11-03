use super::session_startup_abort_tests::{fixture_child_pid, wait_for_child_reap};
use super::session_tests::{assert_stopped, fixture, intent, open, pid};
use super::sessions::Sessions;
use std::future::poll_fn;
use std::future::Future;
use std::task::Poll;
use std::time::Duration;

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn real_startup_child_holds_the_fourth_process_slot_until_reaped() {
    let runtime = Sessions::default();
    let (directory, plugin) = fixture();
    let (fourth_directory, fourth_plugin) = fixture();
    let (fifth_directory, fifth_plugin) = fixture();

    let mut sessions = Vec::new();
    for index in 0..3 {
        let owner = format!("window:main:budget-existing-{index}");
        let session = open(&runtime, &owner, &plugin).await;
        let root_pid = u32::try_from(pid(&session).await).expect("Node pid fits u32");
        sessions.push((owner, session, root_pid));
    }
    assert_eq!(runtime.sessions.read().len(), 3);
    assert_eq!(runtime.process_budget.available(), 1);

    let fourth_owner = "window:main:budget-pending-fourth";
    let mut fourth_opening = Box::pin(runtime.open(
        &fourth_plugin,
        "tool".into(),
        intent(&runtime, fourth_owner, &fourth_plugin),
    ));
    let fourth_pid = tokio::time::timeout(Duration::from_secs(4), async {
        loop {
            let open_poll =
                poll_fn(|context| Poll::Ready(fourth_opening.as_mut().poll(context))).await;
            assert!(
                matches!(open_poll, Poll::Pending),
                "the fourth startup must remain pending at the child rendezvous"
            );
            if let Some(pid) = fixture_child_pid(&fourth_directory) {
                break pid;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fourth open must expose a real child before initialize completes");

    assert_eq!(runtime.sessions.read().len(), 3);
    assert_eq!(runtime.process_budget.available(), 0);
    assert!(runtime.openings.lock().contains_key(fourth_owner));
    assert_eq!(unsafe { libc::kill(fourth_pid as i32, 0) }, 0);

    // No scheduler yield occurs between dropping the startup future and these
    // checks. Its child task has the shutdown request queued but has not yet
    // run the process wait loop, so the real child must still own the permit.
    drop(fourth_opening);
    assert!(runtime.openings.lock().is_empty());
    assert_eq!(runtime.sessions.read().len(), 3);
    assert_eq!(runtime.process_budget.available(), 0);
    assert_eq!(unsafe { libc::kill(fourth_pid as i32, 0) }, 0);

    let fifth_owner = "window:main:budget-rejected-fifth";
    let mut fifth_opening = Box::pin(runtime.open(
        &fifth_plugin,
        "tool".into(),
        intent(&runtime, fifth_owner, &fifth_plugin),
    ));
    let fifth_poll = poll_fn(|context| Poll::Ready(fifth_opening.as_mut().poll(context))).await;
    let fifth_error = match fifth_poll {
        Poll::Ready(Err(error)) => error,
        Poll::Ready(Ok(_)) => panic!("the fifth open must not bypass the live-child budget"),
        Poll::Pending => panic!("the full process budget must reject the fifth open immediately"),
    };
    assert!(fifth_error.contains("limit 4"));
    drop(fifth_opening);
    assert_eq!(runtime.sessions.read().len(), 3);
    assert!(runtime.openings.lock().is_empty());
    assert!(fixture_child_pid(&fifth_directory).is_none());
    assert_eq!(unsafe { libc::kill(fourth_pid as i32, 0) }, 0);
    assert_eq!(runtime.process_budget.available(), 0);
    assert!(runtime
        .intents
        .lock()
        .values()
        .any(|intent| intent.owner == fifth_owner));
    assert!(runtime.close_owner(fifth_owner, None).await.is_empty());
    assert!(!runtime
        .intents
        .lock()
        .values()
        .any(|intent| intent.owner == fifth_owner));

    wait_for_child_reap(fourth_pid).await;
    tokio::time::timeout(Duration::from_secs(2), async {
        while runtime.process_budget.available() != 1 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("the fourth slot must return only after its startup child is reaped");
    assert_eq!(runtime.sessions.read().len(), 3);
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.close_owner(fourth_owner, None).await.is_empty());

    let replacement_owner = "window:main:budget-replacement-fourth";
    let replacement = open(&runtime, replacement_owner, &fourth_plugin).await;
    let replacement_pid = u32::try_from(pid(&replacement).await).expect("Node pid fits u32");
    assert_eq!(runtime.sessions.read().len(), 4);
    assert_eq!(runtime.process_budget.available(), 0);

    for (owner, session, root_pid) in &sessions {
        runtime.close_owner(owner, None).await;
        assert_stopped(session).await;
        wait_for_child_reap(*root_pid).await;
    }
    runtime.close_owner(replacement_owner, None).await;
    assert_stopped(&replacement).await;
    wait_for_child_reap(replacement_pid).await;

    assert_eq!(runtime.process_budget.available(), 4);
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.intents.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
    drop(directory);
    drop(fourth_directory);
    drop(fifth_directory);
}
