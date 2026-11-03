use std::{
    future::Future,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use super::GeneralSettingsCoordinator;
use tokio::{
    sync::{mpsc, oneshot, Mutex as AsyncMutex},
    task::JoinHandle,
    time::timeout,
};

const SIGNAL_TIMEOUT: Duration = Duration::from_secs(2);
const BLOCKED_ASSERTION_WINDOW: Duration = Duration::from_millis(100);

#[derive(Default)]
struct ActiveEffects {
    active: AtomicUsize,
    maximum: AtomicUsize,
}

impl ActiveEffects {
    fn enter(&self) {
        let active = self.active.fetch_add(1, Ordering::SeqCst) + 1;
        self.maximum.fetch_max(active, Ordering::SeqCst);
    }

    fn leave(&self) {
        assert!(self.active.fetch_sub(1, Ordering::SeqCst) > 0);
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    timeout(SIGNAL_TIMEOUT, future)
        .await
        .expect("coordinator operation timed out")
}

#[tokio::test(flavor = "current_thread")]
async fn caller_cancellation_keeps_active_gate_until_effect_finishes() {
    let coordinator = GeneralSettingsCoordinator::default();
    let effects = Arc::new(ActiveEffects::default());
    let (first_started_tx, first_started_rx) = oneshot::channel();
    let (release_first_tx, release_first_rx) = oneshot::channel();
    let (first_finished_tx, first_finished_rx) = oneshot::channel();

    let first_caller: JoinHandle<Result<&'static str, String>> = tokio::spawn({
        let coordinator = coordinator.clone();
        let effects = Arc::clone(&effects);
        async move {
            coordinator
                .run(move || async move {
                    effects.enter();
                    let _ = first_started_tx.send(());
                    let _ = release_first_rx.await;
                    effects.leave();
                    let _ = first_finished_tx.send(());
                    Ok("first")
                })
                .await
        }
    });
    bounded(first_started_rx)
        .await
        .expect("first effect did not start");

    first_caller.abort();
    assert!(first_caller
        .await
        .expect_err("caller should be cancelled")
        .is_cancelled());

    let (second_attempted_tx, second_attempted_rx) = oneshot::channel();
    let (second_started_tx, mut second_started_rx) = oneshot::channel();
    let (release_second_tx, release_second_rx) = oneshot::channel();
    let (second_finished_tx, second_finished_rx) = oneshot::channel();
    let second_caller = tokio::spawn({
        let coordinator = coordinator.clone();
        let effects = Arc::clone(&effects);
        async move {
            let _ = second_attempted_tx.send(());
            coordinator
                .run(move || async move {
                    effects.enter();
                    let _ = second_started_tx.send(());
                    let _ = release_second_rx.await;
                    effects.leave();
                    let _ = second_finished_tx.send(());
                    Ok("second")
                })
                .await
        }
    });
    bounded(second_attempted_rx)
        .await
        .expect("second caller did not attempt admission");
    assert!(
        timeout(BLOCKED_ASSERTION_WINDOW, &mut second_started_rx)
            .await
            .is_err(),
        "second effect entered while the first effect was still active"
    );

    release_first_tx
        .send(())
        .expect("first effect already stopped");
    bounded(first_finished_rx)
        .await
        .expect("detached first effect did not finish");
    bounded(&mut second_started_rx)
        .await
        .expect("second effect did not start after first completed");
    assert_eq!(effects.active.load(Ordering::SeqCst), 1);
    assert_eq!(effects.maximum.load(Ordering::SeqCst), 1);

    release_second_tx
        .send(())
        .expect("second effect already stopped");
    bounded(second_finished_rx)
        .await
        .expect("second effect did not finish");
    assert_eq!(bounded(second_caller).await.unwrap(), Ok("second"));
    assert_eq!(effects.active.load(Ordering::SeqCst), 0);

    let reusable = bounded(coordinator.run(|| async { Ok::<_, String>("reused") })).await;
    assert_eq!(reusable, Ok("reused"));
    assert_eq!(effects.maximum.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn thirty_third_admission_is_rejected_until_all_admitted_work_drains() {
    let coordinator = GeneralSettingsCoordinator::default();
    let effects = Arc::new(ActiveEffects::default());
    let completed = Arc::new(AtomicUsize::new(0));
    let (first_started_tx, mut first_started_rx) = mpsc::unbounded_channel();
    let (release_first_tx, release_first_rx) = oneshot::channel();
    let first_release = Arc::new(AsyncMutex::new(Some(release_first_rx)));
    let (attempted_tx, mut attempted_rx) = mpsc::unbounded_channel();
    let mut callers = Vec::with_capacity(32);

    for _ in 0..32 {
        let coordinator = coordinator.clone();
        let effects = Arc::clone(&effects);
        let completed = Arc::clone(&completed);
        let first_release = Arc::clone(&first_release);
        let attempted_tx = attempted_tx.clone();
        let first_started_tx = first_started_tx.clone();

        callers.push(tokio::spawn(async move {
            let _ = attempted_tx.send(());
            coordinator
                .run(move || async move {
                    effects.enter();
                    if let Some(release) = first_release.lock().await.take() {
                        let _ = first_started_tx.send(());
                        let _ = release.await;
                    }
                    effects.leave();
                    completed.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                })
                .await
        }));
    }
    drop(attempted_tx);

    bounded(first_started_rx.recv())
        .await
        .expect("no admitted effect became active");
    for _ in 0..32 {
        bounded(attempted_rx.recv())
            .await
            .expect("admission-attempt channel closed early");
    }

    let rejected_effects = Arc::new(AtomicUsize::new(0));
    let rejected_effects_for_operation = Arc::clone(&rejected_effects);
    let rejected = bounded(coordinator.run(move || async move {
        rejected_effects_for_operation.fetch_add(1, Ordering::SeqCst);
        Ok::<_, String>(())
    }))
    .await;
    assert_eq!(
        rejected,
        Err("Too many General settings writes are already queued".to_owned())
    );
    assert_eq!(rejected_effects.load(Ordering::SeqCst), 0);
    assert_eq!(completed.load(Ordering::SeqCst), 0);

    release_first_tx
        .send(())
        .expect("first effect already stopped");
    for caller in callers {
        assert_eq!(bounded(caller).await.unwrap(), Ok(()));
    }
    assert_eq!(completed.load(Ordering::SeqCst), 32);
    assert_eq!(effects.active.load(Ordering::SeqCst), 0);
    assert_eq!(effects.maximum.load(Ordering::SeqCst), 1);

    assert_eq!(
        bounded(coordinator.run(|| async { Ok::<_, String>("available") })).await,
        Ok("available")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn queued_general_settings_read_observes_commit_after_writer_caller_is_cancelled() {
    use std::collections::BTreeMap;

    use serde_json::{json, Value};

    let directory = tempfile::tempdir().expect("temporary database directory");
    let database_path = directory.path().join("settings.db");
    let database =
        Arc::new(atools_core::Database::open(&database_path).expect("open temporary database"));
    database
        .set_setting(
            "settings-general",
            r#"{"theme":"dark","unknown":"preserve"}"#,
        )
        .expect("seed the initial settings snapshot");

    let coordinator = GeneralSettingsCoordinator::default();
    let (write_started_tx, write_started_rx) = oneshot::channel();
    let (release_effects_tx, release_effects_rx) = oneshot::channel();
    let (write_committed_tx, write_committed_rx) = oneshot::channel();
    let write_caller = tokio::spawn({
        let coordinator = coordinator.clone();
        let database = Arc::clone(&database);
        async move {
            coordinator
                .run(move || async move {
                    let _ = write_started_tx.send(());
                    // Model the native-effects phase; it must finish before the DB patch.
                    let _ = release_effects_rx.await;
                    let changes = BTreeMap::from([("theme".to_owned(), json!("light"))]);
                    let raw = database
                        .patch_general_settings_current(&changes)
                        .map_err(|error| error.to_string())?;
                    let _ = write_committed_tx.send(raw.clone());
                    Ok(raw)
                })
                .await
        }
    });
    bounded(write_started_rx)
        .await
        .expect("owned write operation did not start");

    write_caller.abort();
    assert!(write_caller
        .await
        .expect_err("UI-side writer waiter should be cancelled")
        .is_cancelled());

    let (read_attempted_tx, read_attempted_rx) = oneshot::channel();
    let mut read_caller = tokio::spawn({
        let coordinator = coordinator.clone();
        let database = Arc::clone(&database);
        async move {
            let _ = read_attempted_tx.send(());
            coordinator
                .run(move || async move {
                    database
                        .read_renderer_general_settings()
                        .map_err(|error| error.to_string())
                })
                .await
        }
    });
    bounded(read_attempted_rx)
        .await
        .expect("read caller did not attempt the coordinator");
    assert!(
        timeout(BLOCKED_ASSERTION_WINDOW, &mut read_caller)
            .await
            .is_err(),
        "settings read completed while the prior owned write was still in effects"
    );

    release_effects_tx
        .send(())
        .expect("owned write operation already stopped");
    let committed_raw = bounded(write_committed_rx)
        .await
        .expect("owned write did not commit its settings patch");
    let read_result = bounded(read_caller)
        .await
        .expect("queued settings read task failed");
    let read_raw = read_result
        .expect("queued settings read command failed")
        .expect("committed General settings row is missing");

    assert_eq!(read_raw, committed_raw);
    let settings: Value = serde_json::from_str(&read_raw).expect("read settings JSON");
    assert_eq!(settings["theme"], "light");
    assert_eq!(settings["unknown"], "preserve");

    let reopened = atools_core::Database::open(&database_path)
        .expect("reopen temporary database after coordinator operations");
    assert_eq!(
        reopened
            .read_renderer_general_settings()
            .expect("reopen read succeeds")
            .as_deref(),
        Some(read_raw.as_str())
    );
}

#[test]
fn hotkey_lease_rejects_reads_and_writes_before_touching_any_registry() {
    let coordinator = GeneralSettingsCoordinator::default();
    {
        let _lease = coordinator
            .hotkey_operation_lease()
            .expect("lease acquired");
        let mut called = false;
        assert_eq!(
            coordinator
                .with_owned_main_hotkey(|_| called = true)
                .unwrap_err(),
            "SETTINGS_HOTKEY_REJECTED"
        );
        assert_eq!(
            coordinator
                .with_hotkey_registries(|_, _| called = true)
                .unwrap_err(),
            "SETTINGS_HOTKEY_REJECTED"
        );
        assert_eq!(
            coordinator
                .with_app_shortcuts(|_| called = true)
                .unwrap_err(),
            "SETTINGS_HOTKEY_REJECTED"
        );
        assert_eq!(
            coordinator
                .with_hotkey_operation(|| {
                    called = true;
                    Ok(())
                })
                .unwrap_err(),
            "SETTINGS_HOTKEY_REJECTED"
        );
        assert!(!called, "busy calls must not reach registry or IO closures");
    }

    coordinator
        .with_owned_main_hotkey(|_| ())
        .expect("lease should be released by RAII");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn movable_hotkey_lease_survives_awaiter_drop_until_real_blocking_owner_exits() {
    let coordinator = GeneralSettingsCoordinator::default();
    let lease = coordinator.hotkey_operation_lease().unwrap();
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let (finished_tx, finished_rx) = oneshot::channel();
    let task = tokio::task::spawn_blocking(move || {
        let _owned_lease = lease;
        let _ = started_tx.send(());
        release_rx.recv().unwrap();
        drop(_owned_lease);
        let _ = finished_tx.send(());
    });
    bounded(started_rx).await.unwrap();
    drop(task);
    assert!(coordinator.hotkey_operation_lease().is_err());
    release_tx.send(()).unwrap();
    bounded(finished_rx).await.unwrap();
    assert!(coordinator.hotkey_operation_lease().is_ok());
}
