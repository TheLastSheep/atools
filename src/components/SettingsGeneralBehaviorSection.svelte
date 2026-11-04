<script lang="ts">
  import LauncherTabTargetPicker from "./LauncherTabTargetPicker.svelte";
  import PluginMarketSourceAction from "./PluginMarketSourceAction.svelte";
  import { preferredMarketUrl } from "../lib/pluginMarketView";
  import { generalUnsupportedCapabilities } from "../lib/settingsPages";
  import {
    autoBackToSearchOptions,
    autoClearOptions,
    autoPasteOptions,
    callHumanCapability,
    devToolsModeOptions,
    hasTauriRuntime,
    rowOptions,
    searchModeOptions,
    tabKeyOptions,
    windowPositionStrategyOptions,
  } from "../lib/settingsPanelTypesAndOptions";

  let {
    activeMenu,
    placeholder = $bindable(),
    searchMode = $bindable(),
    showRecentInSearch = $bindable(),
    showMatchRecommendation = $bindable(),
    localAppSearch = $bindable(),
    localLaunchSearch = $bindable(),
    spaceOpenCommand = $bindable(),
    recentRows = $bindable(),
    pinnedRows = $bindable(),
    tabKeyFunction = $bindable(),
    tabTarget = $bindable(),
    autoPaste = $bindable(),
    autoClear = $bindable(),
    autoBackToSearch = $bindable(),
    pluginEscapeToSearch = $bindable(),
    windowDefaultHeight = $bindable(),
    windowPositionStrategy = $bindable(),
    clipboardRetentionDays = $bindable(),
    superPanelEnabled = $bindable(),
    superPanelStatus,
    floatingBallEnabled = $bindable(),
    floatingBallStatus,
    proxyEnabled = $bindable(),
    proxyUrl = $bindable(),
    pluginMarketCustom = $bindable(),
    pluginMarketUrl = $bindable(),
    pluginMarketTrustedPublicKeysText = $bindable(),
    devToolsMode = $bindable(),
    devtoolsStatus,
    disableGpuAcceleration = $bindable(),
    persistSoon,
    persistFloatingBallChange,
    persistSuperPanelChange,
    openDevtoolsForWindow,
  }: Record<string, any> = $props();
</script>

