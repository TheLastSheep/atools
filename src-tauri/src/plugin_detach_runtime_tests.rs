use super::*;
use crate::plugin_detach_validation::{
    check_handoff_budget, validate_claim_window, validate_current_snapshot, MAX_HANDOFF_BYTES,
};
use atools_core::{models::Plugin, Database};
use serde_json::{json, Value};
use std::collections::HashMap;

fn action(payload: Value, entry_type: Option<&'static str>) -> FeatureAction {
    FeatureAction {
        plugin_id: "plugin-a".into(),
        plugin_name: "Plugin A".into(),
        feature_code: "feature-a".into(),
        feature_label: None,
        feature_label_source: None,
        main_url: "index.html".into(),
        plugin_path: "/plugins/plugin-a".into(),
        preload_path: None,
        expand_height: 541,
        plugin_permissions: vec![],
        plugin_providers: HashMap::new(),
        payload,
        entry_type,
        auto_detach: false,
    }
}

fn pending(payload: Value, entry_type: Option<&'static str>) -> PendingPluginAction {
    PendingPluginAction {
        id: uuid::Uuid::new_v4().to_string(),
        action: action(payload, entry_type),
        plugin_version: "1".into(),
        code_revision: Some("ready:revision-1".into()),
        request_id: "request-test".into(),
        expires_at: Instant::now() + HANDOFF_TTL,
        generation: 0,
        ready: true,
    }
}

