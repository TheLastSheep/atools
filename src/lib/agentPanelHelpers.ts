import { invoke } from "@tauri-apps/api/core";
import { auditDurationLabel, auditPreview } from "./auditView";
import type {
  AuditLogQuery,
  Capability,
  MemoryItem,
  TaskRun,
} from "./types";

export function hasTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function copyText(text: string): Promise<void> {
  if (hasTauriRuntime()) {
    await invoke("copy_text", { text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

export async function safeHomePath(): Promise<string> {
  try {
    return await invoke<string>("system_get_path", { name: "home" });
  } catch {
    return "";
  }
}

export function defaultSkillManifest() {
  return {
    id: "",
    name: "",
    description: "",
    version: "1.0.0",
    triggers: [""],
    capabilityIds: [""],
    steps: [{ id: "step-1", capabilityId: "", description: "", input: {}, optional: false }],
    permissionScopes: [],
    failureModes: [],
    validation: [
      {
        id: "result",
        label: "结果验收",
        description: "说明如何判断用户目标已完成",
        kind: "manual",
        config: {},
        required: true,
      },
    ],
    resultSuggestions: [
      {
        id: "result",
        label: "结构化结果",
        kind: "artifact_renderer",
        config: { renderer: "json" },
      },
    ],
    source: "local",
  };
}

export function parsedSkillInput(skillManifest: string): Record<string, unknown> {
  const input = JSON.parse(skillManifest) as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Skill manifest 必须是 JSON object");
  }
  return input;
}

export function buildMemoryInput(params: {
  memoryType: MemoryItem["type"];
  memoryApproval: MemoryItem["approval"];
  memoryTool: string;
  memoryWorkspace: string;
  memoryContent: string;
  memoryConfidence: string;
  memoryExpiresAt: string;
}) {
  const confidence = Number(params.memoryConfidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("置信度必须在 0 到 1 之间");
  }
  if (params.memoryApproval === "temporary" && !params.memoryExpiresAt) {
    throw new Error("临时记忆必须设置过期时间");
  }
  return {
    type: params.memoryType,
    scope: {
      ...(params.memoryWorkspace.trim() ? { workspace: params.memoryWorkspace.trim() } : {}),
      ...(params.memoryTool.trim() ? { tool: params.memoryTool.trim() } : {}),
    },
    content: JSON.parse(params.memoryContent),
    confidence,
    approval: params.memoryApproval,
    expiresAt: params.memoryExpiresAt ? new Date(params.memoryExpiresAt).toISOString() : null,
  };
}

export function failedItemRetryArguments(run: TaskRun): unknown | null {
  if (run.capabilityId !== "compress_images") return null;
  const output = run.output && typeof run.output === "object"
    ? run.output as { items?: unknown }
    : null;
  const input = run.input && typeof run.input === "object" && !Array.isArray(run.input)
    ? run.input as Record<string, unknown>
    : null;
  if (!input || !Array.isArray(output?.items)) return null;
  const paths = output.items
    .filter((item): item is { input: string; status: string } => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as { input?: unknown; status?: unknown };
      return candidate.status === "failed" && typeof candidate.input === "string";
    })
    .map((item) => item.input);
  return paths.length > 0 ? { ...input, paths } : null;
}

export function taskRunStatusMeta(run: TaskRun) {
  if (run.status === "succeeded") return { label: "成功", tone: "success" };
  if (run.status === "failed") return { label: "失败", tone: "error" };
  if (run.status === "partial") return { label: "部分成功", tone: "pending" };
  if (run.status === "cancelled") return { label: "已取消", tone: "denied" };
  if (run.status === "awaiting_permission") return { label: "待授权", tone: "pending" };
  if (run.status === "running") return { label: "执行中", tone: "pending" };
  return { label: "已创建", tone: "pending" };
}

export function taskRunValidationLabel(run: TaskRun) {
  if (run.validation.status === "passed") return "验收通过";
  if (run.validation.status === "failed") return "验收失败";
  return "未执行验收";
}

export function taskRunDuration(run: TaskRun) {
  const metrics = run.metrics as { durationMs?: unknown } | null;
  const durationMs = metrics?.durationMs;
  return typeof durationMs === "number" ? auditDurationLabel(durationMs) : "—";
}

export function taskRunCanRetry(run: TaskRun) {
  return run.status === "failed" || run.status === "partial" || run.status === "cancelled";
}

export function taskRunCanCancel(run: TaskRun) {
  return run.status === "created" || run.status === "awaiting_permission" || run.status === "running";
}

export function compact(value: unknown) {
  return auditPreview(value);
}

export function normalizedFilterValue(value: string) {
  const trimmed = value.trim();
  return trimmed && trimmed !== "all" ? trimmed : null;
}

export function filterSelectOptions(options: string[], selected: string) {
  const selectedValue = normalizedFilterValue(selected);
  return [...new Set([...options, ...(selectedValue ? [selectedValue] : [])])].sort();
}

export function buildAuditBackendQuery(
  {
    auditQuery,
    auditStatusFilter,
    auditToolFilter,
    auditClientFilter,
  }: {
    auditQuery: string;
    auditStatusFilter: string;
    auditToolFilter: string;
    auditClientFilter: string;
  },
  limit: number,
  offset = 0,
): AuditLogQuery {
  return {
    limit,
    offset,
    query: normalizedFilterValue(auditQuery),
    status: normalizedFilterValue(auditStatusFilter),
    tool_name: normalizedFilterValue(auditToolFilter),
    client_id: normalizedFilterValue(auditClientFilter),
  };
}

export function hasActiveAuditFilters(filters: {
  auditQuery: string;
  auditStatusFilter: string;
  auditToolFilter: string;
  auditClientFilter: string;
}) {
  return Boolean(
    normalizedFilterValue(filters.auditQuery)
    || normalizedFilterValue(filters.auditStatusFilter)
    || normalizedFilterValue(filters.auditToolFilter)
    || normalizedFilterValue(filters.auditClientFilter),
  );
}

export function capabilitySourceLabel(capability: Capability) {
  switch (capability.source.kind) {
    case "builtin_tool": return "内置工具";
    case "plugin_tool": return "插件工具";
    case "plugin_feature": return "插件功能";
    case "skill": return "Skill";
    case "external_mcp": return "外部 MCP";
  }
}

export function capabilityInvocationLabel(capability: Capability) {
  if (capability.humanInvocable && capability.agentInvocable) return "人 / Agent";
  if (capability.humanInvocable) return "人工";
  if (capability.agentInvocable) return "Agent";
  return "仅目录";
}