{#if activeMenu === "general"}
        <fieldset class="settings-fieldset" oninput={persistSoon} onchange={persistSoon}>
        <section class="setting-group">
          <h3>搜索</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>搜索框提示文字</span>
              <small>自定义搜索框的占位提示文字</small>
            </div>
            <input class="text-input wide" bind:value={placeholder} aria-label="搜索框提示文字" />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>搜索框模式</span>
              <small>选择搜索框的显示模式</small>
            </div>
            <select class="select-control" bind:value={searchMode}>
              {#each searchModeOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>搜索框显示最近使用</span>
              <small>开启后搜索框将显示最近使用的应用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={showRecentInSearch} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>匹配推荐</span>
              <small>推荐分组尚未接入搜索结果，暂不启用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={showMatchRecommendation} disabled />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>最近使用显示行数</span>
              <small>设置最近使用列表显示的行数（每行9个）</small>
            </div>
            <select class="select-control compact" bind:value={recentRows}>
              {#each rowOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>固定栏显示行数</span>
              <small>设置主搜索首页固定指令最多显示的行数（每行9个）</small>
            </div>
            <select class="select-control compact" bind:value={pinnedRows}>
              {#each rowOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>本地应用搜索</span>
              <small>开启后桌面应用会搜索 /Applications 和用户 Applications 下的应用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={localAppSearch} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>本地启动搜索</span>
              <small>关闭后主搜索不再匹配自定义本地启动项</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={localLaunchSearch} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>空格打开指令</span>
              <small>搜索框为空时按空格键打开选中的指令</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={spaceOpenCommand} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>Tab 功能</span>
              <small>设置 Tab 键用于切换选中项，或直接进入指定指令</small>
            </div>
            <select class="select-control" bind:value={tabKeyFunction}>
              {#each tabKeyOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>
          {#if tabKeyFunction === "target-command"}
            <LauncherTabTargetPicker value={tabTarget} onchange={(value) => { tabTarget = value; persistSoon(); }} />
          {/if}
        </section>

        <section class="setting-group">
          <h3>行为</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>自动粘贴搜索框</span>
              <small>呼出后在设定时间内自动填入最近复制的文本</small>
            </div>
            <select class="select-control" bind:value={autoPaste} aria-label="自动粘贴搜索框">
              {#each autoPasteOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>自动清空搜索框</span>
              <small>执行链接、本地启动、复制等内置动作后清空输入</small>
            </div>
            <select class="select-control" bind:value={autoClear}>
              {#each autoClearOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>自动返回到搜索</span>
              <small>进入设置、Agent 等内置面板后按设定时间返回主搜索</small>
            </div>
            <select class="select-control" bind:value={autoBackToSearch}>
              {#each autoBackToSearchOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>ESC 退出插件</span>
              <small>关闭后 ESC 交给插件处理，适合插件内弹窗、编辑器和队列操作</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={pluginEscapeToSearch} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>插件默认高度</span>
              <small>设置进入插件时的默认高度（像素）</small>
            </div>
            <input class="number-input" type="number" min="200" bind:value={windowDefaultHeight} aria-label="插件默认高度" />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>窗口呼出位置</span>
              <small>多屏切换时决定主窗口出现在哪块屏幕以及是否恢复上次位置</small>
            </div>
            <select class="select-control" bind:value={windowPositionStrategy} aria-label="窗口呼出位置">
              {#each windowPositionStrategyOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>剪贴板历史保存天数</span>
              <small>Agent 搜索剪贴板时会按此天数保留本地历史</small>
            </div>
            <input class="number-input" type="number" min="1" max="3650" bind:value={clipboardRetentionDays} aria-label="剪贴板历史保存天数" />
          </div>
        </section>

        <section class="setting-group">
          <h3>超级面板</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>启用超级面板</span>
              <small>{superPanelStatus || (superPanelEnabled ? "超级面板会常驻屏幕上方，显示剪贴板文本和主搜索入口" : "关闭后不创建超级面板窗口")}</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={superPanelEnabled} oninput={(event) => event.stopPropagation()} onchange={persistSuperPanelChange} />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>悬浮球</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>显示悬浮球</span>
              <small>{floatingBallStatus || (floatingBallEnabled ? "悬浮球窗口会常驻屏幕边缘，点击可打开主搜索" : "关闭后不创建悬浮球窗口")}</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={floatingBallEnabled} oninput={(event) => event.stopPropagation()} onchange={persistFloatingBallChange} />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>网络</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>网络代理</span>
              <small>{proxyEnabled ? "代理将用于 WebDAV 同步和 AI 模型连接测试" : "填写代理地址后可用于 WebDAV 同步和 AI 模型连接测试"}</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                bind:checked={proxyEnabled}
                disabled={!proxyUrl.trim()}
                onchange={persistSoon}
                title={proxyUrl.trim() ? "启用网络代理" : "先填写代理地址"}
              />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>代理地址</span>
              <small>支持 http/https 代理，例如 http://127.0.0.1:7890</small>
            </div>
            <input
              class="input-control"
              bind:value={proxyUrl}
              oninput={() => {
                if (!proxyUrl.trim()) proxyEnabled = false;
                persistSoon();
              }}
              placeholder="http://127.0.0.1:7890"
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>自定义插件市场</span>
              <small>{pluginMarketCustom ? "插件市场页将使用该地址" : "默认使用 ZTools 官方市场；填写地址后可切换兼容目录"}</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                bind:checked={pluginMarketCustom}
                disabled={!pluginMarketUrl.trim()}
                onchange={persistSoon}
                title={pluginMarketUrl.trim() ? "启用自定义插件市场地址" : "先填写插件市场地址"}
              />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>插件市场地址</span>
              <small>支持 ATools 扁平目录、ZTools 3 市场 API 与 legacy plugins.json；自定义无签名来源始终拒绝安装</small>
              <PluginMarketSourceAction
                sourceUrl={preferredMarketUrl({ custom: pluginMarketCustom, url: pluginMarketUrl })}
                runtime={hasTauriRuntime()}
                label="打开市场地址"
                callCapability={callHumanCapability}
              />
            </div>
            <input
              class="input-control"
              bind:value={pluginMarketUrl}
              oninput={() => {
                if (!pluginMarketUrl.trim()) pluginMarketCustom = false;
                persistSoon();
              }}
              placeholder="https://market.example.com/catalog.json"
            />
          </div>
          <div class="setting-item setting-item-stacked">
            <div class="setting-label">
              <span>受信任 Ed25519 公钥</span>
              <small>每行一个 32 字节公钥的 Base64；市场目录提供的公钥不会自动成为信任锚</small>
            </div>
            <textarea
              class="input-control"
              rows="3"
              bind:value={pluginMarketTrustedPublicKeysText}
              oninput={persistSoon}
              placeholder="Base64 Ed25519 public key"
              spellcheck="false"
            ></textarea>
          </div>
        </section>

        <section class="setting-group">
          <h3>开发者</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>开发者工具位置</span>
              <small>插件 DevTools 会按该偏好打开；原生停靠能力取决于当前 WebView</small>
            </div>
            <select class="select-control" bind:value={devToolsMode} onchange={persistSoon}>
              {#each devToolsModeOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>DevTools 测试</span>
              <small>{devtoolsStatus || "在桌面端按当前偏好打开主窗口 DevTools"}</small>
            </div>
            <button class="plain-button" onclick={() => openDevtoolsForWindow("main")} disabled={!hasTauriRuntime()}>
              打开主窗口 DevTools
            </button>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>关闭 GPU 加速</span>
              <small>启动参数尚未接入，暂不启用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={disableGpuAcceleration} disabled />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>首版暂缓能力</h3>
          <div class="compact-list">
            {#each generalUnsupportedCapabilities() as capability}
              <div class="data-row compact muted-row">
                <div class="setting-label">
                  <span>{capability.label}</span>
                  <small>{capability.description}</small>
                </div>
                <span class="meta-pill">{capability.status}</span>
              </div>
            {/each}
          </div>
        </section>
        </fieldset>
{/if}
