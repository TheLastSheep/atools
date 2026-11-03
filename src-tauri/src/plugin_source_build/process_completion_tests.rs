use super::*;

fn spawn(job: Worker) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("atools-build-completion-fixture".into())
        .spawn(job)
        .map(|_| ())
}
fn flags() -> (Arc<AtomicBool>, Arc<AtomicBool>) {
    (
        Arc::new(AtomicBool::new(false)),
        Arc::new(AtomicBool::new(false)),
    )
}

async fn settled(finished: &AtomicBool) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !finished.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
        tokio::task::yield_now().await;
    }
    assert!(finished.load(Ordering::Acquire));
}

#[test]
fn injected_thread_spawn_failure_finishes_without_false_quarantine() {
    let (finished, unsafe_cleanup) = flags();
    let result = spawn_worker::<(), String>(
        || panic!("work must not run"),
        finished.clone(),
        unsafe_cleanup.clone(),
        |_| Err(std::io::Error::from_raw_os_error(libc::EAGAIN)),
    );
    assert!(matches!(result, Err(error) if error == "SourceBuildSupervisorUnavailable"));
    assert!(finished.load(Ordering::Acquire));
    assert!(!unsafe_cleanup.load(Ordering::Acquire));
}

#[tokio::test]
async fn known_success_and_already_cleaned_errors_publish_safe_completion() {
    for outcome in [
        Ok(()),
        Err("SOURCE_BUILD_CANCELLED".to_owned()),
        Err("SourceBuildInvalidOutput".to_owned()),
    ] {
        let (finished, unsafe_cleanup) = flags();
        let expected = outcome.clone();
        let receiver = spawn_worker::<(), String>(
            move || outcome,
            finished.clone(),
            unsafe_cleanup.clone(),
            spawn,
        )
        .unwrap();
        assert_eq!(receiver.await.unwrap(), expected);
        settled(&finished).await;
        assert!(finished.load(Ordering::Acquire));
        assert!(!unsafe_cleanup.load(Ordering::Acquire));
    }
}

#[tokio::test]
async fn closed_worker_channel_waits_for_worker_finished_before_returning_error() {
    let (sender, receiver) = tokio::sync::oneshot::channel::<Result<(), String>>();
    drop(sender);
    let finished = Arc::new(AtomicBool::new(false));
    let task_finished = finished.clone();
    let task =
        tokio::spawn(async move { wait_for_worker::<(), String>(receiver, &task_finished).await });

    tokio::task::yield_now().await;
    assert!(
        !task.is_finished(),
        "closed channel must not bypass the worker completion boundary"
    );

    finished.store(true, Ordering::Release);
    assert_eq!(
        task.await.unwrap(),
        Err("SourceBuildSupervisorTerminated".to_owned())
    );
}

#[tokio::test]
async fn worker_panic_publishes_unsafe_cleanup_before_terminal_notification() {
    let (finished, unsafe_cleanup) = flags();
    let receiver = spawn_worker::<(), String>(
        || panic!("fixed completion panic fixture"),
        finished.clone(),
        unsafe_cleanup.clone(),
        spawn,
    )
    .unwrap();
    assert!(receiver.await.is_err());
    settled(&finished).await;
    assert!(finished.load(Ordering::Acquire));
    assert!(unsafe_cleanup.load(Ordering::Acquire));
}

#[tokio::test]
async fn abandoned_waiter_does_not_hide_late_unconfirmed_cleanup() {
    let (finished, unsafe_cleanup) = flags();
    let (release, wait) = std::sync::mpsc::channel();
    let receiver = spawn_worker::<(), String>(
        move || {
            wait.recv().unwrap();
            Err("SOURCE_BUILD_CLEANUP_UNCONFIRMED".into())
        },
        finished.clone(),
        unsafe_cleanup.clone(),
        spawn,
    )
    .unwrap();
    drop(receiver);
    release.send(()).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while !finished.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
        tokio::task::yield_now().await;
    }
    assert!(finished.load(Ordering::Acquire));
    assert!(unsafe_cleanup.load(Ordering::Acquire));
}

#[tokio::test]
async fn undelivered_payload_cleanup_publishes_before_finished() {
    struct Payload(Arc<AtomicBool>);
    impl Drop for Payload {
        fn drop(&mut self) {
            self.0.store(true, Ordering::Release);
        }
    }
    let (finished, unsafe_cleanup) = flags();
    let signal = unsafe_cleanup.clone();
    let (release, wait) = std::sync::mpsc::channel();
    let receiver = spawn_worker::<Payload, String>(
        move || {
            wait.recv().unwrap();
            Ok(Payload(signal))
        },
        finished.clone(),
        unsafe_cleanup.clone(),
        spawn,
    )
    .unwrap();
    drop(receiver);
    release.send(()).unwrap();
    settled(&finished).await;
    assert!(unsafe_cleanup.load(Ordering::Acquire));
}

#[tokio::test]
async fn undelivered_payload_drop_panic_remains_unknown_cleanup() {
    struct Payload;
    impl Drop for Payload {
        fn drop(&mut self) {
            panic!("fixed payload drop panic fixture");
        }
    }
    let (finished, unsafe_cleanup) = flags();
    let (release, wait) = std::sync::mpsc::channel();
    let receiver = spawn_worker::<Payload, String>(
        move || {
            wait.recv().unwrap();
            Ok(Payload)
        },
        finished.clone(),
        unsafe_cleanup.clone(),
        spawn,
    )
    .unwrap();
    drop(receiver);
    release.send(()).unwrap();
    settled(&finished).await;
    assert!(unsafe_cleanup.load(Ordering::Acquire));
}
