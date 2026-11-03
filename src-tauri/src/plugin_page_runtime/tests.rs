use super::*;
use crate::plugin_asset_protocol::{Authorization, Owner};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Barrier,
    },
};
use tauri::http::{Request, StatusCode};

fn owner(window: &str) -> Owner {
    Owner::new(window, "fixture", &uuid::Uuid::new_v4().to_string()).unwrap()
}
fn authorization_fixture() -> Authorization {
    Authorization {
        root: PathBuf::from("/fixture"),
        revision: Some("revision-a".into()),
    }
}
fn prepare(registry: &Arc<Registry>, owner: &Owner) -> PreparedPage {
    registry
        .commit(
            registry.begin(owner.clone()).unwrap(),
            authorization_fixture(),
        )
        .unwrap()
        .0
}
fn lookup_document(
    registry: &Registry,
    owner: &Owner,
    prepared: &PreparedPage,
) -> registry::Document {
    registry
        .get(&prepared.page_document_id, &owner.window, &owner.plugin)
        .unwrap()
}
fn request(url: &str) -> Request<Vec<u8>> {
    Request::builder().uri(url).body(Vec::new()).unwrap()
}

#[cfg(feature = "legacy-node-smoke")]
#[test]
fn native_frame_revocation_is_synchronous_and_only_removes_the_exact_window_origin() {
    let registry = Arc::new(Registry::default());
    let first_owner = owner("main");
    let first = prepare(&registry, &first_owner);
    let first_binding = lookup_document(&registry, &first_owner, &first).binding;
    let second_owner = owner("main");
    let second = prepare(&registry, &second_owner);
    assert!(registry
        .close_native_frame("foreign-window", &first.expected_origin)
        .is_empty());
    assert!(first_binding.is_active());
    assert_eq!(
        registry.close_native_frame("main", &first.expected_origin),
        vec![first.page_document_id]
    );
    assert!(!first_binding.is_active());
    assert!(registry
        .for_origin(&first.expected_origin, "main")
        .is_none());
    assert!(registry
        .for_origin(&second.expected_origin, "main")
        .is_some());
    assert!(registry
        .close_native_frame("main", &first.expected_origin)
        .is_empty());
}

#[test]
fn page_registry_native_owns_canonical_origin_and_unique_single_use_ticket() {
    let registry = Arc::new(Registry::default());
    let owner = owner("main");
    let prepared = prepare(&registry, &owner);
    let id = uuid::Uuid::parse_str(&prepared.page_document_id).unwrap();
    assert_eq!(id.get_version_num(), 4);
    assert_eq!(
        prepared.expected_origin,
        format!("atools-page://{}.localhost", id.simple())
    );
    assert_eq!(
        prepared.resource_base_url,
        format!("{}/assets/", prepared.expected_origin)
    );
    assert_eq!(prepared.parent_origin, "atools-panel://localhost");
    let document = lookup_document(&registry, &owner, &prepared);
    assert!(registry
        .get(&prepared.page_document_id, "foreign", "fixture")
        .is_none());
    assert!(registry
        .get(&prepared.page_document_id, "main", "foreign")
        .is_none());
    assert!(registry
        .claim(&owner, &prepared.page_document_id, &authorization_fixture())
        .is_err());
    assert_eq!(
        protocol::canonical_origin(&request(&prepared.bootstrap_url)).unwrap(),
        prepared.expected_origin
    );
    let first = protocol::bootstrap(&registry, &document, &request(&prepared.bootstrap_url));
    assert_eq!(first.status(), StatusCode::OK);
    let body = std::str::from_utf8(first.body()).unwrap();
    assert!(body.contains(&prepared.page_document_id));
    for private in [
        "endpoint",
        "pluginRoot",
        "preload",
        "actionconfig",
        "__TAURI",
        "invokeKey",
        "/fixture",
        "revision-a",
    ] {
        assert!(!body.contains(private), "{private}");
    }
    assert!(!first.headers().contains_key("access-control-allow-origin"));
    assert!(!first.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("sandbox"));
    assert!(first.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("base-uri 'self'"));
    registry
        .claim(&owner, &prepared.page_document_id, &authorization_fixture())
        .unwrap();
    assert!(registry
        .claim(&owner, &prepared.page_document_id, &authorization_fixture())
        .is_err());
    let second = protocol::bootstrap(&registry, &document, &request(&prepared.bootstrap_url));
    assert_eq!(second.status(), StatusCode::GONE);
    assert!(!std::str::from_utf8(second.body())
        .unwrap()
        .contains("<script"));
    assert!(second.headers()["content-security-policy"]
        .to_str()
        .unwrap()
        .contains("sandbox;"));
}

