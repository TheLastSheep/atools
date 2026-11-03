use super::{
    execute_sync_request,
    once_authorization::OnceAuthorization,
    registry::{self, Access},
    request::ClipboardRequest,
    sessions::Sessions,
    tests::{fixture, plugin},
    validate_session,
};
use crate::plugin_page_runtime::test_binding;
use atools_core::{
    agent::PermissionDecision,
    db::Database,
    pasteboard::{PasteboardItem, PasteboardItemKind},
    task_run::{TaskRun, TaskRunInitiator, TaskRunStatus},
};
use serde_json::json;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const COPIED_AT: &str = "2026-10-23T10:00:00Z";
const RETENTION_CUTOFF: &str = "2026-10-22T00:00:00Z";

fn private_path(leaf: &str) -> String {
    std::env::temp_dir()
        .join(format!("atools-private-{leaf}"))
        .to_string_lossy()
        .into_owned()
}

fn shelf_item(id: &str, kind: PasteboardItemKind) -> PasteboardItem {
    PasteboardItem {
        id: id.into(),
        kind,
        title: Some("media history fixture".into()),
        source_app: None,
        source_device_id: "history-media-test".into(),
        copied_at: COPIED_AT.into(),
        updated_at: COPIED_AT.into(),
        content_fingerprint: format!("fingerprint-{id}"),
        payload: json!({"private": "payload must not enter audit"}),
        ocr_text: None,
        pinboard_id: None,
        pinboard_order_key: None,
        pinned: true,
        field_clocks: json!({}),
    }
}

fn confirmed_session(
    db: &Database,
    runtime: &Sessions,
    plugin: &atools_core::Plugin,
    access: Access,
    owner: &str,
    document: Option<crate::plugin_page_runtime::DocumentBinding>,
    intent_age: Duration,
) -> (Arc<super::sessions::Session>, String) {
    let tool_name = registry::ensure_tool(db, plugin, access).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool_name).unwrap(),
        PermissionDecision::Confirm
    );
    let intent_id = runtime
        .intent_with_document(owner.into(), plugin.id.clone(), access, document)
        .unwrap();
    let mut run = TaskRun::new(
        tool_name.clone(),
        TaskRunInitiator::human(Some("atools-ui".into())),
        json!({"operation":"open","intentId":intent_id}),
    );
    run.status = TaskRunStatus::Running;
    let tool = db.get_agent_tool(&tool_name).unwrap().unwrap();
    run.output = json!({
        "permission_required":true,
        "retry_after_grant":true,
        "request_id":"media-once-request",
        "client_id":"atools-ui",
        "tool":tool_name,
        "arguments":run.input,
        "scopes":tool.scopes,
        "capabilitySnapshot":"current-media-test-snapshot"
    });
    db.upsert_task_run(&run).unwrap();
    if !intent_age.is_zero() {
        runtime
            .store
            .lock()
            .intents
            .get_mut(&intent_id)
            .unwrap()
            .created = Instant::now() - intent_age;
    }
    let intent = runtime
        .store
        .lock()
        .intents
        .get(&intent_id)
        .unwrap()
        .clone();
    *intent.run.lock() = Some(run.id.clone());
    let proof = OnceAuthorization::for_confirmed_open(
        db, &intent_id, &intent, plugin, access, &tool_name, &run.id,
    )
    .unwrap();
    let session = runtime
        .open_with_once_authorization(&intent_id, plugin, access, Some(proof))
        .unwrap();
    run.status = TaskRunStatus::Succeeded;
    run.output = json!({
        "sessionId":session.id,
        "pluginId":plugin.id,
        "access":access.label(),
        "runtime":"host-clipboard"
    });
    db.upsert_task_run(&run).unwrap();
    (session, run.id)
}

fn record_image(db: &Database, item_id: &str, image_path: &str, preview: &str) {
    db.upsert_pasteboard_item(&shelf_item(item_id, PasteboardItemKind::Image))
        .unwrap();
    db.record_clipboard_media_projection(
        item_id,
        "image",
        &json!({"imagePath":image_path,"byteSize":4321,"preview":preview}),
        COPIED_AT,
        RETENTION_CUTOFF,
    )
    .unwrap();
}