fn plugin() -> Plugin {
    let manifest = serde_json::from_value(json!({
        "name":"plugin-a",
        "main":"index.html",
        "features":[{"code":"feature-a","cmds":["feature-a"]}]
    }))
    .unwrap();
    Plugin {
        id: "plugin-a".into(),
        name: "Plugin A".into(),
        version: "1".into(),
        path: "/plugins/plugin-a".into(),
        enabled: true,
        manifest,
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}

#[test]
fn matching_handoff_can_be_claimed_only_once() {
    let mut slot = RuntimeState::default();
    let pending = pending(json!({"text":"原样交接"}), Some("over"));
    let id = pending.id.clone();
    slot.replace(pending);

    let claimed = slot.take(&id, Instant::now()).unwrap();
    assert_eq!(claimed.action.payload, json!({"text":"原样交接"}));
    assert!(slot.take(&id, Instant::now()).is_err());
}

#[test]
fn wrong_id_does_not_consume_the_current_slot_and_replacement_invalidates_old_id() {
    let mut slot = RuntimeState::default();
    let first = pending(json!("first"), None);
    let first_id = first.id.clone();
    slot.replace(first);
    let second = pending(json!("second"), None);
    let second_id = second.id.clone();
    slot.replace(second);

    assert!(slot.take(&first_id, Instant::now()).is_err());
    let claimed = slot.take(&second_id, Instant::now()).unwrap();
    assert_eq!(claimed.action.payload, json!("second"));
    slot.replace(pending(json!("new owner"), None));
    let new_owner_id = slot.pending.as_ref().unwrap().id.clone();
    slot.clear_if(&second_id);
    assert_eq!(slot.pending.as_ref().unwrap().id, new_owner_id);
}

#[test]
fn expired_or_failed_open_handoffs_are_removed() {
    let mut slot = RuntimeState::default();
    let expired = pending(json!("old"), None);
    let expired_id = expired.id.clone();
    let after_expiry = expired.expires_at + Duration::from_millis(1);
    slot.replace(expired);
    assert!(slot.take(&expired_id, after_expiry).is_err());
    assert!(slot.pending.is_none());

    let failed_open = pending(json!("unclaimed"), None);
    let failed_id = failed_open.id.clone();
    slot.replace(failed_open);
    slot.clear_if(&failed_id);
    assert!(slot.pending.is_none());
}

#[test]
fn payloads_for_text_files_and_images_are_preserved_without_projection() {
    for (payload, kind) in [
        (json!("正文"), Some("over")),
        (json!([{"path":"/tmp/a.txt","name":"a.txt"}]), Some("files")),
        (json!("data:image/png;base64,AAAA"), Some("img")),
    ] {
        let mut slot = RuntimeState::default();
        let item = pending(payload.clone(), kind);
        let id = item.id.clone();
        slot.replace(item);
        let claimed = slot.take(&id, Instant::now()).unwrap();
        assert_eq!(claimed.action.payload, payload);
        assert_eq!(claimed.action.entry_type, kind);
    }
}

#[test]
fn serialized_handoff_budget_includes_json_encoding() {
    let within = Value::String("x".repeat(MAX_HANDOFF_BYTES - 2));
    let beyond = Value::String("x".repeat(MAX_HANDOFF_BYTES - 1));
    assert!(check_handoff_budget(&within).is_ok());
    assert!(check_handoff_budget(&beyond).is_err());
}

#[test]
fn claim_requires_detached_window_and_current_plugin_snapshot() {
    assert!(validate_claim_window("plugin-detach").is_ok());
    assert!(validate_claim_window("main").is_err());

    let item = pending(json!(null), None);
    let plugin = plugin();
    assert!(validate_current_snapshot(
        &item,
        &plugin,
        "plugin-a",
        Ok(Some("ready:revision-1".into()))
    )
    .is_ok());
    assert!(validate_current_snapshot(
        &item,
        &plugin,
        "plugin-a",
        Ok(Some("ready:revision-2".into()))
    )
    .is_err());
    assert!(validate_current_snapshot(
        &item,
        &plugin,
        "another-plugin",
        Ok(Some("ready:revision-1".into()))
    )
    .is_err());
}

#[test]
fn claim_rejects_disabled_or_replaced_plugins() {
    let item = pending(json!(null), None);
    let mut plugin = plugin();
    plugin.enabled = false;
    assert!(validate_current_snapshot(
        &item,
        &plugin,
        "plugin-a",
        Ok(Some("ready:revision-1".into()))
    )
    .is_err());
    plugin.enabled = true;
    plugin.version = "2".into();
    assert!(validate_current_snapshot(
        &item,
        &plugin,
        "plugin-a",
        Ok(Some("ready:revision-1".into()))
    )
    .is_err());
}

#[test]
fn destroyed_generation_rejects_a_handoff_from_the_old_window_owner() {
    let mut slot = RuntimeState::default();
    let stale_generation = slot.generation;
    slot.begin_destroyed_cleanup();
    let stale_pending = pending(json!("new action"), None);
    assert!(slot
        .replace_for_generation(stale_pending, stale_generation)
        .is_err());
    assert!(slot.pending.is_none());

    slot.complete_destroyed_cleanup();
    let current_generation = slot.generation;
    slot.replace_for_generation(pending(json!("new action"), None), current_generation)
        .unwrap();
    assert!(slot.pending.is_some());
}

#[tokio::test]
async fn new_open_waits_until_queued_destroyed_cleanup_completes() {
    let runtime = PluginDetachRuntime::default();
    runtime.begin_destroyed_cleanup();
    assert!(
        tokio::time::timeout(Duration::ZERO, runtime.wait_for_destroyed_cleanup())
            .await
            .is_err()
    );

    runtime.complete_destroyed_cleanup();
    tokio::time::timeout(Duration::from_secs(1), runtime.wait_for_destroyed_cleanup())
        .await
        .unwrap();
}

#[tokio::test]
async fn claim_waits_for_successful_show_and_failed_open_clears_waiters() {
    let runtime = PluginDetachRuntime::default();
    let request_id = uuid::Uuid::new_v4().to_string();
    let handoff = PendingPluginAction::new(
        action(json!("payload"), None),
        "1".into(),
        None,
        request_id.clone(),
    );
    let id = handoff.id.clone();
    let intent = runtime.reserve_open_intent(&request_id).unwrap();
    runtime.stage_pending(handoff, 0, &intent, None).unwrap();

    assert!(tokio::time::timeout(Duration::ZERO, runtime.claim(&id))
        .await
        .is_err());
    runtime.mark_ready(&id, 0).unwrap();
    let claimed = runtime.claim(&id).await.unwrap();
    assert_eq!(claimed.action.payload, json!("payload"));

    let failed_request_id = uuid::Uuid::new_v4().to_string();
    let failed = PendingPluginAction::new(
        action(json!("failed"), None),
        "1".into(),
        None,
        failed_request_id.clone(),
    );
    let failed_id = failed.id.clone();
    let failed_intent = runtime.reserve_open_intent(&failed_request_id).unwrap();
    runtime
        .stage_pending(failed, 0, &failed_intent, None)
        .unwrap();
    runtime.clear_handoff(&failed_id);
    assert!(runtime.claim(&failed_id).await.is_err());
}

#[test]
fn file_payload_adapter_keeps_only_paths_and_rejects_malformed_items() {
    assert_eq!(
        crate::plugin_detach_validation::normalize_files_payload(Some(json!([
            {"path":"/tmp/a.txt","name":"a.txt"},
            "/tmp/b.txt"
        ])))
        .unwrap(),
        Some(json!(["/tmp/a.txt", "/tmp/b.txt"]))
    );
    for invalid in [json!(null), json!([{"name":"missing-path"}]), json!([7])] {
        assert!(crate::plugin_detach_validation::normalize_files_payload(Some(invalid)).is_err());
    }
}

#[tokio::test]
async fn reuse_gate_rejects_a_claim_that_was_queued_before_reuse() {
    let runtime = std::sync::Arc::new(PluginDetachRuntime::default());
    let generation = runtime.generation();
    let request_id = uuid::Uuid::new_v4().to_string();
    let intent = runtime.reserve_open_intent(&request_id).unwrap();
    let handoff = PendingPluginAction::new(
        action(json!("old action"), None),
        "1".into(),
        None,
        request_id,
    );
    let id = handoff.id.clone();
    runtime
        .stage_pending(handoff, generation, &intent, None)
        .unwrap();
    runtime.mark_ready(&id, generation).unwrap();

    let reuse_gate = runtime.cleanup_gate().lock_owned().await;
    let claimant_runtime = runtime.clone();
    let claimant = tokio::spawn(async move { claimant_runtime.claim_for_validation(&id).await });
    for _ in 0..32 {
        if runtime.inner.lock().pending.is_none() {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(runtime.inner.lock().pending.is_none());

    let next_generation = runtime.begin_reuse();
    drop(reuse_gate);
    assert!(claimant.await.unwrap().is_err());
    assert_eq!(next_generation, generation.wrapping_add(1));
}

#[tokio::test]
async fn claimed_action_holds_reuse_gate_until_snapshot_validation_finishes() {
    let runtime = std::sync::Arc::new(PluginDetachRuntime::default());
    let generation = runtime.generation();
    let request_id = uuid::Uuid::new_v4().to_string();
    let intent = runtime.reserve_open_intent(&request_id).unwrap();
    let handoff = PendingPluginAction::new(
        action(json!("old action"), None),
        "1".into(),
        None,
        request_id,
    );
    let id = handoff.id.clone();
    runtime
        .stage_pending(handoff, generation, &intent, None)
        .unwrap();
    runtime.mark_ready(&id, generation).unwrap();

    let (pending, validation_gate) = runtime.claim_for_validation(&id).await.unwrap();
    runtime.ensure_current_generation(&pending).unwrap();
    let reuse_runtime = runtime.clone();
    let mut reuse = tokio::spawn(async move {
        let _gate = reuse_runtime.cleanup_gate().lock_owned().await;
        reuse_runtime.begin_reuse()
    });
    assert!(tokio::time::timeout(Duration::from_millis(10), &mut reuse)
        .await
        .is_err());

    drop(validation_gate);
    let next_generation = tokio::time::timeout(Duration::from_secs(1), reuse)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(next_generation, generation.wrapping_add(1));
    assert!(runtime.ensure_current_generation(&pending).is_err());
}

#[test]
fn active_window_cancel_survives_a_later_occupied_open_without_clearing_its_intent() {
    let runtime = PluginDetachRuntime::default();
    let active_id = uuid::Uuid::new_v4().to_string();
    let active_intent = runtime.reserve_open_intent(&active_id).unwrap();
    let generation = runtime.generation();
    let pending = PendingPluginAction::new(
        action(json!("editor state"), None),
        "1".into(),
        None,
        active_id.clone(),
    );
    let handoff_id = pending.id.clone();
    runtime
        .stage_pending(pending, generation, &active_intent, None)
        .unwrap();
    runtime.mark_ready(&handoff_id, generation).unwrap();

    // A later attempt reserves the latest intent, then would fail the native
    // occupied-window check and fall back to the launcher.
    let later_id = uuid::Uuid::new_v4().to_string();
    runtime.reserve_open_intent(&later_id).unwrap();
    assert!(runtime.latest_request_matches(&later_id));

    let cancel = runtime.cancel_open_request(&active_id);
    assert!(!cancel.latest_intent);
    assert!(cancel.active_window);
    assert!(runtime.active_request_matches(&active_id));
    assert!(runtime.is_occupied());

    assert!(runtime.begin_cancel_for_request(&active_id, true));
    assert!(!runtime.active_request_matches(&active_id));
    assert!(!runtime.is_occupied());
    assert!(runtime.latest_request_matches(&later_id));

    runtime.begin_destroyed_cleanup();
    runtime.complete_destroyed_cleanup();
    assert!(runtime.latest_request_matches(&later_id));
}

#[test]
fn active_feature_is_tracked_while_occupied_and_cleared_on_close() {
    let runtime = PluginDetachRuntime::default();
    let generation = runtime.begin_reuse();
    let request_id = uuid::Uuid::new_v4().to_string();
    let intent = runtime.reserve_open_intent(&request_id).unwrap();
    let item = PendingPluginAction::new(
        action(json!(null), None),
        "1".into(),
        None,
        request_id.clone(),
    );
    let handoff_id = item.id.clone();
    assert_eq!(runtime.active_feature(), None);
    runtime
        .stage_pending(item, generation, &intent, None)
        .unwrap();
    runtime.mark_ready(&handoff_id, generation).unwrap();
    assert!(runtime.is_occupied());
    assert_eq!(
        runtime.active_feature(),
        Some(("plugin-a".to_string(), "feature-a".to_string()))
    );
    assert!(runtime.begin_cancel_for_request(&request_id, true));
    assert_eq!(runtime.active_feature(), None);
}

#[test]
fn later_open_intent_supersedes_old_work_and_old_cancel_cannot_touch_it() {
    let runtime = PluginDetachRuntime::default();
    let old_id = uuid::Uuid::new_v4().to_string();
    let current_id = uuid::Uuid::new_v4().to_string();
    let old = runtime.reserve_open_intent(&old_id).unwrap();
    let current = runtime.reserve_open_intent(&current_id).unwrap();

    assert!(runtime.ensure_latest_open_intent(&old).is_err());
    assert!(runtime.ensure_latest_open_intent(&current).is_ok());
    assert_eq!(
        runtime.cancel_open_request(&old_id),
        CancelOpenMatch::default()
    );
    assert!(runtime.ensure_latest_open_intent(&current).is_ok());
    assert_eq!(
        runtime.cancel_open_request(&current_id),
        CancelOpenMatch {
            latest_intent: true,
            active_window: false,
        }
    );
    assert!(runtime.ensure_latest_open_intent(&current).is_err());
}

#[test]
fn stale_request_cannot_cancel_a_different_active_window() {
    let runtime = PluginDetachRuntime::default();
    let old_id = uuid::Uuid::new_v4().to_string();
    runtime.reserve_open_intent(&old_id).unwrap();

    let active_id = uuid::Uuid::new_v4().to_string();
    let active_intent = runtime.reserve_open_intent(&active_id).unwrap();
    let generation = runtime.generation();
    let pending = PendingPluginAction::new(
        action(json!("later editor"), None),
        "1".into(),
        None,
        active_id.clone(),
    );
    let handoff_id = pending.id.clone();
    runtime
        .stage_pending(pending, generation, &active_intent, None)
        .unwrap();
    runtime.mark_ready(&handoff_id, generation).unwrap();

    assert_eq!(
        runtime.cancel_open_request(&old_id),
        CancelOpenMatch::default()
    );
    assert!(runtime.active_request_matches(&active_id));
    assert!(runtime.latest_request_matches(&active_id));
}

#[tokio::test]
async fn window_becomes_occupied_after_show_and_cancel_keeps_owner_identity_exact() {
    let runtime = PluginDetachRuntime::default();
    let request_id = uuid::Uuid::new_v4().to_string();
    let intent = runtime.reserve_open_intent(&request_id).unwrap();
    let generation = runtime.generation();
    let pending = PendingPluginAction::new(
        action(json!("editor state"), None),
        "1".into(),
        None,
        request_id.clone(),
    );
    let handoff_id = pending.id.clone();
    runtime
        .stage_pending(pending, generation, &intent, None)
        .unwrap();
    runtime.mark_ready(&handoff_id, generation).unwrap();
    assert!(runtime.is_occupied());
    runtime.claim(&handoff_id).await.unwrap();
    assert!(runtime.is_occupied());

    assert_eq!(
        runtime.cancel_open_request(&request_id),
        CancelOpenMatch {
            latest_intent: true,
            active_window: true,
        }
    );
    assert!(runtime.begin_cancel_for_request(&request_id, true));
    assert!(!runtime.is_occupied());
    assert!(runtime.destroyed_cleanup_pending());
    runtime.complete_destroyed_cleanup();
    assert!(!runtime.destroyed_cleanup_pending());
}

#[test]
fn snapshot_failure_propagates_and_database_fixture_has_real_feature_owner() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin_with_features(&plugin, &plugin.manifest.features)
        .unwrap();
    assert_eq!(db.get_feature("feature-a").unwrap().plugin_id, "plugin-a");

    let item = pending(json!(null), None);
    assert!(validate_current_snapshot(
        &item,
        &plugin,
        "plugin-a",
        Err("incomplete revision".into())
    )
    .is_err());
}
