use super::{
    registry::Registry,
    renderer::{RendererGrant, RendererPermit},
    SourceBinding,
};
use crate::plugin_asset_protocol::{Authorization, Lease, Owner};
use std::path::PathBuf;

fn owner(window: &str, plugin: &str, instance: &str) -> Owner {
    Owner::new(window, plugin, instance).unwrap()
}

fn authorization() -> Authorization {
    Authorization {
        root: PathBuf::from("/tmp/plugin-source-fixture"),
        revision: Some("revision-a".into()),
    }
}

fn binding(
    owner: Owner,
    frame_id: &str,
    generation: u64,
    nonce: &str,
    session: &str,
) -> SourceBinding {
    SourceBinding::new(
        owner,
        session.into(),
        authorization(),
        frame_id.into(),
        generation,
        nonce.into(),
    )
}

#[test]
fn source_generation_is_monotonic_and_closed_documents_cannot_be_rebound() {
    let owner = owner("main", "fixture", "aabbccdd-1234-4234-8234-aabbccddeeff");
    let mut registry = Registry::default();
    let first = binding(owner.clone(), "main", 7, &"a".repeat(32), "session-a");
    let (bound, retired) = registry.bind(first.clone()).unwrap();
    assert!(retired.is_empty());
    assert_eq!(bound.id(), first.id());

    let duplicate = binding(owner.clone(), "main", 7, &"a".repeat(32), "session-a");
    let (reused, retired) = registry.bind(duplicate).unwrap();
    assert_eq!(reused.id(), first.id());
    assert!(retired.is_empty());
    assert!(registry
        .bind(binding(
            owner.clone(),
            "main",
            7,
            &"b".repeat(32),
            "session-a"
        ))
        .is_err());
    assert!(registry
        .bind(binding(
            owner.clone(),
            "main",
            6,
            &"a".repeat(32),
            "session-a"
        ))
        .is_err());

    let next = binding(owner.clone(), "main", 8, &"b".repeat(32), "session-a");
    let (current, retired) = registry.bind(next).unwrap();
    assert_eq!(retired, vec![first.id().to_owned()]);
    assert!(!first.is_active());
    assert!(current.is_active());
    assert_eq!(
        registry.revoke_id(current.id()),
        vec![current.id().to_owned()]
    );
    assert!(registry
        .bind(binding(
            owner.clone(),
            "main",
            8,
            &"b".repeat(32),
            "session-a"
        ))
        .is_err());

    // A full owner-resource release clears the watermark and begins a new lifecycle.
    assert!(registry.revoke_owner(&owner).is_empty());
    assert!(registry
        .bind(binding(owner, "main", 1, &"c".repeat(32), "session-b"))
        .is_ok());
}

#[test]
fn child_frame_revocation_keeps_its_generation_watermark() {
    let owner = owner("main", "fixture", "aabbccdd-1234-4234-8234-aabbccddeeff");
    let mut registry = Registry::default();
    let child = binding(
        owner.clone(),
        "child:window-7",
        3,
        &"c".repeat(32),
        "session-a",
    );
    registry.bind(child.clone()).unwrap();
    assert_eq!(
        registry.revoke_frame(&owner, "child:window-7"),
        vec![child.id().to_owned()]
    );
    assert!(!child.is_active());
    assert!(registry
        .bind(binding(
            owner.clone(),
            "child:window-7",
            3,
            &"c".repeat(32),
            "session-a"
        ))
        .is_err());
    assert!(registry
        .bind(binding(
            owner,
            "child:window-7",
            4,
            &"d".repeat(32),
            "session-a"
        ))
        .is_ok());
}

#[test]
fn source_identity_budget_is_bounded_and_released_with_owner_resources() {
    let owner = owner("main", "fixture", "aabbccdd-1234-4234-8234-aabbccddeeff");
    let mut registry = Registry::default();
    for index in 0..256 {
        registry
            .bind(binding(
                owner.clone(),
                &format!("child:{index}"),
                1,
                &"a".repeat(32),
                "session-a",
            ))
            .unwrap();
    }
    assert!(registry
        .bind(binding(
            owner.clone(),
            "child:overflow",
            1,
            &"a".repeat(32),
            "session-a"
        ))
        .is_err());
    registry.revoke_owner(&owner);
    assert!(registry
        .bind(binding(
            owner,
            "child:overflow",
            1,
            &"a".repeat(32),
            "session-b"
        ))
        .is_ok());
}

fn source_with_renderer(
    registry: &mut Registry,
    frame_id: &str,
    index: usize,
) -> (SourceBinding, RendererPermit) {
    let source = binding(
        owner("main", "fixture", "aabbccdd-1234-4234-8234-aabbccddeeff"),
        frame_id,
        1,
        &format!("{:032x}", index + 1),
        "session-a",
    );
    registry.bind(source.clone()).unwrap();
    registry
        .add_renderer(&format!("native-window-{index}"), &source)
        .unwrap();
    let grant: RendererGrant = registry
        .renderers
        .get(&format!("native-window-{index}"))
        .unwrap()
        .clone();
    (source, grant.permit())
}

fn lease(id: &str, owner: Owner, authorization: Authorization) -> Lease {
    Lease {
        id: id.into(),
        owner,
        authorization,
    }
}

#[test]
fn renderer_permit_matches_only_its_exact_owner_session_and_authorization() {
    let owner_a = owner("main", "fixture", "aabbccdd-1234-4234-8234-aabbccddeeff");
    let mut registry = Registry::default();
    let (_source, permit) = source_with_renderer(&mut registry, "main", 0);
    let auth = authorization();
    assert!(permit.matches_lease(&lease("session-a", owner_a.clone(), auth.clone())));
    assert!(!permit.matches_lease(&lease("session-b", owner_a, auth.clone())));
    assert!(!permit.matches_lease(&lease(
        "session-a",
        owner("main", "other", "aabbccdd-1234-4234-8234-aabbccddeeff"),
        auth.clone()
    )));
    assert!(!permit.matches_lease(&lease(
        "session-a",
        owner(
            "plugin-detach",
            "fixture",
            "aabbccdd-1234-4234-8234-aabbccddeeff"
        ),
        auth
    )));
}

#[test]
fn source_revocation_blocks_pending_renderer_handoffs_and_renderer_cap_is_sixteen() {
    let owner = owner("main", "fixture", "aabbccdd-1234-4234-8234-aabbccddeeff");
    let mut registry = Registry::default();
    let (first_source, first_permit) = source_with_renderer(&mut registry, "main", 0);
    for index in 1..16 {
        source_with_renderer(&mut registry, &format!("child:{index}"), index);
    }
    let overflow = binding(
        owner.clone(),
        "child:overflow",
        1,
        &"f".repeat(32),
        "session-a",
    );
    registry.bind(overflow.clone()).unwrap();
    assert!(registry
        .add_renderer("native-window-overflow", &overflow)
        .is_err());
    assert_eq!(registry.revoke_id(first_source.id()).len(), 1);
    let mut handed_off = false;
    assert!(first_permit.if_active(|| handed_off = true).is_none());
    assert!(!handed_off);

    let grant = registry.renderers.get("native-window-1").unwrap().clone();
    let permit = grant.permit();
    grant.deactivate();
    assert!(permit.if_active(|| handed_off = true).is_none());
    assert!(!handed_off);
}
