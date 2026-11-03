<script lang="ts">
  import type { PendingAgentToolRequest } from "../lib/types";
  import { permissionDialogFocus } from "../lib/permissionDialogFocus";
  import { sourceBuildPermissionPresentation } from "../lib/pluginSourceBuildPermissions";
  import { pluginDisplayPermissionPresentation } from "../lib/pluginDisplayPermission";
  import {
    clipboardPermissionPresentation,
    pluginDataPermissionPresentation,
    pluginPathsPermissionPresentation,
    pluginDialogPermissionPresentation,
    pluginMainPushPermissionPresentation,
    pluginSecretStoragePermissionPresentation,
    pluginFileDropPermissionPresentation,
    pluginAiPermissionPresentation,
    pluginBrowserWindowPermissionPresentation,
    pluginBackgroundPermissionPresentation,
    type PermissionRequestContext,
  } from "../lib/permissionPresentation";
  import {
    isHighRiskScope,
    permissionRequestPreview,
    scopeLabel,
  } from "../lib/permissionPreview";

  type Props = {
    request: PendingAgentToolRequest;
    busy?: boolean;
    error?: string;
    queuedCount?: number;
    displayName?: string | null;
    requestContext?:PermissionRequestContext | null;
    onallowonce: (request: PendingAgentToolRequest) => void | Promise<void>;
    onallowremember: (request: PendingAgentToolRequest) => void | Promise<void>;
    ondeny: (request: PendingAgentToolRequest) => void | Promise<void>;
  };

  let {
    request,
    busy = false,
    error = "",
    queuedCount = 1,
    displayName = null,
    requestContext = null,
    onallowonce,
    onallowremember,
    ondeny,
  }: Props = $props();

  let sourceBuildPresentation = $derived(sourceBuildPermissionPresentation(request));
  let keyArguments = $derived(sourceBuildPresentation?.arguments ?? argumentPairs(request.arguments));
  let prettyArguments = $derived(formatJson(request.arguments));
  let privateNode = $derived(request.tool_name.startsWith("legacy_node_"));
  let mainPushPresentation = $derived(pluginMainPushPermissionPresentation(request, requestContext));
  let browserWindowPresentation = $derived(pluginBrowserWindowPermissionPresentation(request, requestContext));
  let backgroundPresentation = $derived(pluginBackgroundPermissionPresentation(request, requestContext));
  let fileDropPresentation = $derived(pluginFileDropPermissionPresentation(request, requestContext));
  let aiPresentation = $derived(pluginAiPermissionPresentation(request, requestContext));
  let clipboardPresentation = $derived(
    mainPushPresentation
      ?? browserWindowPresentation
      ?? backgroundPresentation
      ?? aiPresentation
      ?? fileDropPresentation
      ?? pluginDisplayPermissionPresentation(request, requestContext)
      ?? clipboardPermissionPresentation(request, requestContext)
      ?? pluginSecretStoragePermissionPresentation(request, requestContext)
      ?? pluginDataPermissionPresentation(request, requestContext)
      ?? pluginPathsPermissionPresentation(request, requestContext)
      ?? pluginDialogPermissionPresentation(request, requestContext),
  );
  let privatePlugin = $derived(privateNode || Boolean(clipboardPresentation));
  let preview = $derived(permissionRequestPreview(privatePlugin ? {...request,arguments:{}} : request));
  let requestTime = $derived(formatTime(request.created_at));
  let riskHints = $derived(sourceBuildPresentation?.riskHints ?? clipboardPresentation?.riskHints ?? (privateNode ? [
    "此插件可以读写本机文件、连接网络或启动进程。",
    "授权后可直接使用这些本机能力，请仅允许你信任的插件。",
  ] : preview.risks));

  function argumentPairs(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return [{ key: "arguments", value: compact(value) }];
    }

    return Object.entries(value as Record<string, unknown>)
      .slice(0, 6)
      .map(([key, argument]) => ({ key, value: compact(argument) }));
  }

  function compact(value: unknown) {
    const text = formatJson(value);
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  }

  function formatJson(value: unknown) {
    if (value === undefined) return "undefined";
    if (typeof value === "string") return value || "(空字符串)";
    try {
      return JSON.stringify(value, null, 2) ?? "null";
    } catch {
      return String(value);
    }
  }

  function formatTime(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  }

</script>

