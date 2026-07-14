type ReadTextFile = (path: string) => Promise<string>;
type ConvertFileSrc = (path: string) => string;

export type PluginResourceHtmlOptions = {
  pluginDir: string;
  mainFile: string;
  readTextFile: ReadTextFile;
  convertFileSrc: ConvertFileSrc;
  warn?: (message: string, error: unknown) => void;
};

type PluginResourceUrlOptions = {
  pluginDir: string;
  mainFile: string;
  convertFileSrc: ConvertFileSrc;
};

export async function preparePluginHtmlResources(
  html: string,
  options: PluginResourceHtmlOptions,
): Promise<string> {
  const baseDir = pluginHtmlBaseResourceDir(html, options);
  let prepared = rewriteHtmlResourceAttributes(html, options, baseDir);
  prepared = await inlinePluginScripts(prepared, options, baseDir);
  prepared = await inlinePluginStylesheets(prepared, options, baseDir);
  return prepared;
}

export function pluginMainResourceDir(pluginDir: string, mainFile: string): string {
  const normalizedMain = normalizeResourcePath(mainFile || "index.html");
  if (isAbsoluteResourcePath(normalizedMain)) {
    return dirnameResourcePath(normalizedMain);
  }
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
  if (isAbsoluteResourcePath(path)) {
    return normalizeResourcePath(path);
  }

  return joinResourcePath(baseDir || pluginMainResourceDir(pluginDir, mainFile), path);
}

export function convertPluginResourceUrl(
  resourceUrl: string,
  options: PluginResourceUrlOptions,
  baseDir?: string,
): string {
  const value = String(resourceUrl || "").trim();
  if (!isLocalResourceUrl(value)) return resourceUrl;

  const { suffix } = splitResourceUrl(value);
  const path = pluginResourceFilePath(options.pluginDir, options.mainFile, value, baseDir);
  if (!path) return resourceUrl;
  return `${options.convertFileSrc(path)}${suffix}`;
}

