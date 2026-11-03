//! Final publication and lifecycle revocation share one enqueue boundary.
use super::*;
pub(super) fn publish_result(
    r: &Runtime,
    job: &state::Job,
    files: Vec<protocol::FileEntry>,
    enqueue: impl FnOnce(Option<Value>),
) {
    let _delivery = r.delivery.lock();
    let mut s = r.state.lock();
    if !s.matches(job) {
        return;
    }
    s.metadata_files = files.len();
    let notice = s.notice(if files.is_empty() {
        Payload::Error(protocol::ErrorCode::MetadataFailed)
    } else {
        Payload::Drop(files)
    });
    drop(s);
    enqueue(notice);
}
fn acquire_revoke(r: &Runtime) -> parking_lot::MutexGuard<'_, ()> {
    #[cfg(test)]
    if let Some(attempt) = r.revoke_attempt.lock().clone() {
        if let Some(guard) = r.delivery.try_lock() {
            let _ = attempt.send(false);
            return guard;
        }
        let _ = attempt.send(true);
    }
    r.delivery.lock()
}
pub(super) fn revoke(
    r: &Runtime,
    change: impl FnOnce(&mut state::State),
    enqueue: impl FnOnce(Option<Value>),
) {
    let _delivery = acquire_revoke(r);
    let mut s = r.state.lock();
    let notice = s.hover(false);
    change(&mut s);
    drop(s);
    enqueue(notice);
}
#[cfg(test)]
mod tests {
    use super::*;
    fn live() -> (Runtime, state::Job) {
        let r = Runtime {
            delivery: Mutex::new(()),
            revoke_attempt: Mutex::new(None),
            state: Mutex::new(state::State::default()),
        };
        let job = {
            let mut s = r.state.lock();
            s.document_live = true;
            let c = s.context.clone();
            s.set(
                &c,
                None,
                Some(protocol::Rect {
                    x: 0.,
                    y: 0.,
                    width: 10.,
                    height: 10.,
                }),
            )
            .unwrap();
            s.accept(vec!["/fixture".into()]).unwrap()
        };
        (r, job)
    }
    #[test]
    fn actual_publish_and_attempted_revoke_have_one_behavioral_commit_order() {
        let (r, job) = live();
        let trace = std::sync::Mutex::new(Vec::new());
        let (attempt, attempted) = std::sync::mpsc::channel();
        *r.revoke_attempt.lock() = Some(attempt);
        std::thread::scope(|scope| {
            let (finished, done) = std::sync::mpsc::channel();
            publish_result(&r, &job, vec![], |_| {
                let runtime = &r;
                let trace = &trace;
                scope.spawn(move || {
                    revoke(runtime, |s| s.suspend(), |_| {});
                    trace.lock().unwrap().push("revoke-done");
                    let _ = finished.send(());
                });
                // Sent only after actual try_lock: true means proven contention;
                // false means revoke acquired the boundary and must finish before enqueue.
                if !attempted.recv().unwrap() {
                    done.recv().unwrap();
                }
                trace.lock().unwrap().push("enqueue");
            });
        });
        assert_eq!(*trace.lock().unwrap(), ["enqueue", "revoke-done"]);
        publish_result(&r, &job, vec![], |_| {
            trace.lock().unwrap().push("late-enqueue")
        });
        assert_eq!(*trace.lock().unwrap(), ["enqueue", "revoke-done"]);
        assert!(r.state.lock().running, "actual work is still charged");
    }
    #[test]
    fn revoke_first_for_hide_navigation_settings_and_exit_emits_nothing() {
        for op in 0..4 {
            let (r, job) = live();
            revoke(
                &r,
                |s| match op {
                    0 => s.suspend(),
                    1 => s.rotate(),
                    2 => {
                        s.rotate();
                        s.opening += 1
                    }
                    _ => {
                        s.rotate();
                        s.stopped = true
                    }
                },
                |_| {},
            );
            publish_result(&r, &job, vec![], |_| panic!("revoked job published"));
            assert!(r.state.lock().running, "actual worker is still charged");
        }
    }
}
