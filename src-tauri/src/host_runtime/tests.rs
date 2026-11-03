use super::{
    clipboard::{self, ClipboardAccess},
    registry::{self, Access},
    sessions::{credential, Sessions},
};
use atools_core::{db::Database, Plugin, PluginManifest};
use parking_lot::Mutex;
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};

#[derive(Default)]
pub(super) struct IsolatedClipboard {
    text: Mutex<String>,
    reads: AtomicUsize,
    writes: AtomicUsize,
}
impl ClipboardAccess for IsolatedClipboard {
    fn read(&self) -> Result<String, String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        Ok(self.text.lock().clone())
    }
    fn write(&self, text: &str) -> Result<(), String> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        *self.text.lock() = text.into();
        Ok(())
    }
}
pub(super) fn plugin() -> Plugin {
    let manifest: PluginManifest = serde_json::from_value(
        json!({"name":"exact-text-fixture","version":"1.0.0","main":"index.html"}),
    )
    .unwrap();
    Plugin {
        id: "exact-text-fixture".into(),
        name: manifest.name.clone(),
        version: manifest.version.clone(),
        path: "/isolated/plugin".into(),
        enabled: true,
        manifest,
        created_at: "now".into(),
        updated_at: "now".into(),
    }
}
pub(super) fn fixture() -> (Sessions, Arc<IsolatedClipboard>) {
    let backend = Arc::new(IsolatedClipboard::default());
    (Sessions::new(backend.clone()), backend)
}
#[test]
fn exact_values_and_hard_byte_boundaries() {
    let (_, backend) = fixture();
    for text in ["", " \t\n\r\n", "  原文 🧰\u{feff}\n", "a\0b"] {
        clipboard::exact_write(backend.as_ref(), text).unwrap();
        assert_eq!(clipboard::exact_read(backend.as_ref()).unwrap(), text);
    }
    let boundary = "界".repeat(clipboard::MAX_TEXT_BYTES / 3);
    clipboard::exact_write(backend.as_ref(), &boundary).unwrap();
    assert_eq!(clipboard::exact_read(backend.as_ref()).unwrap(), boundary);
    let before = backend.writes.load(Ordering::SeqCst);
    assert!(clipboard::exact_write(
        backend.as_ref(),
        &"界".repeat(clipboard::MAX_TEXT_BYTES / 3 + 1)
    )
    .is_err());
    assert_eq!(backend.writes.load(Ordering::SeqCst), before);
}
#[test]
fn directions_are_separate_and_registration_preserves_disabled_preferences() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    let read = registry::ensure_tool(&db, &plugin, Access::Read).unwrap();
    let write = registry::ensure_tool(&db, &plugin, Access::Write).unwrap();
    assert_ne!(read, write);
    assert_eq!(
        registry::access_for(&db.get_agent_tool(&read).unwrap().unwrap()).unwrap(),
        Access::Read
    );
    assert_eq!(
        db.get_agent_tool(&read).unwrap().unwrap().scopes,
        vec![Access::Read.scope()]
    );
    db.set_agent_tool_enabled(&read, false).unwrap();
    registry::ensure_tool(&db, &plugin, Access::Read).unwrap();
    assert!(!db.get_agent_tool(&read).unwrap().unwrap().enabled);
    assert!(db.get_agent_tool(&write).unwrap().unwrap().enabled);
}
#[tokio::test]
async fn opening_never_touches_clipboard_and_close_before_approval_cannot_resurrect() {
    let (runtime, backend) = fixture();
    let id = runtime
        .intent("owner".into(), plugin().id, Access::Read)
        .unwrap();
    runtime.close(Some("owner"), None, false).await;
    assert!(runtime.open(&id, &plugin(), Access::Read).is_err());
    assert!(runtime
        .intent("owner".into(), plugin().id, Access::Write)
        .is_err());
    assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
    assert_eq!(backend.writes.load(Ordering::SeqCst), 0);
    assert!(runtime.server.lock().await.is_none());
}
#[tokio::test]
async fn approval_is_one_shot_rotates_credentials_and_old_close_cancels_successor() {
    let (runtime, backend) = fixture();
    let id = runtime
        .intent("old".into(), plugin().id, Access::Read)
        .unwrap();
    let old = runtime.open(&id, &plugin(), Access::Read).unwrap();
    assert!(runtime.open(&id, &plugin(), Access::Read).is_err());
    runtime
        .rotate("old", "next", &plugin().id, &[old.id.clone()])
        .unwrap();
    assert!(runtime.get(&old.id).is_err());
    assert!(!*old.active.lock());
    let new = runtime
        .store
        .lock()
        .sessions
        .values()
        .next()
        .unwrap()
        .clone();
    assert_eq!(new.access, Access::Read);
    assert_ne!(old.token, new.token);
    assert!(!runtime
        .store
        .lock()
        .sessions
        .values()
        .any(|s| s.token == old.token));
    runtime.close(Some("old"), None, false).await;
    assert!(runtime.get(&new.id).is_err());
    assert!(runtime
        .intent("next".into(), plugin().id, Access::Read)
        .is_err());
    assert_eq!(backend.reads.load(Ordering::SeqCst), 0);
}
#[tokio::test]
async fn late_rotate_after_switch_or_revoke_is_rejected_without_new_session() {
    let runtime = Arc::new(fixture().0);
    let id = runtime
        .intent("old".into(), plugin().id, Access::Write)
        .unwrap();
    let session = runtime.open(&id, &plugin(), Access::Write).unwrap();
    let other_plugin = "other";
    assert!(runtime
        .rotate("old", "next", other_plugin, &[session.id.clone()])
        .is_err());
    runtime.close(Some("old"), None, false).await;
    assert!(runtime
        .rotate("old", "next", &plugin().id, &[session.id.clone()])
        .is_err());
    assert!(runtime.store.lock().sessions.is_empty());
}
#[test]
fn concurrent_approval_can_create_only_one_session() {
    let runtime = Arc::new(fixture().0);
    let id = runtime
        .intent("owner".into(), plugin().id, Access::Read)
        .unwrap();
    let threads: Vec<_> = (0..8)
        .map(|_| {
            let runtime = runtime.clone();
            let id = id.clone();
            std::thread::spawn(move || runtime.open(&id, &plugin(), Access::Read).is_ok())
        })
        .collect();
    assert_eq!(
        threads
            .into_iter()
            .map(|t| t.join().unwrap())
            .filter(|ok| *ok)
            .count(),
        1
    );
    assert_eq!(runtime.store.lock().sessions.len(), 1);
    assert_ne!(credential(), credential());
}
