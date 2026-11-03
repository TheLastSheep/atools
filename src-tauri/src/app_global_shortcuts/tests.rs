//! Bounded callback state and real shared typed algorithm tests; no physical OS claims.
use super::*;
use crate::general_settings_runtime::app_shortcut_registry::{OwnedShortcut, ShortcutPort};
use atools_core::db::AppGlobalShortcutBinding;
use tauri_plugin_global_shortcut::Shortcut;

fn target(id: usize, epoch: u64) -> BindingTarget {
    BindingTarget {
        row_id: id.to_string(),
        epoch,
        config_generation: "config".into(),
        shortcut: "Alt+1".into(),
        path: format!("/{id}.app"),
        name: "same name".into(),
    }
}
fn row(id: usize, key: &str) -> AppGlobalShortcutBinding {
    AppGlobalShortcutBinding {
        row_id: id.to_string(),
        path: format!("/{id}.app"),
        name: "same name".into(),
        shortcut: key.into(),
        enabled: true,
        generation: "config".into(),
        public_matches: true,
    }
}
#[test]
fn pressed_repeat_released_and_pending_are_bounded() {
    let rt = Runtime::default();
    let first = target(0, 1);
    rt.signal(&first, true);
    rt.signal(&first, true);
    assert_eq!(rt.queue.lock().events.len(), 1);
    rt.signal(&first, false);
    rt.signal(&first, true);
    assert_eq!(rt.queue.lock().events.len(), 1);
    for id in 1..200 {
        rt.signal(&target(id, 1), true)
    }
    let q = rt.queue.lock();
    assert_eq!(q.events.len(), 64);
    assert_eq!(q.pending.len(), 64);
    assert_eq!(q.pressed.len(), 64);
    drop(q);
    rt.signal(&first, false);
    assert!(!rt
        .queue
        .lock()
        .pressed
        .contains(&(first.row_id, first.epoch)));
    rt.stop();
    rt.signal(&target(999, 1), true);
    assert!(rt.queue.lock().events.is_empty());
    // Release is never gated on stopping/current-generation/full queue.
    rt.queue.lock().pressed.insert(("late".into(), 4));
    rt.signal(
        &BindingTarget {
            row_id: "late".into(),
            ..target(1, 4)
        },
        false,
    );
    assert!(rt.queue.lock().pressed.is_empty());
}
#[test]
fn static_reserved_shortcuts_are_compared_after_normalization() {
    for key in ["CmdOrCtrl+W", "CmdOrCtrl+Q", "CmdOrCtrl+V"] {
        assert!(registry::validated_key(key).is_err(), "{key}")
    }
    assert!(registry::validated_key("Ctrl+Alt+9").is_ok());
}
#[test]
fn disabled_and_public_drift_never_become_owned_targets() {
    let mut disabled = row(1, "Ctrl+Alt+1");
    disabled.enabled = false;
    let mut drift = row(2, "Ctrl+Alt+2");
    drift.public_matches = false;
    assert!(registry::desired(&[disabled, drift], 1).unwrap().is_empty());
    let rows = [row(1, "Ctrl+Alt+1"), row(2, "Ctrl+Alt+2")];
    let desired = registry::desired(&rows, 3).unwrap();
    assert_eq!(desired.len(), 2);
    let targets = desired
        .into_values()
        .map(|r| r.target_code)
        .collect::<Vec<_>>();
    assert_ne!(targets[0].path, targets[1].path);
    assert_eq!(targets[0].name, targets[1].name);
    assert!(registry::desired(&[row(1, "Ctrl+Alt+1"), row(2, "Ctrl+Alt+1")], 1).is_err());
}
#[derive(Default)]
pub(super) struct Port {
    pub(super) bindings: BTreeMap<u32, BindingTarget>,
    pub(super) fail: Option<u32>,
}
impl ShortcutPort<BindingTarget> for Port {
    fn is_registered(&self, key: Shortcut) -> Result<bool, String> {
        Ok(self.bindings.contains_key(&key.id()))
    }
    fn register(&mut self, key: Shortcut, target: &BindingTarget) -> Result<(), String> {
        if self.fail == Some(key.id()) {
            return Err("OS conflict".into());
        }
        if self.bindings.contains_key(&key.id()) {
            return Err("owned elsewhere".into());
        }
        self.bindings.insert(key.id(), target.clone());
        Ok(())
    }
    fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
        self.bindings
            .remove(&key.id())
            .ok_or("not owned".into())
            .map(|_| ())
    }
}
#[test]
fn typed_os_probe_failure_preserves_old_target_and_external_owner() {
    let mut registry = registry::Registry::default();
    let mut port = Port::default();
    registry
        .replace_all(
            &mut port,
            registry::desired(&[row(1, "Ctrl+Alt+1")], 1).unwrap(),
        )
        .unwrap();
    let baseline = port.bindings.clone();
    let failing = registry::validated_key("Ctrl+Alt+2").unwrap();
    port.fail = Some(failing.id());
    assert!(registry
        .replace_all(
            &mut port,
            registry::desired(&[row(2, "Ctrl+Alt+2")], 2).unwrap()
        )
        .is_err());
    assert_eq!(port.bindings, baseline);
    port.fail = None;
    port.bindings.insert(failing.id(), target(99, 4));
    assert!(registry
        .replace_all(
            &mut port,
            registry::desired(&[row(2, "Ctrl+Alt+2")], 2).unwrap()
        )
        .is_err());
    assert_eq!(port.bindings.get(&failing.id()), Some(&target(99, 4)));
    assert_eq!(
        registry.entries.values().next().unwrap().target_code,
        baseline.values().next().unwrap().clone()
    );
}
#[test]
fn same_key_target_change_and_compensation_have_typed_generations() {
    let mut registry = registry::Registry::default();
    let mut port = Port::default();
    let before = registry::desired(&[row(1, "Ctrl+Alt+1")], 1).unwrap();
    registry.replace_all(&mut port, before).unwrap();
    let after = registry::desired(&[row(2, "Ctrl+Alt+1")], 2).unwrap();
    let snapshot = registry.replace_all(&mut port, after).unwrap();
    assert_eq!(port.bindings.values().next().unwrap().row_id, "2");
    registry.restore_snapshot(&mut port, snapshot).unwrap();
    assert_eq!(port.bindings.values().next().unwrap().row_id, "1");
    // Native transaction subsequently refreshes the rollback generation before publication.
    registry
        .replace_all(
            &mut port,
            registry::desired(&[row(1, "Ctrl+Alt+1")], 3).unwrap(),
        )
        .unwrap();
    assert_eq!(port.bindings.values().next().unwrap().epoch, 3);
    let owned: &OwnedShortcut<BindingTarget> = registry.entries.values().next().unwrap();
    assert_eq!(owned.target_code.epoch, 3);
}
#[test]
fn opaque_revision_changes_on_every_raw_snapshot_drift() {
    let rt = Runtime::default();
    let mut snapshot = atools_core::db::AppGlobalShortcutSnapshot {
        revision: 0,
        public_raw: Some("[]".into()),
        authority_raw: None,
        revision_raw: None,
        bindings: vec![],
    };
    let one = wire::projection(&rt, &snapshot).unwrap();
    assert_eq!(one, wire::projection(&rt, &snapshot).unwrap());
    for changed in [" [ ] ", "[]\n"] {
        snapshot.public_raw = Some(changed.into());
        let next = wire::projection(&rt, &snapshot).unwrap();
        assert_ne!(one["revision"], next["revision"]);
        assert_eq!(next["rows"], serde_json::json!([]));
    }
    snapshot.authority_raw = Some("raw authority change".into());
    assert_ne!(
        one["revision"],
        wire::projection(&rt, &snapshot).unwrap()["revision"]
    );
}
#[test]
fn wire_rejects_unknown_mutations_fields_and_grant_flags() {
    for value in [
        serde_json::json!({"kind":"shell","path":"/A.app"}),
        serde_json::json!({"kind":"remove","rowId":"x","confirmed":true}),
        serde_json::json!({"kind":"setEnabled","rowId":"x","enabled":false,"grant":{}}),
    ] {
        assert!(serde_json::from_value::<wire::MutationRequest>(value).is_err());
    }
}