#[test]
fn image_and_file_history_run_through_confirmed_session_without_persisting_private_payload() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, backend) = fixture();
    let (session, _) = confirmed_session(
        &db,
        &runtime,
        &plugin,
        Access::HistoryRead,
        "media-history-once",
        None,
        Duration::ZERO,
    );
    let image_path = private_path("secret-image.png");
    let image_preview = "private-image-preview-7d2c";
    record_image(&db, "media-shelf-image", &image_path, image_preview);
    let file_path = private_path("secret-file.txt");
    let file_preview = "private-file-preview-290a";
    db.upsert_pasteboard_item(&shelf_item("media-shelf-files", PasteboardItemKind::Files))
        .unwrap();
    db.record_clipboard_media_projection(
        "media-shelf-files",
        "file",
        &json!({
            "files":[{"path":file_path,"name":"secret-file.txt"}],
            "preview":file_preview
        }),
        COPIED_AT,
        RETENTION_CUTOFF,
    )
    .unwrap();
    db.record_clipboard_text("ordinary text history", COPIED_AT)
        .unwrap();

    assert!(validate_session(&db, &session).is_ok());
    let list = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":10}),
    )
    .unwrap();
    let page = execute_sync_request(&db, &session, &list, backend.as_ref()).unwrap();
    let items = page["items"].as_array().unwrap();
    let image = items.iter().find(|item| item["type"] == "image").unwrap();
    let file = items.iter().find(|item| item["type"] == "file").unwrap();
    assert_eq!(image["imagePath"], image_path);
    assert_eq!(image["content"], image_path);
    assert_eq!(image["preview"], image_preview);
    assert_eq!(image["byteSize"], 4321);
    assert_eq!(file["files"][0]["path"], file_path);
    assert_eq!(file["files"][0]["name"], "secret-file.txt");
    assert_eq!(file["content"][0], file_path);
    assert_eq!(file["preview"], file_preview);

    for row in [image, file] {
        let request = ClipboardRequest::parse(
            Access::HistoryRead,
            &json!({"operation":"getContent","id":row["id"].clone()}),
        )
        .unwrap();
        assert_eq!(
            execute_sync_request(&db, &session, &request, backend.as_ref()).unwrap(),
            row.clone()
        );
    }

    // The durable invocation run retains only an opaque ticket and summary;
    // returned media content remains in the synchronous response only.
    let ticket = "private-history-media-ticket";
    let mut audit_run = crate::agent_tools::new_task_run(
        "atools-ui",
        &session.tool,
        super::invocation_audit_args(&session.id, ticket),
    );
    crate::agent_tools::initialize_new_task_run(&db, &mut audit_run).unwrap();
    audit_run.output = super::invocation_audit_summary(ticket, Access::HistoryRead);
    db.upsert_task_run(&audit_run).unwrap();
    for persisted in db.list_task_runs(50).unwrap() {
        let encoded = serde_json::to_string(&persisted).unwrap();
        for private in [
            image_path.as_str(),
            image_preview,
            file_path.as_str(),
            file_preview,
            "secret-file.txt",
        ] {
            assert!(!encoded.contains(private));
        }
    }
}

