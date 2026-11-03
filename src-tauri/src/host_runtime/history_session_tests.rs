use super::{
    clipboard, execute_sync_request,
    registry::{self, Access},
    request::ClipboardRequest,
    tests::{fixture, plugin},
};
use crate::plugin_page_runtime::test_binding;
use atools_core::{agent::PermissionDecision, db::Database};
use serde_json::json;
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};

const COPIED_AT: &str = "2026-10-22T10:00:00Z";

fn fixture_database() -> (Database, atools_core::Plugin) {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    (db, plugin)
}

fn open_granted_session(
    db: &Database,
    runtime: &super::Sessions,
    plugin: &atools_core::Plugin,
    access: Access,
    owner: &str,
) -> Arc<super::sessions::Session> {
    let tool = registry::ensure_tool(db, plugin, access).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let intent = runtime
        .intent(owner.into(), plugin.id.clone(), access)
        .unwrap();
    runtime.open(&intent, plugin, access).unwrap()
}

fn list_request() -> ClipboardRequest {
    ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":10}),
    )
    .unwrap()
}

#[derive(Default)]
struct ReadCountingClipboard(AtomicUsize);

impl clipboard::ClipboardAccess for ReadCountingClipboard {
    fn read(&self) -> Result<String, String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err("history lookup must not read the system clipboard".into())
    }

    fn write(&self, _: &str) -> Result<(), String> {
        Ok(())
    }
}

#[test]
fn authenticated_history_page_preserves_full_copyable_content_and_persists_only_ticket_metadata() {
    let (db, plugin) = fixture_database();
    let (runtime, backend) = fixture();
    let session =
        open_granted_session(&db, &runtime, &plugin, Access::HistoryRead, "history-owner");
    let first = format!("{} first", "a".repeat(300));
    let second = "second copied row".to_string();
    let first_entry = db
        .record_clipboard_text(&first, "2026-10-22T10:02:00Z")
        .unwrap();
    db.record_clipboard_text(&second, "2026-10-22T10:01:00Z")
        .unwrap();

    let list = execute_sync_request(&db, &session, &list_request(), backend.as_ref()).unwrap();
    let items = list["items"].as_array().unwrap();
    assert_eq!(items.len(), 2);
    assert_eq!(items[0]["content"], first);
    assert_eq!(items[1]["content"], second);
    assert_eq!(items[0]["preview"].as_str().unwrap().chars().count(), 256);
    assert!(items[0]["timestamp"].is_number());
    let merged = items
        .iter()
        .map(|item| item["content"].as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    assert_eq!(merged, format!("{first}\n{second}"));
    assert_eq!(items[0]["id"], first_entry.id);
    assert_eq!(items[0]["type"], "text");
    assert!(items.iter().all(|item| item.get("appName").is_none()));

    let query = "private-query-marker";
    let queried = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":10,"query":query}),
    )
    .unwrap();
    assert_eq!(
        execute_sync_request(&db, &session, &queried, backend.as_ref()).unwrap()["total"],
        0
    );
    let input = super::invocation_audit_args(&session.id, "invocation-marker");
    let output = super::invocation_audit_summary("invocation-marker", Access::HistoryRead);
    let mut run = crate::agent_tools::new_task_run("atools-ui", &session.tool, input);
    crate::agent_tools::initialize_new_task_run(&db, &mut run).unwrap();
    run.output = output;
    db.upsert_task_run(&run).unwrap();
    let persisted = db.get_task_run(&run.id).unwrap().unwrap();
    let encoded = serde_json::to_string(&persisted).unwrap();
    for private in [
        first.as_str(),
        second.as_str(),
        query,
        first_entry.id.as_str(),
    ] {
        assert!(!encoded.contains(private));
    }
    let first_preview: String = first.chars().take(256).collect();
    assert!(!encoded.contains(&first_preview));
    assert_eq!(persisted.input.as_object().unwrap().len(), 3);
    assert_eq!(persisted.input["operation"], "request");
    assert_eq!(persisted.input["invocationId"], "invocation-marker");
}

