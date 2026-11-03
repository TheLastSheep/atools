use super::{tests::fixture, types::Owner};
use crate::plugin_page_runtime::test_binding;
use std::sync::atomic::Ordering;

#[test]
fn revoked_data_document_rejects_late_preparation_and_pending_open() {
    for stage in 0..2 {
        let (_, _, runtime, owner, binding) = fixture();
        let (document, active) = test_binding();
        let preparation = runtime
            .begin_bound(owner.clone(), Some(document.clone()))
            .unwrap();
        assert_eq!(runtime.document_owners(document.id()), vec![owner.clone()]);
        if stage == 0 {
            active.store(false, Ordering::Release);
            assert!(runtime.intent(preparation, binding).is_err());
        } else {
            let intent = runtime.intent(preparation, binding.clone()).unwrap();
            active.store(false, Ordering::Release);
            assert!(runtime.open(&intent, &binding).is_err());
        }
        assert!(runtime.begin_bound(owner, Some(document)).is_err());
        assert_eq!(runtime.counts(), (0, 0, 0, 0));
    }
}

#[test]
fn data_rotation_requires_new_native_binding_and_never_transfers_old_token() {
    let (_, p, runtime, owner, binding) = fixture();
    let (document, active) = test_binding();
    let intent = runtime
        .intent(
            runtime
                .begin_bound(owner.clone(), Some(document.clone()))
                .unwrap(),
            binding.clone(),
        )
        .unwrap();
    let old = runtime.open(&intent, &binding).unwrap();
    let next = Owner::new("main", &p.id, &uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(runtime
        .rotate_bound(&owner, next.clone(), &old.id, None)
        .is_err());
    let (next_document, next_active) = test_binding();
    let (new, _) = runtime
        .rotate_bound(&owner, next, &old.id, Some(next_document.clone()))
        .unwrap();
    assert_ne!(new.token, old.token);
    assert!(runtime.by_token(&old.token).is_none());
    assert_eq!(new.document.as_ref().unwrap().id(), next_document.id());
    active.store(false, Ordering::Release);
    assert!(runtime.document_owners(document.id()).is_empty());
    assert!(runtime.by_token(&new.token).is_some());
    next_active.store(false, Ordering::Release);
    assert!(runtime.by_token(&new.token).is_none());
    for owner in runtime.document_owners(next_document.id()) {
        runtime.close(Some(&owner), None, None, false);
    }
    assert_eq!(runtime.counts(), (0, 0, 0, 0));
}
