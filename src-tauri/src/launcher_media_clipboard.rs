//! Shared capability execution with a request-local raw reply for an explicit human paste.
//! Registry/permission/TaskRun outputs carry metadata only; no global media cache is created.
use crate::launcher_media::ClipboardMedia;
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

pub(crate) const TOOL: &str = "atools.clipboard.read_media";
pub(crate) const SOURCE: &str = "launcher_clipboard";
type Reply = Result<Option<ClipboardMedia>, String>;
#[derive(Default)]
struct HumanReply {
    reply: Mutex<Option<Reply>>,
    // Retain the work slot until the human's shared pipeline is terminal.
    permit: Mutex<Option<crate::launcher_media_work::Permit>>,
}
type ReplySlot = Arc<HumanReply>;
tokio::task_local! {static HUMAN_REPLY:ReplySlot;}

pub(crate) fn tool_definition() -> ToolDefinition {
    ToolDefinition {
        name:TOOL.into(),description:"读取当前剪贴板文件或图片的元信息，仅返回类型、数量与字节摘要，不提供图片分析原文。显式粘贴可在本次请求内交付原始媒体；原始路径和图片不会写入任务历史。".into(),
        input_schema:json!({"type":"object","properties":{"filesOnly":{"type":"boolean"}},"additionalProperties":false}),
        output_schema:None,scopes:vec![PermissionScope::ClipboardRead],enabled_by_default:true,enabled:true,source:SOURCE.into(),plugin_id:None,
    }
}

pub(crate) async fn read_for_launcher(app: &AppHandle, db: &Database, files_only: bool) -> Reply {
    let slot: ReplySlot = Arc::new(HumanReply::default());
    // The browser's explicit paste action confirms this single ClipboardRead operation.
    // A saved deny policy still wins inside the common permission gate.
    let result = HUMAN_REPLY
        .scope(
            slot.clone(),
            crate::agent_tools::call_tool_with_audit(
                app,
                db,
                "atools-ui",
                TOOL,
                json!({"filesOnly":files_only}),
                true,
            ),
        )
        .await;
    let reply = slot
        .reply
        .lock()
        .map_err(|_| "CLIPBOARD_MEDIA_UNAVAILABLE: private reply could not be read")?
        .take();
    finish_read(!result.is_error, reply)
}
fn finish_read(pipeline_succeeded: bool, reply: Option<Reply>) -> Reply {
    match (pipeline_succeeded, reply) {
        (true, Some(reply)) => reply,
        (false, Some(Err(error))) => Err(error),
        // A read may finish before terminal persistence or cancellation wins. Drop its raw reply.
        (false, _) => {
            Err("CLIPBOARD_MEDIA_PERMISSION: 剪贴板读取未获授权、已取消或任务未能完成".into())
        }
        (true, None) => {
            Err("CLIPBOARD_MEDIA_UNAVAILABLE: clipboard execution returned no current reply".into())
        }
    }
}

pub(crate) fn validate_request(tool_name: &str, arguments: &Value) -> Result<(), String> {
    if tool_name == TOOL
        && !arguments.as_object().is_some_and(|fields| {
            fields.len() <= 1
                && fields
                    .iter()
                    .all(|(key, value)| key == "filesOnly" && value.is_boolean())
        })
    {
        return Err(
            "CLIPBOARD_MEDIA_INVALID: only an optional filesOnly boolean is accepted".into(),
        );
    }
    Ok(())
}

