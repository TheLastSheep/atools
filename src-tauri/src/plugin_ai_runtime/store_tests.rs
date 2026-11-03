use super::*;
use crate::plugin_ai_runtime::types::{Binding, Mode, Request};
use atools_core::{agent::PermissionDecision, ai_service::AiRequest};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

fn request(plugin: &str, client: &str, generation: u64) -> Arc<Request> {
    Arc::new(Request {
        id: uuid::Uuid::new_v4().to_string(),
        client_id: client.into(),
        owner: Owner::new("main", plugin, "741ba0d4-6adb-40bf-8514-3d07e9513a86").unwrap(),
        frame: FrameBinding::validate(generation, "0123456789abcdef0123456789abcdef".into(), None)
            .unwrap(),
        document: None,
        binding: Binding {
            path: "/private/plugin".into(),
            version: "1".into(),
            code_revision: None,
            settings_revision: "settings".into(),
        },
        tool: "atools.plugin.ai.test".into(),
        permission_at_prepare: PermissionDecision::Confirm,
        mode: Mode::Collect,
        model: "configured-model".into(),
        request: Mutex::new(None::<AiRequest>),
        created: Instant::now(),
        cancel: crate::ai_runtime::AiCancelHandle::new(),
        run_id: Mutex::new(None),
        submitted: Mutex::new(false),
        started: Mutex::new(false),
        task_terminal: Mutex::new(false),
        running_at: Mutex::new(None),
        output: Mutex::new(None),
        output_bytes: Mutex::new(0),
        delta_count: Mutex::new(0),
        expires_result: Mutex::new(None),
        channel: Mutex::new(None),
        ack: Mutex::new(None),
        active: Mutex::new(true),
    })
}

#[test]
fn plugin_slot_releases_only_after_taskrun_terminal_and_close_drains_indexes() {
    let runtime = Runtime::default();
    let first = request("same-plugin", "client-one", 1);
    runtime.insert(first.clone()).unwrap();
    assert!(runtime
        .insert(request("same-plugin", "client-two", 1))
        .is_err());
    *first.task_terminal.lock() = true;
    runtime
        .insert(request("same-plugin", "client-two", 1))
        .unwrap();
    let removed = runtime.close_matching(Some("same-plugin"), None, None, false);
    assert_eq!(removed.len(), 2);
    assert_eq!(runtime.counts(), (0, 0, 0, 0, 0));
}

#[test]
fn stale_frame_cannot_cancel_owner_request_and_tombstones_fail_closed_then_prune() {
    let runtime = Runtime::default();
    let active = request("owner", "active", 3);
    let owner = active.owner.clone();
    runtime.insert(active).unwrap();
    let stale_frame =
        FrameBinding::validate(2, "0123456789abcdef0123456789abcdef".into(), None).unwrap();
    assert!(runtime
        .cancel_client(&owner, &stale_frame, "active")
        .is_err());
    assert_eq!(runtime.counts().0, 1);

    let frame = FrameBinding::validate(3, "0123456789abcdef0123456789abcdef".into(), None).unwrap();
    for index in 0..16 {
        assert!(runtime
            .cancel_client(&owner, &frame, &format!("missing-{index}"))
            .unwrap()
            .is_none());
    }
    assert!(runtime.cancel_client(&owner, &frame, "overflow").is_err());
    {
        let mut store = runtime.store.lock();
        for tombstone in store.tombstones.values_mut() {
            tombstone.expires = Instant::now() - Duration::from_secs(1);
        }
    }
    assert!(runtime
        .cancel_client(&owner, &frame, "after-expiry")
        .unwrap()
        .is_none());
    assert_eq!(runtime.counts().4, 1);
}