#[test]
fn page_registry_get_headers_cannot_authorize_or_change_owner() {
    let registry = Arc::new(Registry::default());
    let owner = owner("main");
    let prepared = prepare(&registry, &owner);
    let document = lookup_document(&registry, &owner, &prepared);
    let forged = Request::builder()
        .uri(&prepared.bootstrap_url)
        .header("origin", "atools-panel://localhost")
        .header("referer", "atools-panel://localhost/")
        .header("x-atools-plugin-id", "foreign")
        .body(Vec::new())
        .unwrap();
    assert!(registry
        .for_origin(&prepared.expected_origin, "foreign-window")
        .is_none());
    assert!(registry
        .for_origin(
            "atools-page://00000000000040008000000000000000.localhost",
            "main"
        )
        .is_none());
    // Header contents are irrelevant even for the authorized window's ticket.
    assert_eq!(
        protocol::bootstrap(&registry, &document, &forged).status(),
        StatusCode::OK
    );
    let mut other = owner.clone();
    other.instance = uuid::Uuid::new_v4().to_string();
    assert!(registry
        .claim(&other, &prepared.page_document_id, &authorization_fixture())
        .is_err());
    assert!(registry
        .close_owner(&other, Some(&prepared.page_document_id))
        .is_empty());
    assert!(document.binding.is_active());
}