function rewriteHtmlResourceAttributes(
  html: string,
  options: PluginResourceHtmlOptions,
  baseDir?: string,
): string {
  return html.replace(/<([a-zA-Z][\w:-]*)([^>]*)>/g, (tag, tagName: string, attrs: string) => {
    const normalizedTag = tagName.toLowerCase();
    if (normalizedTag === "base") {
      let originalBaseHref: string | undefined;
      const updatedAttrs = attrs.replace(
        /\s(href)\s*=\s*(["'])([^"']*)\2/gi,
        (attribute, attrName: string, quote: string, url: string) => {
          const converted = convertPluginBaseHref(url, options);
          if (converted === url) return attribute;
          originalBaseHref = url;
          return ` ${attrName}=${quote}${escapeHtmlAttribute(converted)}${quote}`;
        },
      );
      if (originalBaseHref && !/\sdata-atools-plugin-base-href\s*=/i.test(updatedAttrs)) {
        return `<${tagName}${updatedAttrs} data-atools-plugin-base-href="${escapeHtmlAttribute(originalBaseHref)}">`;
      }
      return `<${tagName}${updatedAttrs}>`;
    }
    if (normalizedTag === "script" || normalizedTag === "style") return tag;
    if (normalizedTag === "link" && isStylesheetLink(tag)) return tag;

    const allowedAttrs = normalizedTag === "link" ? new Set(["href"]) : new Set(["src", "poster", "srcset"]);
    const updatedAttrs = attrs.replace(
      /\s(src|poster|href|srcset)\s*=\s*(["'])([^"']*)\2/gi,
      (attribute, attrName: string, quote: string, url: string) => {
        if (!allowedAttrs.has(attrName.toLowerCase())) return attribute;
        const converted = attrName.toLowerCase() === "srcset"
          ? rewriteSrcsetResourceUrls(url, options, baseDir)
          : convertPluginResourceUrl(url, options, baseDir);
        if (converted === url) return attribute;
        return ` ${attrName}=${quote}${escapeHtmlAttribute(converted)}${quote}`;
      },
    );

    return `<${tagName}${updatedAttrs}>`;
  });
}

async function inlinePluginScripts(
  html: string,
  options: PluginResourceHtmlOptions,
  baseDir?: string,
): Promise<string> {
  return replaceAsync(
    html,
    /<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi,
    async (tag, beforeSrc: string, _quote: string, src: string, afterSrc: string) => {
      const scriptPath = pluginResourceFilePath(options.pluginDir, options.mainFile, src, baseDir);
      if (!scriptPath) return tag;

      try {
        const scriptContent = await options.readTextFile(scriptPath);
        return `<script${beforeSrc}${afterSrc}>\n${escapeInlineScript(scriptContent)}\n</script>`;
      } catch (error) {
        options.warn?.(`Failed to inline script: ${src}`, error);
        return tag;
      }
    },
  );
}

async function inlinePluginStylesheets(
  html: string,
  options: PluginResourceHtmlOptions,
  baseDir?: string,
): Promise<string> {
  return replaceAsync(
    html,
    /<link\b([^>]*)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi,
    async (tag, _beforeHref: string, _quote: string, href: string, _afterHref: string) => {
      if (!isStylesheetLink(tag)) return tag;

      const stylesheetPath = pluginResourceFilePath(options.pluginDir, options.mainFile, href, baseDir);
      if (!stylesheetPath) return tag;

      try {
        const css = await options.readTextFile(stylesheetPath);
        const rewrittenCss = rewriteCssResourceUrls(css, options, dirnameResourcePath(stylesheetPath));
        return `<style data-atools-plugin-href="${escapeHtmlAttribute(href)}">\n${rewrittenCss}\n</style>`;
      } catch (error) {
        options.warn?.(`Failed to inline stylesheet: ${href}`, error);
        return tag;
      }
    },
  );
}

function rewriteCssResourceUrls(
  css: string,
  options: PluginResourceHtmlOptions,
  baseDir: string,
): string {
  const imported = css.replace(
    /@import\s+(["'])([^"']+)\1/gi,
    (match, _quote: string, url: string) => {
      const converted = convertPluginResourceUrl(url, options, baseDir);
      if (converted === url) return match;
      return `@import "${escapeCssUrl(converted)}"`;
    },
  );

  return imported.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi,
    (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
      const url = (doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
      if (!url) return match;

      const converted = convertPluginResourceUrl(url, options, baseDir);
      if (converted === url) return match;
      return `url("${escapeCssUrl(converted)}")`;
    },
  );
}

function rewriteSrcsetResourceUrls(value: string, options: PluginResourceUrlOptions, baseDir?: string): string {
  return splitSrcsetCandidates(value)
    .map((candidate) => rewriteSrcsetCandidate(candidate, options, baseDir))
    .join(", ");
}

function rewriteSrcsetCandidate(candidate: string, options: PluginResourceUrlOptions, baseDir?: string): string {
  const trimmed = candidate.trim();
  if (!trimmed) return trimmed;

  const match = trimmed.match(/^(\S+)(\s+.*)?$/);
  if (!match) return candidate;

  const converted = convertPluginResourceUrl(match[1], options, baseDir);
  return `${converted}${match[2] ?? ""}`;
}

function splitSrcsetCandidates(value: string): string[] {
  const candidates: string[] = [];
  let current = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "," && isSrcsetSeparator(current)) {
      candidates.push(current);
      current = "";
      continue;
    }
    current += char;
  }

  if (current || candidates.length === 0) {
    candidates.push(current);
  }

  return candidates;
}

function isSrcsetSeparator(current: string): boolean {
  const trimmed = current.trim();
  if (!trimmed) return true;
  return !trimmed.toLowerCase().startsWith("data:") || /\s+\S+$/.test(trimmed);
}

function isStylesheetLink(tag: string): boolean {
  return /\brel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|[^\s>]*stylesheet[^\s>]*)/i.test(tag);
}

function pluginHtmlBaseResourceDir(html: string, options: PluginResourceUrlOptions): string | undefined {
  const match = html.match(/<base\b[^>]*\bhref\s*=\s*(["'])([^"']+)\1[^>]*>/i);
  if (!match) return undefined;

  const rawHref = match[2];
  const basePath = pluginResourceFilePath(options.pluginDir, options.mainFile, rawHref);
  if (!basePath) return undefined;

  const { path } = splitResourceUrl(rawHref.trim());
  return path.replace(/\\/g, "/").endsWith("/")
    ? basePath
    : dirnameResourcePath(basePath);
}

function convertPluginBaseHref(resourceUrl: string, options: PluginResourceUrlOptions): string {
  const value = String(resourceUrl || "").trim();
  if (!isLocalResourceUrl(value)) return resourceUrl;

  const { path, suffix } = splitResourceUrl(value);
  const resourcePath = pluginResourceFilePath(options.pluginDir, options.mainFile, value);
  if (!resourcePath) return resourceUrl;

  const convertedPath = path.replace(/\\/g, "/").endsWith("/") && !resourcePath.endsWith("/")
    ? `${resourcePath}/`
    : resourcePath;
  return `${options.convertFileSrc(convertedPath)}${suffix}`;
}

function isLocalResourceUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  if (hasUrlProtocol(trimmed)) return false;
  return true;
}

function hasUrlProtocol(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/.test(value)) return false;
  return /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value) || value.startsWith("//");
}

function splitResourceUrl(value: string): { path: string; suffix: string } {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  const suffixIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (suffixIndex === undefined) return { path: value, suffix: "" };
  return {
    path: value.slice(0, suffixIndex),
    suffix: value.slice(suffixIndex),
  };
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

function dirnameResourcePath(path: string): string {
  const normalized = normalizeResourcePath(path || "");
  const trimmed = normalized.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return isAbsoluteResourcePath(trimmed) ? "/" : "";
  return trimmed.slice(0, index);
}

function normalizeResourcePath(path: string): string {
  const normalized = String(path || "").replace(/\\/g, "/");
  const absolutePrefix = normalized.startsWith("/") ? "/" : "";
  const drivePrefix = normalized.match(/^[a-zA-Z]:\//)?.[0] ?? "";
  const prefix = drivePrefix || absolutePrefix;
  const withoutPrefix = drivePrefix
    ? normalized.slice(drivePrefix.length)
    : normalized.replace(/^\/+/, "");
  const parts: string[] = [];

  for (const part of withoutPrefix.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!prefix) {
        parts.push(part);
      }
      continue;
    }
    parts.push(part);
  }

  const joined = parts.join("/");
  if (drivePrefix) return `${drivePrefix}${joined}`;
  if (absolutePrefix) return `/${joined}`;
  return joined || ".";
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeCssUrl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeInlineScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
}

async function replaceAsync(
  value: string,
  pattern: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...value.matchAll(pattern)];
  let result = "";
  let lastIndex = 0;

  for (const match of matches) {
    const index = match.index ?? 0;
    result += value.slice(lastIndex, index);
    result += await replacer(...(match as unknown as string[]));
    lastIndex = index + match[0].length;
  }

  return result + value.slice(lastIndex);
}
