use super::*;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};

fn text(data: &str, timestamp: u64) -> LastCopiedContent {
    LastCopiedContent::Text {
        data: data.into(),
        timestamp,
    }
}

async fn execute_fake<F, Fut>(
    time_limit: Option<f64>,
    read: F,
    budget: Arc<tokio::sync::Semaphore>,
) -> Result<Value, String>
where
    F: FnOnce(Option<f64>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Reply> + Send + 'static,
{
    execute_with_budget(time_limit, read, || {
        crate::launcher_media_work::acquire(&budget)
    })
    .await
}

#[test]
fn schema_and_validation_allow_only_an_optional_safe_time_limit() {
    assert_eq!(
        tool_definition().scopes,
        vec![PermissionScope::ClipboardRead]
    );
    for value in [
        json!({}),
        json!({"timeLimit":null}),
        json!({"timeLimit":0}),
        json!({"timeLimit":-4}),
        json!({"timeLimit":12.0}),
    ] {
        assert!(validate_request(TOOL, &value).is_ok(), "{value}");
    }
    for value in [
        json!(null),
        json!({"timeLimit":"12"}),
        json!({"timeLimit":true}),
        json!({"timeLimit":9007199254740992u64}),
        json!({"timeLimit":3,"other":1}),
    ] {
        assert!(validate_request(TOOL, &value).is_err(), "{value}");
    }
}

#[test]
fn saved_clipboard_deny_still_wins_the_main_confirmation_path() {
    assert!(crate::agent_tools::builtin_tool_registry()
        .get(TOOL)
        .is_some());
    let db = Database::in_memory().unwrap();
    db.sync_agent_tools(&[tool_definition()]).unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", TOOL).unwrap(),
        atools_core::agent::PermissionDecision::Confirm
    );
    crate::agent_tools::set_agent_scope_policy(&db, "clipboard_read", "deny").unwrap();
    assert_eq!(
        crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", TOOL).unwrap(),
        atools_core::agent::PermissionDecision::Deny
    );
}

#[tokio::test]
async fn execution_returns_redacted_metadata_and_only_this_main_scope_gets_raw_value() {
    let secret = "PRIVATE_CURRENT_CLIPBOARD";
    let slot = Arc::new(HumanReply::default());
    let budget = Arc::new(tokio::sync::Semaphore::new(2));
    let summary = MAIN_REPLY
        .scope(
            slot.clone(),
            execute_fake(
                Some(1000.0),
                move |limit| async move {
                    assert_eq!(limit, Some(1000.0));
                    Ok(Some(text(secret, 1234)))
                },
                budget,
            ),
        )
        .await
        .unwrap();
    assert_eq!(summary["available"], true);
    assert_eq!(summary["summary"]["type"], "text");
    assert_eq!(summary["summary"]["payloadBytes"], secret.len());
    assert_eq!(summary["summary"]["timestamp"], 1234);
    assert_eq!(summary["contentRedacted"], true);
    assert!(!summary.to_string().contains(secret));
    assert!(slot.permit.lock().unwrap().is_some());
    assert!(
        matches!(slot.reply.lock().unwrap().take().unwrap(), Ok(Some(LastCopiedContent::Text { data, .. })) if data == secret)
    );
    let agent_budget = Arc::new(tokio::sync::Semaphore::new(2));
    let agent_summary = execute_fake(
        None,
        |_| async { Ok(Some(text(secret, 1234))) },
        Arc::clone(&agent_budget),
    )
    .await
    .unwrap();
    assert!(!agent_summary.to_string().contains(secret));
    assert_eq!(agent_budget.available_permits(), 2);
    assert!(MAIN_REPLY.try_with(|_| ()).is_err());
}

#[tokio::test]
async fn permission_failure_cancellation_and_terminal_failure_never_return_late_raw_data() {
    let secret = "PRIVATE_LATE_RESULT";
    let raw = Some(Ok(Some(text(secret, 5))));
    assert!(finish_read(false, raw)
        .unwrap_err()
        .contains("denied, cancelled"));
    assert!(!finish_read(false, Some(Ok(Some(text(secret, 5)))))
        .unwrap_err()
        .contains(secret));
    assert_eq!(finish_read(true, Some(Ok(None))).unwrap(), None);
    assert!(finish_read(true, None).is_err());

    let (started_tx, started_rx) = tokio::sync::oneshot::channel();
    let (release_tx, release_rx) = tokio::sync::oneshot::channel();
    let (finished_tx, finished_rx) = tokio::sync::oneshot::channel();
    let budget = Arc::new(tokio::sync::Semaphore::new(1));
    let worker_budget = Arc::clone(&budget);
    let task = tokio::spawn(async move {
        let slot = Arc::new(HumanReply::default());
        MAIN_REPLY
            .scope(
                slot,
                execute_fake(
                    None,
                    move |_| async move {
                        let _ = started_tx.send(());
                        let _ = release_rx.await;
                        let _ = finished_tx.send(());
                        Ok(Some(text(secret, 5)))
                    },
                    worker_budget,
                ),
            )
            .await
    });
    started_rx.await.unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    assert!(crate::launcher_media_work::acquire(&budget).is_err());
    release_tx.send(()).unwrap();
    finished_rx.await.unwrap();
    let released = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        Arc::clone(&budget).acquire_owned(),
    )
    .await
    .unwrap()
    .unwrap();
    drop(released);
    assert_eq!(budget.available_permits(), 1);
}

