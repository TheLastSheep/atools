use super::{
    registry::Access,
    tests::{fixture, plugin},
};
use crate::plugin_page_runtime::test_binding;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn document_revoke_blocks_open_and_rotated_sessions_require_new_native_binding() {
    let (runtime, _) = fixture();
    let plugin = plugin();
    let (document, active) = test_binding();
    let id = runtime
        .intent_with_document(
            "old".into(),
            plugin.id.clone(),
            Access::Read,
            Some(document.clone()),
        )
        .unwrap();
    let old = runtime.open(&id, &plugin, Access::Read).unwrap();
    assert_eq!(runtime.document_owners(document.id()).len(), 1);
    assert!(runtime
        .rotate_bound("old", "new", &plugin.id, &[old.id.clone()], None)
        .is_err());
    let (next, next_active) = test_binding();
    runtime
        .rotate_bound(
            "old",
            "new",
            &plugin.id,
            &[old.id.clone()],
            Some(next.clone()),
        )
        .unwrap();
    let new = runtime
        .store
        .lock()
        .sessions
        .values()
        .next()
        .unwrap()
        .clone();
    assert_ne!(old.token, new.token);
    assert!(runtime.by_token(&old.token).is_none());
    assert_eq!(new.document.as_ref().unwrap().id(), next.id());
    active.store(false, Ordering::Release);
    assert!(runtime.by_token(&new.token).is_some());
    assert!(runtime.document_owners(document.id()).is_empty());
    next_active.store(false, Ordering::Release);
    assert!(runtime.by_token(&new.token).is_none());
    runtime.close(Some("new"), None, false).await;
    assert!(runtime.store.lock().sessions.is_empty());
}

#[test]
fn revoked_document_cannot_open_pending_clipboard_intent_or_prepare_late() {
    let (runtime, _) = fixture();
    let plugin = plugin();
    let (document, active) = test_binding();
    let id = runtime
        .intent_with_document(
            "old".into(),
            plugin.id.clone(),
            Access::Write,
            Some(document.clone()),
        )
        .unwrap();
    active.store(false, Ordering::Release);
    assert!(runtime.open(&id, &plugin, Access::Write).is_err());
    assert!(runtime
        .intent_with_document("late".into(), plugin.id, Access::Read, Some(document))
        .is_err());
}

#[tokio::test]
async fn document_close_keeps_other_plugin_with_same_window_instance_usable() {
    let (runtime, _) = fixture();
    let first_plugin = plugin();
    let mut second_plugin = first_plugin.clone();
    second_plugin.id = "second-plugin".into();
    let (first, first_active) = test_binding();
    let (second, _) = test_binding();
    let owner = "window:main:shared-instance";
    let first_id = runtime
        .intent_with_document(
            owner.into(),
            first_plugin.id.clone(),
            Access::Read,
            Some(first.clone()),
        )
        .unwrap();
    let old = runtime
        .open(&first_id, &first_plugin, Access::Read)
        .unwrap();
    let second_id = runtime
        .intent_with_document(
            owner.into(),
            second_plugin.id.clone(),
            Access::Read,
            Some(second.clone()),
        )
        .unwrap();
    let kept = runtime
        .open(&second_id, &second_plugin, Access::Read)
        .unwrap();
    let pending = runtime
        .intent_with_document(
            owner.into(),
            second_plugin.id.clone(),
            Access::Write,
            Some(second.clone()),
        )
        .unwrap();
    first_active.store(false, Ordering::Release);
    let owners = runtime.document_owners(first.id());
    assert_eq!(
        owners,
        [(owner.into(), first_plugin.id)].into_iter().collect()
    );
    for (owner, plugin) in owners {
        runtime
            .close_document_owner(&owner, &plugin, first.id())
            .await;
    }
    assert!(runtime.get(&old.id).is_err());
    assert!(runtime.by_token(&kept.token).is_some());
    assert!(runtime
        .open(&pending, &second_plugin, Access::Write)
        .is_ok());
    assert!(runtime
        .intent_with_document(owner.into(), second_plugin.id, Access::Read, Some(second))
        .is_ok());
}
