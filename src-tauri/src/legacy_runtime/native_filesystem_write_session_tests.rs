use crate::legacy_runtime::{
    native_filesystem_request::handle, registry, session_tests::fixture, Sessions,
};
use atools_core::{agent::PermissionScope, Database};
use serde_json::json;
use std::{fs, sync::atomic::Ordering};

#[tokio::test]
async fn real_session_writes_require_file_write_and_an_active_plugin_document() {
    let (_plugin_dir, plugin) = fixture();
    let db = Database::in_memory().unwrap();
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    let tool = registry::ensure_tool(&db, &plugin).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();
    let (document, active) = crate::plugin_page_runtime::test_binding();
    let runtime = Sessions::default();
    let owner = "window:main:native-write";
    let intent_id = runtime
        .create_intent(owner.into(), "atools-ui".into(), plugin.id.clone())
        .unwrap();
    let mut intent = runtime
        .take_intent(Some(&intent_id), "atools-ui", &plugin.id)
        .unwrap();
    intent.document = Some(document);
    let session = runtime.open(&plugin, tool.clone(), intent).await.unwrap();
    assert!(super::super::super::uses_task_run("writeTextPath"));
    let temporary = tempfile::tempdir().unwrap();
    let path = temporary.path().join("saved-文档.md");
    let envelope = json!({"method":"writeTextPath","params":{"path":path.to_str().unwrap(),"text":"\u{feff}# 已保存 🙂\n"}});
    assert_eq!(
        handle(&db, &session, &envelope).await.unwrap(),
        json!({"handled":true})
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "\u{feff}# 已保存 🙂\n");

    // Independent reference: the actual bundled Node session writes the same
    // fixed bytes to another file, rather than a test transport emulating Rust.
    let node_path = temporary.path().join("node-reference.md");
    let fs_module = session
        .runtime
        .request("require", json!({"specifier":"node:fs"}))
        .await
        .unwrap();
    let node_writer = session
        .runtime
        .request(
            "get",
            json!({"handleId":fs_module["handleId"],"property":"writeFileSync"}),
        )
        .await
        .unwrap();
    let node_result = session
        .runtime
        .request(
            "call",
            json!({"handleId":node_writer["handleId"],"args":[
                {"kind":"value","value":node_path},
                {"kind":"value","value":envelope["params"]["text"]},
                {"kind":"value","value":"utf8"}
            ]}),
        )
        .await
        .unwrap();
    assert_eq!(node_result["kind"], "undefined");
    assert_eq!(fs::read(&node_path).unwrap(), fs::read(&path).unwrap());
    use std::os::unix::fs::MetadataExt;
    assert_eq!(
        fs::metadata(&node_path).unwrap().mode() & 0o777,
        fs::metadata(&path).unwrap().mode() & 0o777
    );

    let mut read_only = db.get_agent_tool(&tool).unwrap().unwrap();
    read_only
        .scopes
        .retain(|scope| *scope != PermissionScope::FileWrite);
    db.sync_agent_tools(&[read_only]).unwrap();
    fs::write(&path, "keep").unwrap();
    assert_eq!(
        handle(&db, &session, &envelope).await.unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:EACCES"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
    registry::ensure_tool(&db, &plugin).unwrap();

    let mut write_only = db.get_agent_tool(&tool).unwrap().unwrap();
    write_only
        .scopes
        .retain(|scope| *scope != PermissionScope::FileRead);
    db.sync_agent_tools(&[write_only]).unwrap();
    assert_eq!(
        handle(&db, &session, &envelope).await.unwrap(),
        json!({"handled":true})
    );
    assert_eq!(
        handle(
            &db,
            &session,
            &json!({"method":"readTextPath","params":{"path":path.to_str().unwrap()}})
        )
        .await
        .unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:EACCES"
    );
    registry::ensure_tool(&db, &plugin).unwrap();

    fs::remove_file(&path).unwrap();
    let mut changed = plugin.clone();
    changed.version.push_str("-changed");
    db.save_plugin_with_features(&changed, &[]).unwrap();
    assert_eq!(
        handle(&db, &session, &envelope).await.unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:EACCES"
    );
    assert!(!path.exists());
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    let mut disabled = plugin.clone();
    disabled.enabled = false;
    db.save_plugin_with_features(&disabled, &[]).unwrap();
    assert_eq!(
        handle(&db, &session, &envelope).await.unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:EACCES"
    );
    assert!(!path.exists());
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    active.store(false, Ordering::Release);
    assert_eq!(
        handle(&db, &session, &envelope).await.unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:EACCES"
    );
    assert!(!path.exists());
    runtime.close_owner(owner, Some(&plugin.id)).await;
    assert_eq!(
        session.runtime.status(),
        atools_plugin::sidecar::SidecarStatus::Stopped
    );
}
