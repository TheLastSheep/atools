use std::{
    collections::BTreeMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
};

use atools_core::Database;
use serde_json::{json, Value};

use super::{execute_renderer_patch, ReadApplyOpacity, ReadApplyTray};

struct Fixture {
    _directory: tempfile::TempDir,
    db: Arc<Database>,
    expected: String,
}

#[derive(Default)]
struct FakeTray {
    actual: bool,
    calls: Vec<Option<bool>>,
    fail_candidate: bool,
    fail_restore: bool,
    candidate_attempted: bool,
    candidate_applied: bool,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let db = Arc::new(Database::open(&directory.path().join("general.sqlite")).unwrap());
    db.set_setting(
        "settings-general",
        r#"{"opacity":1.0,"showTrayIcon":true,"unrelated":{"preserved":true}}"#,
    )
    .unwrap();
    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    Fixture {
        _directory: directory,
        db,
        expected,
    }
}

fn tray_io(state: Arc<Mutex<FakeTray>>, conflict_db: Option<Arc<Database>>) -> ReadApplyTray {
    Box::new(move |target| {
        let mut state = state.lock().unwrap();
        state.calls.push(target);
        let Some(target) = target else {
            return Ok(state.actual);
        };
        if !target && state.fail_candidate {
            state.actual = target;
            state.candidate_attempted = true;
            state.fail_candidate = false;
            return Err("injected partial tray visibility failure".into());
        }
        if target && state.fail_restore && (state.candidate_attempted || state.candidate_applied) {
            return Err("injected tray visibility recovery failure".into());
        }
        state.actual = target;
        state.candidate_applied |= !target;
        drop(state);

        if !target {
            if let Some(db) = conflict_db.clone() {
                db.set_setting(
                    "settings-general",
                    r#"{"opacity":1.0,"showTrayIcon":true,"concurrentWriter":true}"#,
                )
                .map_err(|error| error.to_string())?;
            }
        }
        Ok(target)
    })
}

fn opacity_io(actual: Arc<Mutex<f64>>, calls: Arc<Mutex<Vec<Option<f64>>>>) -> ReadApplyOpacity {
    Box::new(move |target| {
        let actual = Arc::clone(&actual);
        let calls = Arc::clone(&calls);
        let operation: Pin<Box<dyn Future<Output = Result<f64, String>> + Send>> =
            Box::pin(async move {
                calls.lock().unwrap().push(target);
                let mut actual = actual.lock().unwrap();
                if let Some(target) = target {
                    *actual = target;
                }
                Ok(*actual)
            });
        operation
    })
}

fn unused_opacity_io() -> ReadApplyOpacity {
    Box::new(|_| Box::pin(async { panic!("tray-only patches must not access opacity") }))
}

fn tray_patch(value: bool) -> BTreeMap<String, Value> {
    BTreeMap::from([("showTrayIcon".to_owned(), json!(value))])
}

fn mixed_patch(opacity: f64, tray: bool) -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("opacity".to_owned(), json!(opacity)),
        ("showTrayIcon".to_owned(), json!(tray)),
    ])
}

