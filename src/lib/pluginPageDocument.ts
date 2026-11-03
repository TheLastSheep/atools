import { packageRelativeResourcePath } from "./pluginResourceLease";
import { pluginMainResourceDir } from "./pluginResourceHtml";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
export type PreparedPluginPage = Readonly<{
  pageDocumentId: string;
  bootstrapUrl: string;
  expectedOrigin: string;
  parentOrigin: string;
  resourceBaseUrl: string;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOUND_PREPARE = new Set(["prepare_legacy_node", "prepare_host_clipboard", "prepare_plugin_data", "prepare_plugin_dialogs", "prepare_plugin_display", "prepare_plugin_secret_storage",
  "list_plugin_ai_models", "prepare_plugin_ai_request", "execute_plugin_ai_request", "ack_plugin_ai_delta", "take_plugin_ai_result", "cancel_plugin_ai_request"]);

/** Experimental mode is compiled only into explicitly selected native fixtures.
 * Native additionally checks its own flag and isolated fixture ownership. */
export function pluginPageDocumentModeEnabled() {
  return import.meta.env.VITE_ATOOLS_PLUGIN_PAGE_DOCUMENT === "true";
}

export function validatePreparedPluginPage(value: PreparedPluginPage, parentOrigin: string): PreparedPluginPage {
  if (!value || !UUID.test(value.pageDocumentId)) throw Error("ERR_ATOOLS_PAGE_IDENTITY");
  const origin = `atools-page://${value.pageDocumentId.replaceAll("-", "")}.localhost`;
  if (value.expectedOrigin !== origin || value.parentOrigin !== parentOrigin || parentOrigin === "null"
    || value.resourceBaseUrl !== `${origin}/assets/`) throw Error("ERR_ATOOLS_PAGE_IDENTITY");
  let url: URL;
  try { url = new URL(value.bootstrapUrl); } catch { throw Error("ERR_ATOOLS_PAGE_IDENTITY"); }
  if (url.protocol !== "atools-page:" || url.hostname !== origin.slice("atools-page://".length) || url.port || url.username || url.password
    || url.search || url.hash || !/^\/[0-9a-f]{32}\/bootstrap\.html$/.test(url.pathname)) throw Error("ERR_ATOOLS_PAGE_IDENTITY");
  return Object.freeze({ ...value });
}

export function pluginPageResourceUrl(page: PreparedPluginPage, pluginRoot: string, file: string): string {
  const root = pluginMainResourceDir(pluginRoot, "index.html").replace(/\/+$/, "");
  const normalized = file.replaceAll("\\", "/"), directory = normalized.endsWith("/");
  const sameRoot = /^[a-z]:\//i.test(root)
    ? normalized.replace(/\/+$/, "").toLowerCase() === root.toLowerCase()
    : normalized.replace(/\/+$/, "") === root;
  if (sameRoot) return page.resourceBaseUrl;
  const relative = packageRelativeResourcePath(pluginRoot, file);
  return page.resourceBaseUrl + relative.split("/").map(encodeURIComponent).join("/") + (directory ? "/" : "");
}

/** Owns one native document from before permission preparation until full drain.
 * Complete plugin HTML remains in the trusted parent and is never sent here. */
export function createPluginPageDocument(options: {
  invoke: Invoke; pluginId: string; pluginRoot: string; parentOrigin: string; isCurrent: () => boolean;
}) {
  const instanceId = crypto.randomUUID();
  const owner = { pluginId: options.pluginId, instanceId };
  let prepared: PreparedPluginPage | undefined, opening: Promise<PreparedPluginPage> | undefined;
  let closed = false, closing: Promise<unknown> | undefined;
  const current = () => !closed && options.isCurrent();
  const cancelled = () => Error("ERR_ATOOLS_PAGE_CANCELLED");
  function release(pageDocumentId?: string) {
    return options.invoke("close_plugin_page", { ...owner, ...(pageDocumentId ? { pageDocumentId } : {}) });
  }
  function prepare() {
    if (!current()) return Promise.reject(cancelled());
    return opening ??= (async () => {
      try {
        const value = await options.invoke<PreparedPluginPage>("prepare_plugin_page", owner);
        prepared = validatePreparedPluginPage(value, options.parentOrigin);
        if (!current()) throw cancelled();
        return prepared;
      } catch (error) {
        closed = true;
        throw error;
      } finally {
        // Close can precede a queued native prepare. Drain its late result even
        // after the first owner cancellation completed.
        if (!current()) await release(prepared?.pageDocumentId).catch(() => {});
      }
    })();
  }
  function close() {
    closed = true;
    if (!opening) return Promise.resolve();
    return closing ??= release(prepared?.pageDocumentId).catch(() => { console.warn("Plugin page cleanup failed"); });
  }
  function configuration() {
    if (!current() || !prepared) throw cancelled();
    return prepared;
  }
  async function claim() {
    const page = configuration();
    await options.invoke("claim_plugin_page", { ...owner, pageDocumentId: page.pageDocumentId });
    if (!current()) throw cancelled();
  }
  const invoke: Invoke = async <T>(command: string, args?: Record<string, unknown>): Promise<T> => {
    if (!BOUND_PREPARE.has(command)) return options.invoke<T>(command, args);
    const page = configuration();
    return options.invoke<T>(command, { ...args, pageDocumentId: page.pageDocumentId });
  };
  return { instanceId, prepare, claim, close, configuration, invoke,
    resourceUrl: (file: string) => pluginPageResourceUrl(configuration(), options.pluginRoot, file) };
}
