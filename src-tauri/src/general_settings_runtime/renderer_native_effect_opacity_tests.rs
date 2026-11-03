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
struct FakeOpacity {
    actual: f64,
    calls: Vec<Option<f64>>,
    fail_candidate: bool,
    fail_restore: bool,
    candidate_attempted: bool,
    candidate_applied: bool,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let database_path = directory.path().join("opacity.sqlite");
    let db = Arc::new(Database::open(&database_path).unwrap());
    db.set_setting(
        "settings-general",
        r#"{"opacity":1.0,"unrelated":{"preserved":true}}"#,
    )
    .unwrap();
    let expected = db.read_renderer_general_settings().unwrap().unwrap();
    Fixture {
        _directory: directory,
        db,
        expected,
    }
}

fn opacity_io(
    state: Arc<Mutex<FakeOpacity>>,
    conflict_db: Option<Arc<Database>>,
) -> ReadApplyOpacity {
    Box::new(move |target| {
        let state = Arc::clone(&state);
        let conflict_db = conflict_db.clone();
        let operation: Pin<Box<dyn Future<Output = Result<f64, String>> + Send>> =
            Box::pin(async move {
                let mut state = state.lock().unwrap();
                state.calls.push(target);
                let Some(target) = target else {
                    return Ok(state.actual);
                };
                if target == 0.65 && state.fail_candidate {
                    state.actual = 0.73;
                    state.candidate_attempted = true;
                    state.fail_candidate = false;
                    return Err("injected native apply failure".into());
                }
                if target == 1.0
                    && state.fail_restore
                    && (state.candidate_attempted || state.candidate_applied)
                {
                    return Err("injected native recovery failure".into());
                }
                state.actual = target;
                state.candidate_applied |= target != 1.0;
                drop(state);

                if target == 0.65 {
                    if let Some(db) = conflict_db {
                        db.set_setting(
                            "settings-general",
                            r#"{"opacity":0.9,"concurrentWriter":true}"#,
                        )
                        .map_err(|error| error.to_string())?;
                    }
                }
                Ok(target)
            });
        operation
    })
}

fn unused_tray_io() -> ReadApplyTray {
    Box::new(|_| panic!("opacity-only and pure patches must not access the tray"))
}

fn opacity_patch(value: f64) -> BTreeMap<String, Value> {
    BTreeMap::from([("opacity".to_owned(), json!(value))])
}

