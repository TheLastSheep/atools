//! Actual Settings session transitions arbitrate the Native display lease.
use super::*;
use crate::renderer_settings_view::{bundle::SettingsBundle, preferences::SettingsPreferences};
use serde_json::json;
fn begin(runtime: &Arc<SettingsViewRuntime>, id: &str) -> SessionView {
    let s = runtime
        .begin_session(
            id.into(),
            Arc::new(SettingsBundle::height_test_bundle("bundle")),
            Arc::new(SettingsPreferences::height_test_preferences(None)),
            json!({}),
            json!("darwin"),
        )
        .unwrap();
    runtime.mark_opened_with(id, |_| Ok(())).unwrap();
    runtime.note_index_request(&s.label, &s.origin).unwrap();
    runtime.record_page_started(id).unwrap();
    runtime.record_ready(id, &s.bundle_revision).unwrap();
    runtime.mark_open_with(id, |_| Ok(())).unwrap();
    s
}
#[test]
fn all_four_real_revocation_paths_reject_uncommitted_display() {
    for mode in 0..4 {
        let runtime = Arc::new(SettingsViewRuntime::default());
        let session = begin(&runtime, "old");
        let grant = runtime.updater_grant(&session).unwrap();
        match mode {
            0 => {
                runtime.mark_closing("old", "child-out").unwrap();
            }
            1 => {
                assert!(runtime.record_page_started("old").unwrap());
            }
            2 => {
                assert!(runtime.take_if("old").is_some());
            }
            _ => {
                assert!(runtime.take_for_shutdown("old").is_some());
            }
        }
        assert!(grant.admit().is_err(), "revocation mode {mode}");
    }
}
#[test]
fn display_commit_is_once_and_old_generation_cannot_admit_after_reopen() {
    let runtime = Arc::new(SettingsViewRuntime::default());
    let session = begin(&runtime, "old");
    let committed = runtime.updater_grant(&session).unwrap();
    let old = runtime.updater_grant(&session).unwrap();
    committed.admit().unwrap();
    assert!(committed.admit().is_err());
    runtime.mark_closing("old", "child-out").unwrap();
    runtime.take_if("old").unwrap();
    let next = begin(&runtime, "new");
    assert!(old.admit().is_err());
    runtime.updater_grant(&next).unwrap().admit().unwrap();
}
#[test]
fn grant_requires_the_same_native_session_identity_not_a_copied_label() {
    let runtime = Arc::new(SettingsViewRuntime::default());
    let session = begin(&runtime, "old");
    let mut forged = session.clone();
    forged.revoked = Arc::new(AtomicBool::new(false));
    assert!(runtime.updater_grant(&forged).is_err());
    let grant = runtime.updater_grant(&session).unwrap();
    // Admission and revocation share the same underlying lock, with Native effects outside it.
    let inner = runtime.inner.lock().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let task = std::thread::spawn(move || {
        tx.send(grant.admit()).unwrap();
    });
    assert!(rx.try_recv().is_err());
    drop(inner);
    assert!(rx.recv().unwrap().is_ok());
    task.join().unwrap();
}

impl SettingsViewRuntime {
    pub(crate) fn poisoned_snapshot_for_test() -> serde_json::Value {
        let runtime = Arc::new(Self::default());
        let worker = runtime.clone();
        assert!(std::thread::spawn(move || {
            let _guard = worker.inner.lock().unwrap();
            panic!("intentional diagnostic poison")
        })
        .join()
        .is_err());
        runtime.diagnostics(false, Some(0))
    }
}
