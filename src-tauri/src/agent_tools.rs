use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Instant;

use atools_core::agent::{
    AuditLogEntry, AuditStatus, PendingAgentToolRequest, PermissionDecision, PermissionMode,
    PermissionScope, ToolDefinition, ToolRegistry,
};
use atools_core::db::Database;
use atools_core::mcp::McpToolCallResult;
use atools_core::models::Plugin;
use base64::Engine;
use image::ImageEncoder;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

const AGENT_SCOPE_POLICY_SETTING: &str = "agent.scope_policy";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentScopePolicy {
    pub scope: String,
    pub label: String,
    pub description: String,
    pub decision: String,
    pub high_risk: bool,
}

pub fn builtin_tool_registry() -> ToolRegistry {
    let mut registry = ToolRegistry::default();
    for tool in [
        ask_ai_model_tool(),
        compress_images_tool(),
        find_local_files_tool(),
        get_current_context_tool(),
        ocr_image_tool(),
        open_or_reveal_path_tool(),
        rename_files_tool(),
        search_clipboard_tool(),
    ] {
        registry.register(tool);
    }
    registry
}

pub fn sync_builtin_tools(db: &Database) -> Result<(), String> {
    db.sync_agent_tools(&builtin_tool_registry().list_all())
        .map_err(|e| e.to_string())
}

pub fn sync_plugin_tools(db: &Database) -> Result<(), String> {
    let tools = db
        .list_plugins()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|plugin| plugin.enabled)
        .flat_map(|plugin| plugin_manifest_tool_definitions(&plugin))
        .collect::<Vec<_>>();
    db.sync_agent_tools(&tools).map_err(|e| e.to_string())?;
    let names = tools
        .iter()
        .map(|tool| tool.name.clone())
        .collect::<Vec<_>>();
    db.delete_agent_tools_by_source_except("plugin", &names)
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn list_enabled_tools(db: &Database) -> Result<Vec<ToolDefinition>, String> {
    Ok(db
        .list_agent_tools()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|tool| tool.enabled)
        .collect())
}

pub fn enabled_tool_registry(db: &Database) -> Result<ToolRegistry, String> {
    let mut registry = ToolRegistry::default();
    for tool in list_enabled_tools(db)? {
        registry.register(tool);
    }
    Ok(registry)
}

pub fn plugin_manifest_tool_definitions(plugin: &Plugin) -> Vec<ToolDefinition> {
    let mut tools = plugin
        .manifest
        .tools
        .iter()
        .filter_map(|(tool_name, manifest)| {
            let normalized_tool_name = agent_plugin_tool_name(&plugin.id, tool_name)?;
            let description = if manifest.description.trim().is_empty() {
                format!("{}: {}", plugin.name, tool_name)
            } else {
                format!("{}: {}", plugin.name, manifest.description.trim())
            };
            let input_schema = if manifest.input_schema.is_null() {
                json!({ "type": "object", "additionalProperties": true })
            } else {
                manifest.input_schema.clone()
            };
            Some(ToolDefinition {
                name: normalized_tool_name,
                description,
                input_schema,
                output_schema: manifest.output_schema.clone(),
                scopes: vec![PermissionScope::PluginData],
                enabled_by_default: false,
                enabled: false,
                source: "plugin".to_string(),
                plugin_id: Some(plugin.id.clone()),
            })
        })
        .collect::<Vec<_>>();
    tools.sort_by(|left, right| left.name.cmp(&right.name));
    tools
}

fn agent_plugin_tool_name(plugin_id: &str, tool_name: &str) -> Option<String> {
    let plugin = tool_name_part(plugin_id)?;
    let tool = tool_name_part(tool_name)?;
    Some(format!("plugin_{}_{}", plugin, tool))
}

fn tool_name_part(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let sanitized = atools_core::utils::sanitize_id(trimmed)
        .replace('-', "_")
        .to_lowercase();
    (!sanitized.is_empty()).then_some(sanitized)
}

pub fn list_agent_scope_policies(db: &Database) -> Result<Vec<AgentScopePolicy>, String> {
    let policy = persisted_scope_policy(db)?;
    Ok(all_permission_scopes()
        .into_iter()
        .map(|scope| {
            let scope_id = permission_scope_id(scope);
            let decision = policy
                .get(scope_id)
                .cloned()
                .unwrap_or_else(|| "confirm".to_string());
            AgentScopePolicy {
                scope: scope_id.to_string(),
                label: permission_scope_label(scope).to_string(),
                description: permission_scope_description(scope).to_string(),
                decision,
                high_risk: permission_scope_is_high_risk(scope),
            }
        })
        .collect())
}

