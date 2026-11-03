import type { PluginRuntimePreloadOptions } from "./pluginRuntimePreload";

type Options = {
  pluginDir: string;
  options: Record<string, unknown>;
  prepare: (options: PluginRuntimePreloadOptions) => Promise<string>;
  readTextFile: (path: string) => Promise<string>;
  isCurrent: () => boolean;
};

function invalid(): never {
  throw new Error("ERR_ATOOLS_BROWSER_WINDOW_PRELOAD_PATH: expected a local script inside the installed plugin");
}

function absolutePath(value: string): string {
  const text = value.replace(/\\/g, "/");
  const prefix = text.match(/^(?:[A-Za-z]:)?\//)?.[0];
  if (!prefix || text.startsWith("//")) invalid();
  const parts: string[] = [];
  for (const part of text.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) invalid();
      parts.pop();
    } else parts.push(part);
  }
  return prefix + parts.join("/");
}

/** Resolve against the installed plugin root, not the child HTML's directory. */
export function pluginBrowserWindowPreloadPath(pluginDir: string, options: Record<string, unknown>): string | null {
  const preferences = options.webPreferences;
  if (preferences === undefined) return null;
  if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) invalid();
  const preload = (preferences as Record<string, unknown>).preload;
  if (preload === undefined) return null;
  if (typeof preload !== "string" || !preload.trim() || preload.length > 8192 || preload.includes("\0")
    || /^[A-Za-z][A-Za-z\d+.-]*:/.test(preload) && !/^[A-Za-z]:[\\/]/.test(preload)) invalid();
  const root = absolutePath(pluginDir);
  const isAbsolute = /^(?:[A-Za-z]:[\\/]|[\\/])/.test(preload);
  const path = absolutePath(isAbsolute ? preload : `${root}/${preload}`);
  if (path === root || !path.startsWith(root.endsWith("/") ? root : `${root}/`)) invalid();
  return path;
}

/** The caller supplies the existing bounded reader and panel-owned runtime. */
export async function preparePluginBrowserWindowPreload(options: Options): Promise<string> {
  const path = pluginBrowserWindowPreloadPath(options.pluginDir, options.options);
  if (!options.isCurrent()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
  if (!path) return "";
  const script = await options.prepare({
    pluginDir: options.pluginDir, preloadPath: path, readTextFile: options.readTextFile,
    isCurrent: options.isCurrent,
  });
  if (!options.isCurrent()) throw new Error("ERR_ATOOLS_PRELOAD_CANCELLED");
  return script;
}