fn stored(db: &Database) -> Value {
    serde_json::from_str(&db.read_renderer_general_settings().unwrap().unwrap()).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn tray_only_patch_commits_and_notifies_without_opacity_io() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeTray {
        actual: true,
        ..FakeTray::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&notifications);
    let receipt = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        tray_patch(false),
        &mut unused_opacity_io(),
        &mut tray_io(Arc::clone(&state), None),
        move |raw| {
            assert!(raw.contains(r#""showTrayIcon":false"#));
            count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap();

    assert_eq!(stored(&fixture.db)["showTrayIcon"], false);
    assert_eq!(state.lock().unwrap().actual, false);
    assert_eq!(state.lock().unwrap().calls, vec![None, Some(false)]);
    assert!(receipt.notification_delivered);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn tray_patch_that_matches_native_state_does_not_call_the_setter() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeTray {
        actual: false,
        ..FakeTray::default()
    }));

    execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        tray_patch(false),
        &mut unused_opacity_io(),
        &mut tray_io(Arc::clone(&state), None),
        |_| true,
    )
    .await
    .unwrap();

    assert_eq!(state.lock().unwrap().calls, vec![None]);
    assert_eq!(stored(&fixture.db)["showTrayIcon"], false);
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_tray_value_is_rejected_before_database_or_native_access() {
    let fixture = fixture();
    let mut no_tray_access: ReadApplyTray =
        Box::new(|_| panic!("invalid tray settings must not access native state"));
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        BTreeMap::from([("showTrayIcon".to_owned(), json!("false"))]),
        &mut unused_opacity_io(),
        &mut no_tray_access,
        |_| panic!("invalid tray settings must not notify"),
    )
    .await
    .unwrap_err();

    assert_eq!(error, "Tray visibility setting must be a boolean");
    assert_eq!(stored(&fixture.db)["showTrayIcon"], true);
}

#[tokio::test(flavor = "current_thread")]
async fn mixed_patch_reads_both_old_values_before_applying_and_committing() {
    let fixture = fixture();
    let log: Arc<Mutex<Vec<&'static str>>> = Arc::new(Mutex::new(Vec::new()));
    let opacity = Arc::new(Mutex::new(1.0));
    let opacity_calls = Arc::new(Mutex::new(Vec::new()));
    let opacity_log = Arc::clone(&log);
    let mut read_apply_opacity = {
        let actual = Arc::clone(&opacity);
        let calls = Arc::clone(&opacity_calls);
        Box::new(move |target: Option<f64>| {
            let actual = Arc::clone(&actual);
            let calls = Arc::clone(&calls);
            let log = Arc::clone(&opacity_log);
            Box::pin(async move {
                log.lock().unwrap().push(if target.is_some() {
                    "apply opacity"
                } else {
                    "read opacity"
                });
                calls.lock().unwrap().push(target);
                let mut actual = actual.lock().unwrap();
                if let Some(target) = target {
                    *actual = target;
                }
                Ok(*actual)
            }) as Pin<Box<dyn Future<Output = Result<f64, String>> + Send>>
        }) as ReadApplyOpacity
    };
    let tray_state = Arc::new(Mutex::new(FakeTray {
        actual: true,
        ..FakeTray::default()
    }));
    let tray_state_for_io = Arc::clone(&tray_state);
    let tray_log = Arc::clone(&log);
    let mut read_apply_tray: ReadApplyTray = Box::new(move |target| {
        tray_log.lock().unwrap().push(if target.is_some() {
            "apply tray"
        } else {
            "read tray"
        });
        let mut state = tray_state_for_io.lock().unwrap();
        state.calls.push(target);
        if let Some(target) = target {
            state.actual = target;
        }
        Ok(state.actual)
    });

    execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        mixed_patch(0.65, false),
        &mut read_apply_opacity,
        &mut read_apply_tray,
        |_| true,
    )
    .await
    .unwrap();

    assert_eq!(
        *log.lock().unwrap(),
        vec!["read opacity", "read tray", "apply opacity", "apply tray"]
    );
    assert_eq!(stored(&fixture.db)["opacity"], 0.65);
    assert_eq!(stored(&fixture.db)["showTrayIcon"], false);
    assert_eq!(*opacity.lock().unwrap(), 0.65);
    assert_eq!(tray_state.lock().unwrap().actual, false);
}