pub fn set_agent_scope_policy(
    db: &Database,
    scope: &str,
    decision: &str,
) -> Result<Vec<AgentScopePolicy>, String> {
    let normalized_scope = normalize_scope_id(scope)?;
    let normalized_decision = match decision {
        "deny" => "deny",
        "confirm" | "allow" | "default" => "confirm",
        _ => return Err(format!("Unsupported scope decision: {}", decision)),
    };
    let mut policy = persisted_scope_policy(db)?;
    if normalized_decision == "deny" {
        policy.insert(
            normalized_scope.to_string(),
            normalized_decision.to_string(),
        );
    } else {
        policy.remove(normalized_scope);
    }
    let value = serde_json::to_string(&policy).map_err(|e| e.to_string())?;
    db.set_setting(AGENT_SCOPE_POLICY_SETTING, &value)
        .map_err(|e| e.to_string())?;
    list_agent_scope_policies(db)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMatch {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindLocalFilesOptions {
    pub limit: usize,
    pub max_depth: Option<usize>,
    pub ignore_dirs: Vec<String>,
    pub ignore_patterns: Vec<String>,
}

impl Default for FindLocalFilesOptions {
    fn default() -> Self {
        Self {
            limit: 50,
            max_depth: None,
            ignore_dirs: Vec::new(),
            ignore_patterns: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindLocalFilesReport {
    pub items: Vec<FileMatch>,
    pub skipped_permission_errors: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameOperation {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameResult {
    pub from: String,
    pub to: String,
    pub status: String,
    pub dry_run: bool,
    pub from_exists: bool,
    pub to_exists: bool,
    pub parent_exists: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AgentAiConfig {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub api_key: String,
    pub temperature: f64,
}

pub fn find_local_files(root: &Path, query: &str, limit: usize) -> Result<Vec<FileMatch>, String> {
    Ok(find_local_files_with_options(
        root,
        query,
        &FindLocalFilesOptions {
            limit,
            ..FindLocalFilesOptions::default()
        },
    )?
    .items)
}

pub fn find_local_files_with_options(
    root: &Path,
    query: &str,
    options: &FindLocalFilesOptions,
) -> Result<FindLocalFilesReport, String> {
    let mut report = FindLocalFilesReport {
        items: Vec::new(),
        skipped_permission_errors: 0,
    };
    let query_lower = query.to_lowercase();
    visit_files(root, root, &query_lower, options, 0, &mut report)?;
    Ok(report)
}

pub fn plan_renames(
    operations: &[RenameOperation],
    dry_run: bool,
) -> Result<Vec<RenameResult>, String> {
    let mut results = Vec::with_capacity(operations.len());
    let mut targets = std::collections::HashSet::new();

    for operation in operations {
        let from = Path::new(&operation.from);
        let to = Path::new(&operation.to);
        let from_exists = from.exists();
        let to_exists = to.exists();
        let parent_exists = to
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .map(Path::exists)
            .unwrap_or(true);

        if operation.from == operation.to {
            return Err(format!(
                "Invalid rename from {} to {}: source and target are identical",
                operation.from, operation.to
            ));
        }
        if !from_exists {
            return Err(format!(
                "Invalid rename from {}: source does not exist",
                operation.from
            ));
        }
        if !parent_exists {
            return Err(format!(
                "Invalid rename to {}: parent directory does not exist",
                operation.to
            ));
        }
        if to_exists {
            return Err(format!(
                "Invalid rename to {}: target already exists",
                operation.to
            ));
        }
        if !targets.insert(operation.to.clone()) {
            return Err(format!(
                "Invalid rename to {}: duplicate target in rename plan",
                operation.to
            ));
        }

        results.push(RenameResult {
            from: operation.from.clone(),
            to: operation.to.clone(),
            status: if dry_run { "planned" } else { "validated" }.to_string(),
            dry_run,
            from_exists,
            to_exists,
            parent_exists,
        });
    }

    if dry_run {
        return Ok(results);
    }

    for result in &mut results {
        fs::rename(&result.from, &result.to)
            .map_err(|e| format!("Failed to rename {}: {}", result.from, e))?;
        result.status = "renamed".to_string();
    }
    Ok(results)
}

pub async fn call_tool_with_audit(
    app: &AppHandle,
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
    confirmed: bool,
) -> McpToolCallResult {
    let started = Instant::now();
    let Some(tool) = db
        .get_agent_tool(tool_name)
        .ok()
        .flatten()
        .or_else(|| builtin_tool_registry().get(tool_name).cloned())
    else {
        return McpToolCallResult::error(format!("Unknown tool: {}", tool_name));
    };

    let permission =
        permission_decision_for_tool(db, client_id, tool_name).unwrap_or(PermissionDecision::Deny);

    if matches!(permission, PermissionDecision::Deny) {
        let entry = AuditLogEntry::new(client_id, tool_name, arguments, AuditStatus::Denied)
            .with_duration_ms(started.elapsed().as_millis() as u64)
            .with_error("Permission denied");
        let _ = db.insert_audit_entry(&entry);
        return McpToolCallResult::error("Permission denied");
    }

    if matches!(permission, PermissionDecision::Confirm) && !confirmed {
        let entry = AuditLogEntry::new(client_id, tool_name, arguments, AuditStatus::Denied)
            .with_duration_ms(started.elapsed().as_millis() as u64)
            .with_error("Permission confirmation required");
        let _ = db.insert_audit_entry(&entry);
        let pending =
            build_pending_agent_tool_request(db, client_id, tool_name, entry.input.clone())
                .unwrap_or_else(|_| PendingAgentToolRequest {
                    id: format!("agent-confirm-{}", atools_core::utils::generate_rev()),
                    client_id: client_id.to_string(),
                    tool_name: tool_name.to_string(),
                    arguments: entry.input.clone(),
                    scopes: tool.scopes.clone(),
                    created_at: atools_core::utils::now_iso(),
                });
        let state = app.state::<crate::state::AppState>();
        state
            .pending_agent_requests
            .lock()
            .insert(pending.id.clone(), pending.clone());
        let _ = app.emit("agent-permission-request", &pending);
        return McpToolCallResult {
            structured_content: permission_required_payload(&pending),
            is_error: true,
        };
    }

    let result = execute_agent_tool(app, db, &tool, arguments.clone()).await;
    let duration_ms = started.elapsed().as_millis() as u64;
    match result {
        Ok(output) => {
            let status = if confirmed {
                AuditStatus::Confirmed
            } else {
                AuditStatus::Allowed
            };
            let entry = AuditLogEntry::new(client_id, tool_name, arguments, status)
                .with_output(output.clone())
                .with_duration_ms(duration_ms);
            let _ = db.insert_audit_entry(&entry);
            McpToolCallResult::success(output)
        }
        Err(error) => {
            let entry = AuditLogEntry::new(client_id, tool_name, arguments, AuditStatus::Error)
                .with_duration_ms(duration_ms)
                .with_error(error.clone());
            let _ = db.insert_audit_entry(&entry);
            McpToolCallResult::error(error)
        }
    }
}

pub fn build_pending_agent_tool_request(
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
) -> Result<PendingAgentToolRequest, String> {
    let Some(tool) = db.get_agent_tool(tool_name).map_err(|e| e.to_string())? else {
        return Err(format!("Unknown tool: {}", tool_name));
    };

    Ok(PendingAgentToolRequest {
        id: format!("agent-confirm-{}", atools_core::utils::generate_rev()),
        client_id: client_id.to_string(),
        tool_name: tool_name.to_string(),
        arguments,
        scopes: tool.scopes,
        created_at: atools_core::utils::now_iso(),
    })
}

pub fn build_permission_required_payload(
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    let pending = build_pending_agent_tool_request(db, client_id, tool_name, arguments)?;
    Ok(permission_required_payload(&pending))
}

pub fn permission_required_payload(request: &PendingAgentToolRequest) -> Value {
    json!({
        "permission_required": true,
        "request_id": &request.id,
        "client_id": &request.client_id,
        "tool": &request.tool_name,
        "arguments": &request.arguments,
        "scopes": &request.scopes,
        "retry_after_grant": true
    })
}

pub fn permission_decision_for_tool(
    db: &Database,
    client_id: &str,
    tool_name: &str,
) -> Result<PermissionDecision, String> {
    let mode = db
        .get_setting("agent.permission_mode")
        .map_err(|e| e.to_string())?
        .as_deref()
        .map(permission_mode_from_str)
        .unwrap_or(PermissionMode::Conservative);
    let Some(tool) = db.get_agent_tool(tool_name).map_err(|e| e.to_string())? else {
        return Ok(PermissionDecision::Deny);
    };

    if !tool.enabled {
        return Ok(PermissionDecision::Deny);
    }
    if tool_has_denied_scope(db, &tool.scopes)? {
        return Ok(PermissionDecision::Deny);
    }
    if matches!(mode, PermissionMode::Developer) {
        return Ok(PermissionDecision::Allow);
    }
    if db
        .is_agent_tool_granted(client_id, tool_name)
        .map_err(|e| e.to_string())?
    {
        return Ok(PermissionDecision::Allow);
    }

    Ok(PermissionDecision::Confirm)
}

fn tool_has_denied_scope(db: &Database, scopes: &[PermissionScope]) -> Result<bool, String> {
    let policy = persisted_scope_policy(db)?;
    Ok(scopes.iter().any(|scope| {
        policy
            .get(permission_scope_id(*scope))
            .is_some_and(|decision| decision == "deny")
    }))
}

fn persisted_scope_policy(db: &Database) -> Result<BTreeMap<String, String>, String> {
    let Some(value) = db
        .get_setting(AGENT_SCOPE_POLICY_SETTING)
        .map_err(|e| e.to_string())?
    else {
        return Ok(BTreeMap::new());
    };
    if value.trim().is_empty() {
        return Ok(BTreeMap::new());
    }
    let raw: BTreeMap<String, String> = serde_json::from_str(&value).map_err(|e| e.to_string())?;
    let mut policy = BTreeMap::new();
    for (scope, decision) in raw {
        let normalized_scope = normalize_scope_id(&scope)?;
        if decision == "deny" {
            policy.insert(normalized_scope.to_string(), "deny".to_string());
        }
    }
    Ok(policy)
}

fn normalize_scope_id(scope: &str) -> Result<&'static str, String> {
    all_permission_scopes()
        .into_iter()
        .map(permission_scope_id)
        .find(|scope_id| *scope_id == scope)
        .ok_or_else(|| format!("Unsupported permission scope: {}", scope))
}

fn all_permission_scopes() -> Vec<PermissionScope> {
    vec![
        PermissionScope::ClipboardRead,
        PermissionScope::ClipboardWrite,
        PermissionScope::FileRead,
        PermissionScope::FileWrite,
        PermissionScope::Network,
        PermissionScope::Shell,
        PermissionScope::Screenshot,
        PermissionScope::BrowserContext,
        PermissionScope::PluginData,
        PermissionScope::SystemSettings,
    ]
}

fn permission_scope_id(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::ClipboardRead => "clipboard_read",
        PermissionScope::ClipboardWrite => "clipboard_write",
        PermissionScope::FileRead => "file_read",
        PermissionScope::FileWrite => "file_write",
        PermissionScope::Network => "network",
        PermissionScope::Shell => "shell",
        PermissionScope::Screenshot => "screenshot",
        PermissionScope::BrowserContext => "browser_context",
        PermissionScope::PluginData => "plugin_data",
        PermissionScope::SystemSettings => "system_settings",
    }
}

fn permission_scope_label(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::ClipboardRead => "读取剪贴板",
        PermissionScope::ClipboardWrite => "写入剪贴板",
        PermissionScope::FileRead => "读取文件",
        PermissionScope::FileWrite => "修改文件",
        PermissionScope::Network => "网络访问",
        PermissionScope::Shell => "执行命令",
        PermissionScope::Screenshot => "截图/OCR",
        PermissionScope::BrowserContext => "浏览器上下文",
        PermissionScope::PluginData => "插件数据",
        PermissionScope::SystemSettings => "系统设置",
    }
}

fn permission_scope_description(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::ClipboardRead => "允许 Agent 读取本机剪贴板或剪贴板历史。",
        PermissionScope::ClipboardWrite => "允许 Agent 写入剪贴板。",
        PermissionScope::FileRead => "允许 Agent 读取本地文件和目录元数据。",
        PermissionScope::FileWrite => "允许 Agent 修改、重命名或生成本地文件。",
        PermissionScope::Network => "允许 Agent 访问本机或外部网络服务。",
        PermissionScope::Shell => "允许 Agent 打开路径、调用系统命令或触发 shell 类能力。",
        PermissionScope::Screenshot => "允许 Agent 读取屏幕内容或发起 OCR。",
        PermissionScope::BrowserContext => "允许 Agent 读取当前浏览器或 Finder 上下文。",
        PermissionScope::PluginData => "允许 Agent 访问插件本地数据。",
        PermissionScope::SystemSettings => "允许 Agent 修改系统级或应用级设置。",
    }
}

fn permission_scope_is_high_risk(scope: PermissionScope) -> bool {
    matches!(
        scope,
        PermissionScope::FileWrite
            | PermissionScope::Network
            | PermissionScope::Shell
            | PermissionScope::Screenshot
            | PermissionScope::SystemSettings
    )
}

pub async fn execute_builtin_tool(
    app: &AppHandle,
    db: &Database,
    tool_name: &str,
    arguments: Value,
) -> Result<Value, String> {
    match tool_name {
        "ask_ai_model" => ask_ai_model(db, arguments).await,
        "search_clipboard" => search_clipboard(app, db, arguments).await,
        "find_local_files" => find_local_files_tool_call(arguments),
        "get_current_context" => get_current_context(),
        "open_or_reveal_path" => open_or_reveal_path(arguments),
        "rename_files" => rename_files_tool_call(arguments),
        "compress_images" => compress_images(arguments),
        "ocr_image" => ocr_image(arguments).await,
        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
}

async fn execute_agent_tool(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    arguments: Value,
) -> Result<Value, String> {
    if tool.source == "plugin" {
        let runtime = app
            .try_state::<Arc<atools_plugin::runtime::JsRuntime>>()
            .ok_or_else(|| {
                "Plugin runtime is not available for Agent tool execution".to_string()
            })?;
        execute_plugin_tool(runtime.inner().as_ref(), db, tool, arguments).await
    } else {
        execute_builtin_tool(app, db, &tool.name, arguments).await
    }
}

pub async fn execute_plugin_tool(
    runtime: &atools_plugin::runtime::JsRuntime,
    db: &Database,
    tool: &ToolDefinition,
    arguments: Value,
) -> Result<Value, String> {
    if tool.source != "plugin" {
        return Err(format!("Tool {} is not a plugin tool", tool.name));
    }
    let plugin_id = tool
        .plugin_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Plugin tool {} is missing plugin_id", tool.name))?;
    let plugin = db.get_plugin(plugin_id).map_err(|e| e.to_string())?;
    if !plugin.enabled {
        return Err(format!("Plugin {} is disabled", plugin_id));
    }
    let manifest_tool_name = plugin
        .manifest
        .tools
        .keys()
        .find(|tool_name| {
            agent_plugin_tool_name(&plugin.id, tool_name)
                .is_some_and(|normalized| normalized == tool.name)
        })
        .cloned()
        .ok_or_else(|| {
            format!(
                "Plugin tool {} no longer exists in manifest for {}",
                tool.name, plugin_id
            )
        })?;

    let payload = vec![json!({
        "tool": manifest_tool_name,
        "normalizedTool": tool.name,
        "arguments": arguments
    })];

    match runtime
        .call_function(plugin_id, "____callAgentTool____", payload.clone())
        .await
    {
        Ok(output) => Ok(output),
        Err(error) if error.to_string().contains("Context not found") => {
            load_plugin_preload_for_agent_tool(runtime, &plugin).await?;
            runtime
                .call_function(plugin_id, "____callAgentTool____", payload)
                .await
                .map_err(|error| format!("Plugin Agent tool {} failed: {}", tool.name, error))
        }
        Err(error) => Err(format!("Plugin Agent tool {} failed: {}", tool.name, error)),
    }
}

async fn load_plugin_preload_for_agent_tool(
    runtime: &atools_plugin::runtime::JsRuntime,
    plugin: &Plugin,
) -> Result<(), String> {
    let preload = plugin.manifest.preload.as_deref().ok_or_else(|| {
        format!(
            "Plugin {} runtime context is missing and manifest has no preload to register Agent tools",
            plugin.id
        )
    })?;
    let preload_path = Path::new(preload);
    if preload_path.is_absolute()
        || preload_path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(format!(
            "Plugin {} preload path is outside the plugin directory: {}",
            plugin.id, preload
        ));
    }
    let path = PathBuf::from(&plugin.path).join(preload_path);
    let preload_code = tokio::fs::read_to_string(&path).await.map_err(|error| {
        format!(
            "Failed to read plugin preload for Agent tool {} at {}: {}",
            plugin.id,
            path.display(),
            error
        )
    })?;

    runtime
        .execute_preload(&plugin.id, &preload_code)
        .await
        .map_err(|error| {
            format!(
                "Failed to execute plugin preload for Agent tool {}: {}",
                plugin.id, error
            )
        })
}

pub fn permission_mode_from_str(value: &str) -> PermissionMode {
    match value {
        "per_tool" => PermissionMode::PerTool,
        "developer" => PermissionMode::Developer,
        _ => PermissionMode::Conservative,
    }
}

pub fn permission_mode_to_str(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Conservative => "conservative",
        PermissionMode::PerTool => "per_tool",
        PermissionMode::Developer => "developer",
    }
}

pub fn agent_ai_config_from_settings(settings: &Value) -> Result<AgentAiConfig, String> {
    if !settings
        .get("aiUseForAgent")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err("AI model is not enabled for Agent".to_string());
    }

    let provider = settings_string(settings, "aiProvider");
    if provider == "disabled" || provider.is_empty() {
        return Err("AI provider is disabled for Agent".to_string());
    }
    if !matches!(provider.as_str(), "openai" | "compatible" | "local") {
        return Err(format!("Unsupported AI provider for Agent: {provider}"));
    }

    let base_url = settings_string(settings, "aiBaseUrl");
    if base_url.is_empty() {
        return Err("AI Base URL is required for Agent".to_string());
    }
    let model = settings_string(settings, "aiDefaultModel");
    if model.is_empty() {
        return Err("AI default model is required for Agent".to_string());
    }
    let api_key = settings_string(settings, "aiApiKey");
    if provider != "local" && api_key.is_empty() {
        return Err("AI API key is required for Agent".to_string());
    }
    let temperature = settings
        .get("aiTemperature")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.0..=2.0).contains(value))
        .unwrap_or(0.2);

    Ok(AgentAiConfig {
        provider,
        base_url,
        model,
        api_key,
        temperature,
    })
}