#[test]
fn read_grant_cannot_authorize_delete_and_denied_clear_leaves_database_unchanged() {
    let (db, plugin) = fixture_database();
    let (runtime, backend) = fixture();
    let read = open_granted_session(&db, &runtime, &plugin, Access::HistoryRead, "read-owner");
    let write_tool = registry::ensure_tool(&db, &plugin, Access::Write).unwrap();
    db.grant_agent_tool("atools-ui", &write_tool).unwrap();
    let delete_tool = registry::ensure_tool(&db, &plugin, Access::HistoryDelete).unwrap();
    assert_eq!(
        super::super::agent_tools::permission_decision_for_tool(&db, "atools-ui", &read.tool)
            .unwrap(),
        PermissionDecision::Allow
    );
    assert_eq!(
        super::super::agent_tools::permission_decision_for_tool(&db, "atools-ui", &write_tool)
            .unwrap(),
        PermissionDecision::Allow
    );

    assert_eq!(
        super::super::agent_tools::permission_decision_for_tool(&db, "atools-ui", &delete_tool)
            .unwrap(),
        PermissionDecision::Confirm
    );
    assert!(ClipboardRequest::parse(Access::HistoryRead, &json!({"operation":"clear"})).is_err());
    assert!(ClipboardRequest::parse(
        Access::Write,
        &json!({"operation":"delete","id":"clip-0123456789abcdef"})
    )
    .is_err());

    db.record_clipboard_text("must remain", COPIED_AT).unwrap();
    let deleted_entry = db
        .record_clipboard_text("delete exactly this row", "2026-10-22T10:01:00Z")
        .unwrap();
    db.grant_agent_tool("atools-ui", &delete_tool).unwrap();
    let delete = runtime
        .intent(
            "delete-owner".into(),
            plugin.id.clone(),
            Access::HistoryDelete,
        )
        .unwrap();
    let delete_session = runtime
        .open(&delete, &plugin, Access::HistoryDelete)
        .unwrap();
    let delete_request = ClipboardRequest::parse(
        Access::HistoryDelete,
        &json!({"operation":"delete","id":deleted_entry.id}),
    )
    .unwrap();
    assert_eq!(
        execute_sync_request(&db, &delete_session, &delete_request, backend.as_ref()).unwrap()
            ["deleted"],
        true
    );
    assert_eq!(db.search_clipboard_history("", 10).unwrap().len(), 1);

    db.set_setting("agent.scope_policy", r#"{"clipboard_delete":"deny"}"#)
        .unwrap();
    let clear =
        ClipboardRequest::parse(Access::HistoryDelete, &json!({"operation":"clear"})).unwrap();
    assert!(execute_sync_request(&db, &delete_session, &clear, backend.as_ref()).is_err());
    assert_eq!(db.search_clipboard_history("", 10).unwrap().len(), 1);
}

#[test]
fn expired_history_authorization_cannot_open_a_session() {
    let (db, plugin) = fixture_database();
    let (runtime, _) = fixture();
    let tool = registry::ensure_tool(&db, &plugin, Access::HistoryRead).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let intent = runtime
        .intent(
            "expired-owner".into(),
            plugin.id.clone(),
            Access::HistoryRead,
        )
        .unwrap();
    runtime
        .store
        .lock()
        .intents
        .get_mut(&intent)
        .unwrap()
        .created = Instant::now() - Duration::from_secs(601);
    assert!(runtime.open(&intent, &plugin, Access::HistoryRead).is_err());
    assert!(runtime.store.lock().sessions.is_empty());
}

#[test]
fn get_content_accepts_exact_256_kib_and_rejects_larger_body_without_truncation() {
    let (db, _) = fixture_database();
    let exact = "x".repeat(clipboard::MAX_TEXT_BYTES);
    let exact_row = db.record_clipboard_text(&exact, COPIED_AT).unwrap();
    let too_large = "y".repeat(clipboard::MAX_TEXT_BYTES + 1);
    let too_large_row = db
        .record_clipboard_text(&too_large, "2026-10-22T10:01:00Z")
        .unwrap();

    let exact_request = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"getContent","id":exact_row.id}),
    )
    .unwrap();
    let (_, backend) = fixture();
    let exact_output = exact_request
        .execute_host(Access::HistoryRead, backend.as_ref(), &db)
        .unwrap();
    assert_eq!(exact_output["content"], exact);
    assert_eq!(
        exact_output["content"].as_str().unwrap().len(),
        clipboard::MAX_TEXT_BYTES
    );

    let oversized_request = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"getContent","id":too_large_row.id}),
    )
    .unwrap();
    assert!(oversized_request
        .execute_host(Access::HistoryRead, backend.as_ref(), &db)
        .is_err());
    let unchanged = db
        .search_clipboard_history("", 10)
        .unwrap()
        .into_iter()
        .find(|entry| entry.id == too_large_row.id)
        .unwrap();
    assert_eq!(unchanged.text, too_large);

    let page_db = Database::in_memory().unwrap();
    page_db
        .record_clipboard_text(&exact, "2026-10-22T10:02:00Z")
        .unwrap();
    page_db
        .record_clipboard_text(
            &too_large[..clipboard::MAX_TEXT_BYTES],
            "2026-10-22T10:01:00Z",
        )
        .unwrap();
    let page_request = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":2}),
    )
    .unwrap();
    let (_, page_backend) = fixture();
    assert!(page_request
        .execute_host(Access::HistoryRead, page_backend.as_ref(), &page_db)
        .is_err());
}

