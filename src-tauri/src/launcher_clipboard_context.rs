//! Shared current-clipboard capability with raw content confined to one Main request.
use crate::pasteboard_runtime::LastCopiedContent;
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    Database,
};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;

pub(crate) const TOOL: &str = "atools.clipboard.read_current";
pub(crate) const SOURCE: &str = "launcher_clipboard_context";
const INVALID: &str = "CLIPBOARD_CONTEXT_INVALID: timeLimit must be a finite safe number or null";
const UNAVAILABLE: &str = "CLIPBOARD_CONTEXT_UNAVAILABLE: current clipboard could not be read";
const PERMISSION: &str =
    "CLIPBOARD_CONTEXT_PERMISSION: clipboard read was denied, cancelled, or not durably completed";
const BUSY: &str = "MEDIA_INPUT_BUSY: 媒体处理繁忙，请稍后重试";
type Reply = Result<Option<LastCopiedContent>, String>;
type Permit = crate::launcher_media_work::Permit;

#[derive(Default)]
struct HumanReply {
    reply: Mutex<Option<Reply>>,
    permit: Mutex<Option<Permit>>,
}
type ReplySlot = Arc<HumanReply>;

tokio::task_local! { static MAIN_REPLY: ReplySlot; }

pub(crate) fn tool_definition() -> ToolDefinition {
    ToolDefinition {
        name: TOOL.into(),
        description: "Read the current system clipboard locally. Agent results contain metadata only; explicit Main paste returns content only to that request and never stores it in task history.".into(),
        input_schema: json!({
            "type":"object",
            "additionalProperties":false,
            "properties":{"timeLimit":{"type":["number","null"],"minimum":-9007199254740991i64,"maximum":9007199254740991i64}}
        }),
        output_schema: Some(json!({
            "type":"object",
            "properties":{
                "available":{"type":"boolean"},
                "contentRedacted":{"const":true},
                "summary":{
                    "type":["object","null"],
                    "properties":{
                        "type":{"enum":["text","image","file"]},
                        "payloadBytes":{"type":"integer"},
                        "fileCount":{"type":"integer"},
                        "timestamp":{"type":"integer"}
                    },
                    "required":["type","payloadBytes","fileCount","timestamp"],
                    "additionalProperties":false
                }
            },
            "required":["available","contentRedacted","summary"],
            "additionalProperties":false
        })),
        scopes: vec![PermissionScope::ClipboardRead],
        enabled_by_default: true,
        enabled: true,
        source: SOURCE.into(),
        plugin_id: None,
    }
}

pub(crate) fn validate_request(tool_name: &str, arguments: &Value) -> Result<(), String> {
    if tool_name != TOOL {
        return Ok(());
    }
    let valid = arguments.as_object().is_some_and(|fields| {
        fields.len() <= 1
            && fields.iter().all(|(key, value)| {
                key == "timeLimit"
                    && (value.is_null()
                        || value.as_f64().is_some_and(|limit| {
                            crate::pasteboard_runtime::validate_time_limit(Some(limit)).is_ok()
                        }))
            })
    });
    if valid {
        Ok(())
    } else {
        Err(INVALID.into())
    }
}

pub(crate) async fn read_for_main(
    app: &AppHandle,
    db: &Database,
    time_limit: Option<f64>,
) -> Result<Option<LastCopiedContent>, String> {
    let arguments = json!({"timeLimit":time_limit});
    validate_request(TOOL, &arguments)?;
    let slot = Arc::new(HumanReply::default());
    let result = MAIN_REPLY
        .scope(
            slot.clone(),
            crate::agent_tools::call_tool_with_audit(app, db, "atools-ui", TOOL, arguments, true),
        )
        .await;
    let reply = slot.reply.lock().map_err(|_| UNAVAILABLE)?.take();
    finish_read(!result.is_error, reply)
}

fn finish_read(pipeline_succeeded: bool, reply: Option<Reply>) -> Reply {
    match (pipeline_succeeded, reply) {
        (true, Some(reply)) => reply,
        (false, Some(Err(error))) => Err(error),
        // A successful native read is still withheld if permission, cancellation,
        // or durable TaskRun/audit completion failed later in the shared pipeline.
        (false, _) => Err(PERMISSION.into()),
        (true, None) => Err(UNAVAILABLE.into()),
    }
}

pub(crate) async fn execute(app: &AppHandle, arguments: Value) -> Result<Value, String> {
    validate_request(TOOL, &arguments)?;
    let time_limit = arguments.get("timeLimit").and_then(Value::as_f64);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, time_limit);
        let error = "CLIPBOARD_CONTEXT_UNSUPPORTED: current native clipboard read is unavailable on this platform";
        set_request_error(error);
        return Err(error.into());
    }
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let runtime = app
            .try_state::<crate::state::AppState>()
            .map(|state| Arc::clone(&state.pasteboard_runtime))
            .ok_or_else(|| {
                set_request_error(UNAVAILABLE);
                UNAVAILABLE.to_string()
            })?;
        execute_with_budget(
            time_limit,
            move |time_limit| async move { runtime.read_current_context(time_limit).await },
            crate::launcher_media_work::try_permit,
        )
        .await
    }
}

async fn execute_with_budget<F, Fut, A>(
    time_limit: Option<f64>,
    read: F,
    acquire: A,
) -> Result<Value, String>
where
    F: FnOnce(Option<f64>) -> Fut + Send + 'static,
    Fut: std::future::Future<Output = Reply> + Send + 'static,
    A: FnOnce() -> Result<Permit, String>,
{
    let permit = match acquire() {
        Ok(permit) => permit,
        Err(_) => {
            set_request_error(BUSY);
            return Err(BUSY.into());
        }
    };
    match MAIN_REPLY.try_with(|slot| {
        let mut retained = slot.permit.lock().map_err(|_| ())?;
        *retained = Some(permit.clone());
        Ok::<(), ()>(())
    }) {
        Ok(Err(())) => {
            set_request_error(UNAVAILABLE);
            return Err(UNAVAILABLE.into());
        }
        Ok(Ok(())) | Err(_) => {}
    }
    // Backend diagnostics can contain clipboard paths or text. Only a fixed
    // failure code may enter TaskRun/audit rows or cross the Main bridge.
    // The owned reader keeps this permit until the native read actually returns.
    // Main's task-local reply keeps its clone until audit/TaskRun is terminal.
    let worker = tokio::spawn(async move {
        let result = read(time_limit).await;
        drop(permit);
        result
    });
    let result = worker
        .await
        .unwrap_or_else(|_| Err(UNAVAILABLE.to_string()))
        .map_err(|_| UNAVAILABLE.to_string());
    let summary = result.as_ref().map(safe_summary).map_err(Clone::clone);
    let _ = MAIN_REPLY.try_with(|slot| {
        if let Ok(mut reply) = slot.reply.lock() {
            *reply = Some(result);
        }
    });
    summary
}

fn safe_summary(content: &Option<LastCopiedContent>) -> Value {
    json!({
        "available":content.is_some(),
        "contentRedacted":true,
        "summary":content.as_ref().map(LastCopiedContent::audit_summary)
    })
}

fn set_request_error(error: &str) {
    let _ = MAIN_REPLY.try_with(|slot| {
        if let Ok(mut reply) = slot.reply.lock() {
            *reply = Some(Err(error.to_string()));
        }
    });
}

#[cfg(test)]
#[path = "launcher_clipboard_context_tests.rs"]
mod tests;