#[test]
fn page_protocol_rejects_noncanonical_authority_and_nonempty_or_nonget_tickets_without_consuming() {
    let registry = Arc::new(Registry::default());
    let owner = owner("main");
    let prepared = prepare(&registry, &owner);
    let document = lookup_document(&registry, &owner, &prepared);
    let host = prepared
        .expected_origin
        .strip_prefix("atools-page://")
        .unwrap();
    for authority in [
        format!("user@{host}"),
        format!("{host}:1234"),
        host.to_uppercase(),
        "localhost".into(),
    ] {
        assert!(
            protocol::canonical_origin(&request(&format!("atools-page://{authority}/x"))).is_err()
        );
    }
    for bad in [
        Request::builder()
            .method("HEAD")
            .uri(&prepared.bootstrap_url)
            .body(Vec::new())
            .unwrap(),
        Request::builder()
            .uri(&prepared.bootstrap_url)
            .body(b"body".to_vec())
            .unwrap(),
        request(&format!("{}?ticket=forged", prepared.bootstrap_url)),
    ] {
        assert_eq!(
            protocol::bootstrap(&registry, &document, &bad).status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        protocol::bootstrap(&registry, &document, &request(&prepared.bootstrap_url)).status(),
        StatusCode::OK
    );
}

#[test]
fn page_ticket_concurrent_gets_have_exactly_one_winner() {
    let registry = Arc::new(Registry::default());
    let owner = owner("main");
    let prepared = prepare(&registry, &owner);
    let document = lookup_document(&registry, &owner, &prepared);
    let barrier = Arc::new(Barrier::new(8));
    let wins = Arc::new(AtomicUsize::new(0));
    let mut workers = Vec::new();
    for _ in 0..8 {
        let (registry, document, barrier, wins) = (
            registry.clone(),
            document.clone(),
            barrier.clone(),
            wins.clone(),
        );
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            if registry.consume(&document.binding, &document.ticket_path) {
                wins.fetch_add(1, Ordering::AcqRel);
            }
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(wins.load(Ordering::Acquire), 1);
}

#[test]
fn page_registry_revoke_is_shared_and_suppresses_already_read_response() {
    let registry = Arc::new(Registry::default());
    let owner = owner("main");
    let prepared = prepare(&registry, &owner);
    let document = lookup_document(&registry, &owner, &prepared);
    let session_clone = document.binding.clone();
    assert_eq!(
        registry.if_current(&document.binding, || "bytes"),
        Some("bytes")
    );
    assert_eq!(
        registry.close_owner(&owner, Some(&prepared.page_document_id)),
        vec![prepared.page_document_id]
    );
    assert!(!session_clone.is_active());
    assert!(registry
        .if_current(&document.binding, || panic!(
            "Revoked document cannot deliver bytes"
        ))
        .is_none());
    let prepared = prepare(&registry, &owner);
    let document = lookup_document(&registry, &owner, &prepared);
    let mut changed = authorization_fixture();
    changed.revision = Some("revision-b".into());
    registry.consume(&document.binding, &document.ticket_path);
    assert!(registry
        .claim(&owner, &prepared.page_document_id, &changed)
        .is_err());
    assert!(!document.binding.is_active());
}

#[test]
fn page_registry_only_active_handoff_expires_and_claim_removes_deadline() {
    let registry = Arc::new(Registry::default());
    let owner = owner("main");
    let prepared = prepare(&registry, &owner);
    let document = lookup_document(&registry, &owner, &prepared);
    // Native preparation itself has no idle task or user-approval deadline.
    assert!(document.binding.is_active());
    assert!(registry.consume(&document.binding, &document.ticket_path));
    document.binding.expire();
    assert!(!document.binding.is_active());
    assert!(registry
        .claim(&owner, &prepared.page_document_id, &authorization_fixture())
        .is_err());
    let prepared = prepare(&registry, &owner);
    let document = lookup_document(&registry, &owner, &prepared);
    registry.consume(&document.binding, &document.ticket_path);
    registry
        .claim(&owner, &prepared.page_document_id, &authorization_fixture())
        .unwrap();
    assert!(document.binding.is_active());
}

#[test]
fn page_registry_close_cancels_pending_and_new_generation_does_not_revive_old_binding() {
    let registry = Arc::new(Registry::default());
    let owner = owner("main");
    for kind in ["owner", "plugin", "window"] {
        let pending = registry.begin(owner.clone()).unwrap();
        match kind {
            "owner" => {
                registry.close_owner(&owner, None);
            }
            "plugin" => registry.invalidate_plugin("fixture"),
            _ => registry.close_window("main"),
        }
        assert!(registry.commit(pending, authorization_fixture()).is_err());
    }
    let old = prepare(&registry, &owner);
    let old_binding = lookup_document(&registry, &owner, &old).binding;
    let (new, retired) = registry
        .commit(
            registry.begin(owner.clone()).unwrap(),
            authorization_fixture(),
        )
        .unwrap();
    assert_eq!(retired, vec![old.page_document_id]);
    assert_ne!(new.expected_origin, old.expected_origin);
    assert!(!old_binding.is_active());
    assert!(registry
        .close_owner(&owner, Some(old_binding.id()))
        .is_empty());
    assert!(lookup_document(&registry, &owner, &new).binding.is_active());
    registry.close_window("main");
    assert_eq!(registry.count(), 0);
}

#[test]
fn page_registry_bounds_documents_and_pending_without_idle_workers() {
    let registry = Arc::new(Registry::default());
    let first = owner("main");
    for _ in 0..4 {
        prepare(&registry, &owner("main"));
    }
    assert!(registry
        .commit(registry.begin(first).unwrap(), authorization_fixture())
        .is_err());
    for index in 1..8 {
        for _ in 0..4 {
            prepare(&registry, &owner(&format!("window-{index}")));
        }
    }
    assert_eq!(registry.count(), 32);
    assert!(registry
        .commit(
            registry.begin(owner("ninth")).unwrap(),
            authorization_fixture()
        )
        .is_err());
    let mut pending = Vec::new();
    for _ in 0..64 {
        pending.push(registry.begin(owner("pending")).unwrap());
    }
    assert!(registry.begin(owner("pending")).is_err());
    drop(pending);
    assert!(registry.begin(owner("pending")).is_ok());
}
