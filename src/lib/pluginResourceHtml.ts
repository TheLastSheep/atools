import { rewritePluginInlineModule, type PluginInlineModuleState } from "./pluginInlineModules";
import { findActiveHtmlScriptSpans } from "./pluginHtmlScripts";
import { analyzePluginSource } from "./pluginSourceAnalysis";
import { removeActiveOptionalRemoteFontLinks } from "./pluginActiveHtmlFontMetadata";
import {
  dirnameResourcePath,
  isLocalResourceUrl,
  pluginMainResourceDir,
  pluginResourceFilePath,
  splitResourceUrl,
} from "./pluginResourceFilePath";
export { pluginMainResourceDir, pluginResourceFilePath };
import {
  convertPluginPackageResourceUrl,
  isExternalPluginResourceUrl,
  resolvePluginPackageMainPath,
  resolvePluginPackageMainUrl,
  resolvePluginPackageResourcePath,
} from "./pluginPackageResourcePath";

type ReadTextFile = (path: string) => Promise<string>;
type ConvertFileSrc = (path: string) => string;

export type PluginResourceHtmlOptions = {
  pluginDir: string;
  mainFile: string;
  /** The selected package root. `mainFilePath`, when provided, is already physical. */
  pluginRoot?: string;
  mainFilePath?: string;
  /** User-selected BrowserWindow documents retain the legacy physical-file resolver. */
  resourceResolution?: "package" | "legacy";
  readTextFile: ReadTextFile;
  convertFileSrc: ConvertFileSrc;
  resolveModuleSrc?: (path: string) => string | Promise<string>;
  warn?: (message: string, error: unknown) => void;
};

type PluginResourceUrlOptions = {
  pluginDir: string;
  mainFile: string;
  pluginRoot?: string;
  mainFilePath?: string;
  resourceResolution?: "package" | "legacy";
  convertFileSrc: ConvertFileSrc;
};

