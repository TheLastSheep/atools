use super::{session_tests::fixture, Sessions};
use crate::plugin_page_runtime::test_binding;
use std::sync::atomic::Ordering;

#[tokio::test]
async fn document_revocation_rejects_unclaimed_claimed_and_late_node_open() {
    let (_directory, plugin) = fixture();
    let runtime = Sessions::default();
    let (document, active) = test_binding();
    let id = runtime
        .create_bound_intent(
            "window:main:doc".into(),
            "atools-ui".into(),
            plugin.id.clone(),
            Some(document.clone()),
        )
        .unwrap();
    let intent = runtime
        .take_intent(Some(&id), "atools-ui", &plugin.id)
        .unwrap();
    assert_eq!(intent.document.as_ref().unwrap().id(), document.id());
    assert!(runtime
        .document_owners(document.id())
        .contains(&("window:main:doc".into(), plugin.id.clone())));
    let unclaimed = runtime
        .create_bound_intent(
            "window:main:unclaimed".into(),
            "atools-ui".into(),
            plugin.id.clone(),
            Some(document.clone()),
        )
        .unwrap();
    active.store(false, Ordering::Release);
    assert!(runtime
        .take_intent(Some(&unclaimed), "atools-ui", &plugin.id)
        .is_err());
    assert!(runtime
        .take_intent(Some(&id), "atools-ui", &plugin.id)
        .is_err());
    assert!(runtime.open(&plugin, "tool".into(), intent).await.is_err());
    assert!(runtime
        .create_bound_intent("late".into(), "atools-ui".into(), plugin.id, Some(document))
        .is_err());
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
}

#[tokio::test]
async fn document_revoke_during_node_startup_discovers_and_cancels_opening() {
    let (_directory, plugin) = fixture();
    let runtime = Sessions::default();
    let (document, active) = test_binding();
    let owner = "window:main:starting-document";
    let id = runtime
        .create_bound_intent(
            owner.into(),
            "atools-ui".into(),
            plugin.id.clone(),
            Some(document.clone()),
        )
        .unwrap();
    let intent = runtime
        .take_intent(Some(&id), "atools-ui", &plugin.id)
        .unwrap();
    *intent.run_id.lock() = Some("pending-document-run".into());
    let (opened, runs) = tokio::time::timeout(std::time::Duration::from_secs(4), async {
        tokio::join!(runtime.open(&plugin, "tool".into(), intent), async {
            while !runtime.openings.lock().contains_key(owner) {
                tokio::task::yield_now().await;
            }
            active.store(false, Ordering::Release);
            assert!(runtime
                .document_owners(document.id())
                .contains(&(owner.into(), plugin.id.clone())));
            runtime
                .close_document_owner(owner, &plugin.id, document.id())
                .await
        })
    })
    .await
    .expect("document cancellation must finish bounded Node startup");
    assert!(opened.is_err());
    assert_eq!(runs, vec!["pending-document-run"]);
    assert!(runtime.sessions.read().is_empty());
    assert!(runtime.openings.lock().is_empty());
    assert!(runtime.server.lock().await.is_none());
}

#[test]
fn native_agent_and_legacy_ui_intents_keep_explicit_opaque_binding() {
    let runtime = Sessions::default();
    let agent = runtime
        .take_intent(None, "agent-fixture", "plugin")
        .unwrap();
    assert!(agent.document.is_none());
    assert_eq!(agent.owner, "agent:agent-fixture:plugin");
    let id = runtime
        .create_intent(
            "window:main:legacy".into(),
            "atools-ui".into(),
            "plugin".into(),
        )
        .unwrap();
    assert!(runtime
        .take_intent(Some(&id), "atools-ui", "plugin")
        .unwrap()
        .document
        .is_none());
}

#[tokio::test]
async fn document_close_keeps_other_plugin_with_same_window_instance_usable() {
    let runtime = Sessions::default();
    let (first, first_active) = test_binding();
    let (second, _) = test_binding();
    let owner = "window:main:shared-instance";
    let first_id = runtime
        .create_bound_intent(
            owner.into(),
            "atools-ui".into(),
            "first-plugin".into(),
            Some(first.clone()),
        )
        .unwrap();
    let second_id = runtime
        .create_bound_intent(
            owner.into(),
            "atools-ui".into(),
            "second-plugin".into(),
            Some(second.clone()),
        )
        .unwrap();
    *runtime.intents.lock().get(&first_id).unwrap().run_id.lock() = Some("first-run".into());
    first_active.store(false, Ordering::Release);
    let owners = runtime.document_owners(first.id());
    assert_eq!(
        owners,
        [(owner.into(), "first-plugin".into())]
            .into_iter()
            .collect()
    );
    for (owner, plugin) in owners {
        assert_eq!(
            runtime
                .close_document_owner(&owner, &plugin, first.id())
                .await,
            vec!["first-run"]
        );
    }
    assert!(!runtime.intents.lock().contains_key(&first_id));
    assert!(runtime
        .take_intent(Some(&second_id), "atools-ui", "second-plugin")
        .is_ok());
    assert!(runtime
        .create_bound_intent(
            owner.into(),
            "atools-ui".into(),
            "second-plugin".into(),
            Some(second)
        )
        .is_ok());
}
