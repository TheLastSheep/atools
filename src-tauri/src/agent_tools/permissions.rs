use super::*;
pub fn build_pending_agent_tool_request(
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
) -> Result<PendingAgentToolRequest, String> {
    build_pending_agent_tool_request_with_run(db, client_id, tool_name, arguments, None)
}

pub(super) fn build_pending_agent_tool_request_with_run(
    db: &Database,
    client_id: &str,
    tool_name: &str,
    arguments: Value,
    run_id: Option<String>,
) -> Result<PendingAgentToolRequest, String> {
    let Some(tool) = db.get_agent_tool(tool_name).map_err(|e| e.to_string())? else {
        return Err(format!("Unknown tool: {}", tool_name));
    };

    Ok(PendingAgentToolRequest {
        id: format!("agent-confirm-{}", atools_core::utils::generate_rev()),
        run_id,
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
    if crate::plugin_background_runtime::registry::access_for(&tool)
        .is_ok_and(|(_, access)| access == crate::plugin_background_runtime::registry::Access::Stop)
    {
        // Stop is exact-owner cleanup. Its empty scope and native owner checks
        // keep cleanup available even when background execution is denied.
        return Ok(PermissionDecision::Allow);
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

pub(super) fn tool_has_denied_scope(
    db: &Database,
    scopes: &[PermissionScope],
) -> Result<bool, String> {
    let policy = persisted_scope_policy(db)?;
    Ok(scopes.iter().any(|scope| {
        policy
            .get(permission_scope_id(*scope))
            .is_some_and(|decision| decision == "deny")
    }))
}

pub(super) fn persisted_scope_policy(db: &Database) -> Result<BTreeMap<String, String>, String> {
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

pub(super) fn normalize_scope_id(scope: &str) -> Result<&'static str, String> {
    all_permission_scopes()
        .into_iter()
        .map(permission_scope_id)
        .find(|scope_id| *scope_id == scope)
        .ok_or_else(|| format!("Unsupported permission scope: {}", scope))
}

pub(super) fn all_permission_scopes() -> Vec<PermissionScope> {
    vec![
        PermissionScope::ClipboardRead,
        PermissionScope::ClipboardWrite,
        PermissionScope::InputKeyboard,
        PermissionScope::ClipboardDelete,
        PermissionScope::FileRead,
        PermissionScope::FileWrite,
        PermissionScope::Network,
        PermissionScope::Shell,
        PermissionScope::Screenshot,
        PermissionScope::DisplayRead,
        PermissionScope::BrowserContext,
        PermissionScope::PluginData,
        PermissionScope::SecretStorage,
        PermissionScope::SystemSettings,
        PermissionScope::PluginWindow,
        PermissionScope::PluginBackground,
    ]
}

pub(super) fn permission_scope_id(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::ClipboardRead => "clipboard_read",
        PermissionScope::ClipboardWrite => "clipboard_write",
        PermissionScope::InputKeyboard => "input_keyboard",
        PermissionScope::ClipboardDelete => "clipboard_delete",
        PermissionScope::FileRead => "file_read",
        PermissionScope::FileWrite => "file_write",
        PermissionScope::Network => "network",
        PermissionScope::Shell => "shell",
        PermissionScope::Screenshot => "screenshot",
        PermissionScope::DisplayRead => "display_read",
        PermissionScope::BrowserContext => "browser_context",
        PermissionScope::PluginData => "plugin_data",
        PermissionScope::SecretStorage => "secret_storage",
        PermissionScope::SystemSettings => "system_settings",
        PermissionScope::PluginWindow => "plugin_window",
        PermissionScope::PluginBackground => "plugin_background",
    }
}

pub(super) fn permission_scope_label(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::ClipboardRead => "读取剪贴板",
        PermissionScope::ClipboardWrite => "写入剪贴板",
        PermissionScope::InputKeyboard => "向前台应用发送键盘输入",
        PermissionScope::ClipboardDelete => "删除剪贴板历史",
        PermissionScope::FileRead => "读取文件",
        PermissionScope::FileWrite => "修改文件",
        PermissionScope::Network => "网络访问",
        PermissionScope::Shell => "执行命令",
        PermissionScope::Screenshot => "截图/OCR",
        PermissionScope::DisplayRead => "读取显示器信息",
        PermissionScope::BrowserContext => "浏览器上下文",
        PermissionScope::PluginData => "插件数据",
        PermissionScope::SecretStorage => "插件安全存储",
        PermissionScope::SystemSettings => "系统设置",
        PermissionScope::PluginWindow => "管理当前插件自己的独立窗口",
        PermissionScope::PluginBackground => "允许插件在后台持续运行",
    }
}

pub(super) fn permission_scope_description(scope: PermissionScope) -> &'static str {
    match scope {
        PermissionScope::ClipboardRead => "允许 Agent 读取本机剪贴板或剪贴板历史。",
        PermissionScope::ClipboardWrite => "允许 Agent 写入剪贴板。",
        PermissionScope::InputKeyboard => "允许 Agent 向已确认的前台应用发送一次键盘输入。",
        PermissionScope::ClipboardDelete => "允许删除本机剪贴板文本历史记录。",
        PermissionScope::FileRead => "允许 Agent 读取本地文件和目录元数据。",
        PermissionScope::FileWrite => "允许 Agent 修改、重命名或生成本地文件。",
        PermissionScope::Network => "允许 Agent 访问本机或外部网络服务。",
        PermissionScope::Shell => "允许 Agent 打开路径、调用系统命令或触发 shell 类能力。",
        PermissionScope::Screenshot => "允许 Agent 读取屏幕内容或发起 OCR。",
        PermissionScope::DisplayRead => {
            "允许读取显示器布局、缩放比例和当前光标位置，不读取屏幕内容。"
        }
        PermissionScope::BrowserContext => "允许 Agent 读取当前浏览器或 Finder 上下文。",
        PermissionScope::PluginData => "允许 Agent 访问插件本地数据。",
        PermissionScope::SecretStorage => "允许此插件使用独立的系统安全存储加密和解密其凭据。",
        PermissionScope::SystemSettings => "允许 Agent 修改系统级或应用级设置。",
        PermissionScope::PluginWindow => "允许此插件创建、管理和关闭当前插件自己的独立窗口。",
        PermissionScope::PluginBackground => "允许此插件在后台持续运行，直到你停止、禁用或卸载它。",
    }
}

pub(super) fn permission_scope_is_high_risk(scope: PermissionScope) -> bool {
    matches!(
        scope,
        PermissionScope::FileWrite
            | PermissionScope::InputKeyboard
            | PermissionScope::ClipboardDelete
            | PermissionScope::Network
            | PermissionScope::Shell
            | PermissionScope::Screenshot
            | PermissionScope::SystemSettings
            | PermissionScope::SecretStorage
            | PermissionScope::PluginBackground
    )
}
