<script lang="ts">
  import type { PendingAgentToolRequest } from "../lib/types";
  import {
    isHighRiskScope,
    permissionRequestPreview,
    scopeLabel,
  } from "../lib/permissionPreview";

  type Props = {
    request: PendingAgentToolRequest;
    busy?: boolean;
    error?: string;
    onallowonce: (request: PendingAgentToolRequest) => void | Promise<void>;
    onallowremember: (request: PendingAgentToolRequest) => void | Promise<void>;
    ondeny: (request: PendingAgentToolRequest) => void | Promise<void>;
  };

  let {
    request,
    busy = false,
    error = "",
    onallowonce,
    onallowremember,
    ondeny,
  }: Props = $props();

  let keyArguments = $derived(argumentPairs(request.arguments));
  let prettyArguments = $derived(formatJson(request.arguments));
  let preview = $derived(permissionRequestPreview(request));

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

</script>

<div class="permission-overlay" role="presentation">
  <div class="permission-card" role="dialog" aria-modal="true" aria-labelledby="permission-title">
    <header>
      <div>
        <p class="eyebrow">Agent 权限确认</p>
        <h2 id="permission-title">{request.tool_name}</h2>
      </div>
      <span class="request-time">{request.created_at}</span>
    </header>

    <dl class="summary">
      <div>
        <dt>客户端</dt>
        <dd>{request.client_id}</dd>
      </div>
      <div>
        <dt>Scope</dt>
        <dd class="scope-list">
          {#each request.scopes as scope}
            <span class:high-risk={isHighRiskScope(scope)}>{scopeLabel(scope)}</span>
          {/each}
        </dd>
      </div>
      <div>
        <dt>执行模式</dt>
        <dd>
          <span class="mode-pill" class:dry-run={preview.dryRun}>{preview.dryRun ? "dry-run 预览" : "可能执行"}</span>
        </dd>
      </div>
    </dl>

    <section class={`risk-box ${preview.riskLevel}`}>
      <strong>风险提示</strong>
      <ul>
        {#each preview.risks as item}
          <li>{item}</li>
        {/each}
      </ul>
    </section>

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

    {#if error}
      <div class="error">{error}</div>
    {/if}

    <footer>
      <button class="secondary" disabled={busy} onclick={() => ondeny(request)}>拒绝</button>
      <button class="secondary" disabled={busy} onclick={() => onallowonce(request)}>允许一次</button>
      <button class="primary" disabled={busy} onclick={() => onallowremember(request)}>允许并记住</button>
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
