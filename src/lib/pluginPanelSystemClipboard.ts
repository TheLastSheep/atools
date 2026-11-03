import { Command } from "@tauri-apps/plugin-shell";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";
import { invoke } from "@tauri-apps/api/core";

export type EyeDropperConstructor = new () => { open: () => Promise<{ sRGBHex?: string }> };
type EyeDropperWindow = Window & { EyeDropper?: EyeDropperConstructor };

export function pathFromBridgeValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string") return record.path;
    if (typeof record.name === "string") return record.name;
  }
  throw new Error("Expected a file path");
}

export function pathsFromBridgeValue(value: unknown): string[] {
  const paths = Array.isArray(value)
    ? value.map((entry) => pathFromBridgeValue(entry))
    : [pathFromBridgeValue(value)];
  if (paths.length === 0) throw new Error("Expected at least one file path");
  return paths;
}

export type CopiedFileEntry = {
  path: string;
  name: string;
  isFile: boolean;
  isDiractory: boolean;
  [key: string]: unknown;
};

export function copiedFileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || path;
}

export function normalizeCopiedFileEntry(entry: unknown): CopiedFileEntry | null {
  const record = entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
  const path = typeof entry === "string"
    ? entry
    : typeof record.path === "string"
      ? record.path
      : typeof record.name === "string"
        ? record.name
        : "";
  if (!path) return null;
  const isDiractory = typeof record.isDiractory === "boolean" ? record.isDiractory : /[\\/]$/.test(path);
  const isFile = typeof record.isFile === "boolean" ? record.isFile : !isDiractory;
  const name = typeof record.name === "string" && record.name ? record.name : copiedFileName(path);
  return { ...record, path, name, isFile, isDiractory };
}

export function normalizeCopiedFileEntries(entries: unknown): CopiedFileEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(normalizeCopiedFileEntry)
    .filter((entry): entry is CopiedFileEntry => Boolean(entry));
}

export function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export async function runCommand(program: string, args: string[], label: string): Promise<string> {
  const output = await Command.create(program, args).execute();
  if (output.code !== 0) {
    const detail = output.stderr?.trim() || `exit code ${output.code}`;
    throw new Error(`${label} failed: ${detail}`);
  }
  return output.stdout || "";
}

export async function runAppleScript(script: string, label: string): Promise<string> {
  return runCommand("osascript", ["-e", script], label);
}

export async function hideMainWindowForPluginPaste(onclose: () => void): Promise<void> {
  if ("__TAURI_INTERNALS__" in window) {
    await invoke("hide_main_window");
  } else {
    onclose();
  }
  await new Promise((resolve) => setTimeout(resolve, 80));
}

export function dataUrlToBytes(value: string): Uint8Array | null {
  const match = value.match(/^data:[^;]+;base64,(.*)$/);
  if (!match) return null;
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function writePluginImageToClipboard(image: unknown): Promise<void> {
  if (typeof image !== "string") {
    throw new Error("copyImage currently requires an image path or data URL");
  }
  const dataUrlBytes = dataUrlToBytes(image);
  await writeImage(dataUrlBytes || image);
}

export function pluginFileClipboardAppleScript(paths: string[]): string {
  const fileRefs = paths.map((path) => `(POSIX file ${appleScriptString(path)})`).join(", ");
  return `set the clipboard to {${fileRefs}}`;
}

export function normalizeEyeDropperHex(value: unknown): string {
  if (typeof value !== "string" || !/^#?[0-9a-fA-F]{6}$/.test(value)) {
    throw new Error("screenColorPick unavailable: EyeDropper did not return a valid sRGB color");
  }
  return value.startsWith("#") ? value.toLowerCase() : `#${value.toLowerCase()}`;
}

export function rgbStringFromHex(hex: string): string {
  const normalized = normalizeEyeDropperHex(hex).slice(1);
  const r = Number.parseInt(normalized.slice(0, 2), 16);
  const g = Number.parseInt(normalized.slice(2, 4), 16);
  const b = Number.parseInt(normalized.slice(4, 6), 16);
  return `rgb(${r}, ${g}, ${b})`;
}

export async function pickScreenColorWithEyeDropper(): Promise<{ hex: string; rgb: string }> {
  const EyeDropper = (window as EyeDropperWindow).EyeDropper;
  if (!EyeDropper) {
    throw new Error("screenColorPick unavailable: EyeDropper API is not available in the current WebView host");
  }
  const result = await new EyeDropper().open();
  const hex = normalizeEyeDropperHex(result.sRGBHex);
  return { hex, rgb: rgbStringFromHex(hex) };
}



export function writePluginOutputText(text: string, fallback: (text: string) => Promise<void>): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
    return fallback(text);
  } catch (error) {
    return Promise.reject(error);
  }
}