#[tokio::test]
async fn saturated_shared_budget_rejects_without_reading_and_recovers_after_release() {
    let budget = Arc::new(tokio::sync::Semaphore::new(2));
    let first = crate::launcher_media_work::acquire(&budget).unwrap();
    let second = crate::launcher_media_work::acquire(&budget).unwrap();
    let called = Arc::new(AtomicBool::new(false));
    let marker = Arc::clone(&called);
    let slot = Arc::new(HumanReply::default());
    let failure = MAIN_REPLY
        .scope(
            slot.clone(),
            execute_with_budget(
                None,
                move |_| async move {
                    marker.store(true, Ordering::SeqCst);
                    Ok(None)
                },
                || crate::launcher_media_work::acquire(&budget),
            ),
        )
        .await
        .unwrap_err();
    assert!(failure.starts_with("MEDIA_INPUT_BUSY:"));
    assert!(!called.load(Ordering::SeqCst));
    assert!(finish_read(false, slot.reply.lock().unwrap().take())
        .unwrap_err()
        .starts_with("MEDIA_INPUT_BUSY:"));
    drop(first);
    drop(second);
    assert_eq!(budget.available_permits(), 2);
    let summary = execute_fake(None, |_| async { Ok(None) }, Arc::clone(&budget))
        .await
        .unwrap();
    assert_eq!(summary["available"], false);
    assert_eq!(summary["summary"], Value::Null);
    assert_eq!(budget.available_permits(), 2);
}

#[tokio::test]
async fn main_raw_replies_keep_both_work_permits_until_pipeline_terminal() {
    let budget = Arc::new(tokio::sync::Semaphore::new(2));
    let first = Arc::new(HumanReply::default());
    let second = Arc::new(HumanReply::default());

    for slot in [&first, &second] {
        let result = MAIN_REPLY
            .scope(
                Arc::clone(slot),
                execute_fake(
                    None,
                    |_| async { Ok(Some(text("private", 7))) },
                    Arc::clone(&budget),
                ),
            )
            .await
            .unwrap();
        assert_eq!(result["available"], true);
        assert!(slot.permit.lock().unwrap().is_some());
    }
    assert_eq!(budget.available_permits(), 0);

    let third = Arc::new(HumanReply::default());
    let read_started = Arc::new(AtomicBool::new(false));
    let read_marker = Arc::clone(&read_started);
    let third_result = MAIN_REPLY
        .scope(
            Arc::clone(&third),
            execute_with_budget(
                None,
                move |_| async move {
                    read_marker.store(true, Ordering::SeqCst);
                    Ok(None)
                },
                || crate::launcher_media_work::acquire(&budget),
            ),
        )
        .await;
    assert_eq!(third_result.unwrap_err(), BUSY);
    assert!(!read_started.load(Ordering::SeqCst));
    assert!(finish_read(false, third.reply.lock().unwrap().take())
        .unwrap_err()
        .starts_with("MEDIA_INPUT_BUSY:"));
    drop(third);

    // The raw read may have completed, but the Main-owned slots keep the
    // shared budget occupied until each complete pipeline is finalized.
    drop(finish_read(true, first.reply.lock().unwrap().take()).unwrap());
    assert_eq!(budget.available_permits(), 0);
    assert!(finish_read(false, second.reply.lock().unwrap().take())
        .unwrap_err()
        .contains("denied, cancelled"));
    drop(first);
    assert_eq!(budget.available_permits(), 1);
    drop(second);
    assert_eq!(budget.available_permits(), 2);
}

#[tokio::test]
async fn backend_error_text_is_never_exposed_to_task_run_or_main_reply() {
    let marker = "PRIVATE_BACKEND_PATH_AND_TEXT";
    let slot = Arc::new(HumanReply::default());
    let error = MAIN_REPLY
        .scope(
            slot.clone(),
            execute_fake(
                None,
                move |_| async move { Err(format!("OS error included {marker}")) },
                Arc::new(tokio::sync::Semaphore::new(2)),
            ),
        )
        .await
        .unwrap_err();
    assert_eq!(error, UNAVAILABLE);
    assert!(!error.contains(marker));
    let main_error = finish_read(false, slot.reply.lock().unwrap().take()).unwrap_err();
    assert_eq!(main_error, UNAVAILABLE);
    assert!(!main_error.contains(marker));
    let persisted = json!({"summary":error,"output":Value::Null,"artifacts":[]});
    assert!(!persisted.to_string().contains(marker));
}

#[test]
fn file_summary_keeps_only_count_and_byte_metadata() {
    let secret = "/private/selected/secret.txt";
    let content = Some(LastCopiedContent::File {
        data: vec![crate::pasteboard_runtime::LastCopiedFile {
            path: secret.into(),
            name: "secret.txt".into(),
            is_file: true,
            is_directory: false,
        }],
        timestamp: 9,
    });
    let summary = safe_summary(&content);
    assert_eq!(summary["available"], true);
    assert_eq!(summary["summary"]["fileCount"], 1);
    assert_eq!(
        summary["summary"]["payloadBytes"],
        secret.len() + "secret.txt".len()
    );
    assert!(!summary.to_string().contains("secret"));
}
