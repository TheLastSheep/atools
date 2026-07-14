<script lang="ts">
  import { onMount } from "svelte";
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { save as saveDialog } from "@tauri-apps/plugin-dialog";
  import type {
    AgentToolGrant,
    AgentScopePolicy,
    AuditLogEntry,
    AuditLogPage,
    AuditLogQuery,
    McpServerStatus,
    MemoryItem,
    PendingAgentToolRequest,
    TaskRun,
    TaskRunArtifact,
    ToolDefinition
  } from "../lib/types";
  import {
    auditDetailValue,
    auditFilterOptions,
    auditFilterSummary,
    auditDurationLabel,
    auditPathSummaries,
    auditPreview,
    auditReplaySummary,
    auditSideEffectDiff,
    auditStatusMeta,
    auditSummaryRows,
    filterAuditEntries,
  } from "../lib/auditView";
  import {
    auditFilterViewLabel,
    loadAuditFilterViews,
    removeAuditFilterView,
    saveAuditFilterViews,
    upsertAuditFilterView,
    type SavedAuditFilterView,
  } from "../lib/auditFilterViews";
  import {
    mcpClientConfigText,
    mcpConnectionView,
    mcpClientInstallPlan,
    mcpClientInstallResultText,
    mcpClientSuggestedTargetPath,
    mcpClientTemplateText,
    mcpClientTemplates,
    mcpHttpClientConfig,
    mcpHttpUrl,
    mcpStdioClientConfig,
    type McpClientConfigInstallResult,
    type McpClientTemplate,
  } from "../lib/mcpClientConfig";
  import {
    artifactDiffLines,
    artifactJson,
    artifactLocation,
    artifactMarkdownBlocks,
    artifactPayload,
    artifactPreviewSource,
    artifactRenderKind,
    artifactTable,
  } from "../lib/artifactView";
  import { hasTauriAssetRuntime } from "../lib/resultIcons";

  type Props = {
    onclose: () => void;
  };

  let { onclose }: Props = $props();
  let tools: ToolDefinition[] = $state([]);
  let audits: AuditLogEntry[] = $state([]);
  let grants: AgentToolGrant[] = $state([]);
  let scopePolicies: AgentScopePolicy[] = $state([]);
  let pendingRequests: PendingAgentToolRequest[] = $state([]);
  let taskRuns: TaskRun[] = $state([]);
  let memories: MemoryItem[] = $state([]);
  let status: McpServerStatus | null = $state(null);
  let permissionMode = $state("conservative");
  let error = $state("");
  let busyKey = $state("");
  let selectedAuditId = $state("");
  let selectedTaskRunId = $state("");
  let taskRunStatus = $state("");
  let memoryStatus = $state("");
  let editingMemoryId = $state("");
  let memoryType = $state<MemoryItem["type"]>("preference");
  let memoryApproval = $state<MemoryItem["approval"]>("explicit");
  let memoryTool = $state("");
  let memoryWorkspace = $state("");
  let memoryContent = $state('{"arguments":{}}');
  let memoryConfidence = $state("1");
  let memoryExpiresAt = $state("");
  let auditQuery = $state("");
  let auditStatusFilter = $state("all");
  let auditToolFilter = $state("all");
  let auditClientFilter = $state("all");
  let exportStatus = $state("");
  let mcpCopyStatus = $state("");
  let mcpInstallHomePath = $state("");
  let auditTotal = $state(0);
  let auditFilterReloadReady = false;
  let savedAuditFilterViews: SavedAuditFilterView[] = $state([]);
  let selectedAuditFilterViewId = $state("");
  let auditFilterViewName = $state("");
  let auditFilterViewStatus = $state("");
  const auditPageLimit = 50;
  let auditOptions = $derived(auditFilterOptions(audits));
  let auditToolFilterOptions = $derived(filterSelectOptions(auditOptions.toolNames, auditToolFilter));
  let auditClientFilterOptions = $derived(filterSelectOptions(auditOptions.clientIds, auditClientFilter));
  let auditFilterKey = $derived([
    auditQuery.trim(),
    auditStatusFilter,
    auditToolFilter,
    auditClientFilter,
  ].join("\u001f"));
  let filteredAudits = $derived(filterAuditEntries(audits, {
    query: auditQuery,
    status: auditStatusFilter,
    toolName: auditToolFilter,
    clientId: auditClientFilter,
  }));
  let auditSummaryText = $derived(auditFilterSummary(audits, filteredAudits, {
    query: auditQuery,
    status: auditStatusFilter,
    toolName: auditToolFilter,
    clientId: auditClientFilter,
  }));
  let mcpView = $derived(mcpConnectionView(status));

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

    return () => {
      cancelled = true;
      unlisten?.();
    };
  });

  async function refresh() {
    try {
      const [toolList, auditPage, mcpStatus, mode, grantList, scopePolicyList, pendingList, runList, memoryList] = await Promise.all([
        invoke<ToolDefinition[]>("list_agent_tools"),
        invoke<AuditLogPage>("query_audit_entries_page", { query: auditBackendQuery(auditPageLimit, 0) }),
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<string>("get_permission_mode"),
        invoke<AgentToolGrant[]>("list_agent_tool_grants"),
        invoke<AgentScopePolicy[]>("list_agent_scope_policies"),
        invoke<PendingAgentToolRequest[]>("list_pending_agent_requests"),
        invoke<TaskRun[]>("list_task_runs", { limit: 100 }),
        invoke<MemoryItem[]>("list_memory_items", { includeDisabled: true, limit: 500 }),
      ]);
      tools = toolList;
      applyAuditPage(auditPage);
      status = mcpStatus;
      permissionMode = mode;
      grants = grantList;
      scopePolicies = scopePolicyList;
      pendingRequests = pendingList;
      taskRuns = runList;
      memories = memoryList;
      if (selectedTaskRunId && !runList.some((run) => run.id === selectedTaskRunId)) {
        selectedTaskRunId = "";
      }
      error = "";
    } catch (e) {
      error = String(e);
    }
  }

  function resetMemoryForm() {
    editingMemoryId = "";
    memoryType = "preference";
    memoryApproval = "explicit";
    memoryTool = "";
    memoryWorkspace = "";
    memoryContent = '{"arguments":{}}';
    memoryConfidence = "1";
    memoryExpiresAt = "";
  }

  function editMemory(item: MemoryItem) {
    editingMemoryId = item.id;
    memoryType = item.type;
    memoryApproval = item.approval;
    memoryTool = item.scope.tool ?? "";
    memoryWorkspace = item.scope.workspace ?? "";
    memoryContent = JSON.stringify(item.content, null, 2);
    memoryConfidence = String(item.confidence);
    memoryExpiresAt = item.expiresAt ? item.expiresAt.slice(0, 16) : "";
  }

  function memoryInput() {
    const confidence = Number(memoryConfidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new Error("置信度必须在 0 到 1 之间");
    }
    if (memoryApproval === "temporary" && !memoryExpiresAt) {
      throw new Error("临时记忆必须设置过期时间");
    }
    return {
      type: memoryType,
      scope: {
        ...(memoryWorkspace.trim() ? { workspace: memoryWorkspace.trim() } : {}),
        ...(memoryTool.trim() ? { tool: memoryTool.trim() } : {}),
      },
      content: JSON.parse(memoryContent),
      confidence,
      approval: memoryApproval,
      expiresAt: memoryExpiresAt ? new Date(memoryExpiresAt).toISOString() : null,
    };
  }

  async function saveMemory() {
    busyKey = "memory:save";
    try {
      const input = memoryInput();
      if (editingMemoryId) {
        await invoke<MemoryItem>("update_memory_item", { id: editingMemoryId, input });
        memoryStatus = "记忆已更新";
      } else {
        await invoke<MemoryItem>("create_memory_item", { input });
        memoryStatus = "记忆已保存；执行时仅作为缺省参数，不覆盖显式输入";
      }
      resetMemoryForm();
      await refresh();
    } catch (e) {
      memoryStatus = String(e);
    } finally {
      busyKey = "";
    }
  }

  async function toggleMemory(item: MemoryItem) {
    busyKey = `memory:toggle:${item.id}`;
    try {
      await invoke("set_memory_item_enabled", { id: item.id, enabled: !item.enabled });
      await refresh();
    } finally {
      busyKey = "";
    }
  }

  async function deleteMemory(item: MemoryItem) {
    busyKey = `memory:delete:${item.id}`;
    try {
      await invoke("delete_memory_item", { id: item.id });
      if (editingMemoryId === item.id) resetMemoryForm();
      memoryStatus = "记忆已删除";
      await refresh();
    } finally {
      busyKey = "";
    }
  }

  async function exportMemories() {
    busyKey = "memory:export";
    try {
      await copyText(await invoke<string>("export_memory_items_json"));
      memoryStatus = `已复制 ${memories.length} 条记忆 JSON`;
    } finally {
      busyKey = "";
    }
  }

  async function clearMemories() {
    busyKey = "memory:clear";
    try {
      const count = await invoke<number>("clear_memory_items");
      resetMemoryForm();
      memoryStatus = `已清空 ${count} 条记忆`;
      await refresh();
    } finally {
      busyKey = "";
    }
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
      exportStatus = `已复制 ${count} 条 JSONL${hasActiveAuditFilters() ? "（当前筛选）" : ""}`;
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

  async function copyAuditDetail(audit: AuditLogEntry) {
    busyKey = `audit:copy:${audit.id}`;
    try {
      await copyText(JSON.stringify(audit, null, 2));
      exportStatus = `已复制 ${audit.tool_name} 的审计详情`;
    } finally {
      busyKey = "";
    }
  }

  async function copyText(text: string) {
    try {
      await writeText(text);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  }

  async function copyHttpMcpConfig() {
    if (!status || !mcpHttpUrl(status)) {
      mcpCopyStatus = "MCP HTTP 服务未启动";
      return;
    }
    busyKey = "mcp:http";
    try {
      await copyText(mcpClientConfigText(mcpHttpClientConfig(status)));
      mcpCopyStatus = "已复制 HTTP MCP 配置";
    } finally {
      busyKey = "";
    }
  }

  async function copyStdioMcpConfig() {
    busyKey = "mcp:stdio";
    try {
      await copyText(mcpClientConfigText(mcpStdioClientConfig()));
      mcpCopyStatus = "已复制 stdio proxy 配置";
    } finally {
      busyKey = "";
    }
  }

  async function copyMcpTemplate(template: McpClientTemplate) {
    busyKey = `mcp:template:${template.id}`;
    try {
      await copyText(mcpClientTemplateText(template));
      mcpCopyStatus = `已复制 ${template.label} 配置`;
    } finally {
      busyKey = "";
    }
  }

  async function installMcpTemplate(template: McpClientTemplate) {
    if (!hasTauriRuntime()) {
      mcpCopyStatus = "需在桌面应用中选择并合并配置文件";
      return;
    }
    const homePath = mcpInstallHomePath || await safeHomePath();
    mcpInstallHomePath = homePath;
    const defaultPath = mcpClientSuggestedTargetPath(template, { homePath });
    const targetPath = await saveDialog({
      title: "选择或新建 MCP 配置 JSON",
      defaultPath,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!targetPath) {
      mcpCopyStatus = "已取消合并";
      return;
    }

    busyKey = `mcp:install:${template.id}`;
    try {
      const result = await invoke<McpClientConfigInstallResult>("install_mcp_client_config", {
        targetPath,
        config: template.config,
        serverName: "atools",
        confirmed: true,
      });
      mcpCopyStatus = mcpClientInstallResultText(template, result);
    } catch (e) {
      mcpCopyStatus = String(e);
    } finally {
      busyKey = "";
    }
  }

  function mcpTemplates() {
    return mcpClientTemplates({ status });
  }

  function hasTauriRuntime() {
    return "__TAURI_INTERNALS__" in window;
  }

  async function safeHomePath() {
    try {
      return await invoke<string>("system_get_path", { name: "home" });
    } catch {
      return "";
    }
  }

  async function loadMcpInstallHomePath() {
    if (!hasTauriRuntime()) return;
    mcpInstallHomePath = await safeHomePath();
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

  async function retryTaskRun(run: TaskRun) {
    busyKey = `run:retry:${run.id}`;
    taskRunStatus = `正在重试 ${run.capabilityId}`;
    try {
      await invoke("call_agent_tool", {
        name: run.capabilityId,
        arguments: run.input,
        clientId: run.initiator.clientId ?? "atools-ui",
        confirmed: false,
        runId: run.id,
      });
      taskRunStatus = `${run.capabilityId} 重试已完成`;
    } catch (e) {
      taskRunStatus = String(e);
    } finally {
      await refresh();
      busyKey = "";
    }
  }

  async function cancelTaskRun(run: TaskRun) {
    busyKey = `run:cancel:${run.id}`;
    try {
      await invoke("cancel_task_run", { id: run.id });
      taskRunStatus = `${run.capabilityId} 已取消`;
      await refresh();
    } catch (e) {
      taskRunStatus = String(e);
    } finally {
      busyKey = "";
    }
  }

  async function saveTaskRunAsRecipe(run: TaskRun) {
    busyKey = `run:recipe:${run.id}`;
    try {
      await invoke<MemoryItem>("create_memory_item", {
        input: {
          type: "task_recipe",
          scope: { tool: run.capabilityId },
          content: {
            arguments: run.input,
            recipe: {
              sourceRunId: run.id,
              validation: run.validation,
            },
          },
          sourceRunId: run.id,
          confidence: run.validation.status === "passed" ? 1 : 0.8,
          approval: "explicit",
          expiresAt: null,
        },
      });
      taskRunStatus = "已将成功任务保存为显式任务配方";
      await refresh();
    } catch (e) {
      taskRunStatus = `保存任务配方失败：${String(e)}`;
    } finally {
      busyKey = "";
    }
  }

  async function copyTaskRun(run: TaskRun) {
    busyKey = `run:copy:${run.id}`;
    try {
      await copyText(JSON.stringify(run, null, 2));
      taskRunStatus = `已复制 ${run.capabilityId} 的完整结果`;
    } finally {
      busyKey = "";
    }
  }

  async function openArtifact(artifact: TaskRunArtifact) {
    const target = artifactLocation(artifact);
    if (!target) {
      taskRunStatus = `${artifact.label} 没有可打开的受控位置`;
      return;
    }
    busyKey = `artifact:open:${artifact.id}`;
    try {
      await invoke("shell_open", { url: target });
      taskRunStatus = `已打开 ${artifact.label}`;
    } catch (e) {
      taskRunStatus = `打开产物失败：${String(e)}`;
    } finally {
      busyKey = "";
    }
  }

  async function revealArtifact(artifact: TaskRunArtifact) {
    const path = artifact.path?.trim();
    if (!path) {
      taskRunStatus = `${artifact.label} 不是可定位的本地文件`;
      return;
    }
    busyKey = `artifact:reveal:${artifact.id}`;
    try {
      await invoke("shell_show_item_in_folder", { path });
      taskRunStatus = `已定位 ${artifact.label}`;
    } catch (e) {
      taskRunStatus = `定位产物失败：${String(e)}`;
    } finally {
      busyKey = "";
    }
  }

  async function copyArtifact(run: TaskRun, artifact: TaskRunArtifact) {
    busyKey = `artifact:copy:${artifact.id}`;
    try {
      await copyText(artifactJson(artifactPayload(artifact, run.output)));
      taskRunStatus = `已复制 ${artifact.label}`;
    } finally {
      busyKey = "";
    }
  }

  function taskRunStatusMeta(run: TaskRun) {
    if (run.status === "succeeded") return { label: "成功", tone: "success" };
    if (run.status === "failed") return { label: "失败", tone: "error" };
    if (run.status === "partial") return { label: "部分成功", tone: "pending" };
    if (run.status === "cancelled") return { label: "已取消", tone: "denied" };
    if (run.status === "awaiting_permission") return { label: "待授权", tone: "pending" };
    if (run.status === "running") return { label: "执行中", tone: "pending" };
    return { label: "已创建", tone: "pending" };
  }

  function taskRunValidationLabel(run: TaskRun) {
    if (run.validation.status === "passed") return "验收通过";
    if (run.validation.status === "failed") return "验收失败";
    return "未执行验收";
  }

  function taskRunDuration(run: TaskRun) {
    const metrics = run.metrics as { durationMs?: unknown } | null;
    const durationMs = metrics?.durationMs;
    return typeof durationMs === "number" ? auditDurationLabel(durationMs) : "—";
  }

  function taskRunCanRetry(run: TaskRun) {
    return run.status === "failed" || run.status === "partial" || run.status === "cancelled";
  }

  function taskRunCanCancel(run: TaskRun) {
    return run.status === "created" || run.status === "awaiting_permission";
  }

  function compact(value: unknown) {
    return auditPreview(value);
  }

  function resetAuditFilters() {
    auditQuery = "";
    auditStatusFilter = "all";
    auditToolFilter = "all";
    auditClientFilter = "all";
    selectedAuditId = "";
  }

  function saveCurrentAuditFilterView() {
    const views = upsertAuditFilterView(savedAuditFilterViews, {
      id: selectedAuditFilterViewId,
      label: auditFilterViewName,
      filters: currentAuditFilters(),
    });
    savedAuditFilterViews = views;
    saveAuditFilterViews(views);
    selectedAuditFilterViewId = views[0]?.id ?? "";
    auditFilterViewName = views[0]?.label ?? "";
    auditFilterViewStatus = views[0] ? `已保存 ${views[0].label}` : "";
  }

  function applyAuditFilterView(view: SavedAuditFilterView) {
    auditQuery = view.filters.query ?? "";
    auditStatusFilter = view.filters.status ?? "all";
    auditToolFilter = view.filters.toolName ?? "all";
    auditClientFilter = view.filters.clientId ?? "all";
    selectedAuditFilterViewId = view.id;
    auditFilterViewName = view.label;
    auditFilterViewStatus = `已应用 ${view.label}`;
    selectedAuditId = "";
  }

  function deleteAuditFilterView() {
    if (!selectedAuditFilterViewId) return;
    const next = removeAuditFilterView(savedAuditFilterViews, selectedAuditFilterViewId);
    savedAuditFilterViews = next;
    saveAuditFilterViews(next);
    selectedAuditFilterViewId = "";
    auditFilterViewName = "";
    auditFilterViewStatus = "已删除筛选视图";
  }

  function selectAuditFilterView() {
    const view = selectedAuditFilterView();
    auditFilterViewName = view?.label ?? "";
  }

  function selectedAuditFilterView() {
    return savedAuditFilterViews.find((view) => view.id === selectedAuditFilterViewId) ?? null;
  }

  function currentAuditFilters() {
    return {
      query: auditQuery,
      status: auditStatusFilter,
      toolName: auditToolFilter,
      clientId: auditClientFilter,
    };
  }

  function auditBackendQuery(limit: number, offset = 0): AuditLogQuery {
    return {
      limit,
      offset,
      query: normalizedFilterValue(auditQuery),
      status: normalizedFilterValue(auditStatusFilter),
      tool_name: normalizedFilterValue(auditToolFilter),
      client_id: normalizedFilterValue(auditClientFilter),
    };
  }

  function normalizedFilterValue(value: string) {
    const trimmed = value.trim();
    return trimmed && trimmed !== "all" ? trimmed : null;
  }

  function filterSelectOptions(options: string[], selected: string) {
    const selectedValue = normalizedFilterValue(selected);
    return [...new Set([...options, ...(selectedValue ? [selectedValue] : [])])].sort();
  }

  function hasActiveAuditFilters() {
    return Boolean(
      normalizedFilterValue(auditQuery)
      || normalizedFilterValue(auditStatusFilter)
      || normalizedFilterValue(auditToolFilter)
      || normalizedFilterValue(auditClientFilter),
    );
  }
</script>

<section class="agent-panel">
  <header class="agent-header">
    <div>
      <h2>Agent</h2>
      <p>MCP、权限与审计</p>
    </div>
    <button class="icon-button" onclick={onclose} title="关闭">×</button>
  </header>

  {#if error}
    <div class="error">{error}</div>
  {/if}

  <div class="agent-grid">
    <section class="agent-section">
      <div class="section-title">
        <h3>MCP</h3>
        <div class="row-actions">
          <button disabled={!status || !mcpHttpUrl(status) || busyKey === "mcp:http"} onclick={copyHttpMcpConfig}>复制 HTTP 配置</button>
          <button disabled={busyKey === "mcp:stdio"} onclick={copyStdioMcpConfig}>复制 stdio 配置</button>
        </div>
      </div>
      <dl>
        <div>
          <dt>状态</dt>
          <dd><span class={`mcp-state ${mcpView.statusTone}`}>{mcpView.statusLabel}</span></dd>
        </div>
        <div>
          <dt>地址</dt>
          <dd>{mcpView.httpUrl}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd class="token">{mcpView.tokenLabel}</dd>
        </div>
        <div>
          <dt>推荐</dt>
          <dd>{mcpView.recommendedTransport === "http" ? "HTTP MCP" : "stdio proxy"}</dd>
        </div>
      </dl>
      <div class="security-hint">{mcpView.securityHint}</div>
      {#if mcpCopyStatus}
        <div class="empty">{mcpCopyStatus}</div>
      {/if}
      <div class="template-list">
        {#each mcpTemplates() as template}
          {@const installPlan = mcpClientInstallPlan(template, { homePath: mcpInstallHomePath })}
          <article class="template-row">
            <div>
              <strong>{template.label}</strong>
              <p>{template.description}</p>
              <div class="install-plan">
                <span>{installPlan.targetLabel}</span>
                <code>{installPlan.targetPath}</code>
                <code>建议：{installPlan.suggestedTargetPath}</code>
                <ol>
                  {#each installPlan.steps as step}
                    <li>{step}</li>
                  {/each}
                </ol>
                <small>{installPlan.writeReason}</small>
              </div>
            </div>
            <div class="row-actions">
              <span>{template.transport}</span>
              <span class="write-state">{installPlan.writeStateLabel}</span>
              <button
                disabled={!hasTauriRuntime() || !installPlan.writeAvailable || busyKey === `mcp:install:${template.id}`}
                onclick={() => installMcpTemplate(template)}
              >{busyKey === `mcp:install:${template.id}` ? "合并中" : installPlan.writeActionLabel}</button>
              <button
                disabled={busyKey === `mcp:template:${template.id}`}
                onclick={() => copyMcpTemplate(template)}
              >复制</button>
            </div>
          </article>
        {/each}
      </div>
    </section>

    <section class="agent-section">
      <h3>权限</h3>
      <select value={permissionMode} onchange={(e) => updateMode((e.target as HTMLSelectElement).value)}>
        <option value="conservative">保守确认</option>
        <option value="per_tool">按工具授权</option>
        <option value="developer">开发者宽松</option>
      </select>
      <div class="scope-policy-list">
        {#each scopePolicies as policy}
          <article class="scope-policy-row" class:blocked={policy.decision === "deny"}>
            <div>
              <strong>{policy.label}</strong>
              <p>{policy.description}</p>
              <code>{policy.scope}</code>
            </div>
            <div class="scope-policy-control">
              {#if policy.high_risk}
                <span class="risk-tag">高风险</span>
              {/if}
              <select
                value={policy.decision}
                disabled={busyKey === `scope:${policy.scope}`}
                onchange={(e) => updateScopePolicy(policy.scope, (e.target as HTMLSelectElement).value)}
              >
                <option value="confirm">确认</option>
                <option value="deny">阻断</option>
              </select>
            </div>
          </article>
        {/each}
      </div>
    </section>
  </div>

  <section class="agent-section">
    <div class="section-title">
      <h3>待确认请求</h3>
      <button onclick={refresh}>刷新</button>
    </div>
    {#if pendingRequests.length === 0}
      <div class="empty">暂无待确认请求</div>
    {:else}
      <div class="pending-list">
        {#each pendingRequests as request}
          <article class="pending-row">
            <div>
              <strong>{request.tool_name}</strong>
              <p>{request.client_id} · {request.scopes.join(", ")}</p>
              <div class="audit-json">{compact(request.arguments)}</div>
            </div>
            <div class="row-actions">
              <button
                disabled={busyKey === `pending:${request.id}`}
                onclick={() => approveOnceRequest(request)}
              >允许一次</button>
              <button
                disabled={busyKey === `pending:${request.id}`}
                onclick={() => approveRequest(request)}
              >允许并记住</button>
              <button
                disabled={busyKey === `pending:${request.id}`}
                onclick={() => dismissRequest(request.id)}
              >拒绝</button>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="agent-section memory-section">
    <div class="section-title">
      <div>
        <h3>执行记忆</h3>
        <p>仅保存显式或已确认内容；匹配作用域后只补充缺省参数</p>
      </div>
      <div class="row-actions">
        <button disabled={busyKey === "memory:export"} onclick={exportMemories}>导出</button>
        <button disabled={busyKey === "memory:clear" || memories.length === 0} onclick={clearMemories}>清空</button>
      </div>
    </div>
    <div class="memory-editor">
      <label><span>类型</span><select bind:value={memoryType}>
        <option value="preference">用户偏好</option>
        <option value="workspace_fact">工作区事实</option>
        <option value="task_recipe">任务配方</option>
        <option value="correction">纠正</option>
        <option value="failure_recovery">失败恢复</option>
      </select></label>
      <label><span>审批</span><select bind:value={memoryApproval}>
        <option value="explicit">用户显式</option>
        <option value="confirmed_candidate">已确认候选</option>
        <option value="temporary">临时</option>
      </select></label>
      <label><span>工具作用域</span><input bind:value={memoryTool} placeholder="留空表示全局" /></label>
      <label><span>工作区作用域</span><input bind:value={memoryWorkspace} placeholder="可选绝对路径" /></label>
      <label><span>置信度</span><input bind:value={memoryConfidence} type="number" min="0" max="1" step="0.05" /></label>
      <label><span>过期时间</span><input bind:value={memoryExpiresAt} type="datetime-local" disabled={memoryApproval !== "temporary"} /></label>
      <label class="memory-content"><span>结构化内容</span><textarea bind:value={memoryContent} rows="5" spellcheck="false"></textarea></label>
      <div class="memory-editor-actions row-actions">
        <button disabled={busyKey === "memory:save"} onclick={saveMemory}>{editingMemoryId ? "更新记忆" : "保存记忆"}</button>
        {#if editingMemoryId}<button onclick={resetMemoryForm}>取消编辑</button>{/if}
      </div>
    </div>
    {#if memoryStatus}<div class="empty">{memoryStatus}</div>{/if}
    {#if memories.length === 0}
      <div class="empty">暂无执行记忆。ATools 不会自动把模型推断写入永久记忆。</div>
    {:else}
      <div class="memory-list">
        {#each memories as item}
          <article class="memory-row" class:disabled={!item.enabled}>
            <div class="memory-row-head">
              <strong>{item.type}</strong>
              <span>{item.approval} · 置信度 {item.confidence}</span>
              <code>{item.scope.tool ?? "global"}{item.scope.workspace ? ` · ${item.scope.workspace}` : ""}</code>
            </div>
            <pre>{auditDetailValue(item.content, "无内容")}</pre>
            <small>使用 {item.useCount} 次 · 成功 {item.successCount} 次 · {item.expiresAt ? `过期 ${item.expiresAt}` : "长期"}</small>
            <div class="row-actions">
              <button onclick={() => editMemory(item)}>编辑</button>
              <button disabled={busyKey === `memory:toggle:${item.id}`} onclick={() => toggleMemory(item)}>{item.enabled ? "停用" : "启用"}</button>
              <button disabled={busyKey === `memory:delete:${item.id}`} onclick={() => deleteMemory(item)}>删除</button>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="agent-section result-center-section">
    <div class="section-title">
      <div>
        <h3>结果中心</h3>
        <p>持久 TaskRun、验收状态与结构化产物</p>
      </div>
      <button onclick={refresh}>刷新</button>
    </div>
    {#if taskRunStatus}
      <div class="empty">{taskRunStatus}</div>
    {/if}
    {#if taskRuns.length === 0}
      <div class="empty">暂无 TaskRun；从 MCP 或 Agent 工具执行后会在这里保留结果。</div>
    {:else}
      <div class="task-run-layout">
        <div class="task-run-list">
          {#each taskRuns as run}
            {@const statusMeta = taskRunStatusMeta(run)}
            <button
              class="task-run-row"
              class:selected={selectedTaskRunId === run.id}
              onclick={() => selectedTaskRunId = selectedTaskRunId === run.id ? "" : run.id}
            >
              <div class="task-run-row-head">
                <strong>{run.capabilityId}</strong>
                <span class={`status-badge ${statusMeta.tone}`}>{statusMeta.label}</span>
              </div>
              <p>{run.summary ?? "等待执行摘要"}</p>
              <small>
                {run.initiator.type} · {run.initiator.clientId ?? "local"} · {taskRunDuration(run)} · {run.createdAt}
              </small>
            </button>
          {/each}
        </div>
        {#each taskRuns.filter((run) => run.id === selectedTaskRunId) as run}
          {@const statusMeta = taskRunStatusMeta(run)}
          <article class="task-run-detail">
            <div class="task-run-detail-head">
              <div>
                <strong>{run.capabilityId}</strong>
                <code>{run.id}</code>
              </div>
              <div class="row-actions">
                <span class={`status-badge ${statusMeta.tone}`}>{statusMeta.label}</span>
                <button
                  disabled={busyKey === `run:copy:${run.id}`}
                  onclick={() => copyTaskRun(run)}
                >复制</button>
                {#if taskRunCanRetry(run)}
                  <button
                    disabled={busyKey === `run:retry:${run.id}`}
                    onclick={() => retryTaskRun(run)}
                  >重试</button>
                {/if}
                {#if run.status === "succeeded"}
                  <button
                    disabled={busyKey === `run:recipe:${run.id}`}
                    onclick={() => saveTaskRunAsRecipe(run)}
                  >保存为配方</button>
                {/if}
                {#if taskRunCanCancel(run)}
                  <button
                    disabled={busyKey === `run:cancel:${run.id}`}
                    onclick={() => cancelTaskRun(run)}
                  >取消</button>
                {/if}
              </div>
            </div>
            <div class="task-run-summary-grid">
              <div><span>来源</span><strong>{run.initiator.type} / {run.initiator.clientId ?? "local"}</strong></div>
              <div><span>耗时</span><strong>{taskRunDuration(run)}</strong></div>
              <div><span>验收</span><strong>{taskRunValidationLabel(run)}</strong></div>
              <div><span>产物</span><strong>{run.artifacts.length}</strong></div>
              <div><span>记忆</span><strong>{run.memoryIds.length}</strong></div>
            </div>
            {#if run.retryOf}
              <p class="task-run-retry-link">重试来源：<code>{run.retryOf}</code></p>
            {/if}
            {#if run.memoryIds.length > 0}
              <section class="detail-block">
                <h4>本次使用的执行记忆</h4>
                <div class="artifact-list">
                  {#each run.memoryIds as memoryId}
                    {@const memory = memories.find((item) => item.id === memoryId)}
                    <div>
                      <strong>{memory?.type ?? "已删除记忆"}</strong>
                      <span>{memory?.scope.tool ?? "global"} · {memory?.approval ?? "unknown"}</span>
                      <code>{memory ? auditDetailValue(memory.content, "无影响说明") : memoryId}</code>
                    </div>
                  {/each}
                </div>
                <p>记忆只补充调用方未提供的参数；显式输入始终优先。</p>
              </section>
            {/if}
            <section class="detail-block">
              <h4>验收说明</h4>
              <p>{run.validation.summary ?? "本次结果没有独立验收说明。"}</p>
            </section>
            {#if run.artifacts.length > 0}
              <section class="detail-block">
                <h4>Artifacts</h4>
                <div class="artifact-render-list">
                  {#each run.artifacts as artifact}
                    {@const renderKind = artifactRenderKind(artifact)}
                    {@const payload = artifactPayload(artifact, run.output)}
                    {@const table = artifactTable(payload)}
                    {@const previewSource = artifactPreviewSource(artifact, hasTauriAssetRuntime(), convertFileSrc)}
                    {@const location = artifactLocation(artifact)}
                    <article class="artifact-card">
                      <header>
                        <div>
                          <strong>{artifact.label}</strong>
                          <span>{artifact.kind} · {artifact.mediaType ?? "unknown"}</span>
                          {#if location}<code>{location}</code>{/if}
                        </div>
                        <div class="row-actions">
                          <button disabled={busyKey === `artifact:copy:${artifact.id}`} onclick={() => copyArtifact(run, artifact)}>复制</button>
                          {#if location}<button disabled={busyKey === `artifact:open:${artifact.id}`} onclick={() => openArtifact(artifact)}>打开</button>{/if}
                          {#if artifact.path}<button disabled={busyKey === `artifact:reveal:${artifact.id}`} onclick={() => revealArtifact(artifact)}>定位</button>{/if}
                        </div>
                      </header>

                      {#if renderKind === "image"}
                        {#if previewSource}
                          <img class="artifact-image" src={previewSource} alt={artifact.label} />
                        {:else}
                          <p>远程图片不会自动加载；可使用“打开”查看，本地路径仅在桌面运行时预览。</p>
                        {/if}
                      {:else if renderKind === "table" && table}
                        <div class="artifact-table-wrap">
                          <table>
                            <thead><tr>{#each table.columns as column}<th>{column}</th>{/each}</tr></thead>
                            <tbody>
                              {#each table.rows as row}
                                <tr>{#each table.columns as column}<td>{row[column]}</td>{/each}</tr>
                              {/each}
                            </tbody>
                          </table>
                        </div>
                        {#if table.truncated}<p>表格预览已截断；复制产物可获取完整结构化内容。</p>{/if}
                      {:else if renderKind === "markdown"}
                        <div class="artifact-markdown">
                          {#each artifactMarkdownBlocks(payload) as block}
                            {#if block.kind === "heading"}
                              <h5 class:primary={block.level === 1}>{block.text}</h5>
                            {:else if block.kind === "list_item"}
                              <p class="markdown-list-item">{block.ordered ? "1." : "•"} {block.text}</p>
                            {:else if block.kind === "code"}
                              <pre>{block.text}</pre>
                            {:else}
                              <p>{block.text}</p>
                            {/if}
                          {/each}
                        </div>
                      {:else if renderKind === "diff"}
                        <pre class="artifact-diff">{#each artifactDiffLines(payload) as line}<span class={line.tone}>{line.text || " "}</span>{/each}</pre>
                      {:else if renderKind === "json"}
                        {#if table}
                          <div class="artifact-table-wrap compact">
                            <table>
                              <thead><tr>{#each table.columns as column}<th>{column}</th>{/each}</tr></thead>
                              <tbody>
                                {#each table.rows.slice(0, 20) as row}
                                  <tr>{#each table.columns as column}<td>{row[column]}</td>{/each}</tr>
                                {/each}
                              </tbody>
                            </table>
                          </div>
                        {/if}
                        <pre>{artifactJson(payload)}</pre>
                      {:else if renderKind === "url"}
                        <p>{location ?? "缺少 URL"}</p>
                      {:else if renderKind === "file"}
                        <p>{location ?? "该产物仅保留受控元数据引用"}</p>
                        {#if payload !== null}<pre>{artifactJson(payload)}</pre>{/if}
                      {:else}
                        <pre>{artifactJson(payload)}</pre>
                      {/if}
                    </article>
                  {/each}
                </div>
              </section>
            {/if}
            {#if run.warnings.length > 0 || run.errors.length > 0}
              <section class="detail-block task-run-issues">
                <h4>警告与错误</h4>
                {#each [...run.warnings, ...run.errors] as issue}
                  <p><strong>{issue.code}</strong> · {issue.message}</p>
                {/each}
              </section>
            {/if}
            <div class="task-run-data-grid">
              <section class="detail-block">
                <h4>输入</h4>
                <pre>{auditDetailValue(run.input, "无输入")}</pre>
              </section>
              <section class="detail-block">
                <h4>输出</h4>
                <pre>{auditDetailValue(run.output, "无输出")}</pre>
              </section>
              <section class="detail-block">
                <h4>指标</h4>
                <pre>{auditDetailValue(run.metrics, "无指标")}</pre>
              </section>
            </div>
            <section class="detail-block">
              <h4>结果动作</h4>
              {#if run.actions.length === 0}
                <p>暂无后续动作；重试与取消仍会重新经过能力和权限检查。</p>
              {:else}
                <div class="artifact-list">
                  {#each run.actions as action}
                    <div>
                      <strong>{action.label}</strong>
                      <code>{action.capabilityId}</code>
                      <span>{action.requiresConfirmation ? "需要确认" : "按策略检查"}</span>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="agent-section">
    <div class="section-title">
      <h3>工具白名单</h3>
      <button onclick={refresh}>刷新</button>
    </div>
    <div class="tool-list">
      {#each tools as tool}
        <div class="tool-row">
          <div>
            <strong>{tool.name}</strong>
            <p>{tool.description}</p>
          </div>
          <div class="tool-controls">
            <span>{tool.scopes.join(", ")}</span>
            <label class="toggle">
              <input
                type="checkbox"
                checked={tool.enabled}
                disabled={busyKey === `tool:${tool.name}`}
                onchange={(e) => toggleTool(tool.name, (e.target as HTMLInputElement).checked)}
              />
              <span>启用</span>
            </label>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <section class="agent-section">
    <div class="section-title">
      <h3>授权</h3>
      <button onclick={refresh}>刷新</button>
    </div>
    {#if grants.length === 0}
      <div class="empty">暂无持久授权</div>
    {:else}
      <div class="grant-list">
        {#each grants as grant}
          <div class="grant-row">
            <div>
              <strong>{grant.tool_name}</strong>
              <p>{grant.client_id} · {grant.updated_at}</p>
            </div>
            <button
              disabled={busyKey === `grant:${grant.client_id}:${grant.tool_name}`}
              onclick={() => revokeGrant(grant.client_id, grant.tool_name)}
            >撤销</button>
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <section class="agent-section audit-section">
    <div class="section-title">
      <h3>审计回放</h3>
      <div class="row-actions">
        <button disabled={busyKey === "audit:filter"} onclick={reloadAuditsForFilters}>刷新</button>
        <button disabled={busyKey === "audit:export"} onclick={exportAudits}>导出</button>
        <button disabled={busyKey === "audit:clear"} onclick={clearAudits}>清空</button>
      </div>
    </div>
    {#if exportStatus}
      <div class="empty">{exportStatus}</div>
    {/if}
    {#if audits.length === 0}
      <div class="empty">暂无记录</div>
    {/if}
      <div class="audit-filters">
        <label class="audit-search">
          <span>搜索</span>
          <input
            type="search"
            bind:value={auditQuery}
            placeholder="工具、客户端、路径、错误、参数"
          />
        </label>
        <label>
          <span>状态</span>
          <select bind:value={auditStatusFilter}>
            <option value="all">全部 ({auditOptions.statusCounts.all})</option>
            <option value="success">成功 ({auditOptions.statusCounts.success})</option>
            <option value="denied">拒绝 ({auditOptions.statusCounts.denied})</option>
            <option value="error">失败 ({auditOptions.statusCounts.error})</option>
            <option value="pending">待确认 ({auditOptions.statusCounts.pending})</option>
            <option value="unknown">未知 ({auditOptions.statusCounts.unknown})</option>
          </select>
        </label>
        <label>
          <span>工具</span>
          <select bind:value={auditToolFilter}>
            <option value="all">全部工具</option>
            {#each auditToolFilterOptions as toolName}
              <option value={toolName}>{toolName}</option>
            {/each}
          </select>
        </label>
        <label>
          <span>客户端</span>
          <select bind:value={auditClientFilter}>
            <option value="all">全部客户端</option>
            {#each auditClientFilterOptions as clientId}
              <option value={clientId}>{clientId}</option>
            {/each}
          </select>
        </label>
        <button onclick={resetAuditFilters}>重置</button>
      </div>
      <div class="audit-filter-views">
        <label>
          <span>筛选视图</span>
          <select bind:value={selectedAuditFilterViewId} onchange={selectAuditFilterView}>
            <option value="">已保存视图</option>
            {#each savedAuditFilterViews as view}
              <option value={view.id}>{view.label}</option>
            {/each}
          </select>
        </label>
        <label class="audit-filter-view-name">
          <span>名称</span>
          <input bind:value={auditFilterViewName} placeholder={auditFilterViewLabel(currentAuditFilters())} />
        </label>
        <button onclick={saveCurrentAuditFilterView}>保存视图</button>
        <button disabled={!selectedAuditFilterViewId} onclick={() => {
          const view = selectedAuditFilterView();
          if (view) applyAuditFilterView(view);
        }}>应用</button>
        <button disabled={!selectedAuditFilterViewId} onclick={deleteAuditFilterView}>删除</button>
      </div>
      {#if auditFilterViewStatus}
        <div class="audit-filter-summary">{auditFilterViewStatus}</div>
      {/if}
      <div class="audit-filter-summary">{auditSummaryText} · 已加载 {audits.length} / {auditTotal} 条</div>
      {#if audits.length > 0 && filteredAudits.length === 0}
        <div class="empty">没有匹配的审计记录</div>
      {/if}
      {#if filteredAudits.length > 0}
      <div class="audit-list">
        {#each filteredAudits as audit}
          {@const statusMeta = auditStatusMeta(audit)}
          <button
            class:selected={selectedAuditId === audit.id}
            class="audit-row"
            onclick={() => selectedAuditId = selectedAuditId === audit.id ? "" : audit.id}
          >
            <div class="audit-meta">
              <strong>{audit.tool_name}</strong>
              <span class={`status-badge ${statusMeta.tone}`}>{statusMeta.label}</span>
              <time>{audit.timestamp}</time>
            </div>
            <div class="audit-json">{compact(audit.input)}</div>
            <div class="audit-json">{audit.error ?? compact(audit.output)}</div>
          </button>
        {/each}
      </div>
      {/if}
      {#if audits.length < auditTotal}
        <button
          class="load-more-button"
          disabled={busyKey === "audit:load-more"}
          onclick={loadMoreAudits}
        >{busyKey === "audit:load-more" ? "加载中" : "加载更多"}</button>
      {/if}
      {#each filteredAudits.filter((audit) => audit.id === selectedAuditId) as audit}
        {@const statusMeta = auditStatusMeta(audit)}
        {@const replay = auditReplaySummary(audit)}
        {@const sideEffectDiff = auditSideEffectDiff(audit)}
        {@const paths = auditPathSummaries(audit)}
        <article class="audit-detail">
          <div class="audit-detail-head">
            <div>
              <strong>{audit.tool_name}</strong>
              <p>{audit.client_id}</p>
            </div>
            <div class="audit-stats">
              <span class={`status-badge ${statusMeta.tone}`}>{statusMeta.label}</span>
              <span>{auditDurationLabel(audit.duration_ms)}</span>
              <time>{audit.timestamp}</time>
              <button
                disabled={busyKey === `audit:copy:${audit.id}`}
                onclick={() => copyAuditDetail(audit)}
              >复制详情</button>
            </div>
          </div>
          <div class="audit-summary-grid">
            {#each auditSummaryRows(audit) as row}
              <div class="audit-summary-cell">
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            {/each}
          </div>
          <section class="detail-block replay-block">
            <h4>回放摘要</h4>
            <div class="replay-summary-grid">
              <div>
                <span>权限结果</span>
                <strong>{replay.permissionLabel}</strong>
              </div>
              <div>
                <span>执行模式</span>
                <strong>{replay.executionMode}</strong>
              </div>
              <div>
                <span>本地副作用</span>
                <strong>{replay.sideEffectLabel}</strong>
              </div>
            </div>
            <ol class="replay-steps">
              {#each replay.steps as step}
                <li class={step.tone}>
                  <span>{step.label}</span>
                  <strong>{step.detail}</strong>
                </li>
              {/each}
            </ol>
          </section>
          {#if sideEffectDiff.rows.length > 0}
            <section class="detail-block">
              <h4>副作用 diff</h4>
              <div class="side-effect-summary">{sideEffectDiff.summary}</div>
              <div class="side-effect-diff-list">
                {#each sideEffectDiff.rows as row}
                  <div class={`side-effect-diff-row ${row.tone}`}>
                    <span>{row.action}</span>
                    <code>{row.before || "—"}</code>
                    <strong>→</strong>
                    <code>{row.after || "—"}</code>
                    <em>{row.status}</em>
                    <small>{row.detail}</small>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
          {#if replay.pathChanges.length > 0}
            <section class="detail-block">
              <h4>路径副作用</h4>
              <div class="path-change-list">
                {#each replay.pathChanges as change}
                  <div class="path-change-row">
                    <span>{change.action}</span>
                    <code>{change.source || "—"}</code>
                    <strong>→</strong>
                    <code>{change.target || "—"}</code>
                    <em>{change.status}</em>
                  </div>
                {/each}
              </div>
            </section>
          {/if}
          {#if paths.length > 0}
            <section class="detail-block">
              <h4>涉及路径</h4>
              <div class="path-chip-list">
                {#each paths as path}
                  <code>{path}</code>
                {/each}
              </div>
            </section>
          {/if}
          <div class="audit-detail-grid">
            <section class="detail-block">
              <h4>输入参数</h4>
              <pre>{auditDetailValue(audit.input, "无输入")}</pre>
            </section>
            <section class="detail-block">
              <h4>输出结果</h4>
              <pre>{auditDetailValue(audit.output, "无输出")}</pre>
            </section>
            <section class="detail-block">
              <h4>错误信息</h4>
              <pre>{auditDetailValue(audit.error, "无错误")}</pre>
            </section>
          </div>
        </article>
      {/each}
  </section>
</section>

<style>
  .agent-panel {
    padding: 18px 20px;
    border-top: 1px solid var(--border);
    background: var(--bg-primary);
    max-height: 560px;
    overflow: auto;
  }
  .agent-header,
  .section-title,
  .agent-grid,
  .tool-row,
  .pending-row,
  .grant-row,
  .template-row,
  .audit-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .agent-header h2,
  .agent-section h3 {
    margin: 0;
    color: var(--text-primary);
  }
  .agent-header h2 {
    font-size: 18px;
  }
  .agent-header p,
  .section-title p,
  .tool-row p,
  .scope-policy-row p,
  .pending-row p,
  .grant-row p,
  .task-run-row p,
  .empty {
    margin: 4px 0 0;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  .icon-button,
  .section-title button,
  .row-actions button,
  .grant-row button {
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-primary);
    border-radius: 6px;
    padding: 6px 10px;
    cursor: pointer;
  }

  .task-run-layout {
    display: grid;
    grid-template-columns: minmax(260px, 0.8fr) minmax(0, 1.4fr);
    gap: 12px;
    margin-top: 10px;
  }

  .memory-editor {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin-top: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg-secondary);
  }

  .memory-editor label {
    display: grid;
    gap: 5px;
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .memory-editor input,
  .memory-editor select,
  .memory-editor textarea {
    width: 100%;
    min-width: 0;
    box-sizing: border-box;
    margin: 0;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    background: var(--bg-primary);
    font: inherit;
  }

  .memory-editor textarea,
  .memory-row pre {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .memory-content {
    grid-column: 1 / -1;
  }

  .memory-editor-actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }

  .memory-list {
    display: grid;
    gap: 7px;
    margin-top: 10px;
  }

  .memory-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 7px 12px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg-secondary);
  }

  .memory-row.disabled {
    opacity: 0.58;
  }

  .memory-row-head,
  .memory-row pre,
  .memory-row small {
    grid-column: 1;
    min-width: 0;
  }

  .memory-row-head {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
    align-items: center;
  }

  .memory-row-head span,
  .memory-row small {
    color: var(--text-tertiary);
    font-size: 10.5px;
  }

  .memory-row-head code {
    overflow-wrap: anywhere;
    color: var(--text-tertiary);
    font-size: 10.5px;
  }

  .memory-row pre {
    overflow: auto;
    max-height: 110px;
    margin: 0;
    padding: 7px;
    border-radius: 5px;
    color: var(--text-secondary);
    background: var(--bg-primary);
    white-space: pre-wrap;
  }

  .memory-row > .row-actions {
    grid-column: 2;
    grid-row: 1 / span 3;
    align-self: center;
  }

  .task-run-list {
    display: grid;
    align-content: start;
    gap: 6px;
    max-height: 430px;
    overflow: auto;
  }

  .task-run-row {
    display: grid;
    gap: 5px;
    width: 100%;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    color: var(--text-primary);
    background: var(--bg-secondary);
    text-align: left;
    cursor: pointer;
  }

  .task-run-row.selected {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    background: color-mix(in srgb, var(--accent) 7%, var(--bg-secondary));
  }

  .task-run-row-head,
  .task-run-detail-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .task-run-row p {
    overflow: hidden;
    margin: 0;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-run-row small,
  .task-run-retry-link {
    color: var(--text-tertiary);
    font-size: 10.5px;
  }

  .task-run-detail {
    display: grid;
    gap: 10px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg-secondary);
  }

  .task-run-detail-head > div:first-child {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .task-run-detail code,
  .artifact-list code {
    overflow-wrap: anywhere;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }

  .task-run-summary-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 7px;
  }

  .task-run-summary-grid > div {
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
  }

  .task-run-summary-grid span,
  .task-run-summary-grid strong {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .task-run-summary-grid span,
  .artifact-list span {
    color: var(--text-tertiary);
    font-size: 10.5px;
  }

  .task-run-summary-grid strong {
    margin-top: 3px;
    color: var(--text-primary);
    font-size: 11px;
  }

  .task-run-data-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .artifact-list {
    display: grid;
    gap: 6px;
  }

  .artifact-render-list {
    display: grid;
    gap: 9px;
  }

  .artifact-card {
    min-width: 0;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg-primary);
  }

  .artifact-card > header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 8px;
  }

  .artifact-card > header > div:first-child {
    display: grid;
    gap: 3px;
    min-width: 0;
  }

  .artifact-card header span,
  .artifact-card > p {
    color: var(--text-tertiary);
    font-size: 10.5px;
  }

  .artifact-card header code {
    overflow-wrap: anywhere;
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }

  .artifact-image {
    display: block;
    width: auto;
    max-width: 100%;
    max-height: 320px;
    margin: 0 auto;
    border-radius: 6px;
    object-fit: contain;
    background: var(--bg-secondary);
  }

  .artifact-table-wrap {
    overflow: auto;
    max-height: 320px;
    border: 1px solid var(--border);
    border-radius: 6px;
  }

  .artifact-table-wrap.compact {
    max-height: 180px;
    margin-bottom: 8px;
  }

  .artifact-table-wrap table {
    width: 100%;
    border-collapse: collapse;
    color: var(--text-secondary);
    font-size: 11px;
  }

  .artifact-table-wrap th,
  .artifact-table-wrap td {
    max-width: 280px;
    padding: 6px 8px;
    border-right: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    text-align: left;
    vertical-align: top;
    overflow-wrap: anywhere;
  }

  .artifact-table-wrap th {
    position: sticky;
    top: 0;
    color: var(--text-primary);
    background: var(--bg-secondary);
  }

  .artifact-markdown {
    padding: 10px;
    border-radius: 6px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
  }

  .artifact-markdown h5 {
    margin: 10px 0 5px;
    color: var(--text-primary);
    font-size: 13px;
  }

  .artifact-markdown h5.primary {
    margin-top: 0;
    font-size: 15px;
  }

  .artifact-markdown p {
    margin: 4px 0;
    font-size: 11.5px;
    line-height: 1.55;
  }

  .artifact-markdown .markdown-list-item {
    padding-left: 8px;
  }

  .artifact-diff span {
    display: block;
    min-height: 1.4em;
    padding: 0 5px;
  }

  .artifact-diff span.add {
    color: #0f7b4f;
    background: rgba(15, 123, 79, 0.1);
  }

  .artifact-diff span.remove {
    color: #bd2c2c;
    background: rgba(189, 44, 44, 0.1);
  }

  .artifact-diff span.header {
    color: #6d55b2;
    background: rgba(109, 85, 178, 0.1);
  }

  .artifact-list > div {
    display: grid;
    grid-template-columns: minmax(120px, 0.8fr) minmax(120px, 0.6fr) minmax(0, 1.6fr);
    gap: 8px;
    align-items: center;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
  }

  .task-run-issues p,
  .task-run-detail .detail-block > p {
    margin: 4px 0 0;
    color: var(--text-secondary);
    font-size: 11px;
  }
  .icon-button {
    width: 28px;
    height: 28px;
    padding: 0;
    font-size: 18px;
    line-height: 1;
  }
  button:disabled,
  input:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }
  .agent-grid {
    align-items: stretch;
    margin: 16px 0;
  }
  .agent-section {
    border-top: 1px solid var(--border);
    padding-top: 14px;
    margin-top: 14px;
  }
  .agent-grid .agent-section {
    flex: 1;
    margin: 0;
  }
  dl {
    margin: 10px 0 0;
  }
  dl div {
    display: grid;
    grid-template-columns: 56px 1fr;
    gap: 10px;
    margin-bottom: 8px;
    font-size: 12px;
  }
  dt {
    color: var(--text-tertiary);
  }
  dd {
    margin: 0;
    color: var(--text-primary);
    word-break: break-all;
  }
  .token,
  .audit-json {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .mcp-state {
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 2px 7px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    font-size: 11px;
    font-weight: 750;
  }
  .mcp-state.ready {
    color: #12805c;
    background: rgba(18, 128, 92, 0.1);
  }
  .mcp-state.warning {
    color: #9f6a00;
    background: rgba(217, 154, 0, 0.12);
  }
  .mcp-state.offline {
    color: var(--text-tertiary);
  }
  .security-hint {
    margin-top: 8px;
    color: var(--text-tertiary);
    font-size: 12px;
  }
  select {
    width: 100%;
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-primary);
  }
  .tool-list,
  .scope-policy-list,
  .pending-list,
  .grant-list,
  .audit-list,
  .template-list {
    margin-top: 10px;
  }

  .audit-filters {
    display: grid;
    grid-template-columns: minmax(180px, 1.5fr) minmax(118px, 0.8fr) minmax(150px, 1fr) minmax(150px, 1fr) auto;
    gap: 8px;
    align-items: end;
    margin-top: 10px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .audit-filter-views {
    display: grid;
    grid-template-columns: minmax(170px, 1fr) minmax(180px, 1.2fr) auto auto auto;
    gap: 8px;
    align-items: end;
    margin-top: 8px;
    padding: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .audit-filters label {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  .audit-filter-views label {
    display: grid;
    gap: 5px;
    min-width: 0;
  }

  .audit-filters label span,
  .audit-filter-views label span,
  .audit-filter-summary {
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .audit-filters input,
  .audit-filters select,
  .audit-filter-views input,
  .audit-filter-views select {
    width: 100%;
    min-width: 0;
    margin: 0;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
  }

  .audit-filters button,
  .audit-filter-views button {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 7px 10px;
    background: var(--bg-primary);
    color: var(--text-primary);
    cursor: pointer;
    white-space: nowrap;
  }

  .audit-filter-summary {
    margin-top: 8px;
  }

  .load-more-button {
    width: 100%;
    margin-top: 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .tool-row,
  .scope-policy-row,
  .pending-row,
  .grant-row,
  .audit-row,
  .template-row {
    padding: 10px 0;
    border-top: 1px solid var(--border);
  }
  .audit-row {
    width: 100%;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    background: transparent;
    color: inherit;
    text-align: left;
    cursor: pointer;
  }
  .audit-row.selected {
    background: var(--bg-secondary);
    margin-inline: -8px;
    padding-inline: 8px;
    border-radius: 6px;
  }
  .pending-row,
  .grant-row,
  .template-row {
    align-items: flex-start;
  }
  .scope-policy-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
  }

  .scope-policy-row.blocked {
    margin-inline: -8px;
    padding-inline: 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--danger) 8%, var(--bg-secondary));
  }

  .pending-row > div:first-child,
  .grant-row > div:first-child,
  .template-row > div:first-child,
  .scope-policy-row > div:first-child,
  .tool-row > div:first-child {
    min-width: 0;
  }

  .install-plan {
    display: grid;
    gap: 4px;
    margin-top: 8px;
    color: var(--text-tertiary);
    font-size: 11px;
    line-height: 1.35;
  }

  .install-plan span {
    color: var(--text-secondary);
    font-weight: 700;
  }

  .install-plan code {
    display: block;
    overflow-wrap: anywhere;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 10.5px;
  }

  .install-plan ol {
    margin: 0;
    padding-left: 16px;
  }

  .install-plan li + li {
    margin-top: 2px;
  }

  .install-plan small {
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .write-state {
    border: 1px solid color-mix(in srgb, var(--warning) 34%, var(--border));
    border-radius: 999px;
    padding: 2px 7px;
    color: var(--warning);
    background: color-mix(in srgb, var(--warning) 8%, var(--bg-secondary));
    white-space: nowrap;
  }

  .scope-policy-row code {
    color: var(--text-tertiary);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .scope-policy-control {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
  }

  .scope-policy-control select {
    width: auto;
    min-width: 86px;
    margin: 0;
  }

  .risk-tag {
    border: 1px solid color-mix(in srgb, var(--danger) 32%, var(--border));
    border-radius: 999px;
    padding: 2px 7px;
    color: var(--danger);
    background: color-mix(in srgb, var(--danger) 8%, var(--bg-secondary));
    font-size: 11px;
    white-space: nowrap;
  }
  .row-actions,
  .tool-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .row-actions {
    flex-shrink: 0;
  }
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--text-tertiary);
    font-size: 11px;
    white-space: nowrap;
  }
  .tool-row span,
  .template-row span,
  .audit-meta time {
    color: var(--text-tertiary);
    font-size: 11px;
  }
  .template-row .install-plan span {
    color: var(--text-secondary);
    font-weight: 700;
  }
  .template-row .write-state {
    color: var(--warning);
  }
  .audit-row {
    display: grid;
    gap: 6px;
  }
  .audit-detail {
    border-top: 1px solid var(--border);
    margin-top: 10px;
    padding-top: 10px;
    display: grid;
    gap: 8px;
  }

  .audit-detail-head {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
  }

  .audit-detail-head p {
    margin: 4px 0 0;
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .audit-stats {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 6px;
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .audit-stats button {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 3px 8px;
    color: var(--text-primary);
    background: var(--bg-secondary);
    font-size: 11px;
    cursor: pointer;
  }

  .status-badge {
    min-width: 48px;
    display: inline-flex;
    justify-content: center;
    padding: 3px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    font-size: 11px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
  }

  .status-badge.success {
    color: #059669;
    border-color: rgba(5, 150, 105, 0.28);
    background: rgba(5, 150, 105, 0.08);
  }

  .status-badge.denied,
  .status-badge.pending {
    color: #b45309;
    border-color: rgba(180, 83, 9, 0.3);
    background: rgba(245, 158, 11, 0.12);
  }

  .status-badge.error {
    color: #dc2626;
    border-color: rgba(220, 38, 38, 0.3);
    background: rgba(220, 38, 38, 0.09);
  }

  .audit-summary-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }

  .audit-summary-cell {
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .audit-summary-cell span {
    display: block;
    margin-bottom: 4px;
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .audit-summary-cell strong {
    display: block;
    overflow: hidden;
    color: var(--text-primary);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .replay-block {
    display: grid;
    gap: 8px;
  }

  .replay-summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .replay-summary-grid div {
    min-width: 0;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .replay-summary-grid span,
  .replay-steps span,
  .path-change-row span,
  .path-change-row em {
    color: var(--text-tertiary);
    font-size: 11px;
    font-style: normal;
  }

  .replay-summary-grid strong {
    display: block;
    margin-top: 4px;
    color: var(--text-primary);
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .replay-steps {
    display: grid;
    gap: 6px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .replay-steps li {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 8px;
    align-items: start;
    padding: 7px 8px;
    border-left: 3px solid var(--border-strong);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .replay-steps li.success {
    border-left-color: #059669;
  }

  .replay-steps li.denied,
  .replay-steps li.pending {
    border-left-color: #b45309;
  }

  .replay-steps li.error {
    border-left-color: #dc2626;
  }

  .replay-steps strong {
    min-width: 0;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .path-change-list {
    display: grid;
    gap: 6px;
  }

  .side-effect-summary {
    margin-bottom: 6px;
    color: var(--text-tertiary);
    font-size: 11px;
  }

  .side-effect-diff-list {
    display: grid;
    gap: 6px;
  }

  .side-effect-diff-row {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) auto minmax(0, 1fr) auto minmax(120px, 0.8fr);
    gap: 8px;
    align-items: center;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-left-width: 3px;
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .side-effect-diff-row.success {
    border-left-color: #059669;
  }

  .side-effect-diff-row.pending {
    border-left-color: #b45309;
  }

  .side-effect-diff-row.denied,
  .side-effect-diff-row.error {
    border-left-color: #dc2626;
  }

  .side-effect-diff-row span,
  .side-effect-diff-row em,
  .side-effect-diff-row small {
    color: var(--text-tertiary);
    font-size: 11px;
    font-style: normal;
    overflow-wrap: anywhere;
  }

  .side-effect-diff-row code {
    min-width: 0;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .side-effect-diff-row strong {
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .path-change-row {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) auto minmax(0, 1fr) auto;
    gap: 8px;
    align-items: center;
    padding: 7px 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-secondary);
  }

  .path-change-row code {
    min-width: 0;
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .path-change-row strong {
    color: var(--text-tertiary);
    font-size: 12px;
  }

  .path-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .path-chip-list code {
    max-width: 100%;
    padding: 5px 8px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
    overflow-wrap: anywhere;
  }

  .audit-detail-grid {
    display: grid;
    gap: 8px;
  }

  .detail-block {
    min-width: 0;
  }

  .detail-block h4 {
    margin: 0 0 5px;
    color: var(--text-secondary);
    font-size: 12px;
  }

  .detail-block pre {
    margin: 0;
    padding: 8px;
    max-height: 220px;
    overflow: auto;
    border-radius: 6px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .audit-json {
    color: var(--text-secondary);
    overflow-wrap: anywhere;
  }
  .error {
    margin-top: 12px;
    color: var(--danger);
    font-size: 12px;
  }

  @media (max-width: 760px) {
    .task-run-layout,
    .task-run-data-grid,
    .memory-editor {
      grid-template-columns: 1fr;
    }

    .memory-row {
      grid-template-columns: 1fr;
    }

    .memory-row > .row-actions {
      grid-column: 1;
      grid-row: auto;
      justify-content: flex-start;
    }

    .task-run-summary-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .artifact-list > div {
      grid-template-columns: 1fr;
    }

    .task-run-detail-head {
      flex-direction: column;
    }

    .audit-summary-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .replay-summary-grid {
      grid-template-columns: 1fr;
    }

    .audit-filters,
    .audit-filter-views {
      grid-template-columns: 1fr;
    }

    .scope-policy-row {
      flex-direction: column;
    }

    .scope-policy-control {
      width: 100%;
      justify-content: space-between;
    }

    .replay-steps li {
      grid-template-columns: 1fr;
    }

    .path-change-row {
      grid-template-columns: 1fr;
    }

    .side-effect-diff-row {
      grid-template-columns: 1fr;
    }

    .audit-detail-head {
      flex-direction: column;
    }

    .audit-stats {
      justify-content: flex-start;
    }
  }
</style>
