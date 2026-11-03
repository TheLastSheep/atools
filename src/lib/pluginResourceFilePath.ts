/** Legacy filesystem-path resolution used by user-selected file and API routes. */
export function pluginMainResourceDir(pluginDir: string, mainFile: string): string {
  const normalizedMain = normalizeResourcePath(mainFile || "index.html");
  if (isAbsoluteResourcePath(normalizedMain)) return dirnameResourcePath(normalizedMain);
  return joinResourcePath(pluginDir, dirnameResourcePath(normalizedMain));
}

export function pluginResourceFilePath(
  pluginDir: string,
  mainFile: string,
  resourceUrl: string,
  baseDir?: string,
): string | null {
  const value = String(resourceUrl || "").trim();
  if (!isLocalResourceUrl(value)) return null;
  const { path } = splitResourceUrl(value);
  if (isAbsoluteResourcePath(path)) return normalizeResourcePath(path);
  return joinResourcePath(baseDir || pluginMainResourceDir(pluginDir, mainFile), path);
}

export function splitResourceUrl(value: string): { path: string; suffix: string } {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const suffixIndex = [queryIndex, hashIndex].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (suffixIndex === undefined) return { path: value, suffix: "" };
  return { path: value.slice(0, suffixIndex), suffix: value.slice(suffixIndex) };
}

export function dirnameResourcePath(path: string): string {
  const normalized = normalizeResourcePath(path || "");
  const trimmed = normalized.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return isAbsoluteResourcePath(trimmed) ? "/" : "";
  return trimmed.slice(0, index);
}

export function isLocalResourceUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (hasUrlProtocol(trimmed)) return false;
  return true;
}

function hasUrlProtocol(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("//");
}

function isAbsoluteResourcePath(value: string): boolean {
  return value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value);
}

function joinResourcePath(baseDir: string, path: string): string {
  const base = normalizeResourcePath(baseDir || "");
  const child = normalizeResourcePath(path || "");
  if (!child || child === ".") return base || ".";
  if (isAbsoluteResourcePath(child)) return normalizeResourcePath(child);
  return normalizeResourcePath(`${base.replace(/\/+$/, "")}/${child}`);
}

function normalizeResourcePath(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/");
  const absolutePrefix = normalized.startsWith("/") ? "/" : "";
  const drivePrefix = normalized.match(/^[a-zA-Z]:\//)?.[0] ?? "";
  const prefix = drivePrefix || absolutePrefix;
  const withoutPrefix = drivePrefix ? normalized.slice(drivePrefix.length) : normalized.replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of withoutPrefix.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!prefix) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const joined = parts.join("/");
  if (drivePrefix) return `${drivePrefix}${joined}`;
  if (absolutePrefix) return `/${joined}`;
  return joined || ".";
}
