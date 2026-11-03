import type { PluginPreloadOptions } from "./pluginPreload";

/** A package-relative observation, independently checked by Rust before approval. */
export function selectedNodePreloadAnchor(options: Pick<PluginPreloadOptions, "pluginDir" | "preloadPath">): string {
  const root = normalize(options.pluginDir), entry = normalize(options.preloadPath);
  if (!entry.startsWith(`${root}/`)) throw new Error("ERR_ATOOLS_PRELOAD_PATH_OUTSIDE_PLUGIN");
  return entry.slice(root.length + 1);
}

function normalize(value: string): string {
  const path = value.replace(/\\/g, "/");
  const prefix = path.match(/^(?:[a-zA-Z]:)?\//)?.[0];
  if (!prefix) throw new Error("ERR_ATOOLS_PRELOAD_PATH");
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop(); else parts.push(part);
  }
  return prefix + parts.join("/");
}