fn agent_ai_config_from_db(db: &Database) -> Result<AgentAiConfig, String> {
    let value = db
        .get_setting("settings-general")
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "AI settings are not saved yet".to_string())?;
    let settings = serde_json::from_str::<Value>(&value)
        .map_err(|e| format!("Failed to parse AI settings: {e}"))?;
    agent_ai_config_from_settings(&settings)
}

pub async fn ask_ai_model(db: &Database, arguments: Value) -> Result<Value, String> {
    let started = Instant::now();
    let config = agent_ai_config_from_db(db)?;
    let prompt = arguments
        .get("prompt")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Missing prompt".to_string())?;
    let system = arguments
        .get("system")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let max_tokens = arguments
        .get("max_tokens")
        .and_then(Value::as_u64)
        .map(|value| value.clamp(1, 32_768));

    let mut messages = Vec::new();
    if let Some(system) = system {
        messages.push(json!({ "role": "system", "content": system }));
    }
    messages.push(json!({ "role": "user", "content": prompt }));

    let mut payload = json!({
        "model": config.model.clone(),
        "messages": messages,
        "temperature": config.temperature,
        "stream": false
    });
    if let Some(max_tokens) = max_tokens {
        payload["max_tokens"] = json!(max_tokens);
    }

    let url = ai_chat_completions_url(&config.base_url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("Failed to create Agent AI client: {error}"))?;
    let mut request = client.post(&url).json(&payload);
    if !config.api_key.trim().is_empty() {
        request = request.bearer_auth(config.api_key.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Agent AI request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(format!(
            "Agent AI request failed: HTTP {}{}",
            status.as_u16(),
            if body.trim().is_empty() {
                String::new()
            } else {
                format!(" {}", truncate_for_error(body.trim(), 240))
            }
        ));
    }
    let response_json = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Agent AI response JSON failed: {error}"))?;
    let text = response_json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
                .and_then(Value::as_str)
                .or_else(|| choice.get("text").and_then(Value::as_str))
        })
        .ok_or_else(|| "Agent AI response did not contain assistant text".to_string())?;
    let finish_reason = response_json
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("finish_reason"))
        .cloned()
        .unwrap_or(Value::Null);
    let usage = response_json.get("usage").cloned().unwrap_or(Value::Null);

    Ok(json!({
        "status": "ok",
        "provider": config.provider,
        "model": config.model,
        "text": text,
        "finish_reason": finish_reason,
        "usage": usage,
        "duration_ms": started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
    }))
}

