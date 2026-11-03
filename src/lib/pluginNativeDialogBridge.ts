export type PluginDialogAccess = "open" | "save";
export type PluginDialogsConfig = { instanceId: string; sessions?: Partial<Record<PluginDialogAccess, string>>; endpoints?: Partial<Record<PluginDialogAccess, string>> };
type Selection = { canceled: boolean; paths: string[] };
type Transport = { sync: (endpoint: string, payload: string) => unknown; async: (endpoint: string, payload: string) => Promise<unknown> };

/** Self-contained factory, serialized before the unmodified preload and page. */
export function createPluginNativeDialogBridge(config: PluginDialogsConfig, request: (access: PluginDialogAccess) => void,
  blockedSmoke = false, injected?: Transport) {
  const endpoints = { ...config.endpoints }, requested = new Set<PluginDialogAccess>();
  let closed = false;
  function failure(code: string, message: string) { const error = new Error(message) as Error & { code: string }; error.name = "PluginDialogError"; error.code = code; return error; }
  function parse(raw: unknown): Selection {
    const reply = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!reply || reply.ok !== true) throw failure("ERR_ATOOLS_DIALOG_REQUEST", typeof reply?.error?.message === "string" ? reply.error.message : "文件选择未完成，请重新打开后再试");
    const result = reply.result;
    if (!result || typeof result.canceled !== "boolean" || !Array.isArray(result.paths) || result.paths.length > 128
      || result.paths.some((path: unknown) => typeof path !== "string" || !path || path.length > 16384)
      || new TextEncoder().encode(JSON.stringify(result.paths)).length > 512 * 1024 || result.canceled !== (result.paths.length === 0)) {
      throw failure("ERR_ATOOLS_DIALOG_RESPONSE", "文件选择返回了无效结果");
    }
    return result;
  }
  const transport: Transport = injected ?? {
    sync(endpoint, payload) {
      const xhr = new XMLHttpRequest(); xhr.open("POST", endpoint, false); xhr.setRequestHeader("Content-Type", "text/plain"); xhr.send(payload);
      if (xhr.status !== 200) throw failure("ERR_ATOOLS_DIALOG_TRANSPORT", "文件选择连接已关闭，请重新打开插件");
      return xhr.responseText;
    },
    async(endpoint, payload) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(); xhr.open("POST", endpoint, true); xhr.setRequestHeader("Content-Type", "text/plain");
        xhr.onload = () => xhr.status === 200 ? resolve(xhr.responseText) : reject(failure("ERR_ATOOLS_DIALOG_TRANSPORT", "文件选择连接已关闭，请重新打开插件"));
        xhr.onerror = xhr.onabort = () => reject(failure("ERR_ATOOLS_DIALOG_TRANSPORT", "文件选择连接已关闭，请重新打开插件"));
        // The Rust host owns the native deadline and closes the actual panel.
        xhr.send(payload);
      });
    },
  };
  function payload(access: PluginDialogAccess, options: unknown): [string, string] {
    if (closed) throw failure("ERR_ATOOLS_DIALOG_CLOSED", "插件已关闭，请重新打开后再试");
    if (blockedSmoke) throw failure("ERR_ATOOLS_DIALOG_SMOKE_BLOCKED", "文件选择在常规桌面测试中已停用");
    const endpoint = endpoints[access];
    if (!endpoint) {
      if (!requested.has(access)) { requested.add(access); request(access); }
      throw failure("ERR_ATOOLS_DIALOG_PERMISSION_REQUIRED", "请先允许此插件打开系统文件选择窗口，然后手动重新打开插件；原操作不会自动重放");
    }
    if (!/^http:\/\/127\.0\.0\.1:\d+\/dialog\/[a-f0-9]{64}$/.test(endpoint)) throw failure("ERR_ATOOLS_DIALOG_CONFIG", "文件选择连接无效");
    if (options == null) options = {};
    if (typeof options !== "object" || Array.isArray(options)) throw new TypeError("Dialog options must be an object");
    const encoded = JSON.stringify({ method: access === "open" ? "showOpenDialog" : "showSaveDialog", options });
    if (new TextEncoder().encode(encoded).length > 32 * 1024 + 128) throw failure("ERR_ATOOLS_DIALOG_LIMIT", "文件选择参数超出预算");
    return [endpoint, encoded];
  }
  function sync(access: PluginDialogAccess, options?: unknown) { const [endpoint, encoded] = payload(access, options); return parse(transport.sync(endpoint, encoded)); }
  function asynchronous(access: PluginDialogAccess, options?: unknown) {
    return Promise.resolve().then(() => { const [endpoint, encoded] = payload(access, options); return transport.async(endpoint, encoded); }).then(parse);
  }
  return {
    showOpenDialog(options?: unknown): string[] { return sync("open", options).paths; },
    showSaveDialog(options?: unknown): string | undefined { return sync("save", options).paths[0]; },
    electron: {
      showOpenDialogSync(options?: unknown): string[] | undefined { const result = sync("open", options); return result.canceled ? undefined : result.paths; },
      showSaveDialogSync(options?: unknown): string { return sync("save", options).paths[0] ?? ""; },
      showOpenDialog(options?: unknown) { return asynchronous("open", options).then(result => ({ canceled: result.canceled, filePaths: result.paths })); },
      showSaveDialog(options?: unknown) { return asynchronous("save", options).then(result => ({ canceled: result.canceled, filePath: result.paths[0] ?? "" })); },
    },
    close() { closed = true; delete endpoints.open; delete endpoints.save; },
  };
}
export function pluginNativeDialogBridgeScript(config: PluginDialogsConfig, blockedSmoke: boolean): string {
  const encoded = JSON.stringify({ instanceId: config.instanceId, endpoints: config.endpoints ?? {} }).replace(/</g, "\\u003c");
  return '<script data-atools-native-dialog>\n(function(){var config=' + encoded + ';var bridge=(' + createPluginNativeDialogBridge.toString() + ')(config,function(access){var message={__atools_plugin_dialog_open__:true,instanceId:config.instanceId,access:access};if(window.__ATOOLS_FRAME_TRANSPORT__)window.__ATOOLS_FRAME_TRANSPORT__.post(message);else window.parent.postMessage(message,"*");},' + JSON.stringify(blockedSmoke) + ');' +
    'window.__atoolsNativeDialog=bridge;if(window.utools){window.utools.showOpenDialog=bridge.showOpenDialog;window.utools.showSaveDialog=bridge.showSaveDialog;}if(window.ztools){window.ztools.showOpenDialog=bridge.showOpenDialog;window.ztools.showSaveDialog=bridge.showSaveDialog;}' +
    'window.addEventListener("atools-plugin-out",function(){bridge.close();});})();\n<\/script>';
}