export async function preparePluginHtmlResources(
  html: string,
  options: PluginResourceHtmlOptions,
): Promise<string> {
  const packageRoot = options.pluginRoot ?? options.pluginDir;
  const mainFilePath = options.resourceResolution === "legacy"
    ? options.mainFile
    : options.mainFilePath
      ? resolvePluginPackageMainPath(packageRoot, options.mainFilePath)
      : resolvePluginPackageMainUrl(packageRoot, options.mainFile);
  if (options.resourceResolution !== "legacy" && !mainFilePath) throw new Error("ERR_ATOOLS_PLUGIN_MAIN_PATH");
  const baseDir = pluginHtmlBaseResourceDir(html, options);
  let prepared = rewriteHtmlResourceAttributes(html, options, baseDir);
  prepared = await inlinePluginScripts(prepared, options, baseDir);
  prepared = await inlinePluginStylesheets(prepared, options, baseDir);
  return prepared;
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

function convertResourceUrl(
  resourceUrl: string,
  options: PluginResourceUrlOptions,
  baseDir?: string,
): string {
  if (options.resourceResolution === "legacy") {
    return convertPluginResourceUrl(resourceUrl, options, baseDir);
  }
  const value = String(resourceUrl || "").trim();
  if (isExternalPluginResourceUrl(value)) return resourceUrl;
  const converted = convertPluginPackageResourceUrl(options.pluginRoot ?? options.pluginDir,
    mainFilePath(options), value, options.convertFileSrc, baseDir);
  if (!converted) throw new Error("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
  return converted;
}

function mainFilePath(options: PluginResourceUrlOptions): string {
  const root = options.pluginRoot ?? options.pluginDir;
  const path = options.mainFilePath
    ? resolvePluginPackageMainPath(root, options.mainFilePath)
    : resolvePluginPackageMainUrl(root, options.mainFile);
  if (!path) throw new Error("ERR_ATOOLS_PLUGIN_MAIN_PATH");
  return path;
}

function resolveResourcePath(
  resourceUrl: string,
  options: PluginResourceUrlOptions,
  baseDir?: string,
): string | null {
  if (options.resourceResolution === "legacy") {
    return pluginResourceFilePath(options.pluginDir, options.mainFile, resourceUrl, baseDir);
  }
  if (isExternalPluginResourceUrl(resourceUrl)) return null;
  return resolvePluginPackageResourcePath(options.pluginRoot ?? options.pluginDir, mainFilePath(options), resourceUrl, baseDir);
}

function rewriteHtmlResourceAttributes(
  html: string,
  options: PluginResourceHtmlOptions,
  baseDir?: string,
): string {
  const activeMarkup = removeActiveOptionalRemoteFontLinks(html);
  return activeMarkup.replace(/<([a-zA-Z][\w:-]*)([^>]*)>/g, (tag, tagName: string, attrs: string) => {
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
          : convertResourceUrl(url, options, baseDir);
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
  const activeExternalScripts = new Set(findActiveHtmlScriptSpans(html)
    .filter(script => isClassicScript(script.attributes) || scriptType(script.attributes) === "module")
    .map(script => script.start));
  const externalPrepared = await replaceAsync(
    html,
    /<script\b([^>]*)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi,
    async (tag, beforeSrc: string, _quote: string, src: string, afterSrc: string) => {
      const scriptPath = resolveResourcePath(src, options, baseDir);
      if (!scriptPath) {
        if (options.resourceResolution !== "legacy" && !isExternalPluginResourceUrl(src)) {
          throw new Error("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
        }
        return tag;
      }
      const attributes = `${beforeSrc}${afterSrc}`;
      // Native module URLs define import.meta, relative imports and module identity.
      // Scheduled classic scripts also need their parser scheduling/source URL.
      if (usesNativeExternalScript(attributes)) {
        const scriptUrl = scriptType(attributes) === "module" && options.resolveModuleSrc
          ? `${await options.resolveModuleSrc(scriptPath)}${splitResourceUrl(src).suffix}`
          : convertResourceUrl(src, options, baseDir);
        return `<script${attributes} src="${escapeHtmlAttribute(scriptUrl)}" data-atools-plugin-script-src="${escapeHtmlAttribute(scriptUrl)}"></script>`;
      }
      let scriptContent: string;
      try {
        scriptContent = await options.readTextFile(scriptPath);
      } catch (error) {
        options.warn?.(`Failed to inline script: ${src}`, error);
        return tag;
      }
      const publicPathFallbacks = scriptContent.includes("Automatic publicPath is not supported in this browser")
        ? analyzePluginSource(scriptContent, { includeAutomaticPublicPathFallbacks: true }).automaticPublicPathFallbacks ?? [] : [];
      const leasedPublicPath = Boolean(options.resolveModuleSrc && publicPathFallbacks.length);
      const scriptUrl = leasedPublicPath ? await options.resolveModuleSrc!(scriptPath) : options.convertFileSrc(scriptPath);
      const normalizedScript = normalizeInlinePluginScript(scriptContent, scriptUrl, publicPathFallbacks);
      const publicPathMarker = leasedPublicPath ? ` data-atools-plugin-public-path-src="${escapeHtmlAttribute(scriptUrl)}"` : "";
      return `<script${attributes} data-atools-plugin-script-src="${escapeHtmlAttribute(scriptUrl)}"${publicPathMarker}>\n${escapeInlineScript(normalizedScript)}\n</script>`;
    }, index => activeExternalScripts.has(index),
  );
  if (!options.resolveModuleSrc) return externalPrepared;

  let moduleState: PluginInlineModuleState | undefined;
  const parts: string[] = [];
  let cursor = 0, changed = false;
  for (const script of findActiveHtmlScriptSpans(externalPrepared)) {
    if (scriptType(script.attributes) !== "module" || scriptAttributes(script.attributes).has("src")) continue;
    const result = await rewritePluginInlineModule(externalPrepared.slice(script.contentStart, script.contentEnd), async (specifier) => {
        const { path, suffix } = splitResourceUrl(specifier);
        const modulePath = resolveResourcePath(path, options, baseDir);
        if (!modulePath) throw new Error("ERR_ATOOLS_INLINE_MODULE_PATH");
        return `${await options.resolveModuleSrc!(modulePath)}${suffix}`;
    }, moduleState);
    if (!result) continue;
    moduleState = result.state;
    if (!result.urls.length) continue;
    parts.push(externalPrepared.slice(cursor, script.start));
    const marker = escapeHtmlAttribute(JSON.stringify(result.urls));
    parts.push(`${externalPrepared.slice(script.start, script.openEnd - 1)} data-atools-plugin-module-imports="${marker}">`);
    parts.push(result.source, externalPrepared.slice(script.contentEnd, script.end));
    cursor = script.end;
    changed = true;
  }
  if (!changed) return externalPrepared;
  parts.push(externalPrepared.slice(cursor));
  return parts.join("");
}

function scriptAttributes(attributes: string): Map<string, string> {
  const names = new Map<string, string>();
  for (const match of attributes.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const name = match[1].toLowerCase();
    if (!names.has(name)) names.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return names;
}

function scriptType(attributes: string): string {
  return (scriptAttributes(attributes).get("type") ?? "").split(";", 1)[0].trim().toLowerCase();
}

function usesNativeExternalScript(attributes: string): boolean {
  const names = scriptAttributes(attributes), type = scriptType(attributes);
  return type === "module" || isClassicScript(attributes) && (names.has("defer") || names.has("async"));
}

function isClassicScript(attributes: string): boolean {
  const type = scriptType(attributes);
  return !type || /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:javascript1\.[0-5]|jscript|livescript))$/.test(type);
}

function normalizeInlinePluginScript(source: string, sourceUrl: string, ranges: Array<{ start: number; end: number }>): string {
  const fallback = `new URL(${JSON.stringify(sourceUrl)}, document.baseURI).href`;
  let normalized = source;
  for (const range of [...ranges].sort((left, right) => right.start - left.start))
    normalized = normalized.slice(0, range.start) + `if(!e)e=${fallback};` + normalized.slice(range.end);
  return normalized;
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

      const stylesheetPath = resolveResourcePath(href, options, baseDir);
      if (!stylesheetPath) {
        if (options.resourceResolution !== "legacy" && !isExternalPluginResourceUrl(href)) {
          throw new Error("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
        }
        return tag;
      }

      try {
        const css = await options.readTextFile(stylesheetPath);
        const rewrittenCss = rewriteCssResourceUrls(css, options, dirnameResourcePath(stylesheetPath));
        return `<style data-atools-plugin-href="${escapeHtmlAttribute(href)}">\n${rewrittenCss}\n</style>`;
      } catch (error) {
        if (options.resourceResolution !== "legacy"
          && error instanceof Error
          && error.message === "ERR_ATOOLS_PLUGIN_RESOURCE_PATH") {
          throw error;
        }
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
      const converted = convertResourceUrl(url, options, baseDir);
      if (converted === url) return match;
      return `@import "${escapeCssUrl(converted)}"`;
    },
  );

  return imported.replace(
    /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]+))\s*\)/gi,
    (match, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined) => {
      const url = (doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
      if (!url) return match;

      const converted = convertResourceUrl(url, options, baseDir);
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

  const converted = convertResourceUrl(match[1], options, baseDir);
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
  if (options.resourceResolution === "legacy") {
    const basePath = pluginResourceFilePath(options.pluginDir, options.mainFile, rawHref);
    if (!basePath) return undefined;
    const { path } = splitResourceUrl(rawHref.trim());
    return path.replace(/\\/g, "/").endsWith("/") ? basePath : dirnameResourcePath(basePath);
  }
  const basePath = resolveResourcePath(rawHref, options);
  if (!basePath) {
    if (!isExternalPluginResourceUrl(rawHref)) throw new Error("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");
    return undefined;
  }

  const { path } = splitResourceUrl(rawHref.trim());
  return path.replace(/\\/g, "/").endsWith("/")
    ? basePath
    : dirnameResourcePath(basePath);
}

function convertPluginBaseHref(resourceUrl: string, options: PluginResourceUrlOptions): string {
  const value = String(resourceUrl || "").trim();
  if (options.resourceResolution === "legacy" ? !isLocalResourceUrl(value) : isExternalPluginResourceUrl(value)) return resourceUrl;

  const { path, suffix } = splitResourceUrl(value);
  const resourcePath = options.resourceResolution === "legacy"
    ? pluginResourceFilePath(options.pluginDir, options.mainFile, value)
    : resolveResourcePath(value, options);
  if (!resourcePath) throw new Error("ERR_ATOOLS_PLUGIN_RESOURCE_PATH");

  const convertedPath = path.replace(/\\/g, "/").endsWith("/") && !resourcePath.endsWith("/")
    ? `${resourcePath}/`
    : resourcePath;
  return `${options.convertFileSrc(convertedPath)}${suffix}`;
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
  accept?: (index: number) => boolean,
): Promise<string> {
  const matches = [...value.matchAll(pattern)];
  let result = "";
  let lastIndex = 0;

  for (const match of matches) {
    const index = match.index ?? 0;
    result += value.slice(lastIndex, index);
    result += accept && !accept(index) ? match[0] : await replacer(...(match as unknown as string[]));
    lastIndex = index + match[0].length;
  }

  return result + value.slice(lastIndex);
}
