use atools_core::{agent::PermissionScope, Database};
use serde_json::json;
use std::{fs, sync::atomic::Ordering};
use tempfile::tempdir;

#[tokio::test]
async fn actual_node_session_reads_utf8_and_rejects_revoked_or_changed_context() {
    let (_plugin_dir, plugin) = crate::legacy_runtime::session_tests::fixture();
    let db = Database::in_memory().unwrap();
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    let tool = crate::legacy_runtime::registry::ensure_tool(&db, &plugin).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();

    let (document, active) = crate::plugin_page_runtime::test_binding();
    let runtime = crate::legacy_runtime::Sessions::default();
    let owner = "window:main:native-filesystem";
    let intent_id = runtime
        .create_intent(owner.into(), "atools-ui".into(), plugin.id.clone())
        .unwrap();
    let mut intent = runtime
        .take_intent(Some(&intent_id), "atools-ui", &plugin.id)
        .unwrap();
    intent.document = Some(document);
    let session = runtime.open(&plugin, tool.clone(), intent).await.unwrap();

    assert!(super::super::super::uses_task_run("readTextPath"));
    let fixture = tempdir().unwrap();
    let path = fixture.path().join("utf8-文档.md");
    fs::write(&path, b"\xef\xbb\xbfhello \xff world").unwrap();
    let envelope = json!({"method":"readTextPath","params":{"path":path.to_str().unwrap()}});
    let response =
        crate::legacy_runtime::native_filesystem_request::handle(&db, &session, &envelope)
            .await
            .unwrap();
    assert_eq!(response["handled"], true);
    assert_eq!(response["value"], "\u{feff}hello \u{fffd} world");

    let missing = fixture.path().join("missing.md");
    let response = crate::legacy_runtime::native_filesystem_request::handle(
        &db,
        &session,
        &json!({"method":"readTextPath","params":{"path":missing.to_str().unwrap()}}),
    )
    .await
    .unwrap_err();
    assert_eq!(response, "ERR_ATOOLS_NATIVE_FS:ENOENT");

    let mut no_file_read = db.get_agent_tool(&tool).unwrap().unwrap();
    no_file_read
        .scopes
        .retain(|scope| *scope != PermissionScope::FileRead);
    db.sync_agent_tools(&[no_file_read]).unwrap();
    let denied = crate::legacy_runtime::native_filesystem_request::handle(&db, &session, &envelope)
        .await
        .unwrap_err();
    assert_eq!(denied, "ERR_ATOOLS_NATIVE_FS:EACCES");
    let restored = crate::legacy_runtime::registry::ensure_tool(&db, &plugin).unwrap();
    assert_eq!(restored, tool);

    let mut changed_version = plugin.clone();
    changed_version.version.push_str("-changed");
    db.save_plugin_with_features(&changed_version, &[]).unwrap();
    let changed =
        crate::legacy_runtime::native_filesystem_request::handle(&db, &session, &envelope)
            .await
            .unwrap_err();
    assert_eq!(changed, "ERR_ATOOLS_NATIVE_FS:EACCES");
    db.save_plugin_with_features(&plugin, &[]).unwrap();

    let mut disabled = plugin.clone();
    disabled.enabled = false;
    db.save_plugin_with_features(&disabled, &[]).unwrap();
    let disabled_result =
        crate::legacy_runtime::native_filesystem_request::handle(&db, &session, &envelope)
            .await
            .unwrap_err();
    assert_eq!(disabled_result, "ERR_ATOOLS_NATIVE_FS:EACCES");
    db.save_plugin_with_features(&plugin, &[]).unwrap();

    active.store(false, Ordering::Release);
    let revoked =
        crate::legacy_runtime::native_filesystem_request::handle(&db, &session, &envelope)
            .await
            .unwrap_err();
    assert_eq!(revoked, "ERR_ATOOLS_NATIVE_FS:EACCES");

    runtime.close_owner(owner, Some(&plugin.id)).await;
    assert_eq!(
        session.runtime.status(),
        atools_plugin::sidecar::SidecarStatus::Stopped
    );
}
