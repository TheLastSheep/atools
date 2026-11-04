<script lang="ts">
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import type { MemoryItem, TaskRun, TaskRunArtifact } from "../lib/types";
  import { auditDetailValue } from "../lib/auditView";
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
  import {
    copyText,
    failedItemRetryArguments,
    taskRunCanCancel,
    taskRunCanRetry,
    taskRunDuration,
    taskRunStatusMeta,
    taskRunValidationLabel,
  } from "../lib/agentPanelHelpers";

  type Props = {
    taskRuns: TaskRun[];
    memories: MemoryItem[];
    selectedTaskRunId: string;
    busyKey: string;
    onrefresh: () => Promise<void> | void;
    onselecttaskrun: (id: string) => void;
    onsetbusykey: (key: string) => void;
  };

  let {
    taskRuns,
    memories,
    selectedTaskRunId,
    busyKey,
    onrefresh,
    onselecttaskrun,
    onsetbusykey,
  }: Props = $props();

  let taskRunStatus = $state("");

  async function retryTaskRun(run: TaskRun, argumentsOverride: unknown | null = null) {
    const failedOnly = argumentsOverride !== null;
    onsetbusykey(`run:retry:${run.id}`);
    taskRunStatus = failedOnly
      ? `正在重试 ${run.capabilityId} 的失败项`
      : `正在重试 ${run.capabilityId}`;
    try {
      const retry = await invoke<TaskRun>("start_agent_tool", {
        name: run.capabilityId,
        arguments: argumentsOverride ?? run.input,
        clientId: run.initiator.clientId ?? "atools-ui",
        confirmed: false,
        retryOf: run.id,
      });
      taskRunStatus = `${run.capabilityId} 已进入后台执行（${retry.id}）`;
    } catch (e) {
      taskRunStatus = String(e);
    } finally {
      await onrefresh();
      onsetbusykey("");
    }
  }

  async function cancelTaskRun(run: TaskRun) {
    onsetbusykey(`run:cancel:${run.id}`);
    try {
      await invoke("cancel_task_run", { id: run.id });
      taskRunStatus = `${run.capabilityId} 已取消`;
      await onrefresh();
    } catch (e) {
      taskRunStatus = String(e);
    } finally {
      onsetbusykey("");
    }
  }

  async function saveTaskRunAsRecipe(run: TaskRun) {
    onsetbusykey(`run:recipe:${run.id}`);
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
      await onrefresh();
    } catch (e) {
      taskRunStatus = `保存任务配方失败：${String(e)}`;
    } finally {
      onsetbusykey("");
    }
  }

  async function copyTaskRun(run: TaskRun) {
    onsetbusykey(`run:copy:${run.id}`);
    try {
      await copyText(JSON.stringify(run, null, 2));
      taskRunStatus = `已复制 ${run.capabilityId} 的完整结果`;
    } finally {
      onsetbusykey("");
    }
  }

  async function openArtifact(artifact: TaskRunArtifact) {
    const target = artifactLocation(artifact);
    if (!target) {
      taskRunStatus = `${artifact.label} 没有可打开的受控位置`;
      return;
    }
    onsetbusykey(`artifact:open:${artifact.id}`);
    try {
      await invoke("shell_open", { url: target });
      taskRunStatus = `已打开 ${artifact.label}`;
    } catch (e) {
      taskRunStatus = `打开产物失败：${String(e)}`;
    } finally {
      onsetbusykey("");
    }
  }

  async function revealArtifact(artifact: TaskRunArtifact) {
    const path = artifact.path?.trim();
    if (!path) {
      taskRunStatus = `${artifact.label} 不是可定位的本地文件`;
      return;
    }
    onsetbusykey(`artifact:reveal:${artifact.id}`);
    try {
      await invoke("shell_show_item_in_folder", { path });
      taskRunStatus = `已定位 ${artifact.label}`;
    } catch (e) {
      taskRunStatus = `定位产物失败：${String(e)}`;
    } finally {
      onsetbusykey("");
    }
  }

  async function copyArtifact(run: TaskRun, artifact: TaskRunArtifact) {
    onsetbusykey(`artifact:copy:${artifact.id}`);
    try {
      await copyText(artifactJson(artifactPayload(artifact, run.output)));
      taskRunStatus = `已复制 ${artifact.label}`;
    } finally {
      onsetbusykey("");
    }
  }
</script>

<section class="agent-section result-center-section">
  <div class="section-title">
    <div>
      <h3>结果中心</h3>
      <p>持久 TaskRun、验收状态与结构化产物</p>
    </div>
    <button onclick={onrefresh}>刷新</button>
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
            onclick={() => onselecttaskrun(selectedTaskRunId === run.id ? "" : run.id)}
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
        {@const failedRetryArguments = failedItemRetryArguments(run)}
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
                  onclick={() => retryTaskRun(run, failedRetryArguments)}
                >{failedRetryArguments ? "重试失败项" : "重试"}</button>
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
