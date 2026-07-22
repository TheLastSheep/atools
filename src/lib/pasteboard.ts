export type PasteboardItemKind =
  | "text"
  | "rich_text"
  | "html"
  | "url"
  | "image"
  | "pdf"
  | "color"
  | "files";

export type PasteboardSourceApp = {
  bundleId?: string | null;
  name?: string | null;
};

export type PasteboardItem = {
  id: string;
  kind: PasteboardItemKind;
  title?: string | null;
  sourceApp?: PasteboardSourceApp | null;
  sourceDeviceId: string;
  copiedAt: string;
  updatedAt: string;
  contentFingerprint: string;
  payload: Record<string, unknown>;
  ocrText?: string | null;
  pinboardId?: string | null;
  pinboardOrderKey?: string | null;
  pinned: boolean;
  fieldClocks: Record<string, unknown>;
};

export type PasteboardPinboard = {
  id: string;
  name: string;
  color: string;
  orderKey: string;
  createdAt: string;
  updatedAt: string;
  fieldClocks: Record<string, unknown>;
};

export type PasteboardPreview = {
  itemId: string;
  kind: PasteboardItemKind;
  title?: string | null;
  text?: string | null;
  assetPath?: string | null;
  mediaType?: string | null;
  files: string[];
  ocrText?: string | null;
};

export type PasteboardCaptureStatus = {
  paused: boolean;
  lastChangeCount: number;
  lastOutcome?: unknown;
};

export type PasteboardPasteOutcome = {
  itemId: string;
  copied: boolean;
  pasted: boolean;
  warningCode?: string | null;
  warning?: string | null;
};

export type PasteboardDockEdge = "top" | "bottom" | "left" | "right";

export function pasteboardItemText(item: PasteboardItem): string {
  for (const key of ["text", "url", "color", "previewText"]) {
    const value = item.payload[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const files = item.payload.files;
  if (Array.isArray(files)) return files.filter((value): value is string => typeof value === "string").join("\n");
  return "";
}

export function pasteboardKindLabel(kind: PasteboardItemKind): string {
  return {
    text: "文本",
    rich_text: "富文本",
    html: "HTML",
    url: "链接",
    image: "图片",
    pdf: "PDF",
    color: "颜色",
    files: "文件",
  }[kind];
}

export function relativePasteboardTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Date(timestamp).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}
