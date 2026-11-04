<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { save as saveDialog } from "@tauri-apps/plugin-dialog";
  import type {
    AgentScopePolicy,
    AgentToolGrant,
    McpServerStatus,
    PendingAgentToolRequest,
    ToolDefinition,
  } from "../lib/types";
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
  import { compact, copyText, hasTauriRuntime, safeHomePath } from "../lib/agentPanelHelpers";

  type Props = {
    status: McpServerStatus | null;
    permissionMode: string;
    scopePolicies: AgentScopePolicy[];
    pendingRequests: PendingAgentToolRequest[];
    tools: ToolDefinition[];
    grants: AgentToolGrant[];
    busyKey: string;
    mcpInstallHomePath: string;
    onrefresh: () => Promise<void> | void;
    onupdatepermissionmode: (mode: string) => Promise<void> | void;
    onupdatescopepolicy: (scope: string, decision: string) => Promise<void> | void;
    onapproveonce: (request: PendingAgentToolRequest) => Promise<void> | void;
    onapprove: (request: PendingAgentToolRequest) => Promise<void> | void;
    ondismiss: (requestId: string) => Promise<void> | void;
    ontoggletool: (name: string, enabled: boolean) => Promise<void> | void;
    onrevokegrant: (clientId: string, toolName: string) => Promise<void> | void;
    onsetbusykey: (key: string) => void;
    onsethomepath: (path: string) => void;
  };

  let {
    status,
    permissionMode,
    scopePolicies,
    pendingRequests,
    tools,
    grants,
    busyKey,
    mcpInstallHomePath,
    onrefresh,
    onupdatepermissionmode,
    onupdatescopepolicy,
    onapproveonce,
    onapprove,
    ondismiss,
    ontoggletool,
    onrevokegrant,
    onsetbusykey,
    onsethomepath,
  }: Props = $props();

  let mcpCopyStatus = $state("");
  let mcpView = $derived(mcpConnectionView(status));

  async function copyHttpMcpConfig() {
    if (!status || !mcpHttpUrl(status)) {
      mcpCopyStatus = "MCP HTTP 服务未启动";
      return;
    }
    onsetbusykey("mcp:http");
    try {
      await copyText(mcpClientConfigText(mcpHttpClientConfig(status)));
      mcpCopyStatus = "已复制 HTTP MCP 配置";
    } finally {
      onsetbusykey("");
    }
  }

  async function copyStdioMcpConfig() {
    onsetbusykey("mcp:stdio");
    try {
      await copyText(mcpClientConfigText(mcpStdioClientConfig()));
      mcpCopyStatus = "已复制 stdio proxy 配置";
    } finally {
      onsetbusykey("");
    }
  }

  async function copyMcpTemplate(template: McpClientTemplate) {
    onsetbusykey(`mcp:template:${template.id}`);
    try {
      await copyText(mcpClientTemplateText(template));
      mcpCopyStatus = `已复制 ${template.label} 配置`;
    } finally {
      onsetbusykey("");
    }
  }

  async function installMcpTemplate(template: McpClientTemplate) {
    if (!hasTauriRuntime()) {
      mcpCopyStatus = "需在桌面应用中选择并合并配置文件";
      return;
    }
    const homePath = mcpInstallHomePath || await safeHomePath();
    onsethomepath(homePath);
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

    onsetbusykey(`mcp:install:${template.id}`);
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
      onsetbusykey("");
    }
  }

  function mcpTemplates() {
    return mcpClientTemplates({ status });
  }
</script>

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
    <select value={permissionMode} onchange={(e) => onupdatepermissionmode((e.target as HTMLSelectElement).value)}>
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
              onchange={(e) => onupdatescopepolicy(policy.scope, (e.target as HTMLSelectElement).value)}
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
    <button onclick={onrefresh}>刷新</button>
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
              onclick={() => onapproveonce(request)}
            >允许一次</button>
            <button
              disabled={busyKey === `pending:${request.id}`}
              onclick={() => onapprove(request)}
            >允许并记住</button>
            <button
              disabled={busyKey === `pending:${request.id}`}
              onclick={() => ondismiss(request.id)}
            >拒绝</button>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<section class="agent-section">
  <div class="section-title">
    <h3>工具白名单</h3>
    <button onclick={onrefresh}>刷新</button>
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
              onchange={(e) => ontoggletool(tool.name, (e.target as HTMLInputElement).checked)}
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
    <button onclick={onrefresh}>刷新</button>
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
            onclick={() => onrevokegrant(grant.client_id, grant.tool_name)}
          >撤销</button>
        </div>
      {/each}
    </div>
  {/if}
</section>
