import type { PendingAgentToolRequest } from "./types";

export type PermissionRiskLevel = "low" | "medium" | "high";

export type PermissionRequestPreview = {
  scopeLabels: string[];
  dryRun: boolean;
  paths: string[];
  risks: string[];
  riskLevel: PermissionRiskLevel;
};

const SCOPE_LABELS: Record<string, string> = {
  clipboard_read: "读取剪贴板",
  clipboard_write: "写入剪贴板",
  file_read: "读取文件",
  file_write: "修改文件",
  network: "网络访问",
  shell: "执行命令",
  screenshot: "屏幕截图",
  browser_context: "浏览器上下文",
  plugin_data: "插件数据",
  system_settings: "系统设置",
};

const HIGH_RISK_SCOPES = new Set(["shell", "system_settings", "screenshot"]);
const MEDIUM_RISK_SCOPES = new Set(["file_write", "clipboard_write", "network"]);
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
  "output_dir",
]);

export function permissionRequestPreview(request: PendingAgentToolRequest): PermissionRequestPreview {
  const scopeLabels = request.scopes.map(scopeLabel);
  const dryRun = isDryRun(request.arguments);
  const paths = collectUniquePaths(request.arguments).slice(0, 8);
  const riskLevel = permissionRiskLevel(request.scopes);
  const risks = permissionRisks(request.scopes, dryRun, paths);

  return {
    scopeLabels,
    dryRun,
    paths,
    risks,
    riskLevel,
  };
}

export function scopeLabel(scope: string): string {
  return SCOPE_LABELS[scope] ?? scope;
}

export function isHighRiskScope(scope: string): boolean {
  return HIGH_RISK_SCOPES.has(scope) || MEDIUM_RISK_SCOPES.has(scope);
}

function permissionRiskLevel(scopes: string[]): PermissionRiskLevel {
  if (scopes.some((scope) => HIGH_RISK_SCOPES.has(scope))) return "high";
  if (scopes.some((scope) => MEDIUM_RISK_SCOPES.has(scope))) return "medium";
  return "low";
}

function permissionRisks(scopes: string[], dryRun: boolean, paths: string[]): string[] {
  const risks: string[] = [];

  if (dryRun) {
    risks.push("当前参数声明为 dry-run，工具应只生成计划或预览，不应直接修改本地数据。");
  }
  for (const scope of scopes) {
    if (HIGH_RISK_SCOPES.has(scope) || MEDIUM_RISK_SCOPES.has(scope)) {
      risks.push(`${scopeLabel(scope)}：确认后工具可能产生本地副作用。`);
    }
  }
  if (paths.length > 0) {
    risks.push(`涉及 ${paths.length} 个本地路径；确认前请核对路径是否符合预期。`);
  }
  if (risks.length === 0) {
    risks.push("该调用仍会被审计记录；确认前请检查客户端和参数是否符合预期。");
  }

  return risks;
}

function isDryRun(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.dry_run === true || record.dryRun === true || record.preview === true;
}

function collectUniquePaths(value: unknown): string[] {
  const paths: string[] = [];
  collectPaths(value, "", paths);
  const seen = new Set<string>();
  return paths.filter((path) => {
    const normalized = path.trim();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
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
  const normalized = key.trim();
  return PATH_KEYS.has(normalized) || normalized.toLowerCase().endsWith("path") || normalized.toLowerCase().endsWith("paths");
}

function isPathLikeValue(value: string): boolean {
  return value.startsWith("/") || value.startsWith("~/") || value.startsWith("file://");
}