fn ai_chat_completions_url(base_url: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(base_url.trim())
        .map_err(|error| format!("Invalid AI URL for Agent: {error}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("AI Base URL for Agent must use http or https".to_string());
    }
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "AI Base URL cannot be used as an Agent base path".to_string())?;
        segments.pop_if_empty();
        segments.push("chat");
        segments.push("completions");
    }
    Ok(url.to_string())
}

fn settings_string(settings: &Value, key: &str) -> String {
    settings
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_string()
}

fn truncate_for_error(value: &str, limit: usize) -> String {
    if value.len() <= limit {
        value.to_string()
    } else {
        format!("{}...", value.chars().take(limit).collect::<String>())
    }
}

async fn search_clipboard(
    app: &AppHandle,
    db: &Database,
    arguments: Value,
) -> Result<Value, String> {
    let text = app.clipboard().read_text().ok();
    if text
        .as_deref()
        .map(str::trim)
        .is_some_and(|text| !text.is_empty())
    {
        let cutoff = atools_core::utils::iso_days_ago(clipboard_retention_days(db));
        let _ = db.prune_clipboard_history(&cutoff);
    }
    search_clipboard_history(db, text.as_deref(), arguments)
}

pub fn search_clipboard_history(
    db: &Database,
    current_text: Option<&str>,
    arguments: Value,
) -> Result<Value, String> {
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .min(500) as usize;

    if let Some(text) = current_text.map(str::trim).filter(|text| !text.is_empty()) {
        db.record_clipboard_text(text, &atools_core::utils::now_iso())
            .map_err(|e| e.to_string())?;
    }

    let items = db
        .search_clipboard_history(query, limit)
        .map_err(|e| e.to_string())?;
    let json_items: Vec<Value> = items
        .into_iter()
        .map(|entry| {
            json!({
                "id": entry.id,
                "type": "text",
                "source": "clipboard_history",
                "text": entry.text,
                "first_copied_at": entry.first_copied_at,
                "last_copied_at": entry.last_copied_at,
                "used_count": entry.used_count,
            })
        })
        .collect();
    let total = json_items.len();

    Ok(json!({
        "items": json_items,
        "total": total
    }))
}

