use super::*;

#[test]
fn readiness_is_claimed_once_and_exit_is_terminal() {
    let runtime = Runtime::default();
    assert!(runtime.begin_start());
    assert_eq!(runtime.phase(), Phase::Starting);
    assert!(!runtime.begin_start());

    runtime.stop();
    runtime.stop();
    assert_eq!(runtime.phase(), Phase::Stopped);
    assert!(!runtime.begin_start());
}

#[cfg(feature = "legacy-node-smoke")]
#[test]
fn refresh_invalidates_the_source_before_sending_the_unit_notification() {
    use crate::launcher_app_catalog_source::LauncherAppCatalogSource;
    use std::fs;

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("launcher-apps");
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("Initial.app")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let source = LauncherAppCatalogSource::from_owned_fixture_directory(&root).unwrap();
    assert_eq!(source.snapshot().unwrap().len(), 1);
    fs::create_dir(root.join("Added.app")).unwrap();

    let mut notifications = 0;
    invalidate_then_notify(&source, || {
        notifications += 1;
        let refreshed = source.snapshot().unwrap();
        assert_eq!(refreshed.len(), 2);
        assert!(refreshed
            .iter()
            .any(|app| app.path().ends_with("Added.app")));
        Ok(())
    })
    .unwrap();

    assert_eq!(notifications, 1);
}

#[cfg(all(target_os = "macos", feature = "legacy-node-smoke"))]
#[test]
fn fsevents_add_and_remove_refresh_the_same_owned_source_snapshot() {
    use crate::{
        launcher_app_catalog::LauncherApp, launcher_app_catalog_source::LauncherAppCatalogSource,
    };
    use std::{
        fs,
        path::Path,
        sync::{
            mpsc::{self, Receiver, TryRecvError},
            Arc,
        },
        time::{Duration, Instant},
    };

    const EVENT_TIMEOUT: Duration = Duration::from_secs(10);
    const QUIET_WINDOW: Duration = Duration::from_millis(1600);

    fn names(apps: &[LauncherApp]) -> Vec<String> {
        let mut names = apps
            .iter()
            .filter_map(|app| {
                Path::new(app.path())
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_owned)
            })
            .collect::<Vec<_>>();
        names.sort();
        names
    }

    fn matches_names(actual: &[String], expected: &[&str]) -> bool {
        actual
            .iter()
            .map(String::as_str)
            .eq(expected.iter().copied())
    }

    fn wait_for_snapshot(
        receiver: &Receiver<Result<Vec<String>, &'static str>>,
        expected: &[&str],
    ) -> bool {
        let deadline = Instant::now() + EVENT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            match receiver.recv_timeout(remaining) {
                Ok(Ok(actual)) if matches_names(&actual, expected) => return true,
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout | mpsc::RecvTimeoutError::Disconnected) => {
                    return false;
                }
            }
        }
    }

    fn wait_for_quiet(receiver: &Receiver<Result<Vec<String>, &'static str>>) -> bool {
        let deadline = Instant::now() + EVENT_TIMEOUT;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return false;
            }
            match receiver.recv_timeout(remaining.min(QUIET_WINDOW)) {
                Ok(_) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => return true,
                Err(mpsc::RecvTimeoutError::Disconnected) => return false,
            }
        }
    }

    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("launcher-apps");
    fs::create_dir(&root).unwrap();
    fs::create_dir(root.join("Initial.app")).unwrap();
    let root = fs::canonicalize(root).unwrap();
    let source = std::sync::Arc::new(
        LauncherAppCatalogSource::from_owned_fixture_directory(&root)
            .expect("private temporary catalog source should be accepted"),
    );

    assert!(matches_names(
        &names(&source.snapshot().unwrap()),
        &["Initial.app"]
    ));
    assert!(source
        .watch_roots()
        .is_ok_and(|roots| roots.len() == 1 && roots[0] == root));

    let (sender, receiver) = mpsc::sync_channel::<Result<Vec<String>, &'static str>>(16);
    let callback_source = std::sync::Arc::clone(&source);
    let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        let mut observed = None;
        let result = invalidate_then_notify(&callback_source, || {
            let snapshot = callback_source
                .snapshot()
                .map_err(|_| "owned catalog snapshot failed")?;
            observed = Some(names(&snapshot));
            Ok(())
        })
        .and_then(|()| observed.ok_or("refresh notification ran without a snapshot"));
        let _ = sender.try_send(result);
    });
    let roots = source.watch_roots().unwrap();
    let mut watcher = NativeWatcher::start(&roots, callback)
        .expect("private owned catalog root should support FSEvents");

    fs::create_dir(root.join("Added.app")).unwrap();
    assert!(
        wait_for_snapshot(&receiver, &["Added.app", "Initial.app"]),
        "add callback did not observe the refreshed owned source snapshot"
    );
    assert!(
        wait_for_quiet(&receiver),
        "add callback stream did not settle"
    );

    fs::remove_dir(root.join("Added.app")).unwrap();
    assert!(
        wait_for_snapshot(&receiver, &["Initial.app"]),
        "remove callback did not observe the refreshed owned source snapshot"
    );
    assert!(
        wait_for_quiet(&receiver),
        "remove callback stream did not settle"
    );

    watcher.stop();
    drop(watcher);
    drop(source);
    assert!(matches!(
        receiver.try_recv(),
        Err(TryRecvError::Disconnected)
    ));
    temporary
        .close()
        .expect("stopped watcher should release the private fixture root");
}
