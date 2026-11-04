<script lang="ts">
  import type { AiProvider } from "../lib/settings";
  import { aiProviderOptions } from "../lib/settingsPanelTypesAndOptions";
  import type { PluginProviderDescriptor } from "../lib/types";

  let {
    activeMenu,
    aiProvider,
    aiBaseUrl = $bindable(),
    aiDefaultModel = $bindable(),
    aiApiKey = $bindable(),
    aiTemperature = $bindable(),
    aiUseForAgent = $bindable(),
    aiConnectionStatus,
    pluginProvidersLoading,
    pluginProvidersStatus,
    busyProviderId,
    refreshPluginProviders,
    setDefaultPluginProvider,
    providersForType,
    persistSoon,
    updateAiProvider,
    aiProviderLabel,
    aiBaseUrlPlaceholder,
    aiConfigReady,
    persistAiConfigChange,
    aiConnectionButton,
    aiConnectionResultRows,
    testAiConnection,
    aiOverview,
  }: Record<string, any> = $props();
</script>

    {#if activeMenu === "providers"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>能力提供商</h3>
            <button class="plain-button" onclick={refreshPluginProviders} disabled={pluginProvidersLoading}>刷新</button>
          </div>
          <div class="inline-status">
            插件可通过 ZTools Provider 契约提供翻译和 OCR 能力；默认项保存在本机，调用方也可显式指定其他渠道。
          </div>
          {#if pluginProvidersStatus}
            <div class="inline-status">{pluginProvidersStatus}</div>
          {/if}
        </section>

        {#each (["translation", "ocr"] as const) as providerType}
          {@const rows = providersForType(providerType)}
          <section class="setting-group">
            <div class="section-heading">
              <h3>{providerType === "translation" ? "翻译" : "OCR"}</h3>
              <span class="state-pill" class:enabled={rows.some((provider: PluginProviderDescriptor) => provider.isDefault)}>
                {rows.length} 个渠道
              </span>
            </div>
            {#if pluginProvidersLoading && rows.length === 0}
              <div class="empty-box">正在读取提供商</div>
            {:else if rows.length === 0}
              <div class="empty-box">暂无可用的{providerType === "translation" ? "翻译" : " OCR"}提供商，可安装声明 providers 的插件。</div>
            {:else}
              <div class="compact-list">
                {#each rows as provider}
                  <div class="data-row">
                    <div class="setting-label">
                      <span>{provider.label}</span>
                      <small>{provider.description || `${provider.pluginName} · ${provider.key}`}</small>
                      <code class="mono-value">{provider.id}</code>
                    </div>
                    <div class="row-actions">
                      <span class="meta-pill" class:enabled={provider.enabled}>
                        {provider.enabled ? "插件已启用" : "插件已停用"}
                      </span>
                      <button
                        class="plain-button"
                        class:enabled={provider.isDefault}
                        disabled={!provider.enabled || provider.isDefault || busyProviderId === provider.id}
                        onclick={() => setDefaultPluginProvider(provider)}
                      >
                        {provider.isDefault ? "当前默认" : "设为默认"}
                      </button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/each}
      </div>
    {:else if activeMenu === "ai"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>AI 模型概览</h3>
            <div class="row-actions">
              <span
                class="state-pill"
                class:enabled={aiConfigReady()}
                class:error={aiProvider !== "disabled" && !aiConfigReady()}
              >
                {aiProvider === "disabled" ? "未启用" : aiConfigReady() ? `${aiProviderLabel()} 配置已保存` : "配置不完整"}
              </span>
              <button
                class="plain-button"
                onclick={testAiConnection}
                disabled={aiConnectionButton().disabled}
                title={aiConnectionButton().reason}
              >
                {aiConnectionButton().label}
              </button>
            </div>
          </div>
          <div class="inline-status">
            连接测试只读取 /models，不会发送聊天内容；API Key 仅本地保存，不写入审计或 MCP 配置。
          </div>
          {#if aiConnectionStatus}
            <div class="inline-status">{aiConnectionStatus}</div>
          {/if}

          <div class="ai-overview-grid" aria-label="AI 模型概览：模型提供商、默认模型、Agent 默认、连接状态">
            {#each aiOverview() as card}
              <div
                class="ai-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:disabled={card.tone === "disabled"}
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
          <h3>模型配置</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>模型提供商</span>
              <small>选择 OpenAI、兼容 API 或本地模型服务</small>
            </div>
            <select
              class="select-control"
              value={aiProvider}
              aria-label="AI 模型提供商"
              onchange={(event) => updateAiProvider((event.currentTarget as HTMLSelectElement).value as AiProvider)}
            >
              {#each aiProviderOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>API Base URL</span>
              <small>{aiProvider === "local" ? "本地模型服务地址，需兼容 OpenAI /v1 接口" : "远端接口地址，仅本地保存"}</small>
            </div>
            <input
              class="text-input wide"
              bind:value={aiBaseUrl}
              placeholder={aiBaseUrlPlaceholder()}
              aria-label="AI API Base URL"
              disabled={aiProvider === "disabled"}
              oninput={persistAiConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>默认模型</span>
              <small>例如 gpt-4.1-mini、qwen-max 或本地模型名</small>
            </div>
            <input
              class="text-input wide"
              bind:value={aiDefaultModel}
              placeholder="模型名"
              aria-label="AI 默认模型"
              disabled={aiProvider === "disabled"}
              oninput={persistAiConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>API Key</span>
              <small>{aiProvider === "local" ? "本地服务通常可留空" : "仅本机保存；不会导出到 MCP 客户端配置"}</small>
            </div>
            <input
              class="text-input wide"
              type="password"
              bind:value={aiApiKey}
              placeholder={aiProvider === "local" ? "可选" : "sk-..."}
              aria-label="AI API Key"
              disabled={aiProvider === "disabled"}
              oninput={persistAiConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>温度</span>
              <small>控制生成随机性，范围 0 到 2</small>
            </div>
            <div class="range-control">
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                bind:value={aiTemperature}
                aria-label="AI 温度"
                disabled={aiProvider === "disabled"}
                oninput={persistSoon}
              />
              <output>{Number(aiTemperature).toFixed(1)}</output>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>用于 Agent 默认模型</span>
              <small>开启后 ask_ai_model 工具会读取这组本地配置</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                bind:checked={aiUseForAgent}
                disabled={aiProvider === "disabled"}
                onchange={persistSoon}
              />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>配置预览</h3>
          <div class="debug-grid">
            <div class="debug-row">
              <span>提供商</span>
              <code>{aiProviderLabel()}</code>
            </div>
            <div class="debug-row">
              <span>模型</span>
              <code>{aiDefaultModel || "未设置"}</code>
            </div>
            <div class="debug-row">
              <span>Base URL</span>
              <code>{aiBaseUrl || "未设置"}</code>
            </div>
            <div class="debug-row">
              <span>密钥</span>
              <code>{aiApiKey ? "已填写，本地保存" : "未填写"}</code>
            </div>
            <div class="debug-row">
              <span>Agent 默认</span>
              <code>{aiUseForAgent && aiProvider !== "disabled" ? "启用" : "未启用"}</code>
            </div>
          </div>
        </section>

        {#if aiConnectionResultRows().length}
          <section class="setting-group">
            <h3>连接测试</h3>
            <div class="debug-grid">
              {#each aiConnectionResultRows() as row}
                <div class="debug-row">
                  <span>{row.label}</span>
                  <code>{row.value}</code>
                </div>
              {/each}
            </div>
          </section>
        {/if}
      </div>
    {/if}
