import type { AuditLogEntry } from "./types";

export type AuditStatusTone = "success" | "denied" | "error" | "pending" | "unknown";

export type AuditStatusMeta = {
  label: string;
  tone: AuditStatusTone;
};

export type AuditSummaryRow = {
  label: string;
  value: string;
};

export type AuditPathChange = {
  action: string;
  source: string;
  target: string;
  status: string;
};

export type AuditReplayStep = {
  label: string;
  detail: string;
  tone: AuditStatusTone;
};

export type AuditReplaySummary = {
  permissionLabel: string;
  executionMode: string;
  sideEffectLabel: string;
  pathChanges: AuditPathChange[];
  steps: AuditReplayStep[];
};

export type AuditSideEffectDiffRow = {
  action: string;
  before: string;
  after: string;
  status: string;
  tone: AuditStatusTone;
  detail: string;
};

export type AuditSideEffectDiff = {
  summary: string;
  rows: AuditSideEffectDiffRow[];
};

export type AuditFilterStatus = "all" | "success" | "denied" | "error" | "pending" | "unknown";

export type AuditFilters = {
  query?: string;
  status?: AuditFilterStatus | string;
  toolName?: string;
  clientId?: string;
};

export type AuditFilterOptions = {
  toolNames: string[];
  clientIds: string[];
  statusCounts: Record<AuditFilterStatus, number>;
};

export type AuditDataOverviewRow = {
  label: string;
  value: string;
  tone?: AuditStatusTone;
  detail?: string;
  meta?: string;
};

export type AuditDataOverview = {
  totalLabel: string;
  statusRows: AuditDataOverviewRow[];
  toolRows: AuditDataOverviewRow[];
  clientRows: AuditDataOverviewRow[];
  recentRows: AuditDataOverviewRow[];
  errorRows: AuditDataOverviewRow[];
};

const PATH_KEYS = new Set([
  "path",
  "paths",
  "file",
  "files",
  "source",
  "target",
  "sourcePath",
  "targetPath",
  "outputPath",
  "inputPath",
]);

export function auditStatusMeta(entry: Pick<AuditLogEntry, "status" | "error">): AuditStatusMeta {
  const status = String(entry.status || "").toLowerCase();
  if (status === "confirmed") {
    return { label: "已确认执行", tone: "success" };
  }
  if (status === "allowed") {
    return { label: "已允许", tone: "success" };
  }
  if (status === "denied" || status === "rejected" || status === "refused") {
    return { label: "已拒绝", tone: "denied" };
  }
  if (entry.error || status === "error" || status === "failed" || status === "failure") {
    return { label: "失败", tone: "error" };
  }
  if (status === "success" || status === "ok" || status === "completed") {
    return { label: "已完成", tone: "success" };
  }
  if (status === "pending" || status === "waiting") {
    return { label: "待确认", tone: "pending" };
  }
  return { label: entry.status || "未知", tone: "unknown" };
}

export function auditDurationLabel(durationMs: number): string {
  return Number.isFinite(durationMs) ? `${Math.max(0, Math.round(durationMs))}ms` : "未知";
}

export function auditSummaryRows(entry: AuditLogEntry): AuditSummaryRow[] {
  const status = auditStatusMeta(entry);
  return [
    { label: "客户端", value: entry.client_id || "unknown" },
    { label: "工具", value: entry.tool_name || "unknown_tool" },
    { label: "状态", value: status.label },
    { label: "耗时", value: auditDurationLabel(entry.duration_ms) },
    { label: "时间", value: entry.timestamp || "未知" },
  ];
}

export function auditFilterOptions(entries: AuditLogEntry[]): AuditFilterOptions {
  const toolNames = unique(entries.map((entry) => entry.tool_name).filter(Boolean)).sort();
  const clientIds = unique(entries.map((entry) => entry.client_id).filter(Boolean)).sort();
  const statusCounts: Record<AuditFilterStatus, number> = {
    all: entries.length,
    success: 0,
    denied: 0,
    error: 0,
    pending: 0,
    unknown: 0,
  };

  for (const entry of entries) {
    statusCounts[auditFilterStatus(entry)] += 1;
  }

  return {
    toolNames,
    clientIds,
    statusCounts,
  };
}

export function filterAuditEntries(entries: AuditLogEntry[], filters: AuditFilters): AuditLogEntry[] {
  const query = normalizeFilterText(filters.query);
  const status = normalizeFilterValue(filters.status);
  const toolName = normalizeFilterValue(filters.toolName);
  const clientId = normalizeFilterValue(filters.clientId);

  return entries.filter((entry) => {
    if (status && auditFilterStatus(entry) !== status) return false;
    if (toolName && entry.tool_name !== toolName) return false;
    if (clientId && entry.client_id !== clientId) return false;
    if (query && !auditSearchText(entry).includes(query)) return false;
    return true;
  });
}

