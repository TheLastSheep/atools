import { preparePluginHtmlResources } from "./pluginResourceHtml";
import { pluginLeaseResourceUrl } from "./pluginResourceLease";
import { packageRelativeResourcePath } from "./pluginResourceLease";
import { resolvePluginPackageMainUrl, resolvePluginPackageResourcePath } from "./pluginPackageResourcePath";
import { splitResourceUrl } from "./pluginResourceFilePath";
import { rewritePluginNativeWindowHtmlStyles } from "./pluginNativeWindowHtmlStyles";

const DOCUMENT_ID = /^[0-9a-f]{64}$/;
const DOCUMENT_QUERY = "__atools_window_document";

export type PluginNativeWindowDocument = {
  relativePath: string;
  html: string;
  resourceUrl: string;
};

/** Read and rewrite a package HTML page for an opaque native-window renderer lease. */
export async function preparePluginNativeWindowDocument(options: {
  pluginRoot: string;
  mainUrl: string;
  requestedUrl: string;
  resourceSessionId: string;
  resourceOrigin: string;
  readTextFile: (path: string) => Promise<string>;
  resolveModuleSrc?: (path: string) => string | Promise<string>;
  warn?: (message: string, error: unknown) => void;
}): Promise<PluginNativeWindowDocument> {
  const mainPath = resolvePluginPackageMainUrl(options.pluginRoot, options.mainUrl || "index.html");
  const pagePath = mainPath && resolvePluginPackageResourcePath(options.pluginRoot, mainPath, options.requestedUrl);
  if (!pagePath || !/\.html?$/i.test(pagePath)) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_HTML_PATH");
  const relativePath = packageRelativeResourcePath(options.pluginRoot, pagePath);
  const pathToResourceUrl = (path: string) => pluginLeaseResourceUrl(
    options.resourceOrigin,
    options.resourceSessionId,
    packageRelativeResourcePath(options.pluginRoot, path),
  );
  const html = await options.readTextFile(pagePath);
  const prepared = await preparePluginHtmlResources(html, {
    pluginDir: options.pluginRoot,
    pluginRoot: options.pluginRoot,
    mainFile: options.mainUrl || "index.html",
    mainFilePath: pagePath,
    readTextFile: options.readTextFile,
    convertFileSrc: pathToResourceUrl,
    resolveModuleSrc: options.resolveModuleSrc,
    warn: options.warn,
  });
  const nativeStyledHtml = rewritePluginNativeWindowHtmlStyles(prepared);
  return {
    relativePath,
    html: nativeStyledHtml,
    resourceUrl: `${pluginLeaseResourceUrl(options.resourceOrigin, options.resourceSessionId, relativePath)}${splitResourceUrl(options.requestedUrl).suffix}`,
  };
}

/** Preserve the plugin's raw query and fragment while adding the host-only document lease. */
export function appendPluginNativeWindowDocumentId(resourceUrl: string, documentId: string): string {
  if (!DOCUMENT_ID.test(documentId)) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_DOCUMENT_ID");
  const { path, suffix } = splitResourceUrl(resourceUrl);
  const hashIndex = suffix.indexOf("#");
  const query = hashIndex < 0 ? suffix : suffix.slice(0, hashIndex);
  const hash = hashIndex < 0 ? "" : suffix.slice(hashIndex);
  if (query) {
    const params = new URLSearchParams(query.slice(1));
    if (params.has(DOCUMENT_QUERY)) throw Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_DOCUMENT_QUERY");
  }
  const separator = !query ? "?" : query.endsWith("?") || query.endsWith("&") ? "" : "&";
  return `${path}${query}${separator}${DOCUMENT_QUERY}=${documentId}${hash}`;
}