fn clipboard_retention_days(db: &Database) -> u64 {
    db.get_setting("settings-general")
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_str::<Value>(&value).ok())
        .and_then(|settings| {
            settings
                .get("clipboardRetentionDays")
                .and_then(Value::as_u64)
        })
        .unwrap_or(180)
        .clamp(1, 3650)
}

fn find_local_files_tool_call(arguments: Value) -> Result<Value, String> {
    let root = arguments
        .get("root")
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Cannot determine home directory".to_string())?;
    let query = arguments
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let limit = arguments
        .get("limit")
        .and_then(Value::as_u64)
        .unwrap_or(50)
        .min(500) as usize;
    let max_depth = arguments
        .get("max_depth")
        .and_then(Value::as_u64)
        .map(|depth| depth.min(100) as usize);
    let ignore_dirs = arguments
        .get("ignore_dirs")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(default_ignored_dirs);
    let ignore_patterns = arguments
        .get("ignore_patterns")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let report = find_local_files_with_options(
        &root,
        query,
        &FindLocalFilesOptions {
            limit,
            max_depth,
            ignore_dirs,
            ignore_patterns,
        },
    )?;
    Ok(json!({
        "items": report.items,
        "skipped_permission_errors": report.skipped_permission_errors
    }))
}

fn rename_files_tool_call(arguments: Value) -> Result<Value, String> {
    let dry_run = arguments
        .get("dry_run")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let operations: Vec<RenameOperation> = serde_json::from_value(
        arguments
            .get("operations")
            .cloned()
            .unwrap_or_else(|| json!([])),
    )
    .map_err(|e| e.to_string())?;
    Ok(json!({ "operations": plan_renames(&operations, dry_run)? }))
}

pub fn open_or_reveal_path(arguments: Value) -> Result<Value, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing path".to_string())?;
    let reveal = arguments
        .get("reveal")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        if reveal {
            command.arg("-R");
        }
        command.arg(path);
        let output = command
            .output()
            .map_err(|e| format!("Failed to run macOS open for {}: {}", path, e))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let command_name = if reveal { "open -R" } else { "open" };
            return Err(format!(
                "{} failed for {}{}",
                command_name,
                path,
                if stderr.is_empty() {
                    format!(" with status {}", output.status)
                } else {
                    format!(": {}", stderr)
                }
            ));
        }
        Ok(json!({ "ok": true, "path": path, "reveal": reveal }))
    } else {
        Err(format!(
            "Unsupported platform for open_or_reveal_path: {}. This built-in tool currently supports macOS open/open -R only.",
            std::env::consts::OS
        ))
    }
}

pub fn get_current_context() -> Result<Value, String> {
    let browser_url = read_browser_url();
    let foreground_app = read_foreground_app();
    let finder_path = read_finder_path();
    Ok(json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "home": dirs::home_dir().map(|p| p.to_string_lossy().to_string()),
        "desktop": dirs::desktop_dir().map(|p| p.to_string_lossy().to_string()),
        "downloads": dirs::download_dir().map(|p| p.to_string_lossy().to_string()),
        "browser_url": browser_url.value,
        "browser_url_reason": browser_url.reason,
        "foreground_app": foreground_app.value,
        "foreground_app_reason": foreground_app.reason,
        "finder_path": finder_path.value,
        "finder_path_reason": finder_path.reason
    }))
}

