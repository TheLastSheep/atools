use super::{
    registry,
    sessions::{Binding, Sessions},
    source_hint::{Hints, Usage},
    transport,
};
use atools_core::{agent::PermissionScope, Database, Plugin};
use serde_json::json;
use std::{
    sync::{atomic::Ordering, Arc},
    time::{Duration, Instant},
};
pub(super) fn fixture() -> (Database, Plugin, Binding, Sessions) {
    let db = Database::in_memory().unwrap();
    let plugin:Plugin=serde_json::from_value(json!({"id":"display-fixture","name":"display-fixture","version":"1.0.0","path":"/inert","enabled":true,"manifest":{"name":"display-fixture","version":"1.0.0","main":"index.html"},"created_at":"now","updated_at":"now"})).unwrap();
    db.save_plugin(&plugin).unwrap();
    let binding = Binding::current(&db, &plugin).unwrap();
    (db, plugin, binding, Sessions::new())
}
pub(super) fn open(
    runtime: &Sessions,
    plugin: &Plugin,
    binding: &Binding,
    owner: &str,
) -> Arc<super::sessions::Session> {
    let intent = runtime
        .intent_with_document(owner.into(), plugin.id.clone(), binding.clone(), None)
        .unwrap();
    let session = runtime.open(&intent, plugin, binding).unwrap();
    runtime.complete_open(&intent, &session.id).unwrap();
    session
}
#[test]
fn display_scope_is_separate_and_disabled_preferences_are_preserved() {
    let (db, plugin, _, _) = fixture();
    let name = registry::ensure_tool(&db, &plugin).unwrap();
    let tool = db.get_agent_tool(&name).unwrap().unwrap();
    assert_eq!(tool.scopes, vec![PermissionScope::DisplayRead]);
    registry::validate_tool(&tool).unwrap();
    for scopes in [
        vec![PermissionScope::ClipboardRead],
        vec![PermissionScope::Screenshot],
        vec![],
    ] {
        let mut wrong = tool.clone();
        wrong.scopes = scopes;
        assert!(registry::validate_tool(&wrong).is_err());
    }
    let mut wrong = tool.clone();
    wrong.plugin_id = Some("other".into());
    assert!(registry::validate_tool(&wrong).is_err());
    let mut wrong = tool;
    wrong.source = "host_clipboard".into();
    assert!(registry::validate_tool(&wrong).is_err());
    db.set_agent_tool_enabled(&name, false).unwrap();
    registry::ensure_tool(&db, &plugin).unwrap();
    assert!(!db.get_agent_tool(&name).unwrap().unwrap().enabled);
}
#[test]
fn display_transport_accepts_only_snapshot_without_coordinates_or_operation_replay() {
    transport::parse_request(&json!({"operation":"snapshot"})).unwrap();
    for value in [
        json!({}),
        json!({"operation":"snapshot","cursor":{"x":1,"y":2}}),
        json!({"operation":"capture"}),
        json!({"operation":"snapshot","token":"secret"}),
        json!([]),
        json!(null),
    ] {
        let error = transport::parse_request(&value).unwrap_err();
        assert!(!error.contains("secret"));
    }
}
#[tokio::test]
async fn display_open_is_one_shot_no_listener_or_native_observation_and_close_blocks_late_approval()
{
    let (_, plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document("owner".into(), plugin.id.clone(), binding.clone(), None)
        .unwrap();
    let session = runtime.open(&intent, &plugin, &binding).unwrap();
    assert!(runtime.open(&intent, &plugin, &binding).is_err());
    assert!(runtime.server.lock().await.is_none());
    assert!(runtime.store.lock().invocations.is_empty());
    runtime.close(Some("owner"), None, false).await;
    assert!(!*session.active.lock());
    assert!(runtime.by_token(&session.token).is_none());
    assert!(runtime.open(&intent, &plugin, &binding).is_err());
    assert!(runtime
        .intent_with_document("owner".into(), plugin.id, binding, None)
        .is_err());
}
#[test]
fn display_binding_rejects_path_version_revision_and_disable_changes() {
    let (db, mut plugin, binding, _) = fixture();
    for change in 0..3 {
        let original = plugin.clone();
        match change {
            0 => plugin.path = "/different".into(),
            1 => plugin.version = "2.0.0".into(),
            _ => plugin.enabled = false,
        }
        db.save_plugin(&plugin).unwrap();
        assert!(binding.validate(&db, &plugin.id).is_err());
        plugin = original;
        db.save_plugin(&plugin).unwrap();
    }
    crate::plugin_code_revision::CodeRevision::begin(&db, &plugin.id)
        .unwrap()
        .finish(&db)
        .unwrap();
    assert!(binding.validate(&db, &plugin.id).is_err());
}
#[test]
fn display_open_rejects_binding_changed_while_permission_pending() {
    let (db, mut plugin, binding, runtime) = fixture();
    let intent = runtime
        .intent_with_document("owner".into(), plugin.id.clone(), binding, None)
        .unwrap();
    plugin.version = "2.0.0".into();
    db.save_plugin(&plugin).unwrap();
    let current = Binding::current(&db, &plugin).unwrap();
    assert!(runtime.open(&intent, &plugin, &current).is_err());
    assert!(runtime.store.lock().sessions.is_empty());
}
#[test]
fn display_concurrent_approval_creates_exactly_one_session() {
    let (_, plugin, binding, runtime) = fixture();
    let runtime = Arc::new(runtime);
    let intent = runtime
        .intent_with_document("owner".into(), plugin.id.clone(), binding.clone(), None)
        .unwrap();
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let r = runtime.clone();
            let p = plugin.clone();
            let b = binding.clone();
            let i = intent.clone();
            std::thread::spawn(move || r.open(&i, &p, &b).is_ok())
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .filter_map(|t| t.join().ok())
            .filter(|v| *v)
            .count(),
        1
    );
    assert_eq!(runtime.store.lock().sessions.len(), 1);
}
#[tokio::test]
async fn display_rotate_revokes_credentials_and_old_close_reaches_successor() {
    let (_, plugin, binding, runtime) = fixture();
    let old = open(&runtime, &plugin, &binding, "old");
    runtime
        .rotate("old", "new", &plugin.id, &[old.id.clone()])
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
    assert!(!*old.active.lock());
    assert!(runtime.by_token(&old.token).is_none());
    assert_eq!(new.binding, binding);
    runtime.close(Some("old"), Some(&plugin.id), false).await;
    assert!(runtime.get(&new.id).is_err());
    assert!(runtime.store.lock().sessions.is_empty());
}
#[tokio::test]
async fn display_native_document_revoke_blocks_pending_open_and_requires_new_document_on_rotate() {
    let (_, plugin, binding, runtime) = fixture();
    let (document, active) = crate::plugin_page_runtime::test_binding();
    let intent = runtime
        .intent_with_document(
            "old".into(),
            plugin.id.clone(),
            binding.clone(),
            Some(document.clone()),
        )
        .unwrap();
    let old = runtime.open(&intent, &plugin, &binding).unwrap();
    assert!(runtime
        .rotate_bound("old", "new", &plugin.id, &[old.id.clone()], None)
        .is_err());
    runtime.complete_open(&intent, &old.id).unwrap();
    let (next, next_active) = crate::plugin_page_runtime::test_binding();
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
    active.store(false, Ordering::Release);
    assert!(runtime.by_token(&new.token).is_some());
    next_active.store(false, Ordering::Release);
    assert!(runtime.by_token(&new.token).is_none());
    for (owner, plugin) in runtime.document_owners(next.id()) {
        runtime
            .close_document_owner(&owner, &plugin, next.id())
            .await;
    }
    assert!(runtime.store.lock().sessions.is_empty());
    assert!(runtime
        .intent_with_document("late".into(), plugin.id, binding, Some(document))
        .is_err());
}
#[tokio::test]
async fn display_close_collects_pending_and_running_tickets_and_stop_is_final() {
    let (_, plugin, binding, runtime) = fixture();
    let session = open(&runtime, &plugin, &binding, "owner");
    let ticket = super::sessions::credential();
    runtime.store.lock().invocations.insert(
        ticket,
        Arc::new(super::sessions::Invocation {
            session: session.id.clone(),
            claimed: Default::default(),
            run: parking_lot::Mutex::new(Some("running".into())),
            result: Default::default(),
        }),
    );
    let pending = runtime
        .intent_with_document("second".into(), plugin.id.clone(), binding.clone(), None)
        .unwrap();
    *runtime.store.lock().intents[&pending].run.lock() = Some("pending".into());
    let mut runs = runtime.close(None, Some(&plugin.id), true).await;
    runs.sort();
    assert_eq!(runs, vec!["pending", "running"]);
    assert!(!*session.active.lock());
    assert!(runtime.store.lock().sessions.is_empty());
    assert!(runtime
        .intent_with_document("late".into(), plugin.id, binding, None)
        .is_err());
}
#[test]
fn display_capacity_and_expiry_are_bounded_without_idle_timers() {
    let (_, plugin, binding, runtime) = fixture();
    for index in 0..32 {
        open(&runtime, &plugin, &binding, &format!("owner-{index}"));
    }
    // Remove consumed intents as the real prepare command does after audit.
    runtime.store.lock().intents.clear();
    let extra = runtime
        .intent_with_document("extra".into(), plugin.id.clone(), binding.clone(), None)
        .unwrap();
    assert!(runtime.open(&extra, &plugin, &binding).is_err());
    assert_eq!(runtime.store.lock().sessions.len(), 32);
    for intent in runtime.store.lock().intents.values_mut() {
        intent.created = Instant::now() - Duration::from_secs(601);
        *intent.run.lock() = Some("expired".into());
    }
    assert_eq!(runtime.expire(), vec!["expired"]);
    assert!(runtime.open(&extra, &plugin, &binding).is_err());
}
#[test]
fn display_source_hints_are_nonexecuting_bounded_revision_cached_and_conversion_free() {
    let (_, mut plugin, _, _) = fixture();
    let dir = tempfile::tempdir().unwrap();
    plugin.path = dir.path().to_string_lossy().into();
    let path = dir.path().join("preload.js");
    let hints = Hints::default();
    for source in ["window.utools.getAllDisplays()","require('electron').screen['getCursorScreenPoint']()","ztools [ 'getDisplayMatching' ] ({x:0,y:0,width:1,height:1}); throw new Error('must not run')"] {
        std::fs::write(&path,source).unwrap();assert_eq!(hints.scan(&plugin,None),Usage::Detected);
    }
    std::fs::write(
        &path,
        "window.utools.dipToScreenRect(x); window.title='web'",
    )
    .unwrap();
    assert_eq!(hints.scan(&plugin, None), Usage::NotDetected);
    std::fs::write(&path, "window.ztools.getPrimaryDisplay()").unwrap();
    assert_eq!(hints.scan(&plugin, Some("a")), Usage::Detected);
    std::fs::write(&path, "window.title='web'").unwrap();
    assert_eq!(hints.scan(&plugin, Some("a")), Usage::Detected);
    assert_eq!(hints.scan(&plugin, Some("b")), Usage::NotDetected);
    hints.invalidate(Some(&plugin.id));
    assert_eq!(hints.scan(&plugin, Some("a")), Usage::NotDetected);
    std::fs::write(
        dir.path().join("oversize.js"),
        vec![b'x'; 2 * 1024 * 1024 + 1],
    )
    .unwrap();
    assert_eq!(hints.scan(&plugin, None), Usage::Unknown);
}

#[test]
fn display_durable_inputs_reject_payloads_coordinates_and_forged_credentials() {
    let id = super::sessions::credential();
    assert_eq!(
        super::privacy::private_operation(&json!({"operation":"open","intentId":id})).unwrap(),
        "open"
    );
    assert_eq!(
        super::privacy::private_operation(
            &json!({"operation":"request","sessionId":id,"invocationId":id})
        )
        .unwrap(),
        "request"
    );
    for value in [
        json!({"operation":"open","intentId":"/private/secret"}),
        json!({"operation":"open","intentId":id,"cursor":{"x":1,"y":2}}),
        json!({"operation":"request","sessionId":id,"invocationId":id,"snapshot":{}}),
        json!({"operation":"snapshot"}),
    ] {
        let error = super::privacy::private_operation(&value).unwrap_err();
        assert!(!error.contains("/private/secret"));
    }
}