export function auditFilterSummary(entries: AuditLogEntry[], filteredEntries: AuditLogEntry[], filters: AuditFilters): string {
  const activeCount = [
    normalizeFilterText(filters.query),
    normalizeFilterValue(filters.status),
    normalizeFilterValue(filters.toolName),
    normalizeFilterValue(filters.clientId),
  ].filter(Boolean).length;
  const suffix = activeCount > 0 ? ` · ${activeCount} 个筛选条件` : "";
  return `显示 ${filteredEntries.length} / ${entries.length} 条审计${suffix}`;
}

export function auditDataOverview(entries: AuditLogEntry[]): AuditDataOverview {
  const options = auditFilterOptions(entries);
  const recentEntries = [...entries].sort((left, right) => String(right.timestamp).localeCompare(String(left.timestamp)));
  return {
    totalLabel: entries.length > 0 ? `共 ${entries.length} 条审计记录` : "暂无审计记录",
    statusRows: [
      { label: "成功", value: `${options.statusCounts.success} 条`, tone: "success" },
      { label: "拒绝", value: `${options.statusCounts.denied} 条`, tone: "denied" },
      { label: "失败", value: `${options.statusCounts.error} 条`, tone: "error" },
      { label: "待确认", value: `${options.statusCounts.pending} 条`, tone: "pending" },
      { label: "未知", value: `${options.statusCounts.unknown} 条`, tone: "unknown" },
    ],
    toolRows: topAuditCountRows(entries, (entry) => entry.tool_name || "unknown_tool"),
    clientRows: topAuditCountRows(entries, (entry) => entry.client_id || "unknown"),
    recentRows: recentEntries.slice(0, 5).map(auditOverviewRecentRow),
    errorRows: recentEntries
      .filter((entry) => ["denied", "error"].includes(auditFilterStatus(entry)))
      .slice(0, 5)
      .map(auditOverviewErrorRow),
  };
}

export function auditReplaySummary(entry: AuditLogEntry): AuditReplaySummary {
  const status = normalizedStatus(entry);
  const statusMeta = auditStatusMeta(entry);
  const dryRun = auditIsDryRun(entry);
  const pathChanges = auditPathChanges(entry);
  const executed = status !== "denied" && !dryRun && !entry.error;
  const mutates = pathChanges.some((change) => change.action !== "涉及路径") || mutatingToolNames.has(entry.tool_name);
  const permissionLabel = auditPermissionLabel(status);
  const executionMode = dryRun ? "dry-run 预览" : executed ? "已执行" : "未执行";
  const sideEffectLabel = !executed || dryRun
    ? "未执行本地修改"
    : mutates
      ? "有本地副作用"
      : "无明显副作用";

  return {
    permissionLabel,
    executionMode,
    sideEffectLabel,
    pathChanges,
    steps: [
      {
        label: "客户端请求",
        detail: `${entry.client_id || "unknown"} 调用 ${entry.tool_name || "unknown_tool"}`,
        tone: "unknown",
      },
      {
        label: "权限结果",
        detail: permissionLabel,
        tone: statusMeta.tone,
      },
      {
        label: "执行模式",
        detail: executionMode,
        tone: dryRun ? "pending" : executed ? "success" : statusMeta.tone,
      },
      {
        label: "本地副作用",
        detail: sideEffectLabel,
        tone: mutates && executed ? "error" : "success",
      },
      {
        label: "执行结果",
        detail: entry.error || statusMeta.label,
        tone: statusMeta.tone,
      },
    ],
  };
}

export function auditSideEffectDiff(entry: AuditLogEntry): AuditSideEffectDiff {
  const rows = auditSideEffectDiffRows(entry);
  return {
    summary: auditSideEffectDiffSummary(entry, rows),
    rows,
  };
}

export function auditPathSummaries(entry: AuditLogEntry): string[] {
  const paths: string[] = [];
  collectPaths(entry.input, "", paths);
  collectPaths(entry.output, "", paths);
  return unique(paths).slice(0, 12);
}

