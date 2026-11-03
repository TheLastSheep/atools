import type { SearchResult } from "./types";

export const MAX_LAUNCHER_TEXT_BYTES = 256 * 1024;
export const LAUNCHER_TEXT_LIMIT_MESSAGE = "文本超过 256 KiB，请缩小内容后重试；不会截断执行。";

export function launcherTextWithinBudget(content: string): boolean {
  return content.length <= MAX_LAUNCHER_TEXT_BYTES
    && new TextEncoder().encode(content).byteLength <= MAX_LAUNCHER_TEXT_BYTES;
}

/** A short visible preview only. Full content stays in the in-memory controller. */
export function launcherTextSummary(content: string): string {
  const compact = content.slice(0, 96).replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  return characters.slice(0, 24).join("") + (characters.length > 24 || content.length > 96 ? "…" : "");
}

export function isTextContentResult(result: SearchResult): boolean {
  return result.match_type === "regex" || result.match_type === "over";
}

export function isLauncherFixTextShortcut(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  return event.key.toLowerCase() === "f" && (event.metaKey || event.ctrlKey)
    && !event.altKey && !event.shiftKey
    && target?.dataset?.atoolsSearchInput === "true";
}

export function plainTextPasteForEmptySearch(event: ClipboardEvent, query: string): string | null {
  const target = event.target as HTMLInputElement | null;
  if (query.length || !target || target.dataset?.atoolsComposing === "true") return null;
  if (target.selectionStart !== target.selectionEnd) return null;
  const content = event.clipboardData?.getData("text/plain") ?? "";
  return content.trim() ? content : null;
}