#[test]
fn deleted_history_content_returns_null_without_system_clipboard_read() {
    let db = Database::in_memory().unwrap();
    let backend = ReadCountingClipboard::default();
    let row = db
        .record_clipboard_text("copyable text", COPIED_AT)
        .unwrap();
    let get = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"getContent","id":row.id}),
    )
    .unwrap();
    let existing = get
        .execute_host(Access::HistoryRead, &backend, &db)
        .unwrap();
    assert_eq!(existing["content"], "copyable text");

    let delete = ClipboardRequest::parse(
        Access::HistoryDelete,
        &json!({"operation":"delete","id":row.id}),
    )
    .unwrap();
    assert_eq!(
        delete
            .execute_host(Access::HistoryDelete, &backend, &db)
            .unwrap()["deleted"],
        true
    );
    assert_eq!(
        get.execute_host(Access::HistoryRead, &backend, &db)
            .unwrap(),
        serde_json::Value::Null
    );
    assert_eq!(backend.0.load(Ordering::SeqCst), 0);

    for id in ["clip-short", "clip-0123456789abcdeG"] {
        assert!(ClipboardRequest::parse(
            Access::HistoryRead,
            &json!({"operation":"getContent","id":id}),
        )
        .is_err());
    }
}

#[tokio::test]
async fn synchronous_history_dispatch_rejects_closed_revoked_and_rebound_documents() {
    let (db, plugin) = fixture_database();
    let (runtime, backend) = fixture();
    let session = open_granted_session(&db, &runtime, &plugin, Access::HistoryRead, "close-owner");
    let request = list_request();
    assert!(execute_sync_request(&db, &session, &request, backend.as_ref()).is_ok());
    // A removed/expired session fails before the same authenticated dispatch.
    runtime.remove(&session.id).await;
    assert!(runtime.get(&session.id).is_err());
    assert!(execute_sync_request(&db, &session, &request, backend.as_ref()).is_err());

    let close_runtime = super::Sessions::new(backend.clone());
    let close_session = open_granted_session(
        &db,
        &close_runtime,
        &plugin,
        Access::HistoryRead,
        "closed-owner",
    );
    close_runtime.close(Some("closed-owner"), None, false).await;
    assert!(execute_sync_request(&db, &close_session, &request, backend.as_ref()).is_err());

    let revoked_runtime = super::Sessions::new(backend.clone());
    let (revoked_document, revoked_active) = test_binding();
    let revoked_intent = revoked_runtime
        .intent_with_document(
            "revoked-owner".into(),
            plugin.id.clone(),
            Access::HistoryRead,
            Some(revoked_document),
        )
        .unwrap();
    let revoked_session = revoked_runtime
        .open(&revoked_intent, &plugin, Access::HistoryRead)
        .unwrap();
    revoked_active.store(false, std::sync::atomic::Ordering::Release);
    assert!(execute_sync_request(&db, &revoked_session, &request, backend.as_ref()).is_err());

    let rebound_runtime = super::Sessions::new(backend.clone());
    let (old_document, _) = test_binding();
    let old_intent = rebound_runtime
        .intent_with_document(
            "old-document-owner".into(),
            plugin.id.clone(),
            Access::HistoryRead,
            Some(old_document),
        )
        .unwrap();
    let old_session = rebound_runtime
        .open(&old_intent, &plugin, Access::HistoryRead)
        .unwrap();
    let (new_document, _) = test_binding();
    rebound_runtime
        .rotate_bound(
            "old-document-owner",
            "new-document-owner",
            &plugin.id,
            &[old_session.id.clone()],
            Some(new_document),
        )
        .unwrap();
    assert!(execute_sync_request(&db, &old_session, &request, backend.as_ref()).is_err());
    let new_session = rebound_runtime
        .store
        .lock()
        .sessions
        .values()
        .next()
        .unwrap()
        .clone();
    assert!(execute_sync_request(&db, &new_session, &request, backend.as_ref()).is_ok());

    db.set_setting("agent.scope_policy", r#"{"clipboard_read":"deny"}"#)
        .unwrap();
    assert!(execute_sync_request(&db, &new_session, &request, backend.as_ref()).is_err());
}

#[test]
fn revoked_read_grant_rejects_history_page_without_database_changes() {
    let (db, plugin) = fixture_database();
    let (runtime, backend) = fixture();
    let session = open_granted_session(
        &db,
        &runtime,
        &plugin,
        Access::HistoryRead,
        "revoked-read-owner",
    );
    let original = db
        .record_clipboard_text("must stay unchanged", COPIED_AT)
        .unwrap();
    assert!(db.revoke_agent_tool("atools-ui", &session.tool).unwrap());

    assert!(execute_sync_request(&db, &session, &list_request(), backend.as_ref()).is_err());
    let remaining = db.search_clipboard_history("", 10).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, original.id);
    assert_eq!(remaining[0].text, original.text);
    assert_eq!(remaining[0].used_count, original.used_count);
}

