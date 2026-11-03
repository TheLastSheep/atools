import { convertPluginResourceUrl } from "./pluginResourceHtml";
import {
  dirnameResourcePath,
  pluginResourceFilePath,
  splitResourceUrl,
} from "./pluginResourceFilePath";
import {
  convertPluginPackageResourceUrl,
  isExternalPluginResourceUrl,
  resolvePluginPackageMainUrl,
  resolvePluginPackageResourcePath,
} from "./pluginPackageResourcePath";

export type PluginRuntimeDocumentKind = "main" | "browserWindow";

export type PluginRuntimeResourceUrlOptions = {
  pluginRoot: string;
  mainUrl: string;
  documentKind: PluginRuntimeDocumentKind;
  resourceUrl: string;
  baseUrl?: string;
  convertFileSrc: (path: string) => string;
};

/**
 * Resolve a resource request using the identity of the document that sent it.
 * The main plugin document uses package URL semantics; hosted BrowserWindow
 * documents retain the existing physical-file resolver semantics.
 */
export function convertPluginRuntimeResourceUrl(
  options: PluginRuntimeResourceUrlOptions,
): string | null {
  const { pluginRoot, mainUrl, resourceUrl, convertFileSrc } = options;
  if (options.documentKind === "browserWindow") {
    return convertPluginResourceUrl(resourceUrl, {
      pluginDir: pluginRoot,
      mainFile: mainUrl,
      convertFileSrc,
    }, legacyRuntimeBaseDir(pluginRoot, mainUrl, options.baseUrl));
  }

  const mainFilePath = resolvePluginPackageMainUrl(pluginRoot, mainUrl);
  if (!mainFilePath) return null;
  const baseDirPath = packageRuntimeBaseDir(pluginRoot, mainFilePath, options.baseUrl);
  if (baseDirPath === null) return null;
  return convertPluginPackageResourceUrl(
    pluginRoot,
    mainFilePath,
    resourceUrl,
    convertFileSrc,
    baseDirPath,
  );
}

function legacyRuntimeBaseDir(pluginRoot: string, mainUrl: string, baseUrl?: string): string | undefined {
  const raw = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!raw) return undefined;
  const basePath = pluginResourceFilePath(pluginRoot, mainUrl, raw);
  if (!basePath) return undefined;
  const rawPath = splitResourceUrl(raw).path.replace(/\\/g, "/");
  return rawPath.endsWith("/") ? basePath : dirnameResourcePath(basePath);
}

function packageRuntimeBaseDir(
  pluginRoot: string,
  mainFilePath: string,
  baseUrl?: string,
): string | undefined | null {
  const raw = typeof baseUrl === "string" ? baseUrl.trim() : "";
  if (!raw || isExternalPluginResourceUrl(raw)) return undefined;
  const basePath = resolvePluginPackageResourcePath(pluginRoot, mainFilePath, raw);
  if (!basePath) return null;
  return splitResourceUrl(raw).path.replace(/\\/g, "/").endsWith("/")
    ? basePath
    : dirnameResourcePath(basePath);
}
