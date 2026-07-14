import type { ZToolsImportCandidate, ZToolsImportReport } from "./types";

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
  const rows = candidates.map((candidate) => candidateRow(candidate, selected));
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

function candidateRow(candidate: ZToolsImportCandidate, selected: Set<string>): ZToolsImportViewRow {
  const status = candidateStatus(candidate);
  const selectable = status !== "blocked";
  return {
    path: candidate.path,
    title: candidate.title?.trim() || candidate.name || candidate.path,
    subtitle: candidateSubtitle(candidate),
    status,
    statusLabel: statusLabel(status),
    selectable,
    selected: selectable && selected.has(candidate.path),
    messages: [...candidate.warnings, ...candidate.errors],
    missingFlags: missingFlags(candidate),
  };
}

function candidateStatus(candidate: ZToolsImportCandidate): ZToolsImportCandidateStatus {
  if (candidate.errors.length > 0) return "blocked";
  if (candidate.warnings.length > 0) return "warning";
  return "ready";
}

function statusLabel(status: ZToolsImportCandidateStatus): string {
  if (status === "blocked") return "不可导入";
  if (status === "warning") return "需注意";
  return "可导入";
}

function candidateSubtitle(candidate: ZToolsImportCandidate): string {
  const version = candidate.version.trim() || "0.0.0";
  return `${candidate.name} · ${version} · ${Math.max(0, candidate.features_count)} 指令`;
}

function candidateReportDetail(candidate: ZToolsImportCandidate): string {
  const version = candidate.version.trim() || "0.0.0";
  return `${candidate.name} · ${version}`;
}

function missingFlags(candidate: ZToolsImportCandidate): string[] {
  const flags: string[] = [];
  if (!candidate.platform_supported) flags.push("平台不匹配");
  if (!candidate.main_exists) flags.push("缺少入口");
  if (!candidate.preload_exists) flags.push("缺少 preload");
  if (!candidate.logo_exists) flags.push("缺少图标");
  if (candidate.unsupported_cmd_types.length > 0) flags.push(`未支持 ${candidate.unsupported_cmd_types.join("/")}`);
  return flags;
}