#[test]
fn revoked_delete_grant_rejects_delete_without_database_changes() {
    let (db, plugin) = fixture_database();
    let (runtime, backend) = fixture();
    let session = open_granted_session(
        &db,
        &runtime,
        &plugin,
        Access::HistoryDelete,
        "revoked-delete-owner",
    );
    let original = db
        .record_clipboard_text("must survive delete", COPIED_AT)
        .unwrap();
    let request = ClipboardRequest::parse(
        Access::HistoryDelete,
        &json!({"operation":"delete","id":original.id}),
    )
    .unwrap();
    assert!(db.revoke_agent_tool("atools-ui", &session.tool).unwrap());

    assert!(execute_sync_request(&db, &session, &request, backend.as_ref()).is_err());
    let remaining = db.search_clipboard_history("", 10).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].id, original.id);
    assert_eq!(remaining[0].text, original.text);
    assert_eq!(remaining[0].used_count, original.used_count);
}

#[test]
fn clipboard_history_search_preserves_current_text_bytes_in_temporary_database() {
    let db = Database::in_memory().unwrap();
    let original = " \nClipboard text with surrounding whitespace\t\n ";
    let result = crate::agent_tools::search_clipboard_history(
        &db,
        Some(original),
        json!({"query":"Clipboard text","limit":10}),
    )
    .unwrap();
    assert_eq!(result["total"], 1);
    assert_eq!(result["items"][0]["text"], original);

    crate::agent_tools::search_clipboard_history(
        &db,
        Some(" \n\t "),
        json!({"query":"","limit":10}),
    )
    .unwrap();
    let entries = db.search_clipboard_history("", 10).unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].text, original);
}
