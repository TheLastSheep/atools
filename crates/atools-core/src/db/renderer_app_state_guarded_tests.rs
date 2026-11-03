use std::{
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

use rusqlite::TransactionBehavior;
use serde_json::{json, Value};

use super::*;

static SQLITE_BUSY_CALLBACKS: AtomicUsize = AtomicUsize::new(0);
static SQLITE_BUSY_TEST_LOCK: Mutex<()> = Mutex::new(());

fn app(path: &str, name: &str) -> RendererAppIdentity {
    RendererAppIdentity {
        path: path.to_owned(),
        name: name.to_owned(),
        sub_type: RendererDirectSubtype::App,
    }
}

fn assert_guard_rejection(error: crate::error::AToolsError) {
    match error {
        crate::error::AToolsError::Config(message) => {
            assert_eq!(message, RENDERER_APP_STATE_GUARD_REJECTED)
        }
        other => panic!("expected stable guard rejection, got {other:?}"),
    }
}

#[test]
fn false_guard_rejects_before_reading_or_changing_persisted_state() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("guard-rejected.sqlite");
    let db = Database::open(&path).unwrap();
    let raw_history = "malformed history remains untouched";
    let raw_pins = json!([{
        "path": "/Applications/Editor.app",
        "name": "Editor",
        "type": "direct",
        "subType": "app",
        "customMetadata": {"keep": true}
    }])
    .to_string();
    db.set_setting(HISTORY_STORAGE_KEY, raw_history).unwrap();
    db.set_setting(PINS_STORAGE_KEY, &raw_pins).unwrap();
    db.set_setting(REVISION_KEY, "19").unwrap();
    db.set_setting("ztools-renderer:other-metadata", "preserve-me")
        .unwrap();

    let called = std::cell::Cell::new(false);
    let error = db
        .apply_renderer_app_state_guarded(RendererAppStateMutation::ClearHistory, || {
            called.set(true);
            false
        })
        .unwrap_err();
    assert!(called.get());
    assert_guard_rejection(error);
    assert_eq!(
        db.get_setting(HISTORY_STORAGE_KEY).unwrap().as_deref(),
        Some(raw_history)
    );
    assert_eq!(
        db.get_setting(PINS_STORAGE_KEY).unwrap().as_deref(),
        Some(raw_pins.as_str())
    );
    assert_eq!(db.get_setting(REVISION_KEY).unwrap().as_deref(), Some("19"));
    assert_eq!(
        db.get_setting("ztools-renderer:other-metadata")
            .unwrap()
            .as_deref(),
        Some("preserve-me")
    );
    drop(db);

    let reopened = Database::open(&path).unwrap();
    assert_eq!(
        reopened
            .get_setting(HISTORY_STORAGE_KEY)
            .unwrap()
            .as_deref(),
        Some(raw_history)
    );
    assert_eq!(
        reopened.get_setting(PINS_STORAGE_KEY).unwrap().as_deref(),
        Some(raw_pins.as_str())
    );
    assert_eq!(
        reopened.get_setting(REVISION_KEY).unwrap().as_deref(),
        Some("19")
    );
}

