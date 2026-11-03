use super::{
    clipboard::ClipboardAccess,
    clipboard_paste::{
        self, ClipboardCommit, ForegroundTarget, PasteGate, PasteHost, PreparedContent,
    },
    request::ContentPayload,
};
use super::{registry::Access, request::ClipboardRequest};
use parking_lot::Mutex;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

#[derive(Default)]
struct FakeClipboard {
    writes: Mutex<Vec<String>>,
    file_writes: Mutex<Vec<Vec<String>>>,
}
impl ClipboardAccess for FakeClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }
    fn write(&self, text: &str) -> Result<(), String> {
        self.writes.lock().push(text.into());
        Ok(())
    }
    fn write_files(&self, paths: &[String]) -> Result<(), String> {
        self.file_writes.lock().push(paths.to_vec());
        Ok(())
    }
}
struct FakePaste {
    events: Mutex<Vec<&'static str>>,
    current: std::sync::Arc<Mutex<ForegroundTarget>>,
    restore_ok: AtomicBool,
    on_hide: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}
impl FakePaste {
    fn new() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            current: std::sync::Arc::new(Mutex::new(ForegroundTarget {
                pid: 42,
                bundle_id: Some("test.target".into()),
            })),
            restore_ok: AtomicBool::new(true),
            on_hide: Mutex::new(None),
        }
    }
}
impl PasteHost for FakePaste {
    fn prepare_input(&self) -> Result<(), String> {
        self.events.lock().push("prepare");
        Ok(())
    }
    fn capture_target(&self) -> Result<ForegroundTarget, String> {
        self.events.lock().push("capture");
        Ok(ForegroundTarget {
            pid: 42,
            bundle_id: Some("test.target".into()),
        })
    }
    fn hide_owner_window(&self, _: &str) -> Result<(), String> {
        self.events.lock().push("hide");
        if let Some(callback) = self.on_hide.lock().as_ref() {
            callback();
        }
        Ok(())
    }
    fn restore_target(
        &self,
        expected: &ForegroundTarget,
        authorized: std::sync::Arc<dyn Fn() -> bool + Send + Sync>,
    ) -> Result<(), String> {
        self.events.lock().push("restore");
        if !authorized() {
            return Err("authorization revoked".into());
        }
        if !self.restore_ok.load(Ordering::SeqCst) {
            return Err("restore refused".into());
        }
        let mut current = self.current.lock();
        if *current == *expected {
            return Ok(());
        }
        if current.pid != std::process::id() as i32 {
            self.events.lock().push("refuse-steal");
            return Err("third party foreground".into());
        }
        *current = expected.clone();
        self.events.lock().push("activate-target");
        Ok(())
    }
    fn target_matches(&self, expected: &ForegroundTarget) -> bool {
        self.events.lock().push("verify");
        *self.current.lock() == *expected
    }
    fn paste_if_target_matches(
        &self,
        _: &ForegroundTarget,
        still_authorized: &dyn Fn() -> bool,
    ) -> Result<(), String> {
        if !still_authorized() {
            return Err("revoked".into());
        }
        self.events.lock().push("paste");
        Ok(())
    }
}

