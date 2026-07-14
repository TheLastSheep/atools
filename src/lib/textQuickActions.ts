import type { SearchResult } from "./types";

export type TextQuickActionKind = "json" | "color" | "timestamp" | "path-open" | "path-reveal";

export type TextQuickActionPayload = {
  kind: TextQuickActionKind;
  output: string;
};

const URL_LIKE_PATTERN = /^(https?:\/\/|localhost(?::|\/|$)|\d{1,3}(?:\.\d{1,3}){3}(?::|\/|$)|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[:/?#]|$))/i;
const HEX_COLOR_PATTERN = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;
const TIMESTAMP_PATTERN = /^\d{10}(?:\d{3})?$/;
const MAC_PATH_PATTERN = /^(~\/|\/)[^\n\r]+$/;

export function textQuickActionResultsForQuery(value: string): SearchResult[] {
  const input = value.trim();
  if (!input || URL_LIKE_PATTERN.test(input)) return [];

  const jsonOutput = formattedJson(input);
  if (jsonOutput) {
    return [
      textResult({
        kind: "json",
        output: jsonOutput,
        label: "复制格式化 JSON",
        explain: firstLine(jsonOutput),
        score: 87,
      }),
    ];
  }

  const color = normalizedHexColor(input);
  if (color) {
    return [
      textResult({
        kind: "color",
        output: color,
        label: `复制颜色 ${color}`,
        explain: rgbExplain(color),
        score: 86,
      }),
    ];
  }

  const timestamp = timestampToIso(input);
  if (timestamp) {
    return [
      textResult({
        kind: "timestamp",
        output: timestamp,
        label: `复制时间 ${timestamp}`,
        explain: "Unix 时间戳转换为 ISO 时间",
        score: 85,
      }),
    ];
  }

  if (isPathLike(input)) {
    return [
      textResult({
        kind: "path-open",
        output: input,
        label: `打开路径 ${input}`,
        explain: "通过本地工具打开路径，执行前会走权限确认",
        score: 84,
      }),
      textResult({
        kind: "path-reveal",
        output: input,
        label: `在 Finder 中显示 ${input}`,
        explain: "通过本地工具定位路径，执行前会走权限确认",
        score: 83,
      }),
    ];
  }

  return [];
}

export function payloadFromTextQuickActionCode(code: string): TextQuickActionPayload | null {
  if (!code.startsWith("text:")) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(code.slice("text:".length))) as TextQuickActionPayload;
    if (!payload || typeof payload.kind !== "string" || typeof payload.output !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

function textResult(input: {
  kind: TextQuickActionKind;
  output: string;
  label: string;
  explain: string;
  score: number;
}): SearchResult {
  const payload: TextQuickActionPayload = {
    kind: input.kind,
    output: input.output,
  };
  return {
    code: `text:${encodeURIComponent(JSON.stringify(payload))}`,
    plugin_id: "text-quick-actions",
    plugin_name: "文本快识别",
    label: input.label,
    icon: null,
    explain: input.explain,
    score: input.score,
    match_type: "exact",
  };
}

function formattedJson(input: string): string | null {
  if (!input.startsWith("{") && !input.startsWith("[")) return null;
  try {
    return JSON.stringify(JSON.parse(input), null, 2);
  } catch {
    return null;
  }
}

function normalizedHexColor(input: string): string | null {
  const match = input.match(HEX_COLOR_PATTERN);
  if (!match) return null;
  const value = match[1];
  const expanded = value.length === 3
    ? value.split("").map((char) => `${char}${char}`).join("")
    : value;
  return `#${expanded.toUpperCase()}`;
}

function rgbExplain(hex: string): string {
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  return `RGB ${red}, ${green}, ${blue}`;
}

function timestampToIso(input: string): string | null {
  if (!TIMESTAMP_PATTERN.test(input)) return null;
  const value = Number(input);
  const millis = input.length === 10 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function isPathLike(input: string): boolean {
  if (!MAC_PATH_PATTERN.test(input)) return false;
  return input.length > 1 && !input.includes("://");
}

function firstLine(value: string): string {
  return value.split("\n")[0] || value;
}
