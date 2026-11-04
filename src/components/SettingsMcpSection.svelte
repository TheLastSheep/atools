<script lang="ts">
  import { permissionModeLabel } from "../lib/settingsPages";
  import { hasTauriRuntime } from "../lib/settingsPanelTypesAndOptions";
  import type { AgentToolGrant, PendingAgentToolRequest } from "../lib/types";

  let {
    activeMenu = $bindable(),
    agentTools,
    agentScopePolicies,
    pendingAgentRequests,
    agentToolGrants,
    mcpRecentAudits,
    mcpPermissionMode,
    mcpLoading,
    mcpPolicyBusyKey,
    mcpRequestBusyKey,
    mcpPageStatus,
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
    mcpTemplates,
    mcpInstallPlan,
    mcpConnection,
    mcpGovernance,
    mcpScopeRows,
    mcpPendingRows,
    mcpGrantListRows,
    mcpAuditListRows,
    mcpHttpUrl,
  }: Record<string, any> = $props();
</script>

    {#if activeMenu === "mcp"}
      {@const governance = mcpGovernance()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>MCP 治理概览</h3>
            <div class="row-actions">
              <span class="state-pill" class:enabled={mcpPermissionMode !== "developer"}>{permissionModeLabel(mcpPermissionMode)}</span>
              <button class="plain-button" onclick={refreshMcpPage} disabled={mcpLoading}>刷新</button>
            </div>
          </div>
          <div class="mcp-governance-grid" aria-label="MCP 治理概览">
            {#each governance.cards as card}
              <div
                class="mcp-governance-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:danger={card.tone === "danger"}
                class:desktop={card.tone === "desktop"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
          <div class="inline-status">{governance.auditChain}</div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>权限策略</h3>
            <span class="meta-pill">{agentScopePolicies.length ? `${agentScopePolicies.length} 个 Scope` : "桌面端读取"}</span>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>权限模式</span>
              <small>控制 Agent 工具调用的默认确认强度；高风险 Scope 仍可单独阻断</small>
            </div>
            <select
              class="select-control"
              value={mcpPermissionMode}
              disabled={!hasTauriRuntime() || mcpPolicyBusyKey === "permission-mode"}
              aria-label="MCP 权限模式"
              onchange={(event) => updateMcpPermissionMode((event.target as HTMLSelectElement).value)}
            >
              <option value="conservative">保守确认</option>
              <option value="per_tool">按工具授权</option>
              <option value="developer">开发者宽松</option>
            </select>
          </div>

          {#if mcpScopeRows().length === 0}
            <div class="empty-box">权限 Scope 需在桌面应用中读取；浏览器预览不会加载真实本地策略。</div>
          {:else}
            <div class="mcp-scope-policy-list">
              {#each mcpScopeRows() as policy}
                <div class="mcp-scope-policy-row" class:blocked={policy.blocked}>
                  <div class="setting-label">
                    <span>{policy.label}</span>
                    <small>{policy.description}</small>
                    <code>{policy.scope}</code>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill" class:danger={policy.high_risk}>{policy.riskLabel}</span>
                    <select
                      class="select-control compact"
                      value={policy.decision}
                      disabled={!hasTauriRuntime() || mcpPolicyBusyKey === `scope:${policy.scope}`}
                      aria-label={`${policy.label} 权限策略`}
                      onchange={(event) => updateMcpScopePolicy(policy.scope, (event.target as HTMLSelectElement).value)}
                    >
                      <option value="confirm">确认</option>
                      <option value="deny">阻断</option>
                    </select>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>待确认请求</h3>
            <button class="plain-button" onclick={refreshMcpPage} disabled={mcpLoading}>刷新</button>
          </div>
          {#if !hasTauriRuntime()}
            <div class="empty-box">待确认请求需在桌面应用中读取；浏览器预览不会加载真实 Agent 调用。</div>
          {:else if mcpPendingRows().length === 0}
            <div class="empty-box">暂无待确认请求；保守确认模式下 Agent 调用高风险工具会出现在这里。</div>
          {:else}
            <div class="mcp-request-list">
              {#each mcpPendingRows() as row}
                {@const request = pendingAgentRequests.find((item: PendingAgentToolRequest) => item.id === row.id)}
                <div class="mcp-request-row">
                  <div class="setting-label">
                    <span>{row.toolName}</span>
                    <small>{row.clientId} · {row.scopeLabel}</small>
                    <code>{row.argumentPreview}</code>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill pending">待确认</span>
                    <button
                      class="plain-button"
                      disabled={!request || mcpRequestBusyKey === `pending:${row.id}`}
                      onclick={() => request && approveMcpRequestOnce(request)}
                    >允许一次</button>
                    <button
                      class="plain-button"
                      disabled={!request || mcpRequestBusyKey === `pending:${row.id}`}
                      onclick={() => request && approveAndRememberMcpRequest(request)}
                    >允许并记住</button>
                    <button
                      class="plain-button danger"
                      disabled={!request || mcpRequestBusyKey === `pending:${row.id}`}
                      onclick={() => request && dismissMcpRequest(request)}
                    >拒绝</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>持久授权</h3>
            <span class="meta-pill">{hasTauriRuntime() ? `${agentToolGrants.length} 条` : "桌面端读取"}</span>
          </div>
          {#if !hasTauriRuntime()}
            <div class="empty-box">持久授权需在桌面应用中读取；浏览器预览不会加载真实客户端授权。</div>
          {:else if mcpGrantListRows().length === 0}
            <div class="empty-box">暂无持久授权；点击待确认请求的“允许并记住”后会出现在这里。</div>
          {:else}
            <div class="mcp-request-list">
              {#each mcpGrantListRows() as row}
                {@const grant = agentToolGrants.find((item: AgentToolGrant) => item.client_id === row.clientId && item.tool_name === row.toolName)}
                <div class="mcp-request-row">
                  <div class="setting-label">
                    <span>{row.toolName}</span>
                    <small>{row.clientId} · 更新于 {row.updatedAt}</small>
                    <code>{row.summary}</code>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill active">已授权</span>
                    <button
                      class="plain-button danger"
                      disabled={!grant || mcpRequestBusyKey === `grant:${row.clientId}:${row.toolName}`}
                      onclick={() => grant && revokeMcpGrant(grant)}
                    >撤销</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>最近调用审计</h3>
            <div class="row-actions">
              <span class="meta-pill">{hasTauriRuntime() ? `${mcpRecentAudits.length} 条` : "桌面端读取"}</span>
              <button class="plain-button" onclick={() => activeMenu = "data"}>打开我的数据</button>
            </div>
          </div>
          {#if !hasTauriRuntime()}
            <div class="empty-box">最近调用审计需在桌面应用中读取；浏览器预览不会加载真实 Agent 调用记录。</div>
          {:else if mcpAuditListRows().length === 0}
            <div class="empty-box">暂无调用审计；Agent 或 MCP 调用工具后会在这里显示最近记录。</div>
          {:else}
            <div class="mcp-request-list">
              {#each mcpAuditListRows() as row}
                <div class="mcp-request-row">
                  <div class="setting-label">
                    <span>{row.toolName}</span>
                    <small>{row.clientId} · {row.timestamp}</small>
                    <code>{row.preview}</code>
                  </div>
                  <div class="row-actions">
                    <span
                      class="meta-pill"
                      class:active={row.tone === "success"}
                      class:denied={row.tone === "denied"}
                      class:error={row.tone === "error"}
                      class:pending={row.tone === "pending"}
                    >
                      {row.statusLabel}
                    </span>
                    <span class="meta-pill">{row.durationLabel}</span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>MCP 服务</h3>
            <button class="plain-button" onclick={refreshMcpPage} disabled={mcpLoading}>刷新</button>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>服务状态</span>
              <small>本地 HTTP MCP Server，只绑定本机地址</small>
            </div>
            <span class="state-pill" class:enabled={mcpConnection().statusTone === "ready"}>{mcpConnection().statusLabel}</span>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>地址</span>
              <small>客户端通过 Bearer Token 访问</small>
            </div>
            <code class="mono-value">{mcpHttpUrl()}</code>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>Token</span>
              <small>{mcpConnection().securityHint}</small>
            </div>
            <code class="mono-value token-value">{mcpConnection().tokenLabel}</code>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>推荐连接</span>
              <small>HTTP ready 时优先 HTTP，否则使用 stdio proxy</small>
            </div>
            <span class="meta-pill">{mcpConnection().recommendedTransport === "http" ? "HTTP MCP" : "stdio proxy"}</span>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>复制配置提示</span>
              <small>复制 HTTP MCP 客户端配置；未启动时复制 stdio fallback 示例</small>
            </div>
            <button class="plain-button" onclick={copyMcpConfig}>复制配置</button>
          </div>
          {#if mcpPageStatus}
            <div class="inline-status">{mcpPageStatus}</div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>客户端模板</h3>
          <div class="tool-list compact-list">
            {#each mcpTemplates() as template}
              {@const installPlan = mcpInstallPlan(template)}
              <div class="tool-row">
                <div class="setting-label">
                  <span>{template.label}</span>
                  <small>{template.description}</small>
                  <div class="mcp-install-plan">
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
                  <span class="meta-pill">{template.transport}</span>
                  <span class="meta-pill active">{installPlan.writeStateLabel}</span>
                  <button
                    class="plain-button"
                    onclick={() => installMcpTemplate(template)}
                    disabled={!hasTauriRuntime() || !installPlan.writeAvailable || mcpRequestBusyKey === `mcp:install:${template.id}`}
                  >{mcpRequestBusyKey === `mcp:install:${template.id}` ? "合并中" : installPlan.writeActionLabel}</button>
                  <button class="plain-button" onclick={() => copyMcpTemplate(template)}>复制</button>
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>工具开关</h3>
          {#if agentTools.length === 0}
            <div class="empty-box">暂无可暴露工具</div>
          {:else}
            <div class="tool-list compact-list">
              {#each agentTools as tool}
                <div class="tool-row">
                  <div class="setting-label">
                    <span>{tool.name}</span>
                    <small>{tool.description || "无描述"} · {tool.scopes.join(", ")}</small>
                  </div>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      onchange={(event) => toggleAgentTool(tool, (event.target as HTMLInputElement).checked)}
                    />
                    <span></span>
                  </label>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {/if}
