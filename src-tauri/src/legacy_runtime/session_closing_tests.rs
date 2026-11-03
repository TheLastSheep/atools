use crate::{
    legacy_runtime::{registry, session_tests::fixture, Sessions},
    plugin_filesystem::node_text_write,
};
use atools_core::Database;
use atools_plugin::sidecar::SidecarStatus;
use serde_json::json;
use std::{fs, sync::Arc, time::Duration};

#[cfg(unix)]
#[tokio::test]
async fn cancelled_session_rejects_queued_write_before_truncate_or_create() {
    let (_plugin_dir, plugin) = fixture();
    let db = Database::in_memory().unwrap();
    db.save_plugin_with_features(&plugin, &[]).unwrap();
    let tool = registry::ensure_tool(&db, &plugin).unwrap();
    db.grant_agent_tool("atools-ui", &tool).unwrap();

    let runtime = Sessions::default();
    let owner = "window:main:write-cancel";
    let intent_id = runtime
        .create_intent(owner.into(), "atools-ui".into(), plugin.id.clone())
        .unwrap();
    let intent = runtime
        .take_intent(Some(&intent_id), "atools-ui", &plugin.id)
        .unwrap();
    let session = runtime.open(&plugin, tool, intent).await.unwrap();
    assert_eq!(session.runtime.status(), SidecarStatus::Running);

    let directory = tempfile::tempdir().unwrap();
    let existing = directory.path().join("existing.txt");
    let created = directory.path().join("created.txt");
    fs::write(&existing, "keep this content").unwrap();

    // Pause the writer at the final authorization boundary, after it has
    // queued and inspected the target but before it can truncate the file.
    let (entered_tx, mut entered_rx) = tokio::sync::mpsc::unbounded_channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let authorize_db = db.clone();
    let authorize_session = Arc::clone(&session);
    let existing_request = json!({
        "method":"writeTextPath",
        "params":{"path":existing.to_str().unwrap(),"text":"must not replace"}
    });
    let request_after_close = existing_request.clone();
    let existing_write = tokio::spawn(async move {
        node_text_write::handle_authorized(&existing_request, move || {
            entered_tx
                .send(())
                .map_err(|_| "ERR_ATOOLS_NATIVE_FS:EACCES".to_owned())?;
            release_rx
                .recv_timeout(Duration::from_secs(3))
                .map_err(|_| "ERR_ATOOLS_NATIVE_FS:EACCES".to_owned())?;
            super::validate_session(&authorize_db, &authorize_session)
                .map_err(|_| "ERR_ATOOLS_NATIVE_FS:EACCES".to_owned())
        })
        .await
    });

    tokio::time::timeout(Duration::from_secs(6), entered_rx.recv())
        .await
        .expect("writer must reach the controlled authorization boundary")
        .expect("writer authorization signal must be sent");

    // This is the synchronous first step used by session-close paths. It must
    // revoke the session while the sidecar is still running and before any
    // asynchronous process shutdown can complete.
    super::cancel_inflight(&db, &runtime, &session.id);
    assert!(session.is_closing());
    assert_eq!(session.runtime.status(), SidecarStatus::Running);
    assert_eq!(
        super::native_filesystem_request::handle(&db, &session, &request_after_close)
            .await
            .unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:EACCES"
    );
    release_tx.send(()).unwrap();

    assert_eq!(
        existing_write.await.unwrap().unwrap_err(),
        "ERR_ATOOLS_NATIVE_FS:EACCES"
    );
    assert_eq!(fs::read_to_string(&existing).unwrap(), "keep this content");

    let created_request = json!({
        "method":"writeTextPath",
        "params":{"path":created.to_str().unwrap(),"text":"must not be created"}
    });
    let create_result = node_text_write::handle_authorized(&created_request, {
        let authorize_db = db.clone();
        let authorize_session = Arc::clone(&session);
        move || {
            super::validate_session(&authorize_db, &authorize_session)
                .map_err(|_| "ERR_ATOOLS_NATIVE_FS:EACCES".to_owned())
        }
    })
    .await;
    assert_eq!(create_result.unwrap_err(), "ERR_ATOOLS_NATIVE_FS:EACCES");
    assert!(!created.exists());

    runtime.remove(&session.id).await;
}
