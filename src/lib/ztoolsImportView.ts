import type { ZToolsImportCandidate, ZToolsImportReport } from "./types";
import { officialPluginMarketRequest, type PluginMarketRequest } from "./pluginMarketNavigation";
import { groupImportCandidates, importCandidateIdentity, isImportCandidateSelectable, safeImportPaths } from "./ztoolsImportSelection";

export type ZToolsImportCandidateStatus = "ready" | "warning" | "blocked";
export type ZToolsImportReportKind = "imported" | "skipped" | "failed";

export type ZToolsImportViewRow = {
  path: string;
  title: string;
  subtitle: string;
  status: ZToolsImportCandidateStatus;
  statusLabel: string;
  selectable: boolean;
  selected: boolean;
  messages: string[];
  missingFlags: string[];
  readiness: ZToolsImportCandidate["entry_readiness"];
  marketRequest: PluginMarketRequest | null;
  readinessMessage: string | null;
  sourceChoiceMessage: string | null;
  sourceBuildCheckable: boolean;
};

export type ZToolsImportSummaryChip = {
  label: string;
  tone: "neutral" | "success" | "warning" | "danger" | "accent";
};

export type ZToolsImportView = {
  summary: {
    total: number;
    selectable: number;
    selected: number;
    warning: number;
    blocked: number;
    features: number;
  };
  summaryChips: ZToolsImportSummaryChip[];
  rows: ZToolsImportViewRow[];
  emptyText: string;
  sourceChoiceCount: number;
  pendingSourceChoices: number;
};

export type ZToolsImportReportRow = {
  kind: ZToolsImportReportKind;
  title: string;
  detail: string;
  path: string;
};

export type ZToolsImportReportView = {
  summary: {
    imported: number;
    skipped: number;
    failed: number;
    total: number;
  };
  rows: ZToolsImportReportRow[];
  hasFailures: boolean;
};

export function ztoolsImportView(candidates: ZToolsImportCandidate[], selected: Set<string>): ZToolsImportView {
  const groups = groupImportCandidates(candidates);
  const safeSelected = new Set(safeImportPaths(candidates, selected));
  const sourceChoices = [...groups.values()].filter(group => group.length > 1);
  const rows = candidates.map((candidate) => candidateRow(candidate, safeSelected, groups.get(importCandidateIdentity(candidate))!));
  const summary = {
    total: candidates.length,
    selectable: rows.filter((row) => row.selectable).length,
    selected: rows.filter((row) => row.selected).length,
    warning: rows.filter((row) => row.status === "warning").length,
    blocked: rows.filter((row) => row.status === "blocked").length,
    features: candidates.reduce((total, candidate) => total + Math.max(0, candidate.features_count), 0),
  };
  return {
    summary,
    summaryChips: [
      { label: `候选 ${summary.total}`, tone: "neutral" },
      { label: `可导入 ${summary.selectable}`, tone: "success" },
      { label: `已选 ${summary.selected}`, tone: "accent" },
      { label: `警告 ${summary.warning}`, tone: "warning" },
      { label: `错误 ${summary.blocked}`, tone: "danger" },
    ],
    rows,
    emptyText: "选择 ZTools 插件目录后，这里会显示可导入插件和预检结果。",
    sourceChoiceCount: sourceChoices.length,
    pendingSourceChoices: sourceChoices.filter(group => !group.some(candidate => safeSelected.has(candidate.path))).length,
  };
}

export function ztoolsImportReportView(report: ZToolsImportReport | null): ZToolsImportReportView | null {
  if (!report) return null;
  const importedRows: ZToolsImportReportRow[] = report.imported.map((path) => ({
    kind: "imported",
    title: "已导入",
    detail: path,
    path,
  }));
  const skippedRows: ZToolsImportReportRow[] = report.skipped.map((candidate) => ({
    kind: "skipped",
    title: "已跳过",
    detail: candidateReportDetail(candidate),
    path: candidate.path,
  }));
  const failedRows: ZToolsImportReportRow[] = report.failed.map((failure) => ({
    kind: "failed",
    title: "导入失败",
    detail: failure.error || "未知错误",
    path: failure.path,
  }));
  const rows = [...importedRows, ...skippedRows, ...failedRows];
  return {
    summary: {
      imported: report.imported.length,
      skipped: report.skipped.length,
      failed: report.failed.length,
      total: rows.length,
    },
    rows,
    hasFailures: failedRows.length > 0,
  };
}