#[test]
fn true_guard_keeps_app_state_semantics_and_unrelated_data_on_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("guard-accepted.sqlite");
    let db = Database::open(&path).unwrap();
    let raw_history = json!([{
        "path": "/Applications/Editor.app",
        "name": "Editor",
        "type": "direct",
        "subType": "app",
        "lastUsed": 12,
        "useCount": 3,
        "customMetadata": {"source": "history"}
    }])
    .to_string();
    let existing_pins = json!([
        {
            "path": "plugin:calculator",
            "name": "Calculator",
            "type": "plugin",
            "featureCode": "calculate",
            "customMetadata": {"source": "plugin"}
        },
        {
            "path": "/Applications/Editor.app",
            "name": "Editor",
            "type": "direct",
            "subType": "app",
            "customMetadata": {"source": "pin"}
        }
    ])
    .to_string();
    db.set_setting(HISTORY_STORAGE_KEY, &raw_history).unwrap();
    db.set_setting(PINS_STORAGE_KEY, &existing_pins).unwrap();
    db.set_setting(REVISION_KEY, "4").unwrap();
    db.set_setting("ztools-renderer:other-metadata", "untouched")
        .unwrap();
    db.set_setting(PINS_KEY, "legacy value stays untouched")
        .unwrap();

    let guard_calls = std::cell::Cell::new(0);
    let snapshot = db
        .apply_renderer_app_state_guarded(
            RendererAppStateMutation::Pin {
                app: app("/Applications/Editor Beta.app", "Editor Beta"),
            },
            || {
                guard_calls.set(guard_calls.get() + 1);
                true
            },
        )
        .unwrap();
    assert_eq!(guard_calls.get(), 1);
    assert_eq!(snapshot.revision, 5);
    assert_eq!(snapshot.changed, vec![PINS_KEY.to_owned()]);
    assert_eq!(
        snapshot.values[HISTORY_KEY].as_deref(),
        Some(raw_history.as_str())
    );
    let pins: Vec<Value> =
        serde_json::from_str(snapshot.values[PINS_KEY].as_deref().unwrap()).unwrap();
    assert_eq!(pins.len(), 3);
    assert_eq!(pins[0]["customMetadata"]["source"], "plugin");
    assert_eq!(pins[1]["customMetadata"]["source"], "pin");
    assert_eq!(pins[2]["path"], "/Applications/Editor Beta.app");
    assert_eq!(
        db.get_setting("ztools-renderer:other-metadata")
            .unwrap()
            .as_deref(),
        Some("untouched")
    );
    assert_eq!(
        db.get_setting(PINS_KEY).unwrap().as_deref(),
        Some("legacy value stays untouched")
    );
    drop(db);

    let reopened = Database::open(&path).unwrap();
    let persisted = reopened.read_renderer_app_state().unwrap();
    assert_eq!(persisted.revision, 5);
    assert_eq!(
        persisted.values[HISTORY_KEY].as_deref(),
        Some(raw_history.as_str())
    );
    let persisted_pins: Vec<Value> =
        serde_json::from_str(persisted.values[PINS_KEY].as_deref().unwrap()).unwrap();
    assert_eq!(persisted_pins, pins);
    assert_eq!(persisted.changed, Vec::<String>::new());
}

#[test]
fn queued_immediate_mutation_is_rejected_if_guard_closes_before_lock_release() {
    let _serial = SQLITE_BUSY_TEST_LOCK.lock().unwrap();
    SQLITE_BUSY_CALLBACKS.store(0, Ordering::Release);

    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("queued-guard.sqlite");
    let writer = Database::open(&path).unwrap();
    writer.set_setting(HISTORY_STORAGE_KEY, "[]").unwrap();
    writer.set_setting(PINS_STORAGE_KEY, "[]").unwrap();
    writer.set_setting(REVISION_KEY, "7").unwrap();
    let queued = Database::open(&path).unwrap();
    queued
        .conn
        .lock()
        .busy_handler(Some(observe_sqlite_busy))
        .unwrap();

    let mut writer_connection = writer.conn.lock();
    let blocker = writer_connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .unwrap();

    let session_active = Arc::new(AtomicBool::new(true));
    let guard_calls = Arc::new(AtomicUsize::new(0));
    let thread_session_active = Arc::clone(&session_active);
    let thread_guard_calls = Arc::clone(&guard_calls);
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let result = queued.apply_renderer_app_state_guarded(
            RendererAppStateMutation::Pin {
                app: app("/Applications/Queued.app", "Queued"),
            },
            move || {
                thread_guard_calls.fetch_add(1, Ordering::AcqRel);
                thread_session_active.load(Ordering::Acquire)
            },
        );
        result_tx.send(
            result
                .map(|snapshot| snapshot.revision)
                .map_err(|e| e.to_string()),
        )
    });

    wait_for_busy_callback();
    assert!(matches!(
        result_rx.recv_timeout(Duration::from_millis(40)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    session_active.store(false, Ordering::Release);
    drop(blocker);
    drop(writer_connection);

    let result = result_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("queued mutation should finish after Immediate is released");
    assert_eq!(
        result,
        Err(format!("Config error: {RENDERER_APP_STATE_GUARD_REJECTED}"))
    );
    assert_eq!(guard_calls.load(Ordering::Acquire), 1);
    worker.join().unwrap().unwrap();
    drop(writer);

    let reopened = Database::open(&path).unwrap();
    let snapshot = reopened.read_renderer_app_state().unwrap();
    assert_eq!(snapshot.revision, 7);
    assert_eq!(snapshot.values[HISTORY_KEY].as_deref(), Some("[]"));
    assert_eq!(snapshot.values[PINS_KEY].as_deref(), Some("[]"));
}

fn observe_sqlite_busy(_attempt: i32) -> bool {
    SQLITE_BUSY_CALLBACKS.fetch_add(1, Ordering::AcqRel);
    thread::sleep(Duration::from_millis(2));
    true
}

fn wait_for_busy_callback() {
    let deadline = Instant::now() + Duration::from_secs(3);
    while SQLITE_BUSY_CALLBACKS.load(Ordering::Acquire) == 0 {
        assert!(Instant::now() < deadline, "Immediate request did not queue");
        thread::sleep(Duration::from_millis(2));
    }
}
