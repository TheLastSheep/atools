<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import type {
    AgentScopePolicy,
    AgentToolGrant,
    AuditLogEntry,
    AuditLogPage,
    Capability,
    McpServerStatus,
    MemoryItem,
    PendingAgentToolRequest,
    SkillDefinition,
    TaskRun,
    ToolDefinition,
  } from "../lib/types";
  import {
    loadAuditFilterViews,
    type SavedAuditFilterView,
  } from "../lib/auditFilterViews";
  import {
    buildAuditBackendQuery,
    copyText,
    hasActiveAuditFilters,
    hasTauriRuntime,
    safeHomePath,
  } from "../lib/agentPanelHelpers";
  import AgentMcpPermissionSection from "./AgentMcpPermissionSection.svelte";
  import AgentCapabilitySkillMemorySection from "./AgentCapabilitySkillMemorySection.svelte";
  import AgentResultCenterSection from "./AgentResultCenterSection.svelte";
  import AgentAuditReplaySection from "./AgentAuditReplaySection.svelte";
  import "./AgentPanel.css";
  import "./AgentPanelTaskRun.css";
  import "./AgentPanelAudit.css";

  type Props = {
    onclose: () => void;
    view?: "all" | "results";
  };

  let { onclose, view = "all" }: Props = $props();
  let tools: ToolDefinition[] = $state([]);
  let capabilities: Capability[] = $state([]);
  let audits: AuditLogEntry[] = $state([]);
  let grants: AgentToolGrant[] = $state([]);
  let scopePolicies: AgentScopePolicy[] = $state([]);
  let pendingRequests: PendingAgentToolRequest[] = $state([]);
  let taskRuns: TaskRun[] = $state([]);
  let memories: MemoryItem[] = $state([]);
  let skills: SkillDefinition[] = $state([]);
  let status: McpServerStatus | null = $state(null);
  let permissionMode = $state("conservative");
  let error = $state("");
  let busyKey = $state("");
  let selectedAuditId = $state("");
  let selectedTaskRunId = $state("");
  let auditQuery = $state("");
  let auditStatusFilter = $state("all");
  let auditToolFilter = $state("all");
  let auditClientFilter = $state("all");
  let exportStatus = $state("");
  let mcpInstallHomePath = $state("");
  let auditTotal = $state(0);
  let auditFilterReloadReady = false;
  let savedAuditFilterViews: SavedAuditFilterView[] = $state([]);
  const auditPageLimit = 50;

  let auditFilterKey = $derived([
    auditQuery.trim(),
    auditStatusFilter,
    auditToolFilter,
    auditClientFilter,
  ].join("\u001f"));

  $effect(() => {
    auditFilterKey;
    if (!auditFilterReloadReady) {
      auditFilterReloadReady = true;
      return;
    }
    void reloadAuditsForFilters();
  });

  onMount(() => {
    savedAuditFilterViews = loadAuditFilterViews();
    refresh();
    loadMcpInstallHomePath();
    let unlisten: (() => void) | undefined;
    let taskRunUnlisten: (() => void) | undefined;
    let cancelled = false;
    listen("agent-permission-request", () => refresh())
      .then((stop) => {
        if (cancelled) {
          stop();
        } else {
          unlisten = stop;
        }
      })
      .catch(() => {});
    listen("task-run-updated", () => refresh())
      .then((stop) => {
        if (cancelled) {
          stop();
        } else {
          taskRunUnlisten = stop;
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
      taskRunUnlisten?.();
    };
  });

  function auditBackendQuery(limit: number, offset = 0) {
    return buildAuditBackendQuery(
      { auditQuery, auditStatusFilter, auditToolFilter, auditClientFilter },
      limit,
      offset,
    );
  }

  async function refresh() {
    try {
      const [
        toolList,
        capabilityList,
        auditPage,
        mcpStatus,
        mode,
        grantList,
        scopePolicyList,
        pendingList,
        runList,
        memoryList,
        skillList,
      ] = await Promise.all([
        invoke<ToolDefinition[]>("list_agent_tools"),
        invoke<Capability[]>("list_capabilities"),
        invoke<AuditLogPage>("query_audit_entries_page", { query: auditBackendQuery(auditPageLimit, 0) }),
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<string>("get_permission_mode"),
        invoke<AgentToolGrant[]>("list_agent_tool_grants"),
        invoke<AgentScopePolicy[]>("list_agent_scope_policies"),
        invoke<PendingAgentToolRequest[]>("list_pending_agent_requests"),
        invoke<TaskRun[]>("list_task_runs", { limit: 100 }),
        invoke<MemoryItem[]>("list_memory_items", { includeDisabled: true, limit: 500 }),
        invoke<SkillDefinition[]>("list_skills", { includeDisabled: true, limit: 500 }),
      ]);
      tools = toolList;
      capabilities = capabilityList;
      applyAuditPage(auditPage);
      status = mcpStatus;
      permissionMode = mode;
      grants = grantList;
      scopePolicies = scopePolicyList;
      pendingRequests = pendingList;
      taskRuns = runList;
      memories = memoryList;
      skills = skillList;
      if (selectedTaskRunId && !runList.some((run) => run.id === selectedTaskRunId)) {
        selectedTaskRunId = "";
      }
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  async function loadMcpInstallHomePath() {
    if (!hasTauriRuntime()) return;
    mcpInstallHomePath = await safeHomePath();
  }

  async function updateMode(mode: string) {
    permissionMode = mode;
    await invoke("set_permission_mode", { mode });
  }

  async function updateScopePolicy(scope: string, decision: string) {
    busyKey = `scope:${scope}`;
    try {
      scopePolicies = await invoke<AgentScopePolicy[]>("set_agent_scope_policy", { scope, decision });
    } catch (e) {
      error = String(e);
    } finally {
      busyKey = "";
    }
  }

  async function toggleTool(name: string, enabled: boolean) {
    busyKey = `tool:${name}`;
    try {
      await invoke("set_agent_tool_enabled", { name, enabled });
      await refresh();
    } finally {
      busyKey = "";
    }
  }

  async function approveOnceRequest(request: PendingAgentToolRequest) {
    busyKey = `pending:${request.id}`;
    try {
      await invoke("call_agent_tool", {
        name: request.tool_name,
        arguments: request.arguments,
        clientId: request.client_id,
        confirmed: true,
        runId: request.run_id,
      });
    } catch (e) {
      error = String(e);
    } finally {
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      await refresh();
      busyKey = "";
    }
  }

  async function approveRequest(request: PendingAgentToolRequest) {
    busyKey = `pending:${request.id}`;
    try {
      await invoke("grant_agent_tool", {
        clientId: request.client_id,
        toolName: request.tool_name,
        requestId: request.id,
      });
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      await refresh();
    } finally {
      busyKey = "";
    }
  }

  async function dismissRequest(requestId: string) {
    busyKey = `pending:${requestId}`;
    try {
      await invoke("dismiss_pending_agent_request", { requestId });
      await refresh();
    } finally {
      busyKey = "";
    }
  }

  async function revokeGrant(clientId: string, toolName: string) {
    busyKey = `grant:${clientId}:${toolName}`;
    try {
      await invoke("revoke_agent_tool", { clientId, toolName });
      await refresh();
    } finally {
      busyKey = "";
    }
  }

  async function clearAudits() {
    busyKey = "audit:clear";
    try {
      const count = await invoke<number>("clear_audit_entries");
      audits = [];
      auditTotal = 0;
      selectedAuditId = "";
      exportStatus = `已清空 ${count} 条审计记录`;
    } catch (e) {
      error = String(e);
    } finally {
      busyKey = "";
    }
  }

  async function exportAudits() {
    busyKey = "audit:export";
    try {
      const jsonl = await invoke<string>("export_audit_entries_jsonl_filtered", { query: auditBackendQuery(1000) });
      await copyText(jsonl);
      const count = jsonl.split("\n").filter(Boolean).length;
      const active = hasActiveAuditFilters({ auditQuery, auditStatusFilter, auditToolFilter, auditClientFilter });
      exportStatus = `已复制 ${count} 条 JSONL${active ? "（当前筛选）" : ""}`;
    } finally {
      busyKey = "";
    }
  }

  async function loadMoreAudits() {
    busyKey = "audit:load-more";
    try {
      applyAuditPage(await queryAuditPage(audits.length), true);
    } catch (e) {
      error = String(e);
    } finally {
      busyKey = "";
    }
  }

  async function reloadAuditsForFilters() {
    busyKey = "audit:filter";
    try {
      selectedAuditId = "";
      applyAuditPage(await queryAuditPage(0));
    } catch (e) {
      error = String(e);
    } finally {
      busyKey = "";
    }
  }

  async function queryAuditPage(offset = 0) {
    return invoke<AuditLogPage>("query_audit_entries_page", {
      query: auditBackendQuery(auditPageLimit, offset),
    });
  }

  function applyAuditPage(page: AuditLogPage, append = false) {
    const nextAudits = append ? [...audits, ...page.entries] : page.entries;
    audits = nextAudits;
    auditTotal = page.total;
    if (selectedAuditId && !nextAudits.some((audit) => audit.id === selectedAuditId)) {
      selectedAuditId = "";
    }
  }
</script>

<section class="agent-panel" class:results-only={view === "results"}>
  <header class="agent-header">
    <div>
      <h2>{view === "results" ? "结果中心" : "Agent"}</h2>
      <p>{view === "results" ? "TaskRun 任务历史、验收状态与结构化产物" : "MCP、权限与审计"}</p>
    </div>
    <button class="icon-button" onclick={onclose} title="关闭">×</button>
  </header>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <AgentMcpPermissionSection
    {status}
    {permissionMode}
    {scopePolicies}
    {pendingRequests}
    {tools}
    {grants}
    {busyKey}
    {mcpInstallHomePath}
    onrefresh={refresh}
    onupdatepermissionmode={updateMode}
    onupdatescopepolicy={updateScopePolicy}
    onapproveonce={approveOnceRequest}
    onapprove={approveRequest}
    ondismiss={dismissRequest}
    ontoggletool={toggleTool}
    onrevokegrant={revokeGrant}
    onsetbusykey={(key) => busyKey = key}
    onsethomepath={(path) => mcpInstallHomePath = path}
  />

  <AgentCapabilitySkillMemorySection
    {capabilities}
    {skills}
    {memories}
    {busyKey}
    onrefresh={refresh}
    onsetbusykey={(key) => busyKey = key}
  />

  <AgentResultCenterSection
    {taskRuns}
    {memories}
    {selectedTaskRunId}
    {busyKey}
    onrefresh={refresh}
    onselecttaskrun={(id) => selectedTaskRunId = id}
    onsetbusykey={(key) => busyKey = key}
  />

  <AgentAuditReplaySection
    {audits}
    {auditTotal}
    bind:auditQuery
    bind:auditStatusFilter
    bind:auditToolFilter
    bind:auditClientFilter
    {selectedAuditId}
    {savedAuditFilterViews}
    {exportStatus}
    {busyKey}
    {reloadAuditsForFilters}
    {exportAudits}
    {clearAudits}
    {loadMoreAudits}
    onselectaudit={(id) => selectedAuditId = id}
    onupdatesavedviews={(views) => savedAuditFilterViews = views}
    onsetexportstatus={(s) => exportStatus = s}
    onsetbusykey={(key) => busyKey = key}
  />
</section>