pub fn compress_images(arguments: Value) -> Result<Value, String> {
    let paths = arguments
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| "Missing paths array".to_string())?;
    let output_dir = arguments
        .get("output_dir")
        .and_then(Value::as_str)
        .map(PathBuf::from);
    let max_width = arguments
        .get("max_width")
        .and_then(Value::as_u64)
        .unwrap_or(1600);
    let max_bytes = arguments
        .get("max_bytes")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0);
    let output_format = CompressionImageFormat::from_arguments(&arguments)?;

    let mut outputs = Vec::new();
    for path in paths.iter().filter_map(Value::as_str) {
        let input = PathBuf::from(path);
        let original_size = fs::metadata(&input)
            .map_err(|e| format!("Failed to read input metadata for {}: {}", path, e))?
            .len();
        let file_name = input
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| format!("Invalid file path: {}", path))?;
        let target_dir = output_dir.clone().unwrap_or_else(|| {
            input
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .to_path_buf()
        });
        if !target_dir.exists() {
            return Err(format!(
                "Output directory does not exist: {}",
                target_dir.to_string_lossy()
            ));
        }
        let output = compressed_output_path(&input, &target_dir, file_name, output_format)?;
        match output_format {
            CompressionImageFormat::Original => {
                fs::copy(&input, &output).map_err(|e| {
                    format!(
                        "Failed to copy {} to {}: {}",
                        input.to_string_lossy(),
                        output.to_string_lossy(),
                        e
                    )
                })?;
                if cfg!(target_os = "macos") {
                    let sips_output = Command::new("sips")
                        .arg("--resampleWidth")
                        .arg(max_width.to_string())
                        .arg(&output)
                        .output()
                        .map_err(|e| {
                            format!("Failed to run sips for {}: {}", output.to_string_lossy(), e)
                        })?;
                    if !sips_output.status.success() {
                        let stderr = String::from_utf8_lossy(&sips_output.stderr)
                            .trim()
                            .to_string();
                        return Err(format!(
                            "sips failed for {}{}",
                            output.to_string_lossy(),
                            if stderr.is_empty() {
                                format!(" with status {}", sips_output.status)
                            } else {
                                format!(": {}", stderr)
                            }
                        ));
                    }
                }
            }
            CompressionImageFormat::Webp => write_webp_output(&input, &output, max_width)?,
        }
        let (output, output_size, target_reason) =
            tune_image_to_target(output, max_bytes, output_format.allows_quality_tuning())?;
        let target_met = max_bytes.map(|target| output_size <= target);
        let status = if target_met == Some(false) {
            "target_unmet"
        } else if cfg!(target_os = "macos") || output_format.is_encoded() {
            "compressed"
        } else {
            "copied"
        };
        outputs.push(json!({
            "input": input.to_string_lossy(),
            "output": output.to_string_lossy(),
            "format": output_format.as_str(),
            "status": status,
            "original_size": original_size,
            "output_size": output_size,
            "target_size": max_bytes,
            "target_met": target_met,
            "target_reason": target_reason,
            "compression_ratio": compression_ratio(original_size, output_size)
        }));
    }

    Ok(json!({ "items": outputs }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CompressionImageFormat {
    Original,
    Webp,
}

impl CompressionImageFormat {
    fn from_arguments(arguments: &Value) -> Result<Self, String> {
        match arguments
            .get("format")
            .and_then(Value::as_str)
            .unwrap_or("original")
            .to_ascii_lowercase()
            .as_str()
        {
            "original" => Ok(Self::Original),
            "webp" => Ok(Self::Webp),
            other => Err(format!(
                "Unsupported compress_images format: {}. Supported formats: original, webp",
                other
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Original => "original",
            Self::Webp => "webp",
        }
    }

    fn allows_quality_tuning(self) -> bool {
        matches!(self, Self::Original)
    }

    fn is_encoded(self) -> bool {
        matches!(self, Self::Webp)
    }
}

fn compressed_output_path(
    input: &Path,
    target_dir: &Path,
    file_name: &str,
    output_format: CompressionImageFormat,
) -> Result<PathBuf, String> {
    match output_format {
        CompressionImageFormat::Original => {
            Ok(target_dir.join(format!("compressed-{}", file_name)))
        }
        CompressionImageFormat::Webp => {
            let stem = input
                .file_stem()
                .and_then(|name| name.to_str())
                .ok_or_else(|| format!("Invalid file path: {}", input.to_string_lossy()))?;
            Ok(target_dir.join(format!("compressed-{}.webp", stem)))
        }
    }
}

fn write_webp_output(input: &Path, output: &Path, max_width: u64) -> Result<(), String> {
    let mut image = image::ImageReader::open(input)
        .map_err(|error| {
            format!(
                "Failed to open image {}: {}",
                input.to_string_lossy(),
                error
            )
        })?
        .decode()
        .map_err(|error| {
            format!(
                "Failed to decode image {}: {}",
                input.to_string_lossy(),
                error
            )
        })?;
    let max_width = max_width.min(u32::MAX as u64) as u32;
    if max_width > 0 && image.width() > max_width {
        let scaled_height = ((image.height() as f64 * max_width as f64) / image.width() as f64)
            .round()
            .max(1.0) as u32;
        image = image.resize(
            max_width,
            scaled_height,
            image::imageops::FilterType::Lanczos3,
        );
    }
    let rgba = image.to_rgba8();
    let mut file = fs::File::create(output)
        .map_err(|error| format!("Failed to create {}: {}", output.to_string_lossy(), error))?;
    image::codecs::webp::WebPEncoder::new_lossless(&mut file)
        .write_image(
            rgba.as_raw(),
            rgba.width(),
            rgba.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|error| {
            format!(
                "Failed to encode WebP output {}: {}",
                output.to_string_lossy(),
                error
            )
        })
}

fn tune_image_to_target(
    output: PathBuf,
    max_bytes: Option<u64>,
    allow_quality_tuning: bool,
) -> Result<(PathBuf, u64, Option<String>), String> {
    let mut current_output = output;
    let mut current_size = fs::metadata(&current_output)
        .map_err(|e| {
            format!(
                "Failed to read output metadata for {}: {}",
                current_output.to_string_lossy(),
                e
            )
        })?
        .len();
    let Some(target) = max_bytes else {
        return Ok((current_output, current_size, None));
    };
    if current_size <= target {
        return Ok((current_output, current_size, None));
    }

    #[cfg(target_os = "macos")]
    {
        if allow_quality_tuning {
            if let Some((optimized_output, optimized_size)) =
                best_sips_quality_candidate(&current_output, target)?
            {
                if optimized_size < current_size {
                    let _ = fs::remove_file(&current_output);
                    current_output = optimized_output;
                    current_size = optimized_size;
                }
            }
        }
    }

    let reason = if current_size <= target {
        None
    } else {
        Some(format!(
            "Could not reach max_bytes target {}; smallest output is {} bytes",
            target, current_size
        ))
    };
    Ok((current_output, current_size, reason))
}

#[cfg(target_os = "macos")]
fn best_sips_quality_candidate(
    source: &Path,
    target: u64,
) -> Result<Option<(PathBuf, u64)>, String> {
    let mut best: Option<(PathBuf, u64)> = None;
    for quality in [85, 75, 65, 55, 45, 35, 25, 15] {
        let candidate = quality_candidate_path(source, quality);
        let sips_output = Command::new("sips")
            .arg("-s")
            .arg("format")
            .arg("jpeg")
            .arg("-s")
            .arg("formatOptions")
            .arg(quality.to_string())
            .arg(source)
            .arg("--out")
            .arg(&candidate)
            .output()
            .map_err(|e| {
                format!(
                    "Failed to run sips quality pass for {}: {}",
                    source.to_string_lossy(),
                    e
                )
            })?;
        if !sips_output.status.success() {
            let _ = fs::remove_file(&candidate);
            continue;
        }
        let candidate_size = fs::metadata(&candidate)
            .map_err(|e| {
                format!(
                    "Failed to read output metadata for {}: {}",
                    candidate.to_string_lossy(),
                    e
                )
            })?
            .len();
        if best
            .as_ref()
            .map(|(_, best_size)| candidate_size < *best_size)
            .unwrap_or(true)
        {
            if let Some((old_candidate, _)) = best.replace((candidate.clone(), candidate_size)) {
                let _ = fs::remove_file(old_candidate);
            }
        } else {
            let _ = fs::remove_file(&candidate);
        }
        if candidate_size <= target {
            break;
        }
    }
    Ok(best)
}

#[cfg(target_os = "macos")]
fn quality_candidate_path(source: &Path, quality: u64) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("image");
    let parent = source.parent().unwrap_or_else(|| Path::new("."));
    parent.join(format!("{}-q{}.jpg", stem, quality))
}

fn compression_ratio(original_size: u64, output_size: u64) -> f64 {
    if original_size == 0 {
        return 0.0;
    }
    ((output_size as f64 / original_size as f64) * 10_000.0).round() / 10_000.0
}

pub async fn ocr_image(arguments: Value) -> Result<Value, String> {
    let path = arguments
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| "Missing path".to_string())?;
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = image_mime_for_path(Path::new(path));
    let payload = json!({ "image": format!("data:{};base64,{}", mime, encoded) });
    let endpoint = arguments
        .get("endpoint")
        .and_then(Value::as_str)
        .unwrap_or("http://127.0.0.1:8765/ocr");
    let client = reqwest::Client::new();
    let response: Value = client
        .post(endpoint)
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            format!(
                "Local OCR service is unavailable at {}. Start the OCR service that accepts POST /ocr JSON with an image data URI, then retry. Network error: {}",
                endpoint, e
            )
        })?
        .json()
        .await
        .map_err(|e| format!("Local OCR service returned invalid JSON from {}: {}", endpoint, e))?;
    if response.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(json!({ "text": response.get("text").cloned().unwrap_or(Value::String(String::new())) }))
    } else {
        Err(response
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("OCR failed")
            .to_string())
    }
}

