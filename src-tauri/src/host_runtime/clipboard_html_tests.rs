use super::{prepare_content, PreparedContent, RuntimeCommit};
use crate::host_runtime::{
    clipboard::ClipboardAccess,
    once_authorization::OnceAuthorization,
    registry::{self, Access},
    request::{ClipboardRequest, ContentPayload},
    sessions::Sessions,
    tests::plugin,
};
use atools_core::{
    agent::{PermissionDecision, PermissionScope},
    db::Database,
    task_run::{TaskRun, TaskRunInitiator, TaskRunStatus},
};
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

#[derive(Default)]
struct HtmlClipboard {
    writes: Mutex<Vec<(String, Option<String>)>>,
    fail: AtomicBool,
}

impl ClipboardAccess for HtmlClipboard {
    fn read(&self) -> Result<String, String> {
        Ok(String::new())
    }

    fn write(&self, _text: &str) -> Result<(), String> {
        Err("text write should not be used for HTML".into())
    }

    fn write_html(&self, html: &str, text: Option<&str>) -> Result<(), String> {
        if self.fail.load(Ordering::Acquire) {
            return Err("fixture write failed".into());
        }
        self.writes
            .lock()
            .push((html.to_owned(), text.map(str::to_owned)));
        Ok(())
    }
}

fn content_request(payload: Value) -> Result<ContentPayload, String> {
    match ClipboardRequest::parse(Access::ContentWrite, &payload)? {
        ClipboardRequest::ContentWrite(content) => Ok(content),
        _ => Err("expected content-write request".into()),
    }
}

fn prepared_html(html: &str, text: Option<&str>) -> PreparedContent {
    let mut payload = json!({"kind":"html","html":html});
    if let Some(text) = text {
        payload["text"] = json!(text);
    }
    prepare_content(content_request(payload).unwrap()).unwrap()
}

fn write_payload(backend: &HtmlClipboard, html: &str, text: Option<&str>) -> Result<(), String> {
    let mut payload = json!({"kind":"html","html":html});
    if let Some(text) = text {
        payload["text"] = json!(text);
    }
    crate::host_runtime::clipboard_paste::write_content(backend, content_request(payload)?)
}

#[test]
fn html_copy_preserves_dual_format_html_only_empty_and_unicode_values() {
    let backend = HtmlClipboard::default();
    let cases = [
        ("<b>rich</b>", Some("plain")),
        ("<i>html only</i>", None),
        ("", Some("")),
        ("<p>原样 🧰</p>", Some("纯文本\n🧰")),
    ];

    for (html, text) in cases {
        write_payload(&backend, html, text).unwrap();
        assert_eq!(
            backend.writes.lock().last().unwrap(),
            &(html.to_owned(), text.map(str::to_owned))
        );
    }
}

#[test]
fn html_parser_enforces_exact_shapes_and_both_size_budgets() {
    let backend = HtmlClipboard::default();
    for invalid in [
        json!({"kind":"html","html":"<b>x</b>","text":null}),
        json!({"kind":"html","html":"<b>x</b>","extra":true}),
        json!({"kind":"html","html":4}),
        json!({"kind":"html","text":"missing html"}),
        json!({"kind":"text","html":"wrong kind"}),
        json!({"kind":"html","html":"x","text":7}),
    ] {
        assert!(ClipboardRequest::parse(Access::ContentWrite, &invalid).is_err());
    }
    assert!(backend.writes.lock().is_empty());

    let exact_html_bytes =
        "x".repeat(crate::host_runtime::clipboard_html::MAX_HTML_CONTENT_BYTES - 3);
    write_payload(&backend, &exact_html_bytes, Some("界")).unwrap();
    assert_eq!(
        backend.writes.lock().last().unwrap().0.len() + 3,
        256 * 1024
    );
    assert!(write_payload(&backend, &exact_html_bytes, Some("界a")).is_err());

    // NUL is escaped as six ASCII bytes in the actual JSON wire representation.
    let wire_heavy_html = "\0".repeat(90_000);
    assert!(write_payload(&backend, &wire_heavy_html, None).is_err());
    assert_eq!(backend.writes.lock().len(), 1);
}

