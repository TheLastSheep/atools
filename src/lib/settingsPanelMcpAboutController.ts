import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { loadCommandAliases } from "./commandAliases";
import { loadCommandHistory } from "./commandHistory";
import { diagnosticBundleText } from "./debugDiagnostics";
import { loadLocalLaunchEntries } from "./localLaunch";
import {
  mcpClientConfig as buildMcpClientConfig,
  mcpClientConfigText,
  mcpClientInstallPlan,
  mcpClientInstallResultText,
  mcpClientSuggestedTargetPath,
  mcpClientTemplateText,
  mcpClientTemplates,
  mcpConnectionView,
  type McpClientConfigInstallResult,
  type McpClientTemplate,
} from "./mcpClientConfig";
import {
  mcpAuditRows,
  mcpGovernanceOverview,
  mcpGrantRows,
  mcpPendingRequestRows,
  mcpScopePolicyRows,
  permissionModeLabel,
} from "./settingsPages";
import { copyText, hasTauriRuntime, safeHomePath } from "./settingsPanelTypesAndOptions";
import type { SettingsPanelState } from "./settingsPanelState.svelte";
import type {
  AgentScopePolicy,
  AgentToolGrant,
  AuditLogEntry,
  CrashLogEntry,
  McpServerStatus,
  PendingAgentToolRequest,
  RuntimeDiagnostics,
  ToolDefinition,
} from "./types";
import { loadWebQuickOpenEntries } from "./webQuickOpen";