fn visit_files(
    root: &Path,
    base_root: &Path,
    query_lower: &str,
    options: &FindLocalFilesOptions,
    depth: usize,
    report: &mut FindLocalFilesReport,
) -> Result<(), String> {
    let limit = options.limit.max(1);
    if report.items.len() >= limit {
        return Ok(());
    }
    if options
        .max_depth
        .map(|max_depth| depth > max_depth)
        .unwrap_or(false)
    {
        return Ok(());
    }
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::PermissionDenied => {
            report.skipped_permission_errors += 1;
            return Ok(());
        }
        Err(error) => return Err(format!("Failed to read {:?}: {}", root, error)),
    };
    for entry in entries {
        if report.items.len() >= limit {
            break;
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                if error.kind() == ErrorKind::PermissionDenied {
                    report.skipped_permission_errors += 1;
                }
                continue;
            }
        };
        let path = entry.path();
        let file_name = entry.file_name().to_string_lossy().to_string();
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(error) => {
                if error.kind() == ErrorKind::PermissionDenied {
                    report.skipped_permission_errors += 1;
                }
                continue;
            }
        };
        if file_type.is_dir() && options.ignore_dirs.iter().any(|name| name == &file_name) {
            continue;
        }
        let relative_path = slash_path(path.strip_prefix(base_root).unwrap_or(path.as_path()));
        if matches_ignore_patterns(
            &file_name,
            &relative_path,
            file_type.is_dir(),
            &options.ignore_patterns,
        ) {
            continue;
        }
        if query_lower.is_empty() || file_name.to_lowercase().contains(query_lower) {
            report.items.push(FileMatch {
                path: path.to_string_lossy().to_string(),
                name: file_name,
                is_dir: file_type.is_dir(),
            });
        }
        if file_type.is_dir() {
            visit_files(&path, base_root, query_lower, options, depth + 1, report)?;
        }
    }
    Ok(())
}

fn slash_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn matches_ignore_patterns(
    file_name: &str,
    relative_path: &str,
    is_dir: bool,
    patterns: &[String],
) -> bool {
    patterns.iter().any(|pattern| {
        let pattern = pattern.trim().trim_start_matches("./");
        if pattern.is_empty() {
            return false;
        }
        if let Some(prefix) = pattern.strip_suffix("/**") {
            let prefix = prefix.trim_end_matches('/');
            return !prefix.is_empty()
                && (relative_path == prefix || relative_path.starts_with(&format!("{prefix}/")));
        }
        wildcard_match(pattern, file_name)
            || wildcard_match(pattern, relative_path)
            || (is_dir && wildcard_match(pattern.trim_end_matches('/'), relative_path))
    })
}

fn wildcard_match(pattern: &str, text: &str) -> bool {
    let pattern = pattern.as_bytes();
    let text = text.as_bytes();
    let (mut pattern_index, mut text_index) = (0, 0);
    let mut star_index = None;
    let mut star_text_index = 0;

    while text_index < text.len() {
        if pattern_index < pattern.len()
            && (pattern[pattern_index] == b'?' || pattern[pattern_index] == text[text_index])
        {
            pattern_index += 1;
            text_index += 1;
        } else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
            star_index = Some(pattern_index);
            star_text_index = text_index;
            pattern_index += 1;
        } else if let Some(star) = star_index {
            pattern_index = star + 1;
            star_text_index += 1;
            text_index = star_text_index;
        } else {
            return false;
        }
    }

    while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
        pattern_index += 1;
    }

    pattern_index == pattern.len()
}

fn default_ignored_dirs() -> Vec<String> {
    [".git", "node_modules", "target", ".next", ".svelte-kit"]
        .into_iter()
        .map(ToString::to_string)
        .collect()
}

#[derive(Debug)]
struct ContextValue {
    value: Value,
    reason: Value,
}

fn read_browser_url() -> ContextValue {
    match crate::commands::read_current_browser_url() {
        Ok(Some(url)) if !url.is_empty() => ContextValue {
            value: Value::String(url),
            reason: Value::Null,
        },
        Ok(_) => ContextValue {
            value: Value::Null,
            reason: Value::String(
                "No current browser URL is available from the frontmost supported browser."
                    .to_string(),
            ),
        },
        Err(error) => ContextValue {
            value: Value::Null,
            reason: Value::String(format!("Unable to read the current browser URL: {}", error)),
        },
    }
}

fn read_foreground_app() -> ContextValue {
    if cfg!(target_os = "macos") {
        match run_osascript(&[
            "-e",
            "tell application \"System Events\" to get name of first application process whose frontmost is true",
        ]) {
            Ok(value) if !value.is_empty() => ContextValue {
                value: Value::String(value),
                reason: Value::Null,
            },
            Ok(_) => ContextValue {
                value: Value::Null,
                reason: Value::String(
                    "macOS returned an empty foreground application name.".to_string(),
                ),
            },
            Err(error) => ContextValue {
                value: Value::Null,
                reason: Value::String(format!(
                    "Unable to read the foreground app with osascript: {}",
                    error
                )),
            },
        }
    } else {
        ContextValue {
            value: Value::Null,
            reason: Value::String(format!(
                "Foreground application detection is not implemented for {}.",
                std::env::consts::OS
            )),
        }
    }
}