#[test]
fn html_write_errors_do_not_report_success_and_read_scope_cannot_write() {
    let backend = HtmlClipboard::default();
    backend.fail.store(true, Ordering::Release);
    assert!(write_payload(&backend, "<b>failure</b>", Some("failure")).is_err());
    assert!(backend.writes.lock().is_empty());

    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let tool = registry::ensure_tool(&db, &plugin, Access::Read).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &tool).unwrap(),
        PermissionDecision::Allow,
    );
    let runtime = Sessions::new(Arc::new(HtmlClipboard::default()));
    let intent = runtime
        .intent("read-only-owner".into(), plugin.id.clone(), Access::Read)
        .unwrap();
    let session = runtime.open(&intent, &plugin, Access::Read).unwrap();
    assert!(ClipboardRequest::parse(
        session.access,
        &json!({"kind":"html","html":"<b>read scope</b>"}),
    )
    .is_err());
    assert!(ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"kind":"html","html":"<b>history scope</b>"}),
    )
    .is_err());
    assert!(backend.writes.lock().is_empty());
}

fn allowed_commit(
    db: Database,
    runtime: Arc<Sessions>,
    document: Option<crate::plugin_page_runtime::DocumentBinding>,
) -> RuntimeCommit {
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let tool = registry::ensure_tool(&db, &plugin, Access::ContentWrite).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let intent = runtime
        .intent_with_document(
            "html-owner".into(),
            plugin.id.clone(),
            Access::ContentWrite,
            document,
        )
        .unwrap();
    let session = runtime
        .open(&intent, &plugin, Access::ContentWrite)
        .unwrap();
    RuntimeCommit {
        runtime,
        db,
        session,
    }
}

#[test]
fn html_commit_rechecks_revoked_permission_and_closed_document() {
    let db = Database::in_memory().unwrap();
    let backend = Arc::new(HtmlClipboard::default());
    let runtime = Arc::new(Sessions::new(backend.clone()));
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let tool = registry::ensure_tool(&db, &plugin, Access::ContentWrite).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let intent = runtime
        .intent(
            "revoked-owner".into(),
            plugin.id.clone(),
            Access::ContentWrite,
        )
        .unwrap();
    let session = runtime
        .open(&intent, &plugin, Access::ContentWrite)
        .unwrap();
    let commit = RuntimeCommit {
        runtime: runtime.clone(),
        db: db.clone(),
        session,
    };
    commit
        .write(
            backend.as_ref(),
            prepared_html("<b>before revoke</b>", None),
        )
        .unwrap();
    db.revoke_agent_tool("atools-ui", &tool).unwrap();
    let before = backend.writes.lock().len();
    assert!(commit
        .write(backend.as_ref(), prepared_html("<b>after revoke</b>", None))
        .is_err());
    assert_eq!(backend.writes.lock().len(), before);

    let (document, active) = crate::plugin_page_runtime::test_binding();
    let doc_commit = allowed_commit(db, runtime, Some(document));
    active.store(false, Ordering::Release);
    let backend = HtmlClipboard::default();
    assert!(doc_commit
        .write(&backend, prepared_html("<b>closed document</b>", None))
        .is_err());
    assert!(backend.writes.lock().is_empty());
}

