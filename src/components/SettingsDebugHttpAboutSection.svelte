<script lang="ts">
  import AToolsMark from "./AToolsMark.svelte";
  import { appUpdaterState } from "../lib/appUpdater";
  import {
    hasTauriRuntime,
    placeholderPages,
    type MenuId,
  } from "../lib/settingsPanelTypesAndOptions";

  let {
    activeMenu = $bindable(),
    menuItems,
    mcpPageStatus,
    debugLoading,
    debugStatus,
    debugMcpStatus,
    crashLogs,
    aboutLoading,
    aboutPageStatus,
    copyHttpMcpUrl,
    copyHttpMcpConfig,
    copyAboutRuntimeInfo,
    copyAboutDiagnosticBundle,
    mcpConnection,
    refreshDebugPage,
    copyDebugInfo,
    copyCrashLog,
    clearCrashLog,
    environmentRows,
    localDebugRows,
    runtimeDebugRows,
    auditErrorRows,
    crashLogRows,
    debugOverview,
    appUpdaterStatusText,
    appUpdaterCheckedAtText,
    appUpdaterBusy,
    checkForAppUpdate,
    installAppUpdate,
    httpStatusPage,
    httpOverview,
    aboutPage,
    aboutOverview,
    aboutRuntimeRows,
  }: Record<string, any> = $props();