fn read_finder_path() -> ContextValue {
    match crate::commands::read_current_folder_path() {
        Ok(Some(path)) if !path.is_empty() => ContextValue {
            value: Value::String(path),
            reason: Value::Null,
        },
        Ok(_) => ContextValue {
            value: Value::Null,
            reason: Value::String(
                "No current Finder path is available from the command-layer folder bridge."
                    .to_string(),
            ),
        },
        Err(error) => ContextValue {
            value: Value::Null,
            reason: Value::String(format!("Unable to read the current Finder path: {}", error)),
        },
    }
}

fn run_osascript(args: &[&str]) -> Result<String, String> {
    let output = Command::new("osascript")
        .args(args)
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("osascript exited with {}", output.status)
        } else {
            stderr
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod context_tests {
    use super::*;

    #[test]
    fn finder_context_matches_command_layer_folder_bridge() {
        let expected = crate::commands::read_current_folder_path();
        let actual = read_finder_path();

        match expected {
            Ok(Some(path)) => {
                assert_eq!(actual.value, Value::String(path));
                assert!(actual.reason.is_null());
            }
            Ok(None) => {
                assert!(actual.value.is_null());
                let reason = actual.reason.as_str().unwrap();
                assert!(reason.len() > 10);
                assert!(!reason.contains("not implemented"));
            }
            Err(error) => {
                assert!(actual.value.is_null());
                let reason = actual.reason.as_str().unwrap();
                assert!(reason.contains("Unable to read the current Finder path"));
                assert!(reason.contains(&error));
            }
        }
    }
}

fn image_mime_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("heic") => "image/heic",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        _ => "application/octet-stream",
    }
}

fn tool(
    name: &str,
    description: &str,
    input_schema: Value,
    output_schema: Value,
    scopes: Vec<PermissionScope>,
) -> ToolDefinition {
    ToolDefinition {
        name: name.to_string(),
        description: description.to_string(),
        input_schema,
        output_schema: Some(output_schema),
        scopes,
        enabled_by_default: true,
        enabled: true,
        source: "builtin".to_string(),
        plugin_id: None,
    }
}

fn search_clipboard_tool() -> ToolDefinition {
    tool(
        "search_clipboard",
        "Search local clipboard history without uploading it. The current clipboard text is captured locally before searching.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 }
            }
        }),
        json!({ "type": "object", "properties": { "items": { "type": "array" }, "total": { "type": "integer" } } }),
        vec![PermissionScope::ClipboardRead],
    )
}

fn ask_ai_model_tool() -> ToolDefinition {
    tool(
        "ask_ai_model",
        "Send a prompt to the AI model configured in ATools settings. Requires the AI provider to be enabled for Agent use.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "prompt": { "type": "string" },
                "system": { "type": "string" },
                "max_tokens": { "type": "integer", "minimum": 1, "maximum": 32768 }
            },
            "required": ["prompt"]
        }),
        json!({
            "type": "object",
            "properties": {
                "status": { "type": "string" },
                "provider": { "type": "string" },
                "model": { "type": "string" },
                "text": { "type": "string" },
                "finish_reason": { "type": ["string", "null"] },
                "usage": { "type": ["object", "null"] },
                "duration_ms": { "type": "integer" }
            }
        }),
        vec![PermissionScope::Network],
    )
}

fn find_local_files_tool() -> ToolDefinition {
    tool(
        "find_local_files",
        "Find local files by filename under a root directory.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "root": { "type": "string" },
                "query": { "type": "string" },
                "limit": { "type": "integer", "minimum": 1, "maximum": 500 },
                "max_depth": { "type": "integer", "minimum": 0, "maximum": 100 },
                "ignore_dirs": { "type": "array", "items": { "type": "string" } },
                "ignore_patterns": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Optional filename or relative-path wildcard patterns to skip, such as *.tmp or generated/**."
                }
            }
        }),
        json!({
            "type": "object",
            "properties": {
                "items": { "type": "array" },
                "skipped_permission_errors": { "type": "integer" }
            }
        }),
        vec![PermissionScope::FileRead],
    )
}

fn ocr_image_tool() -> ToolDefinition {
    tool(
        "ocr_image",
        "Run OCR on a local image through the local OCR endpoint.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "path": { "type": "string" },
                "endpoint": { "type": "string" }
            },
            "required": ["path"]
        }),
        json!({ "type": "object", "properties": { "text": { "type": "string" } } }),
        vec![PermissionScope::FileRead],
    )
}

fn compress_images_tool() -> ToolDefinition {
    tool(
        "compress_images",
        "Create compressed local image copies.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "paths": { "type": "array", "items": { "type": "string" } },
                "output_dir": { "type": "string" },
                "max_width": { "type": "integer" },
                "max_bytes": { "type": "integer", "minimum": 1 },
                "format": { "type": "string", "enum": ["original", "webp"], "default": "original" }
            },
            "required": ["paths"]
        }),
        json!({
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "input": { "type": "string" },
                            "output": { "type": "string" },
                            "format": { "type": "string" },
                            "status": { "type": "string" },
                            "original_size": { "type": "integer" },
                            "output_size": { "type": "integer" },
                            "target_size": { "type": ["integer", "null"] },
                            "target_met": { "type": ["boolean", "null"] },
                            "target_reason": { "type": ["string", "null"] },
                            "compression_ratio": { "type": "number" }
                        }
                    }
                }
            }
        }),
        vec![PermissionScope::FileRead, PermissionScope::FileWrite],
    )
}

fn rename_files_tool() -> ToolDefinition {
    tool(
        "rename_files",
        "Plan or execute local file renames.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "dry_run": { "type": "boolean", "default": true },
                "operations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" }
                        },
                        "required": ["from", "to"]
                    }
                }
            },
            "required": ["operations"]
        }),
        json!({
            "type": "object",
            "properties": {
                "operations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "from": { "type": "string" },
                            "to": { "type": "string" },
                            "status": { "type": "string" },
                            "dry_run": { "type": "boolean" },
                            "from_exists": { "type": "boolean" },
                            "to_exists": { "type": "boolean" },
                            "parent_exists": { "type": "boolean" }
                        }
                    }
                }
            }
        }),
        vec![PermissionScope::FileWrite],
    )
}

fn open_or_reveal_path_tool() -> ToolDefinition {
    tool(
        "open_or_reveal_path",
        "Open or reveal a local path.",
        json!({
            "type": "object",
            "additionalProperties": false,
            "properties": {
                "path": { "type": "string" },
                "reveal": { "type": "boolean", "default": false }
            },
            "required": ["path"]
        }),
        json!({ "type": "object", "properties": { "ok": { "type": "boolean" } } }),
        vec![PermissionScope::Shell],
    )
}

fn get_current_context_tool() -> ToolDefinition {
    tool(
        "get_current_context",
        "Return local platform and common directory context.",
        json!({ "type": "object", "additionalProperties": false, "properties": {} }),
        json!({ "type": "object" }),
        vec![PermissionScope::BrowserContext],
    )
}
