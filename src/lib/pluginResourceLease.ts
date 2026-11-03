import { pluginMainResourceDir, pluginResourceFilePath } from "./pluginResourceHtml";

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Session = { sessionId: string; pluginRoot: string };
type Options = { invoke: Invoke; pluginId: string; pluginRoot: string; isCurrent: () => boolean;
  convertFileSrc: (path: string, protocol?: string) => string; onCloseError?: (error: unknown) => void };

export function packageRelativeResourcePath(root: string, file: string): string {
  const base = pluginMainResourceDir(root, "index.html").replace(/\/$/, "");
  const resolved = pluginResourceFilePath(base, "index.html", file);
  const windows = /^[a-z]:\//i.test(base);
  const prefix = `${base}/`, target = resolved ?? "";
  if (!(windows ? target.toLowerCase().startsWith(prefix.toLowerCase()) : target.startsWith(prefix)))
    throw Error("ERR_ATOOLS_RESOURCE_OUTSIDE_PLUGIN");
  let parts: string[];
  try { parts = target.slice(prefix.length).split("/").map(decodeURIComponent); }
  catch { throw Error("ERR_ATOOLS_RESOURCE_PATH"); }
  if (parts.some(part => !part || part === "." || part === ".." || /[\\/\u0000-\u001f\u007f]/.test(part)))
    throw Error("ERR_ATOOLS_RESOURCE_PATH");
  return parts.join("/");
}

export function pluginLeaseResourceUrl(origin: string, sessionId: string, relative: string): string {
  if (!/^(?:atools-plugin:\/\/localhost|https?:\/\/atools-plugin\.localhost)\/?$/.test(origin)
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId))
    throw Error("ERR_ATOOLS_RESOURCE_SESSION");
  // Tauri convertFileSrc encodes an entire path. Preserve real segment separators
  // so native relative imports keep the lease and package directory.
  return `${origin.replace(/\/$/, "")}/${sessionId}/${relative.split("/").map(encodeURIComponent).join("/")}`;
}

/** One lazy, revocable resource lease for one PluginPanel generation. */
export function createPluginResourceLease(options: Options) {
  const instanceId = crypto.randomUUID();
  let closed = false, opening: Promise<Session> | undefined, closing: Promise<void> | undefined;
  const args = { pluginId: options.pluginId, instanceId };
  const cancel = () => Error("ERR_ATOOLS_RESOURCE_CANCELLED");
  function release() {
    return closing ??= options.invoke<void>("close_plugin_resources", args).catch(error => {
      if (options.onCloseError) options.onCloseError(error);
      else console.warn("[Plugin resources] Release failed", error);
    });
  }
  async function openSession(): Promise<Session> {
    if (closed || !options.isCurrent()) throw cancel();
    opening ??= options.invoke<Session>("prepare_plugin_resources", args);
    const session = await opening;
    if (closed || !options.isCurrent()) { await release(); throw cancel(); }
    if (!session || typeof session.sessionId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(session.sessionId)
      || typeof session.pluginRoot !== "string" || !session.pluginRoot) {
      await release();
      throw Error("ERR_ATOOLS_RESOURCE_SESSION");
    }
    return session;
  }
  async function prepare() {
    const session = await openSession();
    return { sessionId: session.sessionId, pluginRoot: session.pluginRoot, instanceId };
  }
  async function resolveModuleSrc(file: string) {
    const relative = packageRelativeResourcePath(options.pluginRoot, file);
    const session = await openSession();
    return pluginLeaseResourceUrl(options.convertFileSrc("", "atools-plugin"), session.sessionId, relative);
  }
  function close(): Promise<void> {
    closed = true;
    return opening ? opening.then(() => release(), () => undefined) : Promise.resolve();
  }
  return { prepare, resolveModuleSrc, close };
}