fn confirmed_near_expiry_commit(db: &Database, runtime: Arc<Sessions>) -> RuntimeCommit {
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let access = Access::ContentWrite;
    let tool_name = registry::ensure_tool(db, &plugin, access).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool_name).unwrap(),
        PermissionDecision::Confirm,
    );
    let intent_id = runtime
        .intent("expiring-owner".into(), plugin.id.clone(), access)
        .unwrap();
    let mut run = TaskRun::new(
        tool_name.clone(),
        TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"open","intentId":intent_id}),
    );
    run.status = TaskRunStatus::Running;
    let tool = db.get_agent_tool(&tool_name).unwrap().unwrap();
    run.output = json!({
        "permission_required":true,"retry_after_grant":true,"request_id":"html-approved",
        "client_id":"atools-ui","tool":tool_name,"arguments":run.input,
        "scopes":tool.scopes,"capabilitySnapshot":"html-test-snapshot"
    });
    db.upsert_task_run(&run).unwrap();
    let mut state = runtime.store.lock();
    state.intents.get_mut(&intent_id).unwrap().created =
        Instant::now() - Duration::from_millis(599_000);
    *state.intents.get(&intent_id).unwrap().run.lock() = Some(run.id.clone());
    let intent = state.intents.get(&intent_id).unwrap().clone();
    drop(state);

    let proof = OnceAuthorization::for_confirmed_open(
        db, &intent_id, &intent, &plugin, access, &tool_name, &run.id,
    )
    .unwrap();
    let remaining = proof.remaining_ms();
    let session = runtime
        .open_with_once_authorization(&intent_id, &plugin, access, Some(proof))
        .unwrap();
    run.status = TaskRunStatus::Succeeded;
    run.output = json!({
        "sessionId":session.id,"pluginId":plugin.id,"access":access.label(),"runtime":"host-clipboard"
    });
    db.upsert_task_run(&run).unwrap();
    std::thread::sleep(Duration::from_millis(remaining.saturating_add(20)));
    RuntimeCommit {
        runtime,
        db: db.clone(),
        session,
    }
}

#[test]
fn expired_once_authorization_cannot_write_html() {
    let db = Database::in_memory().unwrap();
    let backend = Arc::new(HtmlClipboard::default());
    let runtime = Arc::new(Sessions::new(backend.clone()));
    let commit = confirmed_near_expiry_commit(&db, runtime);
    assert!(commit
        .write(backend.as_ref(), prepared_html("<b>expired</b>", None))
        .is_err());
    assert!(backend.writes.lock().is_empty());
}

#[test]
fn confirmed_open_uses_the_existing_content_write_scope() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let tool = registry::ensure_tool(&db, &plugin, Access::ContentWrite).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", &tool).unwrap(),
        PermissionDecision::Confirm,
    );
    assert_eq!(
        Access::ContentWrite.scopes(),
        vec![PermissionScope::ClipboardWrite],
    );
}

#[cfg(target_os = "macos")]
#[test]
#[ignore = "native integration requires macOS pasteboard service; run explicitly"]
fn named_pasteboard_round_trips_both_formats_and_replaces_stale_text() {
    struct ClearNamed(String);
    impl Drop for ClearNamed {
        fn drop(&mut self) {
            crate::host_runtime::clipboard_html::mac_clear_named(&self.0);
        }
    }

    let name = format!("dev.atools.html-test.{}", uuid::Uuid::new_v4());
    let _clear = ClearNamed(name.clone());
    crate::host_runtime::clipboard_html::mac_write_html(
        Some(&name),
        "<p>本机原样 🧰</p>",
        Some("纯文本 🧰"),
    )
    .unwrap();
    assert_eq!(
        crate::host_runtime::clipboard_html::mac_read_html_text(&name).unwrap(),
        (Some("<p>本机原样 🧰</p>".into()), Some("纯文本 🧰".into())),
    );

    crate::host_runtime::clipboard_html::mac_write_html(Some(&name), "<b>html only</b>", None)
        .unwrap();
    assert_eq!(
        crate::host_runtime::clipboard_html::mac_read_html_text(&name).unwrap(),
        (Some("<b>html only</b>".into()), None),
    );
    drop(_clear);
    assert_eq!(
        crate::host_runtime::clipboard_html::mac_read_html_text(&name).unwrap(),
        (None, None),
    );
}
