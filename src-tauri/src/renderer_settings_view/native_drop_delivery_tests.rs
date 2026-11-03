use super::*;
use atools_core::db::Database;
use std::{
    collections::VecDeque,
    sync::{atomic::AtomicUsize, Mutex},
};

const SESSION: &str = "00000000000040008000000000000001";

fn pending(phase: NoticePhase, counts: DropCounts) -> PendingNotice {
    PendingNotice {
        phase,
        counts,
        busy: false,
        rejected: false,
    }
}

#[derive(Default)]
struct MainQueue(Mutex<VecDeque<ScheduledDelivery>>);

impl MainQueue {
    fn schedule(&self, task: ScheduledDelivery) -> Result<(), ()> {
        self.0.lock().unwrap().push_back(task);
        Ok(())
    }

    fn run_next(&self) {
        let task = self.0.lock().unwrap().pop_front().unwrap();
        task();
    }
}

// Exercise the Child's strict monotonic-revision acceptance rule against the
// scripts emitted by the actual native delivery function, not prebuilt notices.
struct BridgeReceiver {
    revision: AtomicU64,
    accepted: Mutex<Vec<serde_json::Value>>,
}

impl BridgeReceiver {
    fn eval(&self, script: &str) -> bool {
        let json = script
            .strip_prefix(&format!("window.{DELIVER_FUNCTION}("))
            .unwrap()
            .strip_suffix(");")
            .unwrap();
        let notice: serde_json::Value = serde_json::from_str(json).unwrap();
        let revision = notice["revision"].as_u64().unwrap();
        if revision <= self.revision.load(Ordering::Relaxed) {
            return true;
        }
        self.revision.store(revision, Ordering::Relaxed);
        self.accepted.lock().unwrap().push(notice);
        true
    }
}

#[tokio::test]
async fn successful_batch_result_queued_from_background_survives_inline_gui_hover() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("registered.txt");
    std::fs::write(&file, "registered").unwrap();
    let database = Arc::new(Database::in_memory().unwrap());
    let paths = validate_paths(&[file]).unwrap();
    let counts = execute_path_batch(
        &paths,
        || true,
        |path| {
            let database = Arc::clone(&database);
            async move { super::super::tests::add_path_to_database(&database, path) }
        },
    )
    .await;
    assert_eq!(
        counts,
        DropCounts {
            added: 1,
            failed: 0
        }
    );
    assert_eq!(database.read_renderer_local_shortcuts().unwrap().len(), 1);

    // Enter/Leave of the completed drop already consumed revisions 1 and 2.
    let revisions = Arc::new(AtomicU64::new(2));
    let queue = Arc::new(MainQueue::default());
    let target_reads = Arc::new(AtomicUsize::new(0));
    let bridge = Arc::new(BridgeReceiver {
        revision: AtomicU64::new(2),
        accepted: Mutex::new(Vec::new()),
    });
    let queued = {
        let queue = Arc::clone(&queue);
        let revisions = Arc::clone(&revisions);
        let target_reads = Arc::clone(&target_reads);
        let bridge = Arc::clone(&bridge);
        std::thread::spawn(move || {
            schedule_notice(
                pending(NoticePhase::Result, counts),
                SESSION.into(),
                revisions,
                move || {
                    target_reads.fetch_add(1, Ordering::Relaxed);
                    Some(())
                },
                move |(), script| bridge.eval(script),
                |task| queue.schedule(task),
            )
        })
        .join()
        .unwrap()
    };
    assert!(queued);
    assert_eq!(revisions.load(Ordering::Relaxed), 2);
    assert_eq!(target_reads.load(Ordering::Relaxed), 0);

    // Wry may execute a GUI sender inline before the queued background task.
    let hover_bridge = Arc::clone(&bridge);
    assert!(schedule_notice(
        pending(NoticePhase::Enter, DropCounts::default()),
        SESSION.into(),
        Arc::clone(&revisions),
        || Some(()),
        move |(), script| hover_bridge.eval(script),
        |task| {
            task();
            Ok::<_, ()>(())
        },
    ));
    queue.run_next();

    let accepted = bridge.accepted.lock().unwrap();
    assert_eq!(
        accepted.len(),
        2,
        "a successful write must notify the Child"
    );
    assert_eq!(accepted[0]["phase"], "enter");
    assert_eq!(accepted[0]["revision"], 3);
    assert_eq!(accepted[1]["phase"], "result");
    assert_eq!(accepted[1]["revision"], 4);
    assert_eq!(accepted[1]["added"], 1);
    assert_eq!(accepted[1]["failed"], 0);
    assert_eq!(target_reads.load(Ordering::Relaxed), 1);
}

#[test]
fn queued_delivery_rechecks_target_before_allocating_a_revision_or_evaluating() {
    let queue = MainQueue::default();
    let revisions = Arc::new(AtomicU64::new(0));
    let current = Arc::new(AtomicBool::new(true));
    let current_at_delivery = Arc::clone(&current);
    assert!(schedule_notice(
        pending(
            NoticePhase::Result,
            DropCounts {
                added: 1,
                failed: 0
            }
        ),
        SESSION.into(),
        Arc::clone(&revisions),
        move || current_at_delivery.load(Ordering::Acquire).then_some(()),
        |(), _| panic!("closed or stale Child must not receive a notice"),
        |task| queue.schedule(task),
    ));
    current.store(false, Ordering::Release);
    queue.run_next();
    assert_eq!(revisions.load(Ordering::Relaxed), 0);
}

#[test]
fn rejected_scheduler_and_invalid_counts_never_lookup_target_or_consume_revision() {
    let revisions = Arc::new(AtomicU64::new(0));
    assert!(!schedule_notice(
        pending(NoticePhase::Leave, DropCounts::default()),
        SESSION.into(),
        Arc::clone(&revisions),
        || -> Option<()> { panic!("rejected scheduler must not lookup target") },
        |(), _| panic!("rejected scheduler must not eval"),
        |_| Err(()),
    ));
    assert!(!schedule_notice(
        pending(
            NoticePhase::Result,
            DropCounts {
                added: 65,
                failed: 0
            }
        ),
        SESSION.into(),
        Arc::clone(&revisions),
        || -> Option<()> { panic!("invalid DTO must not lookup target") },
        |(), _| panic!("invalid DTO must not eval"),
        |_| -> Result<(), ()> { panic!("invalid DTO must not be scheduled") },
    ));
    assert_eq!(revisions.load(Ordering::Relaxed), 0);
}

#[test]
fn exhausted_revisions_do_not_eval_and_eval_failure_never_reuses_a_revision() {
    let payload = pending(NoticePhase::Leave, DropCounts::default());
    let exhausted = AtomicU64::new(MAX_SAFE_INTEGER);
    assert!(!deliver_notice(
        payload,
        SESSION.into(),
        &exhausted,
        || Some(()),
        |(), _| { panic!("exhausted revisions must not eval") }
    ));
    let revisions = AtomicU64::new(0);
    assert!(!deliver_notice(
        payload,
        SESSION.into(),
        &revisions,
        || Some(()),
        |(), _| false
    ));
    assert_eq!(next_revision(&revisions), Some(2));
}