struct FakeCommit {
    active: std::sync::Arc<AtomicBool>,
    writes: AtomicUsize,
    pastes: AtomicUsize,
    close_on_write: bool,
}
impl FakeCommit {
    fn new() -> Self {
        Self {
            active: std::sync::Arc::new(AtomicBool::new(true)),
            writes: AtomicUsize::new(0),
            pastes: AtomicUsize::new(0),
            close_on_write: false,
        }
    }
}
impl ClipboardCommit for FakeCommit {
    fn valid(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    fn authorization(&self) -> std::sync::Arc<dyn Fn() -> bool + Send + Sync> {
        let active = self.active.clone();
        std::sync::Arc::new(move || active.load(Ordering::SeqCst))
    }
    fn write(&self, backend: &dyn ClipboardAccess, content: PreparedContent) -> Result<(), String> {
        if !self.valid() {
            return Err("closed".into());
        }
        self.writes.fetch_add(1, Ordering::SeqCst);
        clipboard_paste::write_prepared(backend, content)?;
        if self.close_on_write {
            self.active.store(false, Ordering::SeqCst);
        }
        Ok(())
    }
    fn paste(&self, host: &dyn PasteHost, target: &ForegroundTarget) -> Result<(), String> {
        if !self.valid() {
            return Err("closed".into());
        }
        self.pastes.fetch_add(1, Ordering::SeqCst);
        host.paste_if_target_matches(target, &|| self.valid())
    }
}

#[test]
fn paste_captures_hides_revalidates_writes_then_pastes_once() {
    let clipboard = FakeClipboard::default();
    let host = FakePaste::new();
    let commit = FakeCommit::new();
    let gate = PasteGate::default();
    clipboard_paste::write_and_paste(
        &clipboard,
        &host,
        "window:plugin:uuid",
        &gate,
        &commit,
        clipboard_paste::prepare_content(ContentPayload::Text("private fixture".into())).unwrap(),
    )
    .unwrap();
    assert_eq!(*clipboard.writes.lock(), ["private fixture"]);
    assert_eq!(
        *host.events.lock(),
        ["prepare", "capture", "hide", "restore", "verify", "verify", "paste"]
    );
}

#[test]
fn launcher_frontmost_after_hide_restores_captured_target_before_write_and_paste() {
    let clipboard = FakeClipboard::default();
    let host = FakePaste::new();
    let commit = FakeCommit::new();
    let gate = PasteGate::default();
    let current = host.current.clone();
    *host.on_hide.lock() = Some(Box::new(move || {
        *current.lock() = ForegroundTarget {
            pid: std::process::id() as i32,
            bundle_id: Some("atools".into()),
        };
    }));
    clipboard_paste::write_and_paste(
        &clipboard,
        &host,
        "window:plugin:uuid",
        &gate,
        &commit,
        clipboard_paste::prepare_content(ContentPayload::Text("private fixture".into())).unwrap(),
    )
    .unwrap();
    assert_eq!(*clipboard.writes.lock(), ["private fixture"]);
    assert_eq!(commit.writes.load(Ordering::SeqCst), 1);
    assert_eq!(commit.pastes.load(Ordering::SeqCst), 1);
    assert_eq!(
        *host.events.lock(),
        [
            "prepare",
            "capture",
            "hide",
            "restore",
            "activate-target",
            "verify",
            "verify",
            "paste"
        ]
    );
}

#[test]
fn changed_foreground_after_hide_prevents_clipboard_write_and_key_event() {
    let clipboard = FakeClipboard::default();
    let host = FakePaste::new();
    let commit = FakeCommit::new();
    let gate = PasteGate::default();
    let current = host.current.clone();
    *host.on_hide.lock() = Some(Box::new(move || {
        *current.lock() = ForegroundTarget {
            pid: 99,
            bundle_id: Some("third.party".into()),
        };
    }));
    assert!(clipboard_paste::write_and_paste(
        &clipboard,
        &host,
        "window:plugin:uuid",
        &gate,
        &commit,
        clipboard_paste::prepare_content(ContentPayload::Text("private fixture".into())).unwrap()
    )
    .is_err());
    assert!(clipboard.writes.lock().is_empty());
    assert!(!host.events.lock().contains(&"paste"));
}

#[test]
fn invalidation_after_clipboard_write_prevents_key_event() {
    let clipboard = FakeClipboard::default();
    let host = FakePaste::new();
    let commit = FakeCommit {
        close_on_write: true,
        ..FakeCommit::new()
    };
    let gate = PasteGate::default();
    let result = clipboard_paste::write_and_paste(
        &clipboard,
        &host,
        "window:plugin:uuid",
        &gate,
        &commit,
        clipboard_paste::prepare_content(ContentPayload::Text("private fixture".into())).unwrap(),
    );
    assert!(result.is_err());
    assert_eq!(*clipboard.writes.lock(), ["private fixture"]);
    assert!(!host.events.lock().contains(&"paste"));
}

#[test]
fn close_while_hidden_and_waiting_prevents_later_clipboard_write_or_key() {
    let clipboard = FakeClipboard::default();
    let host = FakePaste::new();
    let commit = FakeCommit::new();
    let gate = PasteGate::default();
    let close = commit.active.clone();
    *host.on_hide.lock() = Some(Box::new(move || close.store(false, Ordering::SeqCst)));
    let result = clipboard_paste::write_and_paste(
        &clipboard,
        &host,
        "window:plugin:uuid",
        &gate,
        &commit,
        clipboard_paste::prepare_content(ContentPayload::Text("private fixture".into())).unwrap(),
    );
    assert!(result.is_err());
    assert_eq!(commit.writes.load(Ordering::SeqCst), 0);
    assert_eq!(commit.pastes.load(Ordering::SeqCst), 0);
    assert!(clipboard.writes.lock().is_empty());
}

#[test]
fn restore_failure_prevents_clipboard_write_and_key_event() {
    let clipboard = FakeClipboard::default();
    let host = FakePaste::new();
    let commit = FakeCommit::new();
    let gate = PasteGate::default();
    host.restore_ok.store(false, Ordering::SeqCst);
    assert!(clipboard_paste::write_and_paste(
        &clipboard,
        &host,
        "window:plugin:uuid",
        &gate,
        &commit,
        clipboard_paste::prepare_content(ContentPayload::Text("private fixture".into())).unwrap(),
    )
    .is_err());
    assert!(clipboard.writes.lock().is_empty());
    assert!(!host.events.lock().contains(&"paste"));
}

#[test]
fn third_party_foreground_is_not_activated_or_overwritten() {
    let clipboard = FakeClipboard::default();
    let host = FakePaste::new();
    let commit = FakeCommit::new();
    let gate = PasteGate::default();
    let current = host.current.clone();
    *host.on_hide.lock() = Some(Box::new(move || {
        *current.lock() = ForegroundTarget {
            pid: 99,
            bundle_id: Some("third.party".into()),
        };
    }));
    assert!(clipboard_paste::write_and_paste(
        &clipboard,
        &host,
        "window:plugin:uuid",
        &gate,
        &commit,
        clipboard_paste::prepare_content(ContentPayload::Text("private fixture".into())).unwrap(),
    )
    .is_err());
    assert!(clipboard.writes.lock().is_empty());
    assert!(host.events.lock().contains(&"refuse-steal"));
    assert!(!host.events.lock().contains(&"paste"));
}

#[test]
fn concurrent_sessions_cannot_overlap_paste_transactions() {
    use std::sync::{Arc, Barrier};
    use std::thread;
    let gate = Arc::new(PasteGate::default());
    let clipboard_a = Arc::new(FakeClipboard::default());
    let host_a = Arc::new(FakePaste::new());
    let commit_a = Arc::new(FakeCommit::new());
    let entered_hide = Arc::new(Barrier::new(2));
    let release_hide = Arc::new(Barrier::new(2));
    let entered = entered_hide.clone();
    let release = release_hide.clone();
    *host_a.on_hide.lock() = Some(Box::new(move || {
        entered.wait();
        release.wait();
    }));
    let gate_a = gate.clone();
    let clipboard_a_thread = clipboard_a.clone();
    let host_a_thread = host_a.clone();
    let commit_a_thread = commit_a.clone();
    let first = thread::spawn(move || {
        clipboard_paste::write_and_paste(
            clipboard_a_thread.as_ref(),
            host_a_thread.as_ref(),
            "window:a:uuid",
            gate_a.as_ref(),
            commit_a_thread.as_ref(),
            clipboard_paste::prepare_content(ContentPayload::Text("session A".into())).unwrap(),
        )
    });
    entered_hide.wait();

    let clipboard_b = FakeClipboard::default();
    let host_b = FakePaste::new();
    let commit_b = FakeCommit::new();
    let second = clipboard_paste::write_and_paste(
        &clipboard_b,
        &host_b,
        "window:b:uuid",
        gate.as_ref(),
        &commit_b,
        clipboard_paste::prepare_content(ContentPayload::Text("session B".into())).unwrap(),
    );
    assert!(second.is_err());
    assert!(clipboard_b.writes.lock().is_empty());
    assert_eq!(commit_b.pastes.load(Ordering::SeqCst), 0);
    release_hide.wait();
    first.join().unwrap().unwrap();
    assert_eq!(*clipboard_a.writes.lock(), ["session A"]);
}

#[test]
fn content_write_and_paste_are_separate_fixed_permission_capabilities() {
    assert_eq!(
        Access::parse("content_write").unwrap().scopes(),
        [atools_core::agent::PermissionScope::ClipboardWrite]
    );
    assert_eq!(
        Access::parse("paste").unwrap().scopes(),
        [
            atools_core::agent::PermissionScope::ClipboardWrite,
            atools_core::agent::PermissionScope::InputKeyboard,
        ]
    );
    assert!(matches!(
        ClipboardRequest::parse(Access::ContentWrite, &json!({"kind":"text","text":"x"})),
        Ok(ClipboardRequest::ContentWrite(_))
    ));
    assert!(matches!(
        ClipboardRequest::parse(Access::Paste, &json!({"kind":"text","text":"x"})),
        Ok(ClipboardRequest::Paste(_))
    ));
    assert!(ClipboardRequest::parse(
        Access::ContentWrite,
        &json!({"kind":"text","text":"x","paste":true})
    )
    .is_err());
}

#[test]
fn file_content_uses_injected_clipboard_backend_after_bounded_path_validation() {
    let path = std::fs::canonicalize(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../ZTools-plugins/plugins/calculation-paper/logo.png"),
    )
    .unwrap()
    .to_string_lossy()
    .into_owned();
    let clipboard = FakeClipboard::default();
    clipboard_paste::write_content(&clipboard, ContentPayload::Files(vec![path.clone()])).unwrap();
    assert_eq!(*clipboard.file_writes.lock(), [vec![path]]);
}
