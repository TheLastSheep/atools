//! TaskRun-authorized Rust text I/O for the existing Legacy Node session.
use super::types::Session;
use atools_core::{
    agent::{PermissionScope, ToolDefinition},
    db::Database,
};
use serde_json::Value;
use std::sync::Arc;

pub(super) async fn handle(
    db: &Database,
    session: &Arc<Session>,
    request: &Value,
) -> Result<Value, String> {
    let scope = match request.get("method").and_then(Value::as_str) {
        Some("readTextPath") => PermissionScope::FileRead,
        Some("writeTextPath") => PermissionScope::FileWrite,
        _ => return Err(native_error("EINVAL")),
    };
    validate(db, session, &scope)?;
    let result = match scope {
        PermissionScope::FileRead => {
            crate::plugin_filesystem::node_text_read::handle(request).await
        }
        PermissionScope::FileWrite => {
            let write_db = db.clone();
            let write_session = Arc::clone(session);
            crate::plugin_filesystem::node_text_write::handle_authorized(request, move || {
                validate(&write_db, &write_session, &PermissionScope::FileWrite)
            })
            .await
        }
        _ => unreachable!("only text I/O scopes are selected above"),
    };
    validate(db, session, &scope)?;
    result
}

fn validate(db: &Database, session: &Session, scope: &PermissionScope) -> Result<(), String> {
    super::validate_session(db, session).map_err(|_| native_error("EACCES"))?;
    let tool = db
        .get_agent_tool(&session.tool)
        .map_err(|_| native_error("EACCES"))?
        .ok_or_else(|| native_error("EACCES"))?;
    if !is_file_tool(&tool, &session.plugin_id, &session.tool, scope) {
        return Err(native_error("EACCES"));
    }
    Ok(())
}

fn is_file_tool(
    tool: &ToolDefinition,
    plugin_id: &str,
    tool_name: &str,
    scope: &PermissionScope,
) -> bool {
    tool.source == super::registry::SOURCE
        && tool.name == tool_name
        && tool.name == super::registry::tool_name(plugin_id)
        && tool.plugin_id.as_deref() == Some(plugin_id)
        && tool.scopes.contains(scope)
}

fn native_error(code: &str) -> String {
    format!("ERR_ATOOLS_NATIVE_FS:{code}")
}

#[cfg(test)]
#[path = "native_filesystem_request_tests.rs"]
mod tests;