export function createSettingsMcpAboutController(
  s: SettingsPanelState,
  deps: {
    aboutRuntimeInfoText: () => string;
    currentDiagnosticBundle: () => ReturnType<typeof import("./debugDiagnostics").buildDiagnosticBundle>;
  },
) {
  const { aboutRuntimeInfoText, currentDiagnosticBundle } = deps;

  async function refreshMcpPage() {
    s.mcpLoading = true;
    s.mcpPageStatus = "";
    if (!hasTauriRuntime()) {
      s.mcpStatus = null;
      s.agentTools = [];
      s.agentScopePolicies = [];
      s.pendingAgentRequests = [];
      s.agentToolGrants = [];
      s.mcpRecentAudits = [];
      s.mcpPermissionMode = "conservative";
      s.mcpPageStatus = "Tauri 运行时未连接，MCP 状态需在桌面应用中查看";
      s.mcpLoading = false;
      return;
    }
    try {
      const [status, tools, mode, policies, pendingRequests, grants, audits] = await Promise.all([
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<ToolDefinition[]>("list_agent_tools"),
        invoke<string>("get_permission_mode"),
        invoke<AgentScopePolicy[]>("list_agent_scope_policies"),
        invoke<PendingAgentToolRequest[]>("list_pending_agent_requests"),
        invoke<AgentToolGrant[]>("list_agent_tool_grants"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 8 }),
      ]);
      s.mcpStatus = status;
      s.agentTools = tools;
      s.mcpPermissionMode = mode;
      s.agentScopePolicies = policies;
      s.pendingAgentRequests = pendingRequests;
      s.agentToolGrants = grants;
      s.mcpRecentAudits = audits;
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      s.mcpLoading = false;
    }
  }

  async function toggleAgentTool(tool: ToolDefinition, enabled: boolean) {
    s.mcpPageStatus = `正在${enabled ? "启用" : "停用"} ${tool.name}`;
    try {
      await invoke("set_agent_tool_enabled", { name: tool.name, enabled });
      await refreshMcpPage();
      s.mcpPageStatus = `${tool.name} 已${enabled ? "启用" : "停用"}`;
    } catch (error) {
      s.mcpPageStatus = String(error);
    }
  }

  async function updateMcpPermissionMode(mode: string) {
    s.mcpPermissionMode = mode;
    if (!hasTauriRuntime()) {
      s.mcpPageStatus = "权限模式需在桌面应用中保存";
      return;
    }
    s.mcpPolicyBusyKey = "permission-mode";
    s.mcpPageStatus = `正在切换权限模式为 ${permissionModeLabel(mode)}`;
    try {
      await invoke("set_permission_mode", { mode });
      await refreshMcpPage();
      s.mcpPageStatus = `权限模式已切换为 ${permissionModeLabel(mode)}`;
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      s.mcpPolicyBusyKey = "";
    }
  }

  async function updateMcpScopePolicy(scope: string, decision: string) {
    if (!hasTauriRuntime()) {
      s.mcpPageStatus = "Scope 策略需在桌面应用中保存";
      return;
    }
    s.mcpPolicyBusyKey = `scope:${scope}`;
    const label = mcpScopePolicyRows(s.agentScopePolicies).find((row) => row.scope === scope)?.label ?? scope;
    try {
      s.agentScopePolicies = await invoke<AgentScopePolicy[]>("set_agent_scope_policy", { scope, decision });
      s.mcpPageStatus = `${label} 已设置为${decision === "deny" ? "阻断" : "确认"}`;
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      s.mcpPolicyBusyKey = "";
    }
  }

  async function approveMcpRequestOnce(request: PendingAgentToolRequest) {
    if (!hasTauriRuntime()) {
      s.mcpPageStatus = "待确认请求需在桌面应用中处理";
      return;
    }
    s.mcpRequestBusyKey = `pending:${request.id}`;
    try {
      await invoke("call_agent_tool", {
        name: request.tool_name,
        arguments: request.arguments,
        clientId: request.client_id,
        confirmed: true,
        runId: request.run_id,
      });
      s.mcpPageStatus = `${request.tool_name} 已允许一次`;
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      await invoke("dismiss_pending_agent_request", { requestId: request.id }).catch(() => {});
      await refreshMcpPage();
      s.mcpRequestBusyKey = "";
    }
  }

  async function approveAndRememberMcpRequest(request: PendingAgentToolRequest) {
    if (!hasTauriRuntime()) {
      s.mcpPageStatus = "待确认请求需在桌面应用中处理";
      return;
    }
    s.mcpRequestBusyKey = `pending:${request.id}`;
    try {
      await invoke("grant_agent_tool", {
        clientId: request.client_id,
        toolName: request.tool_name,
      });
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      s.mcpPageStatus = `${request.client_id} 已持久授权 ${request.tool_name}`;
      await refreshMcpPage();
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      s.mcpRequestBusyKey = "";
    }
  }

  async function dismissMcpRequest(request: PendingAgentToolRequest) {
    if (!hasTauriRuntime()) {
      s.mcpPageStatus = "待确认请求需在桌面应用中处理";
      return;
    }
    s.mcpRequestBusyKey = `pending:${request.id}`;
    try {
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      s.mcpPageStatus = `${request.tool_name} 请求已拒绝`;
      await refreshMcpPage();
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      s.mcpRequestBusyKey = "";
    }
  }

  async function revokeMcpGrant(grant: AgentToolGrant) {
    if (!hasTauriRuntime()) {
      s.mcpPageStatus = "持久授权需在桌面应用中处理";
      return;
    }
    s.mcpRequestBusyKey = `grant:${grant.client_id}:${grant.tool_name}`;
    try {
      await invoke("revoke_agent_tool", {
        clientId: grant.client_id,
        toolName: grant.tool_name,
      });
      s.mcpPageStatus = `${grant.client_id} 的 ${grant.tool_name} 授权已撤销`;
      await refreshMcpPage();
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      s.mcpRequestBusyKey = "";
    }
  }

  async function copyMcpConfig() {
    const config = buildMcpClientConfig({ status: s.mcpStatus });
    await copyText(mcpClientConfigText(config));
    s.mcpPageStatus = "已复制 MCP 客户端配置";
  }

  async function copyMcpTemplate(template: McpClientTemplate) {
    await copyText(mcpClientTemplateText(template));
    s.mcpPageStatus = `已复制 ${template.label} 配置`;
  }

  async function installMcpTemplate(template: McpClientTemplate) {
    if (!hasTauriRuntime()) {
      s.mcpPageStatus = "需在桌面应用中选择并合并配置文件";
      return;
    }
    const homePath = s.mcpInstallHomePath || await safeHomePath();
    s.mcpInstallHomePath = homePath;
    const defaultPath = mcpClientSuggestedTargetPath(template, { homePath });
    const targetPath = await saveDialog({
      title: "选择或新建 MCP 配置 JSON",
      defaultPath,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!targetPath) {
      s.mcpPageStatus = "已取消合并";
      return;
    }

    s.mcpRequestBusyKey = `mcp:install:${template.id}`;
    try {
      const result = await invoke<McpClientConfigInstallResult>("install_mcp_client_config", {
        targetPath,
        config: template.config,
        serverName: "atools",
        confirmed: true,
      });
      s.mcpPageStatus = mcpClientInstallResultText(template, result);
    } catch (error) {
      s.mcpPageStatus = String(error);
    } finally {
      s.mcpRequestBusyKey = "";
    }
  }

  async function copyHttpMcpUrl() {
    const connection = mcpConnection();
    if (!connection.tokenAvailable) {
      s.mcpPageStatus = "HTTP MCP 未就绪，无法复制地址";
      return;
    }
    await copyText(connection.httpUrl);
    s.mcpPageStatus = "已复制 MCP 地址";
  }

  async function copyHttpMcpConfig() {
    const config = buildMcpClientConfig({ status: s.mcpStatus ?? s.debugMcpStatus });
    await copyText(mcpClientConfigText(config));
    s.mcpPageStatus = "已复制 MCP 配置";
  }

  async function refreshAboutPage() {
    s.aboutLoading = true;
    s.aboutPageStatus = "";
    s.commandHistory = loadCommandHistory();
    s.localLaunchEntries = loadLocalLaunchEntries();
    s.webQuickOpenEntries = loadWebQuickOpenEntries();
    s.commandAliases = loadCommandAliases();
    if (!hasTauriRuntime()) {
      s.mcpStatus = null;
      s.debugMcpStatus = null;
      s.agentTools = [];
      s.runtimeDiagnostics = null;
      s.debugAudits = [];
      s.recentAuditErrors = [];
      s.crashLogs = [];
      s.aboutPageStatus = "浏览器预览模式，桌面路径和运行事件需在 macOS 应用中查看";
      s.aboutLoading = false;
      return;
    }
    try {
      const [status, tools, runtime, audits, crashes] = await Promise.all([
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<ToolDefinition[]>("list_agent_tools"),
        invoke<RuntimeDiagnostics>("get_runtime_diagnostics"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 30 }),
        invoke<CrashLogEntry[]>("list_crash_logs", { limit: 20 }),
      ]);
      s.mcpStatus = status;
      s.debugMcpStatus = status;
      s.agentTools = tools;
      s.runtimeDiagnostics = runtime;
      s.debugAudits = audits;
      s.recentAuditErrors = audits.filter((audit) => audit.error || audit.status !== "success").slice(0, 5);
      s.crashLogs = crashes;
      s.aboutPageStatus = "运行信息已刷新";
    } catch (error) {
      s.aboutPageStatus = String(error);
    } finally {
      s.aboutLoading = false;
    }
  }

  async function copyAboutRuntimeInfo() {
    await copyText(aboutRuntimeInfoText());
    s.aboutPageStatus = "已复制运行信息";
  }

  async function copyAboutDiagnosticBundle() {
    await copyText(diagnosticBundleText(currentDiagnosticBundle()));
    s.aboutPageStatus = "已复制脱敏诊断包";
  }

  function mcpTemplates() {
    return mcpClientTemplates({ status: s.mcpStatus });
  }

  function mcpInstallPlan(template: McpClientTemplate) {
    return mcpClientInstallPlan(template, { homePath: s.mcpInstallHomePath });
  }

  async function loadMcpInstallHomePath() {
    if (!hasTauriRuntime()) return;
    s.mcpInstallHomePath = await safeHomePath();
  }

  function mcpConnection() {
    return mcpConnectionView(s.mcpStatus);
  }

  function mcpGovernance() {
    return mcpGovernanceOverview({
      tools: s.agentTools,
      scopePolicies: s.agentScopePolicies,
      pendingRequestCount: s.pendingAgentRequests.length,
      permissionMode: s.mcpPermissionMode,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function mcpScopeRows() {
    return mcpScopePolicyRows(s.agentScopePolicies);
  }

  function mcpPendingRows() {
    return mcpPendingRequestRows(s.pendingAgentRequests);
  }

  function mcpGrantListRows() {
    return mcpGrantRows(s.agentToolGrants);
  }

  function mcpAuditListRows() {
    return mcpAuditRows(s.mcpRecentAudits);
  }

  function mcpHttpUrl() {
    return mcpConnection().httpUrl;
  }

  return {
    refreshMcpPage,
    toggleAgentTool,
    updateMcpPermissionMode,
    updateMcpScopePolicy,
    approveMcpRequestOnce,
    approveAndRememberMcpRequest,
    dismissMcpRequest,
    revokeMcpGrant,
    copyMcpConfig,
    copyMcpTemplate,
    installMcpTemplate,
    copyHttpMcpUrl,
    copyHttpMcpConfig,
    refreshAboutPage,
    copyAboutRuntimeInfo,
    copyAboutDiagnosticBundle,
    mcpTemplates,
    mcpInstallPlan,
    loadMcpInstallHomePath,
    mcpConnection,
    mcpGovernance,
    mcpScopeRows,
    mcpPendingRows,
    mcpGrantListRows,
    mcpAuditListRows,
    mcpHttpUrl,
  };
}