#[tokio::test(flavor = "current_thread")]
async fn partial_tray_failure_restores_tray_then_opacity_without_commit() {
    let fixture = fixture();
    let opacity = Arc::new(Mutex::new(1.0));
    let opacity_calls = Arc::new(Mutex::new(Vec::new()));
    let tray = Arc::new(Mutex::new(FakeTray {
        actual: true,
        fail_candidate: true,
        ..FakeTray::default()
    }));
    let receipt_calls = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&receipt_calls);
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        mixed_patch(0.65, false),
        &mut opacity_io(Arc::clone(&opacity), Arc::clone(&opacity_calls)),
        &mut tray_io(Arc::clone(&tray), None),
        move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap_err();

    assert!(error.contains("Tray visibility application failed"));
    assert_eq!(
        tray.lock().unwrap().calls,
        vec![None, Some(false), Some(true)]
    );
    assert_eq!(
        *opacity_calls.lock().unwrap(),
        vec![None, Some(0.65), Some(1.0)]
    );
    assert_eq!(tray.lock().unwrap().actual, true);
    assert_eq!(*opacity.lock().unwrap(), 1.0);
    assert_eq!(stored(&fixture.db)["opacity"], 1.0);
    assert_eq!(stored(&fixture.db)["showTrayIcon"], true);
    assert_eq!(receipt_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn mixed_cas_conflict_restores_both_native_values_and_preserves_conflict() {
    let fixture = fixture();
    let opacity = Arc::new(Mutex::new(1.0));
    let opacity_calls = Arc::new(Mutex::new(Vec::new()));
    let tray = Arc::new(Mutex::new(FakeTray {
        actual: true,
        ..FakeTray::default()
    }));
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        mixed_patch(0.65, false),
        &mut opacity_io(Arc::clone(&opacity), Arc::clone(&opacity_calls)),
        &mut tray_io(Arc::clone(&tray), Some(Arc::clone(&fixture.db))),
        |_| panic!("a conflicted mixed patch must not notify"),
    )
    .await
    .unwrap_err();

    assert_eq!(
        error,
        "Config error: General settings changed; reload before applying the patch"
    );
    assert_eq!(
        tray.lock().unwrap().calls,
        vec![None, Some(false), Some(true)]
    );
    assert_eq!(
        *opacity_calls.lock().unwrap(),
        vec![None, Some(0.65), Some(1.0)]
    );
    assert_eq!(tray.lock().unwrap().actual, true);
    assert_eq!(*opacity.lock().unwrap(), 1.0);
    assert_eq!(stored(&fixture.db)["concurrentWriter"], true);
}

#[tokio::test(flavor = "current_thread")]
async fn mixed_recovery_attempts_every_rollback_and_returns_fixed_failure_code() {
    let fixture = fixture();
    let opacity = Arc::new(Mutex::new(1.0));
    let opacity_calls = Arc::new(Mutex::new(Vec::new()));
    let tray = Arc::new(Mutex::new(FakeTray {
        actual: true,
        fail_candidate: true,
        fail_restore: true,
        ..FakeTray::default()
    }));
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        mixed_patch(0.65, false),
        &mut opacity_io(Arc::clone(&opacity), Arc::clone(&opacity_calls)),
        &mut tray_io(Arc::clone(&tray), None),
        |_| panic!("a failed mixed patch must not notify"),
    )
    .await
    .unwrap_err();

    assert_eq!(error, "SETTINGS_NATIVE_RECOVERY_FAILED");
    assert_eq!(
        tray.lock().unwrap().calls,
        vec![None, Some(false), Some(true)]
    );
    assert_eq!(
        *opacity_calls.lock().unwrap(),
        vec![None, Some(0.65), Some(1.0)]
    );
    assert_eq!(*opacity.lock().unwrap(), 1.0);
    assert_eq!(stored(&fixture.db)["opacity"], 1.0);
}

#[tokio::test(flavor = "current_thread")]
async fn tray_notification_failure_stays_committed_without_retry() {
    let fixture = fixture();
    let tray = Arc::new(Mutex::new(FakeTray {
        actual: true,
        ..FakeTray::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&notifications);
    let receipt = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        tray_patch(false),
        &mut unused_opacity_io(),
        &mut tray_io(Arc::clone(&tray), None),
        move |_| {
            count.fetch_add(1, Ordering::SeqCst);
            false
        },
    )
    .await
    .unwrap();

    assert_eq!(stored(&fixture.db)["showTrayIcon"], false);
    assert_eq!(tray.lock().unwrap().actual, false);
    assert!(!receipt.notification_delivered);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}
