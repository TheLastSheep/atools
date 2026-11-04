<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import type { Capability, MemoryItem, SkillDefinition } from "../lib/types";
  import { auditDetailValue } from "../lib/auditView";
  import {
    buildMemoryInput,
    capabilityInvocationLabel,
    capabilitySourceLabel,
    copyText,
    defaultSkillManifest,
    parsedSkillInput,
  } from "../lib/agentPanelHelpers";

  type Props = {
    capabilities: Capability[];
    skills: SkillDefinition[];
    memories: MemoryItem[];
    busyKey: string;
    onrefresh: () => Promise<void> | void;
    onsetbusykey: (key: string) => void;
  };

  let {
    capabilities,
    skills,
    memories,
    busyKey,
    onrefresh,
    onsetbusykey,
  }: Props = $props();

  let skillStatus = $state("");
  let editingSkillId = $state("");
  let skillManifest = $state(JSON.stringify(defaultSkillManifest(), null, 2));

  let memoryStatus = $state("");
  let editingMemoryId = $state("");
  let memoryType = $state<MemoryItem["type"]>("preference");
  let memoryApproval = $state<MemoryItem["approval"]>("explicit");
  let memoryTool = $state("");
  let memoryWorkspace = $state("");
  let memoryContent = $state('{"arguments":{}}');
  let memoryConfidence = $state("1");
  let memoryExpiresAt = $state("");

  function resetSkillForm() {
    editingSkillId = "";
    skillManifest = JSON.stringify(defaultSkillManifest(), null, 2);
  }

  function editSkill(skill: SkillDefinition) {
    editingSkillId = skill.id;
    const { enabled: _enabled, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = skill;
    skillManifest = JSON.stringify(input, null, 2);
  }

  async function saveSkill() {
    onsetbusykey("skill:save");
    try {
      const input = parsedSkillInput(skillManifest);
      if (editingSkillId) {
        await invoke<SkillDefinition>("update_skill", { id: editingSkillId, input });
        skillStatus = "Skill 已更新；MCP resource 与 prompt 会立即使用新版本";
      } else {
        await invoke<SkillDefinition>("create_skill", { input });
        skillStatus = "Skill 已保存并进入本地能力方法目录";
      }
      resetSkillForm();
      await onrefresh();
    } catch (e) {
      skillStatus = String(e);
    } finally {
      onsetbusykey("");
    }
  }

  async function toggleSkill(skill: SkillDefinition) {
    onsetbusykey(`skill:toggle:${skill.id}`);
    try {
      await invoke("set_skill_enabled", { id: skill.id, enabled: !skill.enabled });
      await onrefresh();
    } finally {
      onsetbusykey("");
    }
  }

  async function deleteSkill(skill: SkillDefinition) {
    onsetbusykey(`skill:delete:${skill.id}`);
    try {
      await invoke("delete_skill", { id: skill.id });
      if (editingSkillId === skill.id) resetSkillForm();
      skillStatus = "Skill 已删除";
      await onrefresh();
    } finally {
      onsetbusykey("");
    }
  }

  async function exportSkills() {
    onsetbusykey("skill:export");
    try {
      await copyText(await invoke<string>("export_skills_json"));
      skillStatus = `已复制 ${skills.length} 个 SkillDefinition`;
    } finally {
      onsetbusykey("");
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

  async function saveMemory() {
    onsetbusykey("memory:save");
    try {
      const input = buildMemoryInput({
        memoryType,
        memoryApproval,
        memoryTool,
        memoryWorkspace,
        memoryContent,
        memoryConfidence,
        memoryExpiresAt,
      });
      if (editingMemoryId) {
        await invoke<MemoryItem>("update_memory_item", { id: editingMemoryId, input });
        memoryStatus = "记忆已更新";
      } else {
        await invoke<MemoryItem>("create_memory_item", { input });
        memoryStatus = "记忆已保存；执行时仅作为缺省参数，不覆盖显式输入";
      }
      resetMemoryForm();
      await onrefresh();
    } catch (e) {
      memoryStatus = String(e);
    } finally {
      onsetbusykey("");
    }
  }

  async function toggleMemory(item: MemoryItem) {
    onsetbusykey(`memory:toggle:${item.id}`);
    try {
      await invoke("set_memory_item_enabled", { id: item.id, enabled: !item.enabled });
      await onrefresh();
    } finally {
      onsetbusykey("");
    }
  }

  async function deleteMemory(item: MemoryItem) {
    onsetbusykey(`memory:delete:${item.id}`);
    try {
      await invoke("delete_memory_item", { id: item.id });
      if (editingMemoryId === item.id) resetMemoryForm();
      memoryStatus = "记忆已删除";
      await onrefresh();
    } finally {
      onsetbusykey("");
    }
  }

  async function exportMemories() {
    onsetbusykey("memory:export");
    try {
      await copyText(await invoke<string>("export_memory_items_json"));
      memoryStatus = `已复制 ${memories.length} 条记忆 JSON`;
    } finally {
      onsetbusykey("");
    }
  }

  async function clearMemories() {
    onsetbusykey("memory:clear");
    try {
      const count = await invoke<number>("clear_memory_items");
      resetMemoryForm();
      memoryStatus = `已清空 ${count} 条记忆`;
      await onrefresh();
    } finally {
      onsetbusykey("");
    }
  }
</script>

<section class="agent-section skill-section">
  <div class="section-title">
    <div>
      <h3>能力目录</h3>
      <p>内置工具、插件工具、插件 Feature 与 Skill 共用稳定标识、schema、权限、执行器和可用性合同</p>
    </div>
    <button onclick={onrefresh}>刷新</button>
  </div>
  {#if capabilities.length === 0}
    <div class="empty">暂无已注册能力</div>
  {:else}
    <div class="capability-list">
      {#each capabilities as capability}
        <article class="capability-row" class:disabled={!capability.availability.available}>
          <div class="capability-row-head">
            <div>
              <strong>{capability.name}</strong>
              <code>{capability.id} · v{capability.version}</code>
            </div>
            <div class="capability-tags">
              <span>{capabilitySourceLabel(capability)}</span>
              <span>{capabilityInvocationLabel(capability)}</span>
              <span>{capability.availability.available ? "可用" : capability.availability.reason ?? "不可用"}</span>
            </div>
          </div>
          <p>{capability.description}</p>
          <div class="capability-meta">
            <span>来源 · {capability.source.name} / {capability.source.id}</span>
            <span>执行器 · {capability.executor.kind} / {capability.executor.id}</span>
            <span>权限 · {capability.permissionScopes.join("、") || "无"}</span>
            <span>兼容 · ATools {capability.compatibility.testedAtoolsVersion} / {capability.compatibility.platforms.join("、")}</span>
          </div>
        </article>
      {/each}
    </div>
  {/if}
</section>

<section class="agent-section skill-section">
  <div class="section-title">
    <div>
      <h3>Skills</h3>
      <p>声明能力依赖、执行顺序、权限、失败恢复、验收和结果建议；Skill 本身不绕过工具权限</p>
    </div>
    <div class="row-actions">
      <button disabled={busyKey === "skill:export" || skills.length === 0} onclick={exportSkills}>导出</button>
      <button onclick={onrefresh}>刷新</button>
    </div>
  </div>
  <div class="skill-editor">
    <label>
      <span>SkillDefinition JSON</span>
      <textarea bind:value={skillManifest} rows="16" spellcheck="false"></textarea>
    </label>
    <div class="row-actions">
      <button disabled={busyKey === "skill:save"} onclick={saveSkill}>{editingSkillId ? "更新 Skill" : "保存 Skill"}</button>
      {#if editingSkillId}<button onclick={resetSkillForm}>取消编辑</button>{/if}
    </div>
    <p>稳定 id 只允许字母、数字、点、下划线和连字符；每个步骤必须引用已声明 capability，且至少包含一条验收规则和结果建议。</p>
  </div>
  {#if skillStatus}<div class="empty">{skillStatus}</div>{/if}
  {#if skills.length === 0}
    <div class="empty">暂无本地 Skill。保存后会通过 MCP `atools://skills` resource 和独立 prompt 暴露给外部 Agent。</div>
  {:else}
    <div class="skill-list">
      {#each skills as skill}
        <article class="skill-row" class:disabled={!skill.enabled}>
          <div class="skill-row-head">
            <div>
              <strong>{skill.name}</strong>
              <code>{skill.id} · v{skill.version}</code>
            </div>
            <div class="row-actions">
              <button onclick={() => editSkill(skill)}>编辑</button>
              <button disabled={busyKey === `skill:toggle:${skill.id}`} onclick={() => toggleSkill(skill)}>{skill.enabled ? "停用" : "启用"}</button>
              <button disabled={busyKey === `skill:delete:${skill.id}`} onclick={() => deleteSkill(skill)}>删除</button>
            </div>
          </div>
          <p>{skill.description}</p>
          <div class="skill-meta-grid">
            <span>触发 · {skill.triggers.join("、")}</span>
            <span>能力 · {skill.capabilityIds.join("、")}</span>
            <span>权限 · {skill.permissionScopes.join("、") || "无"}</span>
            <span>步骤 {skill.steps.length} · 失败模式 {skill.failureModes.length} · 验收 {skill.validation.length} · 结果建议 {skill.resultSuggestions.length}</span>
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
