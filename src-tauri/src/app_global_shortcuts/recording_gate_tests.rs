use super::*;
fn target() -> Target {
    Target {
        session_id: "a".repeat(32),
        label: "settings".into(),
        origin: "local".into(),
        bundle_revision: "revision".into(),
        visibility_epoch: 1,
    }
}
fn receipt(g: &Arc<Gate>, capture: Option<&str>) -> Arc<Receipt> {
    let r = g.receipt(capture.map(str::to_owned)).unwrap();
    r.publish();
    r
}
#[test]
fn action_and_start_have_one_atomic_winner_and_old_work_never_replays() {
    let g = Arc::new(Gate::default());
    let epoch = g.epoch();
    let action = g.admit(epoch).unwrap();
    assert_eq!(g.start(target(), 1).err().as_deref(), Some(BUSY));
    drop(action);
    let ack = g.start(target(), 1).unwrap();
    assert!(ack.active);
    assert!(g.admit(epoch).is_none());
    assert!(g.stop(&target().session_id, 1).unwrap().drained);
    assert!(g.admit(epoch).is_none());
    assert!(g.admit(g.epoch()).is_some());
}
#[test]
fn overlapping_capture_and_suppression_drain_real_release_once() {
    let g = Arc::new(Gate::default());
    let a = receipt(&g, Some("Ctrl+A"));
    let b = receipt(&g, Some("Ctrl+B"));
    let s = receipt(&g, None);
    let ack = g.start(target(), 1).unwrap();
    assert_eq!(ack.token.as_ref().unwrap().len(), 32);
    assert!(a.edge(true).is_none());
    assert!(a.edge(true).is_none());
    assert!(b.edge(true).is_none());
    assert!(s.edge(true).is_none());
    a.edge(false);
    let (_, n) = g.tick();
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].value["shortcut"], "Ctrl+A");
    b.edge(false);
    assert!(g.tick().1.is_empty());
    assert!(!g.stop(&target().session_id, 1).unwrap().drained);
    assert!(s.edge(true).is_none());
    assert!(g.busy());
    assert_eq!(g.tick().1[0].value["drained"], false);
    s.edge(false);
    assert!(!g.busy());
    let (_, n) = g.tick();
    assert_eq!(n.len(), 1);
    assert_eq!(n[0].value["drained"], true);
    assert!(g.stop(&target().session_id, 1).unwrap().drained);
    assert!(s.edge(true).is_some());
    s.edge(false);
}
#[test]
fn stop_wins_late_start_and_old_generation_cannot_stop_new() {
    let g = Arc::new(Gate::default());
    g.stop(&target().session_id, 1).unwrap();
    assert_eq!(g.start(target(), 1).err().as_deref(), Some(STALE));
    g.start(target(), 2).unwrap();
    assert_eq!(
        g.stop(&target().session_id, 1).err().as_deref(),
        Some(STALE)
    );
    assert!(g.start(target(), 2).unwrap().active);
}
#[test]
fn timeout_does_not_clear_held_and_confirmed_callback_withdrawal_does() {
    let g = Arc::new(Gate::default());
    let r = receipt(&g, Some("Ctrl+A"));
    g.start(target(), 1).unwrap();
    r.edge(true);
    g.state.lock().recording.as_mut().unwrap().deadline = Instant::now();
    let (_, n) = g.tick();
    assert_eq!(n[0].value["reason"], "timeout");
    assert_eq!(n[0].value["drained"], false);
    assert_eq!(g.start(target(), 2).err().as_deref(), Some(BUSY));
    assert!(r.edge(true).is_none());
    drop(r);
    assert!(!g.busy());
    assert_eq!(g.tick().1[0].value["drained"], true);
}
#[test]
fn capacities_are_separate_and_unpublished_or_held_registration_blocks_start() {
    let g = Arc::new(Gate::default());
    let unpublished = g.receipt(Some("Ctrl+A".into())).unwrap();
    assert_eq!(g.start(target(), 1).err().as_deref(), Some(BUSY));
    unpublished.edge(true);
    unpublished.publish();
    assert_eq!(g.start(target(), 1).err().as_deref(), Some(BUSY));
    unpublished.edge(false);
    let mut captures = vec![unpublished];
    for _ in 1..65 {
        captures.push(receipt(&g, Some("Ctrl+A")));
    }
    assert!(g.receipt(Some("Ctrl+Z".into())).is_err());
    let mut suppressions = Vec::new();
    for _ in 0..132 {
        suppressions.push(receipt(&g, None));
    }
    assert!(g.receipt(None).is_err());
    assert!(g.start(target(), 1).is_ok());
}
#[test]
fn close_permanently_fences_actions_and_held_receipts_survive_cancel() {
    let g = Arc::new(Gate::default());
    let r = receipt(&g, None);
    g.start(target(), 1).unwrap();
    r.edge(true);
    g.cancel(None, "cancelled");
    g.close();
    assert!(r.edge(true).is_none());
    assert!(g.admit(g.epoch()).is_none());
    r.edge(false);
    assert!(g.busy());
    assert!(g.closed());
}
#[test]
fn concurrent_barrier_start_or_action_is_exclusive() {
    for _ in 0..32 {
        let g = Arc::new(Gate::default());
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let worker_g = g.clone();
        let worker_barrier = barrier.clone();
        let worker = std::thread::spawn(move || {
            worker_barrier.wait();
            worker_g.admit(0)
        });
        barrier.wait();
        let start = g.start(target(), 1);
        let action = worker.join().unwrap();
        assert_ne!(start.is_ok(), action.is_some());
    }
}

#[test]
fn queued_weak_receipt_cannot_admit_after_owned_callback_is_withdrawn() {
    let g = Arc::new(Gate::default());
    let r = receipt(&g, None);
    let stamp = r.edge(true).unwrap();
    r.edge(false);
    let queued = Arc::downgrade(&r);
    drop(r);
    assert!(queued.upgrade().is_none());
    let replacement = receipt(&g, None);
    assert!(replacement.admit(stamp).is_some()); // A separate genuine registration may act.
}

#[test]
fn ack_and_notice_have_closed_wire_fields_and_token_remains_after_stop() {
    let g = Arc::new(Gate::default());
    let r = receipt(&g, Some("Ctrl+A"));
    let start = g.start(target(), 1).unwrap();
    let value = serde_json::to_value(&start).unwrap();
    assert_eq!(value.as_object().unwrap().len(), 6);
    assert_eq!(value["version"], 1);
    r.edge(true);
    r.edge(false);
    let notice = g.tick().1.pop().unwrap();
    assert_eq!(notice.value.as_object().unwrap().len(), 6);
    assert_eq!(notice.value["token"], value["token"]);
    let stop = g.stop(&target().session_id, 1).unwrap();
    assert_eq!(stop.token, start.token);
    let stopped = g.tick().1.pop().unwrap();
    assert_eq!(stopped.value.as_object().unwrap().len(), 7);
    assert_eq!(stopped.value["drained"], true);
}

#[test]
fn confirmed_retirement_fences_already_upgraded_queue_arc() {
    let g = Arc::new(Gate::default());
    let callback = receipt(&g, None);
    let epoch = callback.edge(true).unwrap();
    callback.edge(false);
    let queued = Arc::downgrade(&callback).upgrade().unwrap();
    callback.retire();
    assert!(queued.admit(epoch).is_none());
    callback.retire();
    assert!(queued.edge(true).is_none());
}