#[test]
fn legacy_display_projection_keeps_rows_without_parsing_opaque_large_numbers() {
    let rt = Runtime::default();
    let snapshot = atools_core::db::AppGlobalShortcutSnapshot {
        revision: 0,
        public_raw: Some(r#"[{"id":"legacy","target":"plugin/cmd","extension":1e999,"huge":90071992547409931234567890},{"id":false,"enabled":false,"shortcut":"Alt+2","unknown":-1e999}]"#.into()),
        authority_raw: None, revision_raw: None, bindings: vec![],
    };
    let reply = wire::projection(&rt, &snapshot).unwrap();
    assert_eq!(reply["rows"].as_array().unwrap().len(), 2);
    assert_eq!(
        reply["rows"][0],
        serde_json::json!({"id":"legacy","target":"plugin/cmd"})
    );
    assert_eq!(
        reply["rows"][1],
        serde_json::json!({"enabled":false,"shortcut":"Alt+2"})
    );
    assert!(reply["bindings"].as_array().unwrap().is_empty());
}

#[test]
fn owned_callback_queue_carries_pause_epoch_to_actual_final_admission() {
    use super::recording_gate::Gate;
    let gate = Arc::new(Gate::default());
    let rt = Runtime::default();
    let binding = target(1, 1);
    let callback = gate.receipt(Some("Ctrl+A".into())).unwrap();
    callback.publish();
    let old = callback.edge(true).unwrap();
    rt.signal_at(&binding, true, old);
    callback.edge(false);
    let queued = rt.queue.lock().events.pop_front().unwrap();
    let epoch = rt
        .queue
        .lock()
        .epochs
        .remove(&(queued.row_id, queued.epoch))
        .unwrap();
    let target = crate::hotkey::recording::Target {
        session_id: "s".into(),
        label: "child".into(),
        origin: "local".into(),
        bundle_revision: "r".into(),
        visibility_epoch: 1,
    };
    gate.start(target.clone(), 1).unwrap();
    assert!(gate.admit(epoch).is_none()); // work already popped before recording start
    assert!(callback.edge(true).is_none()); // same actual callback now captures, never queues launch
    callback.edge(false);
    gate.stop(&target.session_id, 1).unwrap();
    assert!(gate.admit(epoch).is_none()); // no replay after stop
    let resumed = callback.edge(true).unwrap();
    assert!(gate.admit(resumed).is_some());
}

#[test]
fn failed_other_owner_shutdown_still_unregisters_actual_owned_app_registry() {
    let mut owned = registry::Registry::default();
    let mut port = Port::default();
    let desired = registry::desired(&[row(1, "Ctrl+Alt+1")], 1).unwrap();
    owned.replace_all(&mut port, desired).unwrap();
    assert_eq!(port.bindings.len(), 1);
    let result = worker::shutdown_steps(
        || Err("Main teardown failed".into()),
        || owned.replace_all(&mut port, BTreeMap::new()).map(|_| ()),
    );
    assert!(result.unwrap_err().contains("Main teardown failed"));
    assert!(port.bindings.is_empty());
    assert!(owned.entries.is_empty());
    assert_eq!(
        worker::shutdown_steps(|| Err("main".into()), || Err("apps".into())).unwrap_err(),
        "main; apps"
    );
}

#[test]
fn failed_exit_releases_only_attempt_and_explicit_retry_can_finish_owned_cleanup() {
    let rt = Arc::new(Runtime::default());
    let gate = recording_gate::Gate::default();
    let mut port = Port::default();
    rt.registry
        .lock()
        .replace_all(
            &mut port,
            registry::desired(&[row(1, "Ctrl+Alt+1")], 1).unwrap(),
        )
        .unwrap();
    gate.close();
    rt.stop();
    let first = ExitAttempt::claim(&rt).unwrap();
    assert!(ExitAttempt::claim(&rt).is_none());
    drop(first); // Actual request_exit error/cancel path drops its owned attempt.
    assert!(!rt.exit_started.load(Ordering::Acquire));
    assert!(rt.stopping.load(Ordering::Acquire));
    assert!(gate.closed());
    assert_eq!(rt.registry.lock().entries.len(), 1);
    assert_eq!(port.bindings.len(), 1);
    let retry = ExitAttempt::claim(&rt).unwrap();
    rt.registry
        .lock()
        .replace_all(&mut port, BTreeMap::new())
        .unwrap();
    retry.allow();
    assert!(rt.exit_allowed.load(Ordering::Acquire));
    assert!(rt.exit_started.load(Ordering::Acquire));
    assert!(ExitAttempt::claim(&rt).is_none());
    assert!(port.bindings.is_empty());
}

#[test]
fn concurrent_explicit_exit_requests_have_exactly_one_owned_attempt() {
    let rt = Arc::new(Runtime::default());
    rt.stop();
    let start = Arc::new(std::sync::Barrier::new(16));
    let finish = Arc::new(std::sync::Barrier::new(16));
    let threads = (0..16)
        .map(|_| {
            let rt = rt.clone();
            let start = start.clone();
            let finish = finish.clone();
            std::thread::spawn(move || {
                start.wait();
                let attempt = ExitAttempt::claim(&rt);
                finish.wait();
                attempt
            })
        })
        .collect::<Vec<_>>();
    let attempts = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        attempts.iter().filter(|attempt| attempt.is_some()).count(),
        1
    );
    drop(attempts);
    assert!(!rt.exit_started.load(Ordering::Acquire));
    assert!(ExitAttempt::claim(&rt).is_some());
    assert!(rt.stopping.load(Ordering::Acquire));
}
