<script lang="ts">
  import PluginFeatureList from "./PluginFeatureList.svelte";
  import PluginPanelLoadFailure from "./PluginPanelLoadFailure.svelte";
  import PluginBrowserWindowLayer from "./PluginBrowserWindowLayer.svelte";
  import PluginContextMenuOverlay from "./PluginContextMenuOverlay.svelte";
  import type { PluginContextMenuController } from "../lib/pluginContextMenuController.svelte.js";
  import type { PluginFeatureList as PluginFeatureListState } from "../lib/pluginFeatureExportsState";
  import type { FeatureActiveOptionIdentity, FeatureActiveOptionReport } from "../lib/pluginFeatureActiveDescendant.svelte.js";
  import type { PluginHostView } from "../lib/pluginHostView";
  import type { PluginPanelLoadRetrySnapshot } from "../lib/pluginPanelLoadRetry";
  import type { PluginBrowserWindowState } from "../lib/pluginBrowserWindowTypes";
  import type { PluginRuntimePermissionRequest } from "../lib/pluginFramePermissionQueue";
  import type { Action } from "svelte/action";

  type Props = {
    hostView: PluginHostView;
    featureList: PluginFeatureListState;
    featureListA11yId: string;
    reportActiveOption: (value: FeatureActiveOptionReport | null, identity: FeatureActiveOptionIdentity) => void;
    resolveIcon: (value: string) => Promise<string>;
    onFeatureSelect: (index: number) => void;
    onFeatureHover: (index: number) => void;
    onFeaturePointerMove: () => void;
    retryView: PluginPanelLoadRetrySnapshot;
    retryPluginLoad: (source: HTMLButtonElement) => void | Promise<void>;
    onItemClick: (index: number) => void;
    outputContextMenu: { visible: boolean; x: number; y: number; itemIndex: number };
    onOpenOutputContextMenu: (event: MouseEvent, index: number) => void;
    onCopyOutputContextMenuItem: () => void;
    iframeRef?: HTMLIFrameElement | null;
    iframeEpoch: number;
    iframeAction: Action<HTMLIFrameElement>;
    iframeSrc: string;
    iframeSrcDoc: string;
    iframeInert: boolean;
    iframeSandbox: string;
    browserWindows: PluginBrowserWindowState[];
    browserWindowStyle: (window: PluginBrowserWindowState) => string;
    browserWindowFrameStyle: (window: PluginBrowserWindowState) => string;
    closeBrowserWindow: (id: string) => void;
    browserWindowFrameAction: Action<HTMLIFrameElement, string>;
    browserWindowSandbox: string;
    permissionRequest: PluginRuntimePermissionRequest | null;
    contextMenuController: PluginContextMenuController;
    pluginName: string;
    respondPermission: (request: PluginRuntimePermissionRequest, allowed: boolean, persistent?: boolean) => void;
  };
  let {
    hostView, featureList, featureListA11yId, reportActiveOption, resolveIcon,
    onFeatureSelect, onFeatureHover, onFeaturePointerMove, retryView, retryPluginLoad, onItemClick,
    outputContextMenu, onOpenOutputContextMenu, onCopyOutputContextMenuItem,
    iframeRef = $bindable(null), iframeEpoch, iframeAction, iframeSrc, iframeSrcDoc, iframeInert, iframeSandbox,
    browserWindows, browserWindowStyle, browserWindowFrameStyle, closeBrowserWindow,
    browserWindowFrameAction, browserWindowSandbox, permissionRequest, pluginName, respondPermission, contextMenuController,
  }: Props = $props();
  const respondCurrentPermission = (allowed: boolean, persistent = false) => {
    const request = permissionRequest;
    if (request) respondPermission(request, allowed, persistent);
  };
</script>

<div class="plugin-body">
  {#if featureList.mode}
    <PluginFeatureList state={featureList} resolveIcon={resolveIcon}
      listboxId={featureListA11yId} onactiveoption={reportActiveOption}
      onselect={onFeatureSelect} onhover={onFeatureHover} onpointermove={onFeaturePointerMove} />
  {/if}
  {#if hostView.bodyMode === "error" || hostView.bodyMode === "retrying"}
    <PluginPanelLoadFailure errorMessage={hostView.loadError} retryable={retryView.retryable} busy={retryView.busy} onretry={retryPluginLoad} />
  {/if}
  {#if hostView.bodyMode === "output"}
    <div class={hostView.outputLayerClass}>
      <div class="results-list">
        {#each hostView.outputRows as item, i (`${item.title}-${i}`)}
          <button class="result-item" class:selected={item.selected} onclick={() => onItemClick(i)}
            oncontextmenu={(event) => onOpenOutputContextMenu(event, i)}>
            <div class="result-content">
              <div class="result-title">{item.title}</div>
              {#if item.description}<div class="result-description">{item.description}</div>{/if}
            </div>
            {#if item.actionHint}<span class="result-hint">{item.actionHint}</span>{/if}
          </button>
        {/each}
      </div>
    </div>
    {#if outputContextMenu.visible}
      <div class="plugin-output-menu" role="menu" style={`left:${outputContextMenu.x}px;top:${outputContextMenu.y}px;`}>
        <button type="button" role="menuitem" onclick={(event) => { event.stopPropagation(); onCopyOutputContextMenuItem(); }}>复制结果</button>
      </div>
    {/if}
  {:else if hostView.bodyMode === "loading"}
    <div class="plugin-loading"><div class="spinner"></div><div class="loading-text">加载插件中...</div></div>
  {:else if hostView.bodyMode === "iframe" || hostView.bodyMode === "retrying"}
    <iframe bind:this={iframeRef} data-plugin-input-epoch={iframeEpoch} use:iframeAction
      src={iframeSrc || undefined} srcdoc={iframeSrc ? undefined : iframeSrcDoc}
      class={hostView.iframeClass} inert={iframeInert} title="Plugin" sandbox={iframeSandbox}></iframe>
  {/if}
  <PluginBrowserWindowLayer windows={browserWindows} windowStyle={browserWindowStyle} frameStyle={browserWindowFrameStyle}
    closeWindow={closeBrowserWindow} mountFrame={browserWindowFrameAction} iframeSandbox={browserWindowSandbox} />
  {#if permissionRequest}
    <div class="plugin-permission-dialog" role="dialog" aria-modal="true" aria-label="插件运行时权限请求">
      <div><strong>插件请求运行时权限</strong><p>{pluginName} 请求使用 <code>{permissionRequest.permission}</code></p></div>
      <div class="plugin-permission-actions">
        <button type="button" onclick={() => respondCurrentPermission(false)}>拒绝</button>
        <button type="button" onclick={() => respondCurrentPermission(true)}>本次会话允许</button>
        <button type="button" class="primary" onclick={() => respondCurrentPermission(true, true)}>始终允许</button>
      </div>
    </div>
  {/if}
  <PluginContextMenuOverlay controller={contextMenuController} />
</div>