#[test]
fn read_permission_cannot_clear_and_media_delete_uses_history_delete_access() {
    let db = Database::in_memory().unwrap();
    let plugin = plugin();
    db.save_plugin(&plugin).unwrap();
    let (runtime, backend) = fixture();
    let read_tool = registry::ensure_tool(&db, &plugin, Access::HistoryRead).unwrap();
    db.grant_agent_tool("atools-ui", &read_tool).unwrap();
    let read_session = runtime
        .open(
            &runtime
                .intent(
                    "media-read-only".into(),
                    plugin.id.clone(),
                    Access::HistoryRead,
                )
                .unwrap(),
            &plugin,
            Access::HistoryRead,
        )
        .unwrap();
    record_image(
        &db,
        "media-delete-image",
        &private_path("delete.png"),
        "delete preview",
    );
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(
            &db,
            "atools-ui",
            &registry::ensure_tool(&db, &plugin, Access::HistoryDelete).unwrap(),
        )
        .unwrap(),
        PermissionDecision::Confirm
    );
    assert!(ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"clear","type":"image"}),
    )
    .is_err());
    assert!(execute_sync_request(
        &db,
        &read_session,
        &ClipboardRequest::parse(
            Access::HistoryRead,
            &json!({"operation":"list","page":1,"pageSize":10}),
        )
        .unwrap(),
        backend.as_ref(),
    )
    .is_ok());
    assert!(db
        .plugin_clipboard_history_projection_exists("media-delete-image", "image")
        .unwrap());

    let delete_tool = registry::ensure_tool(&db, &plugin, Access::HistoryDelete).unwrap();
    db.grant_agent_tool("atools-ui", &delete_tool).unwrap();
    let delete_session = runtime
        .open(
            &runtime
                .intent(
                    "media-delete-owner".into(),
                    plugin.id.clone(),
                    Access::HistoryDelete,
                )
                .unwrap(),
            &plugin,
            Access::HistoryDelete,
        )
        .unwrap();
    // Resolve the generated stable ID through the database page, then issue the
    // same public delete request that a plugin transport reaches.
    let image_id = db
        .plugin_clipboard_history_page("", 1, 10)
        .unwrap()
        .items
        .into_iter()
        .find(|item| item.kind == "image")
        .unwrap()
        .id;
    let delete = ClipboardRequest::parse(
        Access::HistoryDelete,
        &json!({"operation":"delete","id":image_id}),
    )
    .unwrap();
    assert_eq!(
        execute_sync_request(&db, &delete_session, &delete, backend.as_ref()).unwrap()["deleted"],
        true
    );
    assert!(!db
        .plugin_clipboard_history_projection_exists("media-delete-image", "image")
        .unwrap());
}

#[test]
fn revoked_expired_and_stale_document_sessions_cannot_read_media_history() {
    let plugin = plugin();
    let media_path = private_path("session-gate-image.png");
    let list = ClipboardRequest::parse(
        Access::HistoryRead,
        &json!({"operation":"list","page":1,"pageSize":10}),
    )
    .unwrap();

    let db = Database::in_memory().unwrap();
    db.save_plugin(&plugin).unwrap();
    let (runtime, backend) = fixture();
    let tool = registry::ensure_tool(&db, &plugin, Access::HistoryRead).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let granted = runtime
        .open(
            &runtime
                .intent(
                    "media-revoked".into(),
                    plugin.id.clone(),
                    Access::HistoryRead,
                )
                .unwrap(),
            &plugin,
            Access::HistoryRead,
        )
        .unwrap();
    record_image(&db, "revoked-media", &media_path, "gated preview");
    db.revoke_agent_tool("atools-ui", &tool).unwrap();
    assert!(execute_sync_request(&db, &granted, &list, backend.as_ref()).is_err());

    let expire_db = Database::in_memory().unwrap();
    expire_db.save_plugin(&plugin).unwrap();
    let (expire_runtime, expire_backend) = fixture();
    let (expired, _) = confirmed_session(
        &expire_db,
        &expire_runtime,
        &plugin,
        Access::HistoryRead,
        "media-expired",
        None,
        Duration::from_secs(599),
    );
    record_image(&expire_db, "expired-media", &media_path, "expired preview");
    std::thread::sleep(Duration::from_millis(1100));
    assert!(execute_sync_request(&expire_db, &expired, &list, expire_backend.as_ref()).is_err());

    let document_db = Database::in_memory().unwrap();
    document_db.save_plugin(&plugin).unwrap();
    let (document_runtime, document_backend) = fixture();
    let (document, active) = test_binding();
    let (stale, _) = confirmed_session(
        &document_db,
        &document_runtime,
        &plugin,
        Access::HistoryRead,
        "media-stale-document",
        Some(document),
        Duration::ZERO,
    );
    record_image(&document_db, "stale-media", &media_path, "stale preview");
    active.store(false, std::sync::atomic::Ordering::Release);
    assert!(execute_sync_request(&document_db, &stale, &list, document_backend.as_ref()).is_err());
}
