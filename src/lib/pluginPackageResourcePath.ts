type RootPath = { prefix: string; parts: string[]; drive: boolean };

/** Resolve a manifest main URL. A single leading slash is relative to pluginRoot. */
export function resolvePluginPackageMainUrl(pluginRoot: string, mainUrl: string): string | null {
  const root = parseRoot(pluginRoot);
  if (!root || !isSafeText(mainUrl)) return null;
  const value = mainUrl || "index.html";
  if (isExternal(value) || value.startsWith("//")) return null;
  const { path } = splitSuffix(value);
  if (!path) return null;
  if (/^[a-zA-Z]:[\\/]/.test(path) || path.includes("\\")) return null;
  return resolvePath(root, root.parts, path, path.startsWith("/"));
}

/** Validate an already-physical main path. This API never interprets URL paths. */
export function resolvePluginPackageMainPath(pluginRoot: string, physicalPath: string): string | null {
  const root = parseRoot(pluginRoot);
  if (!root || !isSafeText(physicalPath)) return null;
  const physical = resolveAbsolute(physicalPath);
  if (physical && isWithin(root, physical)) return format(physical);
  return null;
}

/** Resolve a package URL relative to a physical package document/base directory. */
export function resolvePluginPackageResourcePath(
  pluginRoot: string,
  mainFilePath: string,
  resourceUrl: string,
  baseDirPath?: string,
): string | null {
  const root = parseRoot(pluginRoot);
  if (!root || !isSafeText(resourceUrl) || !isSafeText(mainFilePath)) return null;
  const value = resourceUrl.trim();
  if (!value || value.startsWith("#") || isExternal(value) || value.startsWith("//")) return null;
  const { path } = splitSuffix(value);
  if (!path) return null;
  const main = resolveAbsolute(mainFilePath);
  if (!main || !isWithin(root, main)) return null;
  const base = baseDirPath ? resolveAbsolute(baseDirPath) : { ...main, parts: main.parts.slice(0, -1) };
  if (!base || !isWithin(root, base)) return null;
  return resolvePath(root, base.parts, path, path.startsWith("/"));
}

export function isExternalPluginResourceUrl(value: string): boolean {
  const trimmed = String(value || "").trim();
  return !trimmed || trimmed.startsWith("#") || trimmed.startsWith("//") || isExternal(trimmed);
}

export function convertPluginPackageResourceUrl(
  pluginRoot: string,
  mainFilePath: string,
  resourceUrl: string,
  convertFileSrc: (path: string) => string,
  baseDirPath?: string,
): string | null {
  if (isExternalPluginResourceUrl(resourceUrl)) return resourceUrl;
  const path = resolvePluginPackageResourcePath(pluginRoot, mainFilePath, resourceUrl, baseDirPath);
  if (!path) return null;
  const value = resourceUrl.trim();
  const suffixIndex = [value.indexOf("?"), value.indexOf("#")].filter(index => index >= 0).sort((a, b) => a - b)[0];
  return `${convertFileSrc(path)}${suffixIndex === undefined ? "" : value.slice(suffixIndex)}`;
}

function resolvePath(root: RootPath, baseParts: string[], value: string, fromRoot: boolean): string | null {
  if (!isSafeText(value) || value.includes("\\")) return null;
  const parts = fromRoot ? [...root.parts] : [...baseParts];
  for (const rawPart of value.split("/")) {
    if (!rawPart || rawPart === ".") continue;
    let part: string;
    try { part = decodeURIComponent(rawPart); } catch { return null; }
    if (!part || part === ".") continue;
    if (part === "..") {
      const rootFloor = root.parts.length;
      if (parts.length <= rootFloor) return null;
      parts.pop();
      continue;
    }
    if (/[\\/\u0000-\u001f\u007f]/.test(part) || /^[a-zA-Z]:$/.test(part)) return null;
    parts.push(part);
  }
  const resolved = { ...root, parts };
  return isWithin(root, resolved) ? format(resolved) : null;
}

function parseRoot(value: string): RootPath | null {
  if (!isSafeText(value)) return null;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("//")) return null;
  const drivePrefix = normalized.match(/^([a-zA-Z]:)\//)?.[1];
  if (!drivePrefix && !normalized.startsWith("/")) return null;
  const body = drivePrefix ? normalized.slice(3) : normalized.slice(1);
  const parts: string[] = [];
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." || /[\u0000-\u001f\u007f]/.test(part)) return null;
    parts.push(part);
  }
  return { prefix: drivePrefix ? `${drivePrefix}/` : "/", parts, drive: Boolean(drivePrefix) };
}

function resolveAbsolute(value: string): RootPath | null {
  if (!isSafeText(value)) return null;
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("//")) return null;
  const drivePrefix = normalized.match(/^([a-zA-Z]:)\//)?.[1];
  if (!drivePrefix && !normalized.startsWith("/")) return null;
  const root: RootPath = { prefix: drivePrefix ? `${drivePrefix}/` : "/", parts: [], drive: Boolean(drivePrefix) };
  const body = drivePrefix ? normalized.slice(3) : normalized.slice(1);
  for (const part of body.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!root.parts.length) return null;
      root.parts.pop();
    } else if (/[\u0000-\u001f\u007f]/.test(part)) return null;
    else root.parts.push(part);
  }
  return root;
}

function isWithin(root: RootPath, candidate: RootPath): boolean {
  const fold = (value: string) => root.drive ? value.toLowerCase() : value;
  if (fold(root.prefix) !== fold(candidate.prefix) || candidate.parts.length < root.parts.length) return false;
  return root.parts.every((part, index) => fold(part) === fold(candidate.parts[index]));
}

function format(value: RootPath): string {
  return `${value.prefix}${value.parts.join("/")}`;
}

function isExternal(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
}

function isSafeText(value: string): boolean {
  return typeof value === "string" && !/[\u0000-\u001f\u007f]/.test(value);
}

function splitSuffix(value: string): { path: string } {
  const index = [value.indexOf("?"), value.indexOf("#")].filter(item => item >= 0).sort((a, b) => a - b)[0];
  return { path: index === undefined ? value : value.slice(0, index) };
}