</script>

    {#if activeMenu === "debug"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>诊断概览</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={refreshDebugPage} disabled={debugLoading}>刷新</button>
              <button class="plain-button" onclick={copyDebugInfo}>复制信息</button>
            </div>
          </div>
          {#if debugStatus}
            <div class="inline-status">{debugStatus}</div>
          {/if}
          <div class="inline-status">
            脱敏诊断包不会包含 MCP token、AI API Key 或 WebDAV 密码；路径、审计和崩溃信息仅保存在本机。
          </div>
          <div class="debug-overview-grid" aria-label="诊断概览：桌面运行时、MCP 服务、审计异常、崩溃日志">
            {#each debugOverview() as card}
              <div
                class="debug-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:error={card.tone === "error"}
                class:desktop={card.tone === "desktop"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>环境信息</h3>
          <div class="debug-grid">
            {#each environmentRows() as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>桌面运行状态</h3>
          <div class="debug-grid">
            {#each runtimeDebugRows() as row}
              <div class="debug-row diagnostic-row" class:warning={row.tone === "warning"} class:error={row.tone === "error"}>
                <span>{row.label}</span>
                <div class="debug-value">
                  <code>{row.value}</code>
                  {#if row.detail}
                    <small>{row.detail}</small>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>本地配置状态</h3>
          <div class="debug-grid">
            {#each localDebugRows() as row}
              <div class="debug-row diagnostic-row" class:warning={row.tone === "warning"} class:error={row.tone === "error"}>
                <span>{row.label}</span>
                <div class="debug-value">
                  <code>{row.value}</code>
                  {#if row.detail}
                    <small>{row.detail}</small>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>MCP 状态</h3>
          <div class="debug-grid">
            <div class="debug-row">
              <span>状态</span>
              <code>{debugMcpStatus?.enabled ? "运行中" : "未启动"}</code>
            </div>
            <div class="debug-row">
              <span>地址</span>
              <code>{debugMcpStatus ? `http://${debugMcpStatus.bind}/mcp` : "无"}</code>
            </div>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>崩溃日志</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={copyCrashLog} disabled={!hasTauriRuntime() || crashLogs.length === 0}>复制日志</button>
              <button class="plain-button danger" onclick={clearCrashLog} disabled={!hasTauriRuntime() || crashLogs.length === 0}>清空</button>
            </div>
          </div>
          {#if crashLogRows().length === 0}
            <div class="empty-box">暂无崩溃日志；panic 会写入本地 crashes.log</div>
          {:else}
            <div class="compact-list">
              {#each crashLogRows() as crash}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{crash.title}</span>
                    <small>{crash.detail}</small>
                  </div>
                  <code class="mono-value">{crash.raw}</code>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>最近审计错误</h3>
          {#if auditErrorRows().length === 0}
            <div class="empty-box">暂无审计错误</div>
          {:else}
            <div class="compact-list">
              {#each auditErrorRows() as audit}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{audit.toolName}</span>
                    <small>{audit.clientId} · {audit.timestamp} · {audit.duration}</small>
                  </div>
                  <div class="audit-error-meta">
                    <span class="meta-pill error">{audit.status}</span>
                    <code class="mono-value">{audit.message}</code>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "http"}
      {@const httpStatus = httpStatusPage()}
      {@const httpSummary = httpOverview()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>HTTP 服务概览</h3>
            <span class="state-pill error">{httpStatus.label}</span>
          </div>
          <div class="inline-status">{httpStatus.summary}</div>
          <div class="inline-status">传统 HTTP API 不在当前版本启用；自动化入口统一收敛到本机 MCP 服务。</div>
          <div class="http-overview-grid" aria-label="HTTP 服务概览：HTTP API、替代入口、认证审计、客户端配置">
            {#each httpSummary as card}
              <div
                class="http-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>MCP 连接入口</h3>
            <span class="state-pill" class:enabled={mcpConnection().statusTone === "ready"}>{mcpConnection().statusLabel}</span>
          </div>
          <div class="inline-status">{mcpConnection().securityHint}</div>
          <div class="debug-grid">
            {#each httpStatus.rows as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
          <div class="compact-list">
            <div class="data-row">
              <div class="setting-label">
                <span>MCP 地址</span>
                <small>本地 HTTP MCP + Bearer token；工具调用会进入权限确认和审计链路</small>
              </div>
              <div class="row-actions">
                <code class="mono-value">{mcpConnection().httpUrl}</code>
                <button class="plain-button" onclick={copyHttpMcpUrl} disabled={!mcpConnection().tokenAvailable}>复制 MCP 地址</button>
              </div>
            </div>
            <div class="data-row">
              <div class="setting-label">
                <span>客户端配置</span>
                <small>HTTP MCP 未就绪时会复制 stdio proxy fallback；权限和审计仍在桌面端处理</small>
              </div>
              <div class="row-actions">
                <button class="plain-button" onclick={copyHttpMcpConfig}>复制 MCP 配置</button>
                <button class="plain-button" onclick={() => activeMenu = "mcp"}>查看 MCP 服务</button>
              </div>
            </div>
            <div class="data-row muted-row">
              <div class="setting-label">
                <span>传统 HTTP API</span>
                <small>例如 show/hide/toggle 主窗口的 REST API，首版暂不启用</small>
              </div>
              <span class="meta-pill">未接入</span>
            </div>
          </div>
          {#if mcpPageStatus}
            <div class="inline-status">{mcpPageStatus}</div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "about"}
      {@const about = aboutPage()}
      {@const aboutSummary = aboutOverview()}
      <div class="content-panel about-panel">
        <section class="setting-group">
          <div class="section-heading">
            <div class="about-title-row">
              <AToolsMark size="small" />
              <div>
                <h3>关于概览</h3>
                <small>{about.title} · v{about.version}</small>
              </div>
            </div>
            <span class="state-pill" class:enabled={!aboutLoading}>{aboutLoading ? "刷新中" : "已就绪"}</span>
          </div>
          <div class="inline-status">
            诊断包只包含本机运行状态和脱敏配置；MCP token、AI API Key 和 WebDAV 密码不会写入复制内容。
          </div>
          <div class="about-overview-grid" aria-label="关于概览：版本、桌面运行时、本地 MCP、诊断包">
            {#each aboutSummary as card}
              <div
                class="about-overview-card"
                class:ready={card.tone === "ready"}
                class:desktop={card.tone === "desktop"}
                class:private={card.tone === "private"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>产品方向</h3>
          <div class="about-card-grid">
            {#each about.cards as card}
              <div class="about-card">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>运行信息</h3>
            <span class="state-pill" class:enabled={!aboutLoading}>{aboutLoading ? "刷新中" : "已就绪"}</span>
          </div>
          <div class="debug-grid">
            {#each about.rows as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>本地环境</h3>
          <div class="debug-grid">
            {#each aboutRuntimeRows() as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <div>
              <h3>应用更新</h3>
              <small>通过 GitHub Releases 获取经过签名验证的稳定版更新</small>
            </div>
            <span
              class="state-pill"
              class:enabled={$appUpdaterState.phase === "up-to-date" || $appUpdaterState.phase === "available"}
              class:error={$appUpdaterState.phase === "error"}
            >{appUpdaterStatusText($appUpdaterState)}</span>
          </div>
          <div class="compact-list">
            <div class="data-row">
              <div class="setting-label">
                <span>稳定版通道</span>
                <small>
                  当前 v{about.version} · 上次检查：{appUpdaterCheckedAtText($appUpdaterState)}
                </small>
                {#if $appUpdaterState.update?.body}
                  <small>更新说明：{$appUpdaterState.update.body}</small>
                {/if}
              </div>
              <div class="row-actions">
                <button
                  class="plain-button"
                  onclick={checkForAppUpdate}
                  disabled={!hasTauriRuntime() || appUpdaterBusy($appUpdaterState)}
                >检查更新</button>
                {#if $appUpdaterState.update}
                  <button
                    class="plain-button primary"
                    onclick={installAppUpdate}
                    disabled={!hasTauriRuntime() || appUpdaterBusy($appUpdaterState)}
                  >更新并重启</button>
                {/if}
              </div>
            </div>
          </div>
        </section>

        <section class="setting-group">
          <h3>诊断入口</h3>
          <div class="compact-list">
            <div class="data-row">
              <div class="setting-label">
                <span>复制运行信息</span>
                <small>版本、平台、本地数据路径、Agent 工具数量和 MCP 监听地址；token 会隐藏</small>
              </div>
              <button class="plain-button" onclick={copyAboutRuntimeInfo}>复制运行信息</button>
            </div>
            <div class="data-row">
              <div class="setting-label">
                <span>复制脱敏诊断</span>
                <small>复制 atools_diagnostic_bundle；不包含 MCP token、AI API Key 或 WebDAV 密码</small>
              </div>
              <button class="plain-button" onclick={copyAboutDiagnosticBundle}>复制脱敏诊断</button>
            </div>
            <div class="data-row">
              <div class="setting-label">
                <span>排障页面</span>
                <small>进入调试日志查看运行事件，或进入 MCP 服务复制客户端配置</small>
              </div>
              <div class="row-actions">
                <button class="plain-button" onclick={() => activeMenu = "debug"}>打开调试日志</button>
                <button class="plain-button" onclick={() => activeMenu = "mcp"}>打开 MCP 服务</button>
              </div>
            </div>
          </div>
          {#if aboutPageStatus}
            <div class="inline-status">{aboutPageStatus}</div>
          {/if}
        </section>
      </div>
    {:else}
      <div class="content-panel placeholder-panel">
        <section class="setting-group">
          <h3>{menuItems.find((item: { id: string; label: string }) => item.id === activeMenu)?.label}</h3>
          {#each placeholderPages[activeMenu as MenuId] ?? [] as row}
            <div class="setting-item">
              <div class="setting-label">
                <span>{row.title}</span>
                <small>{row.desc}</small>
              </div>
              <span class="meta-pill">{row.meta}</span>
            </div>
          {/each}
        </section>
      </div>
    {/if}