fn stored(db: &Database) -> Value {
    serde_json::from_str(&db.read_renderer_general_settings().unwrap().unwrap()).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn opacity_patch_applies_reads_back_commits_then_notifies_once() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        ..FakeOpacity::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);
    let receipt = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        opacity_patch(0.65),
        &mut opacity_io(Arc::clone(&state), None),
        &mut unused_tray_io(),
        move |raw| {
            assert!(raw.contains(r#""opacity":0.65"#));
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap();

    assert_eq!(stored(&fixture.db)["opacity"], 0.65);
    assert_eq!(stored(&fixture.db)["unrelated"]["preserved"], true);
    assert_eq!(state.lock().unwrap().actual, 0.65);
    assert_eq!(state.lock().unwrap().calls, vec![None, Some(0.65)]);
    assert!(receipt.notification_delivered);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn failed_native_apply_restores_actual_alpha_and_does_not_commit_or_notify() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        fail_candidate: true,
        ..FakeOpacity::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        opacity_patch(0.65),
        &mut opacity_io(Arc::clone(&state), None),
        &mut unused_tray_io(),
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap_err();

    assert!(error.contains("Window opacity application failed"));
    assert_eq!(state.lock().unwrap().actual, 1.0);
    assert_eq!(
        state.lock().unwrap().calls,
        vec![None, Some(0.65), Some(1.0)]
    );
    assert_eq!(stored(&fixture.db)["opacity"], 1.0);
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn cas_conflict_after_apply_restores_alpha_and_preserves_conflict_error() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        ..FakeOpacity::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        opacity_patch(0.65),
        &mut opacity_io(Arc::clone(&state), Some(Arc::clone(&fixture.db))),
        &mut unused_tray_io(),
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap_err();

    assert_eq!(
        error,
        "Config error: General settings changed; reload before applying the patch"
    );
    assert_eq!(state.lock().unwrap().actual, 1.0);
    assert_eq!(stored(&fixture.db)["concurrentWriter"], true);
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn commit_conflict_with_failed_restore_reports_uncertain_native_state() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        fail_restore: true,
        ..FakeOpacity::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        opacity_patch(0.65),
        &mut opacity_io(Arc::clone(&state), Some(Arc::clone(&fixture.db))),
        &mut unused_tray_io(),
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap_err();

    assert_eq!(error, "SETTINGS_OPACITY_RECOVERY_FAILED");
    assert_eq!(state.lock().unwrap().actual, 0.65);
    assert_eq!(stored(&fixture.db)["concurrentWriter"], true);
    assert_eq!(notifications.load(Ordering::SeqCst), 0);
}

#[tokio::test(flavor = "current_thread")]
async fn recovery_failure_is_explicit_when_native_apply_partially_changes_alpha() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        fail_candidate: true,
        fail_restore: true,
        ..FakeOpacity::default()
    }));
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        opacity_patch(0.65),
        &mut opacity_io(Arc::clone(&state), None),
        &mut unused_tray_io(),
        |_| true,
    )
    .await
    .unwrap_err();

    assert_eq!(error, "SETTINGS_OPACITY_RECOVERY_FAILED");
    assert_eq!(state.lock().unwrap().actual, 0.73);
    assert_eq!(stored(&fixture.db)["opacity"], 1.0);
}

#[tokio::test(flavor = "current_thread")]
async fn stale_cas_is_rejected_before_native_access() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        ..FakeOpacity::default()
    }));
    let error = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some("stale snapshot".into()),
        opacity_patch(0.65),
        &mut opacity_io(Arc::clone(&state), None),
        &mut unused_tray_io(),
        |_| panic!("conflicted opacity writes must not notify"),
    )
    .await
    .unwrap_err();

    assert_eq!(
        error,
        "Config error: General settings changed; reload before applying the patch"
    );
    assert!(state.lock().unwrap().calls.is_empty());
    assert_eq!(stored(&fixture.db)["opacity"], 1.0);
}

#[tokio::test(flavor = "current_thread")]
async fn non_opacity_patch_keeps_old_commit_path_without_native_io() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        ..FakeOpacity::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);
    let receipt = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        BTreeMap::from([("theme".to_owned(), json!("dark"))]),
        &mut opacity_io(Arc::clone(&state), None),
        &mut unused_tray_io(),
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            true
        },
    )
    .await
    .unwrap();

    assert_eq!(stored(&fixture.db)["theme"], "dark");
    assert!(state.lock().unwrap().calls.is_empty());
    assert!(receipt.notification_delivered);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}

#[tokio::test(flavor = "current_thread")]
async fn notification_failure_keeps_committed_opacity_and_is_not_retried() {
    let fixture = fixture();
    let state = Arc::new(Mutex::new(FakeOpacity {
        actual: 1.0,
        ..FakeOpacity::default()
    }));
    let notifications = Arc::new(AtomicUsize::new(0));
    let notify_count = Arc::clone(&notifications);
    let receipt = execute_renderer_patch(
        Arc::clone(&fixture.db),
        Some(fixture.expected.clone()),
        opacity_patch(0.65),
        &mut opacity_io(Arc::clone(&state), None),
        &mut unused_tray_io(),
        move |_| {
            notify_count.fetch_add(1, Ordering::SeqCst);
            false
        },
    )
    .await
    .unwrap();

    assert_eq!(stored(&fixture.db)["opacity"], 0.65);
    assert_eq!(state.lock().unwrap().actual, 0.65);
    assert!(!receipt.notification_delivered);
    assert_eq!(notifications.load(Ordering::SeqCst), 1);
}