export function auditPreview(value: unknown, limit = 160): string {
  const text = auditDetailValue(value, "");
  if (!text) return "";
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

export function auditDetailValue(value: unknown, emptyLabel: string): string {
  if (value === null || value === undefined || value === "") return emptyLabel;
  if (typeof value === "string") return value;
  const text = JSON.stringify(value, null, 2);
  return text === undefined ? emptyLabel : text;
}

const mutatingToolNames = new Set(["rename_files", "compress_images", "open_or_reveal_path"]);

function auditFilterStatus(entry: AuditLogEntry): Exclude<AuditFilterStatus, "all"> {
  const tone = auditStatusMeta(entry).tone;
  if (tone === "success" || tone === "denied" || tone === "error" || tone === "pending") {
    return tone;
  }
  return "unknown";
}

function normalizeFilterValue(value: unknown): string {
  return typeof value === "string" && value !== "all" ? value.trim() : "";
}

function normalizeFilterText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function auditSearchText(entry: AuditLogEntry): string {
  return [
    entry.id,
    entry.timestamp,
    entry.client_id,
    entry.tool_name,
    entry.status,
    auditStatusMeta(entry).label,
    entry.error,
    auditDetailValue(entry.input, ""),
    auditDetailValue(entry.output, ""),
    auditPathSummaries(entry).join("\n"),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
    .toLowerCase();
}

function topAuditCountRows(entries: AuditLogEntry[], keyForEntry: (entry: AuditLogEntry) => string): AuditDataOverviewRow[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = keyForEntry(entry).trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 3)
    .map(([label, count]) => ({
      label,
      value: `${count} 条`,
    }));
}

function auditOverviewRecentRow(entry: AuditLogEntry): AuditDataOverviewRow {
  const status = auditStatusMeta(entry);
  return {
    label: entry.tool_name || "unknown_tool",
    value: status.label,
    tone: status.tone,
    detail: `${entry.client_id || "unknown"} · ${entry.timestamp || "未知"} · ${auditDurationLabel(entry.duration_ms)}`,
    meta: auditPreview(entry.error || entry.output || entry.input, 80),
  };
}

function auditOverviewErrorRow(entry: AuditLogEntry): AuditDataOverviewRow {
  const status = auditStatusMeta(entry);
  return {
    label: entry.tool_name || "unknown_tool",
    value: status.label,
    tone: status.tone,
    detail: entry.error || status.label,
    meta: `${entry.client_id || "unknown"} · ${entry.timestamp || "未知"}`,
  };
}

function normalizedStatus(entry: Pick<AuditLogEntry, "status" | "error">): string {
  const status = String(entry.status || "").toLowerCase();
  if (status) return status;
  return entry.error ? "error" : "";
}

function auditPermissionLabel(status: string): string {
  switch (status) {
    case "confirmed":
      return "用户确认执行";
    case "allowed":
    case "success":
    case "ok":
    case "completed":
      return "策略允许执行";
    case "denied":
    case "rejected":
    case "refused":
      return "已拒绝";
    case "pending":
    case "waiting":
      return "待确认";
    case "error":
    case "failed":
    case "failure":
      return "执行失败";
    default:
      return status || "未知";
  }
}

function auditIsDryRun(entry: AuditLogEntry): boolean {
  if (!entry.input || typeof entry.input !== "object") return false;
  const input = entry.input as Record<string, unknown>;
  return input.dry_run === true || input.dryRun === true || input.preview === true;
}

function auditPathChanges(entry: AuditLogEntry): AuditPathChange[] {
  if (entry.tool_name === "rename_files") {
    return renamePathChanges(entry);
  }
  if (entry.tool_name === "compress_images") {
    return compressPathChanges(entry);
  }
  if (entry.tool_name === "open_or_reveal_path") {
    return openPathChanges(entry);
  }

  return auditPathSummaries(entry).map((path) => ({
    action: "涉及路径",
    source: "",
    target: path,
    status: normalizedStatus(entry) || "unknown",
  }));
}

function auditSideEffectDiffRows(entry: AuditLogEntry): AuditSideEffectDiffRow[] {
  if (entry.tool_name === "compress_images") {
    const replay = auditReplaySummary(entry);
    return compressSideEffectRows(entry, replay);
  }
  const replay = auditReplaySummary(entry);
  return replay.pathChanges.map((change) => ({
    action: change.action,
    before: change.source,
    after: change.target,
    status: change.status,
    tone: sideEffectTone(entry, change.status),
    detail: sideEffectDetail(entry),
  }));
}

function auditSideEffectDiffSummary(entry: AuditLogEntry, rows: AuditSideEffectDiffRow[]): string {
  if (rows.length === 0) {
    return "无可展示的本地副作用";
  }
  if (rows.some((row) => row.status === "target_unmet")) {
    return `未达标 ${rows.length} 项本地副作用`;
  }
  if (auditIsDryRun(entry)) {
    return `计划 ${rows.length} 项，未执行本地修改`;
  }
  if (entry.error || auditStatusMeta(entry).tone === "error") {
    return `失败 ${rows.length} 项本地副作用`;
  }
  if (auditStatusMeta(entry).tone === "denied") {
    return `已拒绝 ${rows.length} 项本地副作用`;
  }
  return `已执行 ${rows.length} 项本地副作用`;
}

function compressSideEffectRows(entry: AuditLogEntry, replay: AuditReplaySummary): AuditSideEffectDiffRow[] {
  const items = arrayRecords((entry.output as Record<string, unknown> | null)?.items);
  if (items.length === 0) {
    return replay.pathChanges.map((change) => ({
      action: change.action,
      before: change.source,
      after: change.target,
      status: change.status,
      tone: sideEffectTone(entry, change.status),
      detail: sideEffectDetail(entry),
    }));
  }
  return items.map((item) => ({
    action: "压缩图片",
    before: stringValue(item.input),
    after: stringValue(item.output),
    status: stringValue(item.status) || normalizedStatus(entry) || "unknown",
    tone: sideEffectTone(entry, stringValue(item.status)),
    detail: imageSizeDiffDetail(item) || sideEffectDetail(entry),
  }));
}

function sideEffectTone(entry: AuditLogEntry, status: string): AuditStatusTone {
  if (auditIsDryRun(entry)) return "pending";
  const statusText = status.toLowerCase();
  if (entry.error || ["error", "failed", "failure", "target_unmet"].includes(statusText)) return "error";
  if (auditStatusMeta(entry).tone === "denied") return "denied";
  if (["planned", "pending"].includes(statusText)) return "pending";
  if (["renamed", "compressed", "copied", "ok", "success", "allowed", "confirmed"].includes(statusText)) return "success";
  return auditStatusMeta(entry).tone;
}

function sideEffectDetail(entry: AuditLogEntry): string {
  if (auditIsDryRun(entry)) return "dry-run 预览";
  if (entry.error) return entry.error;
  return auditReplaySummary(entry).permissionLabel;
}

function imageSizeDiffDetail(item: Record<string, unknown>): string {
  const originalSize = numberValue(item.original_size);
  const outputSize = numberValue(item.output_size);
  if (originalSize <= 0 || outputSize <= 0) return "";
  const reduction = Math.max(0, Math.round(((originalSize - outputSize) / originalSize) * 100));
  const targetSize = numberValue(item.target_size);
  const targetMet = item.target_met === true;
  const targetDetail = targetSize > 0 && !targetMet ? `，目标 ${formatBytes(targetSize)} 未达标` : "";
  return `${formatBytes(originalSize)} -> ${formatBytes(outputSize)}，减少 ${reduction}%${targetDetail}`;
}

function renamePathChanges(entry: AuditLogEntry): AuditPathChange[] {
  const operations = arrayRecords((entry.output as Record<string, unknown> | null)?.operations)
    .concat(arrayRecords((entry.input as Record<string, unknown> | null)?.operations))
    .filter((operation, index, all) => {
      const source = stringValue(operation.source);
      const target = stringValue(operation.target);
      return source || target
        ? all.findIndex((item) => stringValue(item.source) === source && stringValue(item.target) === target) === index
        : false;
    });

  return operations.map((operation) => ({
    action: "重命名",
    source: stringValue(operation.source),
    target: stringValue(operation.target),
    status: stringValue(operation.status) || normalizedStatus(entry) || "planned",
  }));
}

function compressPathChanges(entry: AuditLogEntry): AuditPathChange[] {
  return arrayRecords((entry.output as Record<string, unknown> | null)?.items).map((item) => ({
    action: "压缩图片",
    source: stringValue(item.input),
    target: stringValue(item.output),
    status: stringValue(item.status) || normalizedStatus(entry) || "ok",
  }));
}

function openPathChanges(entry: AuditLogEntry): AuditPathChange[] {
  const input = entry.input as Record<string, unknown> | null;
  const output = entry.output as Record<string, unknown> | null;
  const path = stringValue(output?.path) || stringValue(input?.path);
  if (!path) return [];
  return [{
    action: "打开或显示",
    source: "",
    target: path,
    status: output?.ok === true ? "ok" : normalizedStatus(entry) || "unknown",
  }];
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${Math.round(value)}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value % 1024 === 0 ? 0 : 1)}KB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

function collectPaths(value: unknown, key: string, paths: string[]) {
  if (typeof value === "string") {
    if (isPathLikeKey(key) || isPathLikeValue(value)) {
      paths.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPaths(item, key, paths);
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [childKey, childValue] of Object.entries(value)) {
    collectPaths(childValue, childKey, paths);
  }
}

function isPathLikeKey(key: string): boolean {
  return PATH_KEYS.has(key) || key.toLowerCase().endsWith("path") || key.toLowerCase().endsWith("paths");
}

function isPathLikeValue(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || value.startsWith("file://");
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
