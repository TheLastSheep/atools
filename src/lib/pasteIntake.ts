import type { SearchResult } from "./types";

export type PasteFileLike = {
  name: string;
  type?: string;
  size?: number;
  path?: string;
  webkitRelativePath?: string;
};

export type PasteInput = {
  files?: PasteFileLike[];
  text?: string;
};

export type PastedItem = {
  id: string;
  kind: "image" | "file";
  name: string;
  type: string;
  size: number;
  path?: string;
};

export function classifyPastedContent(input: PasteInput): PastedItem[] {
  return (input.files ?? [])
    .filter((file) => file.name || file.type)
    .map((file, index) => {
      const type = file.type || "";
      return {
        id: `paste-${index}`,
        kind: type.startsWith("image/") ? "image" : "file",
        name: file.name || `粘贴文件 ${index + 1}`,
        type,
        size: Number.isFinite(file.size) ? Number(file.size) : 0,
        path: file.path || file.webkitRelativePath || undefined,
      };
    });
}

export function pasteQueryLabel(items: PastedItem[]): string {
  const imageCount = items.filter((item) => item.kind === "image").length;
  const fileCount = items.filter((item) => item.kind === "file").length;
  const parts: string[] = [];
  if (imageCount > 0) parts.push(`${imageCount} 张图片`);
  if (fileCount > 0) parts.push(`${fileCount} 个文件`);
  return parts.length > 0 ? `粘贴了 ${parts.join("、")}` : "";
}

export function pasteResultsForItems(items: PastedItem[]): SearchResult[] {
  return items.flatMap((item) => item.kind === "image" ? imageResults(item) : fileResults(item));
}

export function pasteInputFromDataTransfer(dataTransfer: DataTransfer | null): PasteInput {
  if (!dataTransfer) return {};
  return {
    files: Array.from(dataTransfer.files ?? []).map((file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      path: pathFromFile(file),
      webkitRelativePath: "webkitRelativePath" in file ? file.webkitRelativePath : "",
    })),
    text: dataTransfer.getData("text/plain"),
  };
}

export function pastedItemByCode(code: string, items: PastedItem[]): PastedItem | null {
  const id = code.split(":").at(-1);
  return items.find((item) => item.id === id) ?? null;
}

function imageResults(item: PastedItem): SearchResult[] {
  if (!item.path) {
    return [
      pasteResult({
        code: `paste:save-image:${item.id}`,
        label: `保存图片后再处理 ${item.name}`,
        explain: "浏览器粘贴图片没有本地路径，先保存为文件后可进行 OCR 或压缩",
        score: 92,
        matchType: "pending",
      }),
    ];
  }
  return [
    pasteResult({
      code: `paste:ocr:${item.id}`,
      label: `识别图片文字 ${item.name}`,
      explain: `${formatFileSize(item.size)} · 调用本地 OCR 工具，执行前会走权限确认`,
      score: 98,
      matchType: "exact",
    }),
    pasteResult({
      code: `paste:compress:${item.id}`,
      label: `压缩图片 ${item.name}`,
      explain: `${formatFileSize(item.size)} · 调用图片压缩工具，执行前会走权限确认`,
      score: 96,
      matchType: "exact",
    }),
  ];
}

function fileResults(item: PastedItem): SearchResult[] {
  const noPathSuffix = item.path ? "" : "；当前粘贴对象没有本地路径";
  return [
    pasteResult({
      code: `paste:open:${item.id}`,
      label: `打开粘贴文件 ${item.name}`,
      explain: `${formatFileSize(item.size)}${noPathSuffix}`,
      score: 90,
      matchType: item.path ? "exact" : "pending",
    }),
    pasteResult({
      code: `paste:reveal:${item.id}`,
      label: `在 Finder 中显示 ${item.name}`,
      explain: `${formatFileSize(item.size)}${noPathSuffix}`,
      score: 88,
      matchType: item.path ? "exact" : "pending",
    }),
  ];
}

function pasteResult(input: {
  code: string;
  label: string;
  explain: string;
  score: number;
  matchType: string;
}): SearchResult {
  return {
    code: input.code,
    plugin_id: "paste",
    plugin_name: "粘贴内容",
    label: input.label,
    icon: null,
    explain: input.explain,
    score: input.score,
    match_type: input.matchType,
  };
}

function formatFileSize(size: number) {
  if (size <= 0) return "大小未知";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function pathFromFile(file: File): string | undefined {
  const maybePath = (file as File & { path?: string }).path;
  return typeof maybePath === "string" && maybePath.length > 0 ? maybePath : undefined;
}
