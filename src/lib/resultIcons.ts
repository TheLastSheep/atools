import type { SearchResult } from "./types";

export type ConvertFileSrc = (path: string) => string;
export type ResultFallbackIcon =
  | "system"
  | "app"
  | "folder"
  | "web"
  | "link"
  | "text"
  | "paste"
  | "history"
  | "alias"
  | "plugin";

export function resultIconSrc(
  icon: string | null | undefined,
  tauriAvailable: boolean,
  convertFileSrc: ConvertFileSrc,
): string | null {
  const value = icon?.trim();
  if (!value) return null;
  if (!isLocalPath(value)) return value;
  return tauriAvailable ? convertFileSrc(value) : null;
}

export function hasTauriAssetRuntime(): boolean {
  return typeof window !== "undefined"
    && Boolean((window as Window & { __TAURI_INTERNALS__?: { convertFileSrc?: unknown } }).__TAURI_INTERNALS__?.convertFileSrc);
}

export function resultFallbackIcon(result: SearchResult): ResultFallbackIcon {
  if (result.plugin_id === "system") return "system";
  return resultFallbackIconForCode(result.code);
}

export function resultFallbackIconForCode(code: string): ResultFallbackIcon {
  if (code.startsWith("system:")) return "system";
  if (code.startsWith("local-app:")) return "app";
  if (code.startsWith("local:")) return "folder";
  if (code.startsWith("web:")) return "web";
  if (code.startsWith("url:")) return "link";
  if (code.startsWith("text:")) return "text";
  if (code.startsWith("paste:")) return "paste";
  if (code.startsWith("history:")) return "history";
  if (code.startsWith("alias:")) return "alias";
  return "plugin";
}

function isLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}