function candidateRow(candidate: ZToolsImportCandidate, selected: Set<string>, sources: ZToolsImportCandidate[]): ZToolsImportViewRow {
  const readiness = candidate.entry_readiness ?? null;
  const needsPublishedBuild = readiness === "requires_build";
  const unsupportedPlatform = !candidate.platform_supported;
  const status = candidateStatus(candidate);
  const selectable = status !== "blocked";
  const sourceBuildCheckable = (needsPublishedBuild || readiness === "incomplete")
    && candidate.source_type === "directory" && candidate.platform_supported && !candidate.headless;
  const alternativeArchive = sources.some(source => source.path !== candidate.path && source.source_type !== "directory" && isImportCandidateSelectable(source));
  return {
    path: candidate.path,
    title: candidate.title?.trim() || candidate.name || candidate.path,
    subtitle: candidateSubtitle(candidate, sourceBuildCheckable),
    status,
    statusLabel: unsupportedPlatform ? "本地版本不支持当前系统" : needsPublishedBuild ? "需要发布版"
      : readiness === "incomplete" && sourceBuildCheckable ? "不可直接导入" : statusLabel(status),
    selectable,
    selected: selectable && selected.has(candidate.path),
    messages: [...candidate.warnings, ...candidate.errors],
    missingFlags: missingFlags(candidate),
    readiness,
    marketRequest: needsPublishedBuild || unsupportedPlatform ? officialPluginMarketRequest(candidate.name) : null,
    readinessMessage: unsupportedPlatform
      ? "本地版本未声明支持当前系统。可查询官方发布版是否已支持当前系统。"
      : needsPublishedBuild ? alternativeArchive
        ? "同插件已有可导入的安装包，请从候选中选择一个；此源码目录仍需发布版。"
        : "源码目录需要先获得可运行的发布版，当前候选不能直接导入。" : readiness === "incomplete" && sourceBuildCheckable
        ? "此目录不能直接导入。检查会比较项目根目录与发布目录中的插件信息；如果有多个版本，可选择一份后重新检查。" : null,
    sourceChoiceMessage: sources.length > 1 ? "这些来源会安装为同一个插件，请只选一个。" : null,
    sourceBuildCheckable,
  };
}

function candidateStatus(candidate: ZToolsImportCandidate): ZToolsImportCandidateStatus {
  if (!isImportCandidateSelectable(candidate)) return "blocked";
  if (candidate.warnings.length > 0) return "warning";
  return "ready";
}

function statusLabel(status: ZToolsImportCandidateStatus): string {
  if (status === "blocked") return "不可导入";
  if (status === "warning") return "需注意";
  return "可导入";
}

function candidateSubtitle(candidate: ZToolsImportCandidate, provisionalVersion: boolean): string {
  const version = candidate.version.trim() || "0.0.0";
  const source = candidate.source_type === "zpx" ? "ZPX" : candidate.source_type === "asar" ? "ASAR" : candidate.source_type === "zip" ? "ZIP" : "目录";
  const displayedVersion = provisionalVersion ? `扫描摘要版本 ${version}` : version;
  if (candidate.headless) return `${candidate.name} · ${displayedVersion} · ${source} · 后台功能 · ${Math.max(0, candidate.features_count)} 指令`;
  return `${candidate.name} · ${displayedVersion} · ${source} · ${Math.max(0, candidate.features_count)} 指令`;
}

function candidateReportDetail(candidate: ZToolsImportCandidate): string {
  const version = candidate.version.trim() || "0.0.0";
  return `${candidate.name} · ${version}`;
}

function missingFlags(candidate: ZToolsImportCandidate): string[] {
  const flags: string[] = [];
  if (!candidate.platform_supported) flags.push("平台不匹配");
  if (!candidate.main_exists && !candidate.headless) flags.push("缺少入口");
  if (!candidate.preload_exists) flags.push("缺少 preload");
  if (!candidate.logo_exists) flags.push("缺少图标");
  if (candidate.unsupported_cmd_types.length > 0) flags.push(`未支持 ${candidate.unsupported_cmd_types.join("/")}`);
  return flags;
}
