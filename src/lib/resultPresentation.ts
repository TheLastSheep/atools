import { MATCH_TYPE_META, type SearchResult } from "./types";

export type ResultGroupPresentation = {
  key: string;
  label: string;
  items: Array<{ result: SearchResult; index: number }>;
};

export type ResultRowPresentation = {
  sourceLabel: string;
  sourceDetail: string;
  matchLabel: string;
  matchTone: string;
  shortcutHint: string;
  ariaLabel: string;
};

export function groupedResultPresentation(items: SearchResult[]): ResultGroupPresentation[] {
  const groups: ResultGroupPresentation[] = [];
  const byKey = new Map<string, ResultGroupPresentation>();
  items.forEach((result, index) => {
    const key = resultGroupKey(result);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: resultGroupLabel(result),
        items: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push({ result, index });
  });
  return groups;
}

export function resultRowPresentation(result: SearchResult, options: { selected: boolean }): ResultRowPresentation {
  const sourceLabel = resultSourceLabel(result);
  const matchLabel = resultMatchLabel(result);
  const shortcutHint = resultShortcutHint(result, options.selected);
  return {
    sourceLabel,
    sourceDetail: resultSourceDetail(result),
    matchLabel,
    matchTone: resultMatchTone(result),
    shortcutHint,
    ariaLabel: [
      result.label,
      sourceLabel,
      `${matchLabel}匹配`,
      shortcutHint,
    ].filter(Boolean).join("，"),
  };
}

export function resultGroupKey(result: SearchResult): string {
  if (result.code.startsWith("history:")) return "history";
  if (result.code.startsWith("alias:")) return "alias";
  if (result.code.startsWith("local-app:")) return "local-app";
  if (result.code.startsWith("local:")) return "local-launch";
  if (result.code.startsWith("web:")) return "web-quick-open";
  if (result.code.startsWith("url:")) return "url-quick-open";
  if (result.code.startsWith("text:")) return "text-quick-action";
  if (result.code.startsWith("paste:")) return "paste";
  if (result.plugin_id === "system" || result.code.startsWith("system:")) return "system";
  return result.plugin_id || result.plugin_name || "plugin";
}

export function resultGroupLabel(result: SearchResult): string {
  const key = resultGroupKey(result);
  if (key === "system") return "系统命令";
  if (key === "history") return "最近使用";
  if (key === "alias") return "指令别名";
  return resultSourceLabel(result);
}

export function resultSourceLabel(result: SearchResult): string {
  if (result.code.startsWith("system:") || result.plugin_id === "system") return "系统";
  if (result.code.startsWith("history:")) return "最近使用";
  if (result.code.startsWith("alias:")) return "指令别名";
  if (result.code.startsWith("local-app:")) return "本地应用";
  if (result.code.startsWith("local:")) return "本地启动";
  if (result.code.startsWith("web:")) return "网页快开";
  if (result.code.startsWith("url:")) return "链接快开";
  if (result.code.startsWith("text:")) return "文本识别";
  if (result.code.startsWith("paste:")) return "粘贴内容";
  return result.plugin_name || "插件";
}

export function resultSourceDetail(result: SearchResult): string {
  const parts = [
    compactPluginId(result),
    result.plugin_name || resultSourceLabel(result),
  ].filter(Boolean);
  return parts.join(" · ");
}

export function resultMatchLabel(result: SearchResult): string {
  return MATCH_TYPE_META[result.match_type]?.label ?? result.match_type;
}

export function resultMatchTone(result: SearchResult): string {
  return MATCH_TYPE_META[result.match_type]?.tone ?? "unknown";
}

export function resultShortcutHint(result: SearchResult, selected: boolean): string {
  if (!selected) return "";
  return `Enter ${resultActionVerb(result)}`;
}

function resultActionVerb(result: SearchResult): string {
  const code = result.code;
  if (code.startsWith("web:") || code.startsWith("url:") || code.startsWith("local:") || code.startsWith("local-app:")) {
    return "打开";
  }
  if (code.startsWith("text:")) {
    const kind = textActionKind(code);
    if (kind === "path-open") return "打开";
    if (kind === "path-reveal") return "定位";
    return "复制";
  }
  if (code.startsWith("paste:open:")) return "打开";
  if (code.startsWith("paste:reveal:")) return "定位";
  if (code.startsWith("paste:")) return "处理";
  return "执行";
}

function textActionKind(code: string): string {
  try {
    const payload = JSON.parse(decodeURIComponent(code.slice("text:".length))) as { kind?: unknown };
    return typeof payload.kind === "string" ? payload.kind : "";
  } catch {
    return "";
  }
}

function compactPluginId(result: SearchResult): string {
  const key = resultGroupKey(result);
  if (key === "system") return "system";
  if (key === "history") return "history";
  if (key === "alias") return "alias";
  if (key === "local-app") return "local-app";
  if (key === "local-launch") return "local";
  if (key === "web-quick-open") return "web";
  if (key === "url-quick-open") return "url";
  if (key === "text-quick-action") return "text";
  if (key === "paste") return "paste";
  return result.plugin_id || "plugin";
}
