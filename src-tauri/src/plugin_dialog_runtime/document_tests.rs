use super::{registry::Access, tests::fixture, types::Owner};
use crate::plugin_page_runtime::test_binding;
use std::sync::atomic::Ordering;

#[test]
fn revoked_dialog_document_rejects_late_preparation_and_pending_open() {
    for stage in 0..2 {
        let (_, _, runtime, owner, binding) = fixture();
        let (document, active) = test_binding();
        let preparation = runtime
            .begin_bound(owner.clone(), Some(document.clone()))
            .unwrap();
        assert_eq!(runtime.document_owners(document.id()), vec![owner.clone()]);
        if stage == 0 {
            active.store(false, Ordering::Release);
            assert!(runtime.intent(preparation, binding, Access::Open).is_err());
        } else {
            let intent = runtime
                .intent(preparation, binding.clone(), Access::Open)
                .unwrap();
            active.store(false, Ordering::Release);
            assert!(runtime.open(&intent, &binding).is_err());
        }
        assert!(runtime.begin_bound(owner, Some(document)).is_err());
        assert_eq!(runtime.counts(), (0, 0, 0, 0));
    }
}

#[test]
fn dialog_rotation_rebinds_both_accesses_and_revocation_blocks_token() {
    let (_, p, runtime, owner, binding) = fixture();
    let (document, active) = test_binding();
    let mut old_tokens = Vec::new();
    for access in [Access::Open, Access::Save] {
        let intent = runtime
            .intent(
                runtime
                    .begin_bound(owner.clone(), Some(document.clone()))
                    .unwrap(),
                binding.clone(),
                access,
            )
            .unwrap();
        old_tokens.push(runtime.open(&intent, &binding).unwrap().token.clone());
    }
    let next = Owner::new("main", &p.id, &uuid::Uuid::new_v4().to_string()).unwrap();
    assert!(runtime.rotate_bound(&owner, next.clone(), None).is_err());
    let (next_document, next_active) = test_binding();
    let new = runtime
        .rotate_bound(&owner, next, Some(next_document.clone()))
        .unwrap();
    assert_eq!(new.len(), 2);
    for token in old_tokens {
        assert!(runtime.by_token(&token).is_none());
    }
    active.store(false, Ordering::Release);
    assert!(runtime.document_owners(document.id()).is_empty());
    for session in &new {
        assert_eq!(session.document.as_ref().unwrap().id(), next_document.id());
        assert!(runtime.by_token(&session.token).is_some());
    }
    next_active.store(false, Ordering::Release);
    for session in new {
        assert!(runtime.by_token(&session.token).is_none());
    }
}
