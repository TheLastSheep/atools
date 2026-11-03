export type PluginPathAccess = "standard" | "plugin_data";
export type PluginPathsConfig = { instanceId: string; paths?: Record<string, string>; snapshots?: Partial<Record<PluginPathAccess, string>> };

/** Serialized into the isolated plugin frame. All calls return strings or throw synchronously. */
export function createPluginPathsBridge(config: PluginPathsConfig, request: (access: PluginPathAccess) => void) {
  const names = ["home", "appData", "userData", "temp", "exe", "desktop", "documents", "downloads", "music", "pictures", "videos", "logs", "pluginData"];
  const paths: Record<string, string> = Object.create(null);
  const requested = new Set<PluginPathAccess>();
  let closed = false;
  function failure(code: string, message: string) { const error = new Error(message) as Error & { code: string }; error.name = "PluginPathsError"; error.code = code; return error; }
  const supplied = config.paths ?? {};
  if (Object.keys(supplied).length > 13 || new TextEncoder().encode(JSON.stringify(supplied)).length > 128 * 1024) throw failure("ERR_ATOOLS_PATHS_LIMIT", "Path snapshot exceeds its budget");
  for (const [name, value] of Object.entries(supplied)) {
    if (!names.includes(name) || typeof value !== "string" || new TextEncoder().encode(value).length > 16 * 1024) throw failure("ERR_ATOOLS_PATHS_CONFIG", "Invalid path metadata");
    paths[name] = value;
  }
  return {
    getPath(name: unknown): string {
      if (closed) throw failure("ERR_ATOOLS_PATHS_CLOSED", "插件已关闭，请重新打开后再试");
      if (typeof name !== "string" || !names.includes(name)) return "";
      if (Object.hasOwn(paths, name)) return paths[name];
      const access: PluginPathAccess = name === "pluginData" ? "plugin_data" : "standard";
      if (!requested.has(access)) { requested.add(access); request(access); }
      throw failure("ERR_ATOOLS_PATHS_PERMISSION_REQUIRED", "请先允许读取此插件需要的目录路径，然后重新打开插件");
    },
    close() { closed = true; for (const name of Object.keys(paths)) delete paths[name]; },
  };
}

export function pluginPathsBridgeScript(config: PluginPathsConfig): string {
  const encoded = JSON.stringify({ instanceId: config.instanceId, paths: config.paths ?? {} }).replace(/</g, "\\u003c");
  return '<script data-atools-system-paths>\n(function(){var config=' + encoded + ';var bridge=(' + createPluginPathsBridge.toString() + ')(config,function(access){var message={__atools_plugin_paths_open__:true,instanceId:config.instanceId,access:access};if(window.__ATOOLS_FRAME_TRANSPORT__)window.__ATOOLS_FRAME_TRANSPORT__.post(message);else window.parent.postMessage(message,"*");});' +
    'window.__atoolsSystemPaths=bridge;if(window.utools)window.utools.getPath=bridge.getPath;if(window.ztools)window.ztools.getPath=bridge.getPath;' +
    'window.addEventListener("atools-plugin-out",function(){bridge.close();});})();\n<\/script>';
}