pub(crate) async fn execute(arguments: Value) -> Result<Value, String> {
    execute_with_budget(
        arguments,
        |files_only, permit| async move {
            tauri::async_runtime::spawn_blocking(move || {
                let _permit = permit;
                crate::pasteboard_native::read_launcher_media(files_only)
            })
            .await
            .map_err(|_| "CLIPBOARD_MEDIA_UNAVAILABLE: native clipboard read failed".to_string())?
        },
        crate::launcher_media_work::try_permit,
    )
    .await
}
async fn execute_with_budget<F, Fut, A>(
    arguments: Value,
    read: F,
    acquire: A,
) -> Result<Value, String>
where
    F: FnOnce(bool, crate::launcher_media_work::Permit) -> Fut,
    Fut: std::future::Future<Output = Reply>,
    A: FnOnce() -> Result<crate::launcher_media_work::Permit, String>,
{
    validate_request(TOOL, &arguments)?;
    let permit = match acquire() {
        Ok(permit) => permit,
        Err(error) => {
            let _ = HUMAN_REPLY.try_with(|slot| {
                if let Ok(mut reply) = slot.reply.lock() {
                    *reply = Some(Err(error.clone()));
                }
            });
            return Err(error);
        }
    };
    let _ = HUMAN_REPLY.try_with(|slot| {
        if let Ok(mut held) = slot.permit.lock() {
            *held = Some(permit.clone());
        }
    });
    let result = read(
        arguments
            .get("filesOnly")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        permit,
    )
    .await;
    let summary=result.as_ref().map(|media|match media {
        None=>json!({"kind":"none","contentRedacted":true}),
        Some(ClipboardMedia::Files{files})=>json!({"kind":"files","count":files.len(),"pathBytes":files.iter().map(|file|file.path.len()).sum::<usize>(),"contentRedacted":true}),
        Some(ClipboardMedia::Img{data_url})=>json!({"kind":"img","dataUrlBytes":data_url.len(),"contentRedacted":true}),
    }).map_err(Clone::clone);
    // Task-local scope is inherited by this direct executor future, never by arbitrary calls.
    // Moving the reply into the active human invocation retains no second raw payload copy.
    let _ = HUMAN_REPLY.try_with(|slot| {
        if let Ok(mut slot) = slot.reply.lock() {
            *slot = Some(result);
        }
    });
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::matcher::MediaFile;
    async fn execute_with<F, Fut>(arguments: Value, read: F) -> Result<Value, String>
    where
        F: FnOnce(bool, crate::launcher_media_work::Permit) -> Fut,
        Fut: std::future::Future<Output = Reply>,
    {
        let budget = Arc::new(tokio::sync::Semaphore::new(2));
        execute_with_budget(arguments, read, || {
            crate::launcher_media_work::acquire(&budget)
        })
        .await
    }
    #[tokio::test]
    async fn actual_executor_rejects_a_full_local_budget_before_read_and_preserves_busy_recovery() {
        let budget = Arc::new(tokio::sync::Semaphore::new(2));
        let first = crate::launcher_media_work::acquire(&budget).unwrap();
        let second = crate::launcher_media_work::acquire(&budget).unwrap();
        let slot: ReplySlot = Arc::new(HumanReply::default());
        let failure = HUMAN_REPLY
            .scope(
                slot.clone(),
                execute_with_budget(
                    json!({}),
                    |_, _| async { panic!("busy executor must not read") },
                    || crate::launcher_media_work::acquire(&budget),
                ),
            )
            .await
            .unwrap_err();
        assert!(failure.starts_with("MEDIA_INPUT_BUSY:"));
        assert!(finish_read(false, slot.reply.lock().unwrap().take())
            .unwrap_err()
            .starts_with("MEDIA_INPUT_BUSY:"));
        drop(first);
        drop(second);
        assert_eq!(budget.available_permits(), 2);
        let result = execute_with_budget(
            json!({}),
            |_, permit| async move {
                let _permit = permit;
                Ok(None)
            },
            || crate::launcher_media_work::acquire(&budget),
        )
        .await
        .unwrap();
        assert_eq!(result["kind"], "none");
        assert_eq!(budget.available_permits(), 2);
    }

    #[tokio::test]
    async fn shared_executor_returns_only_summary_and_human_slot_receives_exact_current_payload() {
        let private = "PRIVATE_CLIPBOARD_SELECTED_NAME";
        let media = ClipboardMedia::Files {
            files: vec![MediaFile {
                path: format!("/fixture/{private}"),
                name: private.into(),
                is_file: true,
                is_directory: false,
            }],
        };
        let slot: ReplySlot = Arc::new(HumanReply::default());
        let summary = HUMAN_REPLY
            .scope(
                slot.clone(),
                execute_with(json!({}), |_, _| async { Ok(Some(media)) }),
            )
            .await
            .unwrap();
        assert_eq!(summary["kind"], "files");
        assert_eq!(summary["count"], 1);
        assert!(!summary.to_string().contains(private));
        let Some(ClipboardMedia::Files { files }) =
            slot.reply.lock().unwrap().take().unwrap().unwrap()
        else {
            panic!("file reply missing")
        };
        assert_eq!(files[0].name, private);
        assert!(slot.reply.lock().unwrap().is_none());
    }
    #[tokio::test]
    async fn agent_summary_uses_same_executor_without_creating_a_raw_reply_cache() {
        let summary = execute_with(json!({}), |_, _| async {
            Ok(Some(ClipboardMedia::Img {
                data_url: "PRIVATE_IMAGE_DATA".into(),
            }))
        })
        .await
        .unwrap();
        assert_eq!(summary["kind"], "img");
        assert!(!summary.to_string().contains("PRIVATE_IMAGE_DATA"));
        assert!(HUMAN_REPLY.try_with(|_| ()).is_err());
        let never = execute_with(json!({"raw":"PRIVATE_INPUT"}), |_, _| async {
            panic!("invalid input cannot access clipboard")
        })
        .await
        .unwrap_err();
        assert!(!never.contains("PRIVATE_INPUT"));
    }
    #[test]
    fn raw_reply_is_discarded_if_terminal_pipeline_fails_or_is_cancelled() {
        let failed = finish_read(
            false,
            Some(Ok(Some(ClipboardMedia::Img {
                data_url: "PRIVATE_RAW_REPLY".into(),
            }))),
        );
        let error = failed.err().unwrap();
        assert!(!error.contains("PRIVATE_RAW_REPLY"));
        assert!(finish_read(
            false,
            Some(Err("IMAGE_INPUT_BUDGET: reduce image size".into()))
        )
        .unwrap_err()
        .starts_with("IMAGE_INPUT_BUDGET:"));
        assert!(
            finish_read(false, Some(Err("MEDIA_INPUT_BUSY: fixed recovery".into())))
                .unwrap_err()
                .starts_with("MEDIA_INPUT_BUSY:")
        );
        assert!(finish_read(false, None).is_err());
        assert!(finish_read(true, Some(Ok(None))).unwrap().is_none());
        assert!(finish_read(true, None).is_err());
    }
    #[tokio::test]
    async fn files_only_is_validated_before_execution_and_defaults_false() {
        execute_with(json!({"filesOnly":true}), |mode, _| async move {
            assert!(mode);
            Ok(None)
        })
        .await
        .unwrap();
        execute_with(json!({}), |mode, _| async move {
            assert!(!mode);
            Ok(None)
        })
        .await
        .unwrap();
        for invalid in [
            json!({"filesOnly":"true"}),
            json!({"filesOnly":true,"extra":"PRIVATE"}),
            json!(null),
        ] {
            let e = execute_with(invalid, |_, _| async {
                panic!("invalid mode cannot read clipboard")
            })
            .await
            .unwrap_err();
            assert!(!e.contains("PRIVATE"));
        }
    }
    #[test]
    fn registered_clipboard_direction_obeys_saved_deny_policy() {
        let db = Database::in_memory().unwrap();
        db.sync_agent_tools(&[tool_definition()]).unwrap();
        assert_eq!(
            tool_definition().scopes,
            vec![PermissionScope::ClipboardRead]
        );
        for client in ["atools-ui", "independent-agent"] {
            assert_eq!(
                crate::agent_tools::permission_decision_for_tool(&db, client, TOOL).unwrap(),
                atools_core::agent::PermissionDecision::Confirm
            );
        }
        db.grant_agent_tool("atools-ui", TOOL).unwrap();
        assert_eq!(
            crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", TOOL).unwrap(),
            atools_core::agent::PermissionDecision::Allow
        );
        assert_eq!(
            crate::agent_tools::permission_decision_for_tool(&db, "independent-agent", TOOL)
                .unwrap(),
            atools_core::agent::PermissionDecision::Confirm
        );
        crate::agent_tools::set_agent_scope_policy(&db, "clipboard_read", "deny").unwrap();
        assert_eq!(
            crate::agent_tools::permission_decision_for_tool(&db, "independent-agent", TOOL)
                .unwrap(),
            atools_core::agent::PermissionDecision::Deny
        );
        assert_eq!(
            crate::agent_tools::permission_decision_for_tool(&db, "atools-ui", TOOL).unwrap(),
            atools_core::agent::PermissionDecision::Deny
        );
    }
}