<div class="permission-overlay" role="presentation">
  <div class="permission-card" role="dialog" aria-modal="true" aria-labelledby="permission-title"
    aria-describedby={error ? "permission-status permission-error" : "permission-status"}
    aria-busy={busy} tabindex="-1" data-permission-dialog
    use:permissionDialogFocus={{ busy, deny: () => { void ondeny(request); } }}>
    <header>
      <div>
        <p class="eyebrow">{sourceBuildPresentation ? "本地插件转换" : privatePlugin ? "插件权限确认" : "Agent 权限确认"}</p>
        <h2 id="permission-title">{sourceBuildPresentation?.title ?? clipboardPresentation?.title ?? (privateNode ? displayName ? `${displayName} 请求访问本机` : "插件请求访问本机" : request.tool_name)}</h2>
      </div>
      <span class="request-time" title={request.created_at}>{requestTime}</span>
    </header>

    <p class="request-status" id="permission-status" role="status">{busy ? "正在处理此请求，请稍候…" : queuedCount > 1 ? `当前第 1 个，共 ${queuedCount} 个请求` : "请确认此操作是否由你发起"}</p>

    <dl class="summary">
      <div>
        <dt>{privatePlugin ? "请求来源" : "客户端"}</dt>
        <dd>{sourceBuildPresentation?.sourceLabel ?? (privatePlugin ? displayName || "插件名称暂不可用" : request.client_id)}</dd>
      </div>
      {#if !privatePlugin && displayName}<div><dt>插件</dt><dd>{displayName}</dd></div>{/if}
      <div>
        <dt>访问范围</dt>
        <dd class="scope-list">
          {#if mainPushPresentation}<span>{mainPushPresentation.scopeLabel}</span>{/if}
          {#if browserWindowPresentation}<span>{browserWindowPresentation.scopeLabel}</span>{/if}
          {#if backgroundPresentation}<span>{backgroundPresentation.scopeLabel}</span>{/if}
          {#each request.scopes as scope}
            {#if !browserWindowPresentation && !backgroundPresentation}
              <span class:high-risk={isHighRiskScope(scope) || (fileDropPresentation !== null && scope === "file_read")}>
                {scopeLabel(scope)}
              </span>
            {/if}
          {/each}
        </dd>
      </div>
      {#if !privatePlugin}<div>
        <dt>执行模式</dt>
        <dd>
          <span class="mode-pill" class:dry-run={preview.dryRun}>{sourceBuildPresentation?.mode ?? (preview.dryRun ? "dry-run 预览" : "可能执行")}</span>
        </dd>
      </div>{/if}
    </dl>

    <section class={`risk-box ${fileDropPresentation ? "high" : preview.riskLevel}`}>
      <strong>风险提示</strong>
      <ul>
        {#each riskHints as item}
          <li>{item}</li>
        {/each}
      </ul>
    </section>

    {#if clipboardPresentation}<p class="request-status">{clipboardPresentation.retryHint}</p>{/if}
    {#if sourceBuildPresentation}<p class="request-status">{sourceBuildPresentation.retryHint}</p>{/if}

    {#if preview.paths.length > 0}
      <section class="path-box">
        <h3>涉及路径</h3>
        <div class="path-list">
          {#each preview.paths as path}
            <code>{path}</code>
          {/each}
        </div>
      </section>
    {/if}

    {#if !fileDropPresentation && !aiPresentation && privatePlugin}
      <details class="technical-details"><summary>技术详情</summary><pre>{formatJson({ tool: request.tool_name, client: request.client_id })}</pre></details>
    {:else if !fileDropPresentation && !aiPresentation}
    <section class="arguments">
      <h3>关键参数</h3>
      <div class="argument-grid">
        {#each keyArguments as item}
          <div class="argument-row">
            <span>{item.key}</span>
            <code>{item.value}</code>
          </div>
        {/each}
      </div>
      <details>
        <summary>完整 JSON</summary>
        <pre>{prettyArguments}</pre>
      </details>
    </section>
    {/if}

    {#if error}
      <div class="error" id="permission-error" role="alert">{error}</div>
    {/if}

    <footer>
      <button class="secondary" data-permission-deny disabled={busy} onclick={() => ondeny(request)}>拒绝</button>
      <button class="primary" disabled={busy} onclick={() => onallowonce(request)}>允许一次</button>
      <button class="secondary" disabled={busy} onclick={() => onallowremember(request)}>允许并记住</button>
    </footer>
  </div>
</div>

<style>
  .permission-overlay {
    position: fixed;
    inset: 0;
    z-index: 50;
    display: grid;
    place-items: center;
    padding: 16px;
    background: rgba(10, 12, 16, 0.28);
  }

  .permission-card {
    width: min(680px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: 0 18px 58px rgba(0, 0, 0, 0.2);
  }

  header,
  footer,
  .summary,
  .arguments,
  .risk-box,
  .path-box,
  .error {
    margin: 0 16px;
  }

  .request-status { margin: 12px 16px; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
  .technical-details { margin: 12px 16px; }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 0 12px;
    border-bottom: 1px solid var(--border);
  }

  h2,
  h3,
  p {
    margin: 0;
  }

  h2 {
    margin-top: 3px;
    font-size: 17px;
    line-height: 1.25;
    word-break: break-word;
  }

  h3 {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .eyebrow,
  .request-time,
  dt,
  .risk-box li {
    font-size: 12px;
    color: var(--text-tertiary);
  }

  .request-time {
    flex-shrink: 0;
    font-family: var(--font-mono);
  }

  .summary {
    display: grid;
    gap: 8px;
    padding: 12px 0;
  }

  .summary div {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: 10px;
    align-items: start;
  }

  dd {
    margin: 0;
    min-width: 0;
    color: var(--text-primary);
    word-break: break-word;
  }

  .scope-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .scope-list span {
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 7px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 11px;
  }

  .scope-list .high-risk {
    border-color: color-mix(in srgb, var(--danger) 45%, var(--border));
    color: var(--danger);
  }

  .mode-pill {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 2px 8px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    font-size: 11px;
  }

  .mode-pill.dry-run {
    border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 9%, var(--bg-secondary));
  }

  .risk-box {
    border: 1px solid color-mix(in srgb, var(--danger) 26%, var(--border));
    border-radius: 7px;
    padding: 10px 12px;
    background: color-mix(in srgb, var(--danger) 8%, var(--bg-secondary));
  }

  .risk-box.low {
    border-color: color-mix(in srgb, var(--accent) 24%, var(--border));
    background: color-mix(in srgb, var(--accent) 7%, var(--bg-secondary));
  }

  .risk-box.medium {
    border-color: color-mix(in srgb, var(--warning) 32%, var(--border));
    background: color-mix(in srgb, var(--warning) 8%, var(--bg-secondary));
  }

  .risk-box strong {
    display: block;
    margin-bottom: 5px;
    font-size: 12px;
    color: var(--text-primary);
  }

  .risk-box ul {
    margin: 0;
    padding-left: 18px;
  }

  .risk-box li + li {
    margin-top: 3px;
  }

  .path-box {
    display: grid;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding: 10px 0 0;
    margin-top: 10px;
  }

  .path-list {
    display: grid;
    gap: 5px;
  }

  .arguments {
    display: grid;
    gap: 8px;
    padding: 12px 0 6px;
  }

  .argument-grid {
    display: grid;
    gap: 6px;
  }

  .argument-row {
    display: grid;
    grid-template-columns: minmax(96px, 28%) 1fr;
    gap: 10px;
    align-items: start;
    min-width: 0;
  }

  .argument-row span {
    color: var(--text-tertiary);
    font-size: 12px;
    word-break: break-word;
  }

  code,
  pre {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  code {
    display: block;
    min-width: 0;
    color: var(--text-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  details {
    border-top: 1px solid var(--border);
    padding-top: 8px;
  }

  summary {
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
  }

  pre {
    max-height: 150px;
    margin: 8px 0 0;
    overflow: auto;
    border-radius: 6px;
    padding: 9px;
    background: var(--bg-secondary);
    color: var(--text-secondary);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .error {
    margin-top: 8px;
    color: var(--danger);
    font-size: 12px;
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 0 16px;
    border-top: 1px solid var(--border);
  }

  button {
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 7px 11px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font-size: 12px;
    cursor: pointer;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .permission-card:focus { outline: none; }
  .primary:hover:not(:disabled) { filter: brightness(1.06); }
  button:active:not(:disabled) { transform: translateY(1px); }

  .primary {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong));
    background: var(--accent);
    color: var(--accent-foreground);
  }

  .secondary:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--bg-hover);
  }
</style>
