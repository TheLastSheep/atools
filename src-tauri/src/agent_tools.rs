use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Instant;

use atools_core::agent::{
    AuditLogEntry, AuditStatus, PendingAgentToolRequest, PermissionDecision, PermissionMode,
    PermissionScope, ToolDefinition,
};
use atools_core::db::Database;
use atools_core::mcp::McpToolCallResult;
use atools_core::memory::MemoryScope;
use atools_core::models::Plugin;
use atools_core::task_run::{
    Artifact, ArtifactKind, TaskIssue, TaskRun, TaskRunInitiator, TaskRunStatus,
    TaskValidationStatus,
};
use base64::Engine;
use image::ImageEncoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tauri_plugin_clipboard_manager::ClipboardExt;

const AGENT_SCOPE_POLICY_SETTING: &str = "agent.scope_policy";

mod ai;
mod background_gate;
mod clipboard_ops;
mod executors;
mod file_operations;
mod filesystem_types;
mod guarded_app_launch;
mod image_compression;
mod ocr_context;
mod path_context_operations;
mod permissions;
mod private_task_run_admission;
mod registry_api;
mod task_run_cancellation;
mod task_run_execution;
mod task_run_results;
mod tool_definitions;

mod node_startup_error_observation;
mod plugin_execution_snapshot;
mod plugin_grants;
mod task_run_pipeline;
mod tool_executor;

pub(crate) async fn grant_tool(
    app: &AppHandle,
    db: &Database,
    client: &str,
    tool: &str,
    request_id: Option<&str>,
) -> Result<(), String> {
    plugin_grants::grant(app, db, client, tool, request_id).await
}

pub use ai::{
    agent_ai_config_from_settings, ask_ai_model, permission_mode_from_str, permission_mode_to_str,
};
pub use clipboard_ops::search_clipboard_history;
pub use executors::{execute_builtin_tool, execute_plugin_tool};
pub use filesystem_types::{
    find_local_files, find_local_files_with_options, plan_renames, AgentAiConfig, FileMatch,
    FindLocalFilesOptions, FindLocalFilesReport, RenameOperation, RenameResult,
};
pub(crate) use guarded_app_launch::call_guarded_app_launch;
pub use image_compression::compress_images;
pub use ocr_context::ocr_image;
pub use path_context_operations::{get_current_context, open_or_reveal_path};
pub use permissions::{
    build_pending_agent_tool_request, build_permission_required_payload,
    permission_decision_for_tool, permission_required_payload,
};
pub use registry_api::{
    builtin_tool_registry, enabled_tool_registry, list_agent_scope_policies, list_enabled_tools,
    plugin_manifest_tool_definitions, set_agent_scope_policy, sync_builtin_tools,
    sync_plugin_tools, AgentScopePolicy,
};
pub(crate) use task_run_cancellation::cancel_task_run_by_id;
pub use task_run_execution::{call_tool_with_audit, resume_tool_with_audit};
pub(crate) use task_run_results::{initialize_new_task_run, task_run_result};

use ai::search_clipboard;
use clipboard_ops::clipboard_retention_days;
use file_operations::{find_local_files_tool_call, rename_files_tool_call};
use ocr_context::{
    default_ignored_dirs, image_mime_for_path, read_browser_url, read_finder_path,
    read_foreground_app, visit_files,
};
use path_context_operations::open_url;
#[cfg(test)]
use path_context_operations::validated_open_url;
use permissions::{
    all_permission_scopes, build_pending_agent_tool_request_with_run, normalize_scope_id,
    permission_scope_description, permission_scope_id, permission_scope_is_high_risk,
    permission_scope_label, persisted_scope_policy,
};
use registry_api::agent_plugin_tool_name;
use task_run_results::{
    memory_scope_for_call, structured_failed_items, structured_result_artifacts,
    structured_result_summary, structured_result_task_status, task_run_error, task_run_success,
};
use tool_definitions::{
    ask_ai_model_tool, compress_images_tool, find_local_files_tool, get_current_context_tool,
    ocr_image_tool, open_or_reveal_path_tool, open_url_tool, rename_files_tool,
    search_clipboard_tool,
};

pub(super) fn new_task_run(client_id: &str, tool_name: &str, arguments: Value) -> TaskRun {
    task_run_results::new_task_run(client_id, tool_name, arguments)
}
