import type { createPluginDisplayBridge } from "./pluginDisplayBridge";
import { createPluginElectronWebFrame } from "./pluginElectronWebFrame";
import { createPluginNativeImageFromBytes, validatePluginClipboardImagePayload, type PluginClipboardImagePayload } from "./pluginNativeImage";
import { createPluginNativeImageFactories } from "./pluginNativeImageFactories";
import { createPluginNativeImageTransformProvider } from "./pluginNativeImageTransformProvider";
import { createPluginNativeImagePathFactory } from "./pluginNativeImagePath";
import { browserBufferFactoryScript } from "./browserBuffer";
import { createPluginNativeTheme, type PluginNativeTheme, type PluginNativeThemeSource } from "./pluginNativeTheme";
import { normalizePluginContextMenu } from "./pluginContextMenuSchema";
import { createPluginElectronDynamicFeatureIpc } from "./pluginElectronDynamicFeatureIpc";
import { decodePluginFileClipboardBuffer } from "./pluginFileClipboardBuffer";

type ListenerBroker = Record<string, unknown>;
type NativeShellMethod = "shellOpenExternal" | "shellOpenPath" | "shellShowItemInFolder" | "shellTrashItem";
type PluginElectronWebFrame = { getZoomFactor(): number; setZoomFactor(value: number): void };
type PluginElectronSafeStorage = { isEncryptionAvailable(): boolean; encryptString(text: string): unknown; decryptString(value: unknown): string };
type PluginElectronDynamicFeatureIpc = ReturnType<typeof createPluginElectronDynamicFeatureIpc>;
type PluginStartupRegistration = { get: () => Promise<unknown>; set: (value: unknown) => Promise<null> };
export type PluginElectronHost = {
  application: { name: string; version: string };
  invokeNative?: (method: NativeShellMethod, args: Record<string, unknown>) => Promise<unknown>;
  reportError?: (error: unknown, method: "shell.showItemInFolder") => unknown;
  ipcRenderer?: ListenerBroker;
  dynamicFeatureIpc?: PluginElectronDynamicFeatureIpc;
  startupRegistration?: PluginStartupRegistration;
  getPath?: (name: unknown) => string;
  dialog?: { showOpenDialogSync: (options?: unknown) => string[] | undefined; showSaveDialogSync: (options?: unknown) => string;
    showOpenDialog: (options?: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showSaveDialog: (options?: unknown) => Promise<{ canceled: boolean; filePath: string }> };
  clipboard?: {
    readText(type?: string): string;
    writeText(text: string, type?: string): void;
    hasFormat?(format: string): boolean;
    readFormat?(format: string): string;
    readBuffer?(format: string): Uint8Array;
    writeContent?(payload: Record<string, unknown>): unknown;
    write?(data: { text?: string; html?: string }, type?: string): void;
    writeHTML?(markup: string, type?: string): void;
    readImage?(type?: string): PluginClipboardImagePayload | null;
    writeImage?(image: PluginClipboardImagePayload): void;
  };
  createBuffer?: (bytes: Uint8Array) => unknown;
  isBuffer?: (value: unknown) => boolean;
  createNativeImage?: (value: unknown) => unknown;
  nativeImagePath?: (path: unknown, ...options: unknown[]) => unknown;
  webFrame?: PluginElectronWebFrame;
  webUtils?: { getPathForFile(file: unknown): string };
  screen?: ReturnType<typeof createPluginDisplayBridge>;
  safeStorage?: PluginElectronSafeStorage;
  nativeTheme?: PluginNativeTheme;
  showContextMenu?: (items: unknown) => Promise<unknown>;
  desktopCapturer?: { getSources(options?: Record<string, unknown>): Promise<unknown[]> };
};
type NativeImageFactories = ReturnType<typeof createPluginNativeImageFactories>;

/**
 * Local Electron compatibility only. Metadata is synchronous. Reveal returns void;
 * its asynchronous host failure is observable through reportError or console.error.
 * Other shell methods retain their Promise contracts and never replay a failure.
 * Keep this factory self-contained: production serializes its built source.
 */
export function createPluginElectronAdapter(host: PluginElectronHost, nativeImages?: NativeImageFactories,
  normalizeContextMenu?: typeof normalizePluginContextMenu,
  decodeFileClipboardBuffer?: typeof decodePluginFileClipboardBuffer) {
  function unavailable(name: string): Error {
    const error = new Error("ERR_ATOOLS_ELECTRON_UNSUPPORTED: " + name) as Error & { code: string };
    error.code = "ERR_ATOOLS_ELECTRON_UNSUPPORTED";
    return error;
  }
  function unsupported(name: string) { return () => { throw unavailable(name); }; }
  function text(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.length) throw new TypeError(name + " must be a non-empty string");
    return value;
  }
  function clipboardFormat(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > 256) {
      throw new TypeError("Clipboard format must be 1 to 256 printable ASCII bytes");
    }
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index);
      if (code < 0x20 || code > 0x7e) {
        throw new TypeError("Clipboard format must be 1 to 256 printable ASCII bytes");
      }
    }
    return value;
  }
  function filePath(value: unknown): string {
    const path = text(value, "Path");
    if (path.length > 8192 || path.includes("\0") || !(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path))) {
      throw new TypeError("Path must be an absolute file path without NUL, at most 8192 characters");
    }
    return path;
  }
  function native(method: NativeShellMethod, args: Record<string, unknown>) {
    const invoke = host.invokeNative;
    if (typeof invoke !== "function") return Promise.reject(unavailable("shell." + method));
    return Promise.resolve().then(() => invoke.call(host, method, args)).then((result) => {
      if (result !== null && result !== undefined) throw new Error("Invalid native shell response");
    });
  }
  function reportRevealFailure(error: unknown) {
    function fallback(reporterError?: unknown) {
      try { console.error("[ATools electron shell.showItemInFolder]", error, ...(reporterError === undefined ? [] : [reporterError])); }
      catch { /* A broken console must not create another unhandled rejection. */ }
    }
    if (typeof host.reportError !== "function") { fallback(); return; }
    try { Promise.resolve(host.reportError(error, "shell.showItemInFolder")).catch(fallback); }
    catch (reporterError) { fallback(reporterError); }
  }
  const ipcRenderer: Record<string, any> = {};
  for (const method of ["on", "addListener", "once", "off", "removeListener", "removeAllListeners"]) {
    ipcRenderer[method] = (...args: unknown[]) => {
      const handler = host.ipcRenderer?.[method];
      if (typeof handler !== "function") throw unavailable("ipcRenderer." + method);
      Reflect.apply(handler, host.ipcRenderer, args);
      return ipcRenderer;
    };
  }
  for (const method of ["send", "sendToHost", "postMessage"]) {
    ipcRenderer[method] = unsupported("ipcRenderer." + method);
  }
  ipcRenderer.sendSync = (...args: unknown[]) => {
    const dynamicFeatureIpc = host.dynamicFeatureIpc;
    const sendSync = dynamicFeatureIpc?.sendSync;
    if (typeof sendSync !== "function") throw unavailable("ipcRenderer.sendSync requires the owner-scoped dynamic feature bridge");
    return Reflect.apply(sendSync, dynamicFeatureIpc, args);
  };
  ipcRenderer.sendTo = (...args: unknown[]): void => {
    const handler = host.ipcRenderer?.sendTo;
    if (typeof handler !== "function") throw unavailable("ipcRenderer.sendTo");
    Reflect.apply(handler, host.ipcRenderer, args);
  };
  ipcRenderer.invoke = (channel: unknown, ...args: unknown[]): Promise<unknown> => Promise.resolve().then(() => {
    if (channel === "show-context-menu") {
      if (args.length !== 1) throw new TypeError("ipcRenderer.invoke show-context-menu expects exactly one item array");
      if (typeof normalizeContextMenu !== "function" || typeof host.showContextMenu !== "function") throw unavailable("ipcRenderer.invoke show-context-menu");
      const items = normalizeContextMenu(args[0]);
      return Promise.resolve().then(() => host.showContextMenu!(items)).then(result => {
        if (result !== null && result !== undefined) throw new Error("Invalid context-menu host response");
      });
    }
    if (channel === "ztools:db-get") {
      if (args.length !== 1 || args[0] !== "auto-start-plugin") {
        throw new TypeError("ipcRenderer.invoke ztools:db-get supports only the auto-start-plugin key");
      }
      if (typeof host.startupRegistration?.get !== "function") throw unavailable("ipcRenderer.invoke ztools:db-get requires the owner data session");
      return host.startupRegistration.get();
    }
    if (channel === "ztools:db-put") {
      if (args.length !== 2 || args[0] !== "auto-start-plugin") {
        throw new TypeError("ipcRenderer.invoke ztools:db-put supports only the auto-start-plugin key");
      }
      if (typeof host.startupRegistration?.set !== "function") throw unavailable("ipcRenderer.invoke ztools:db-put requires the owner data session");
      return host.startupRegistration.set(args[1]);
    }
    if (channel !== "open-external") throw unavailable("ipcRenderer.invoke channel");
    if (args.length !== 1) throw new TypeError("ipcRenderer.invoke open-external expects exactly one URL");
    const url = text(args[0], "URL");
    if (url.trim().length === 0 || url.length > 8192 || new TextEncoder().encode(url).byteLength > 8192) {
      throw new TypeError("URL must be non-empty and at most 8192 UTF-8 bytes");
    }
    return native("shellOpenExternal", { url });
  });
  const clipboard: Record<string, (...args: any[]) => unknown> = {};
  for (const method of ["read", "readText", "writeText", "readImage", "writeImage", "clear", "availableFormats",
    "has", "readHTML", "writeHTML", "readRTF", "writeRTF", "readBuffer", "writeBuffer", "readBookmark", "writeBookmark", "write"]) {
    clipboard[method] = unsupported("clipboard." + method + " requires a synchronous authorized host transport");
  }
  function clipboardSelection(type: unknown) {
    if (type !== undefined && type !== "clipboard") throw new TypeError("ERR_ATOOLS_HOST_CLIPBOARD_UNSUPPORTED: Selection clipboard is unavailable");
  }
  if (host.clipboard) {
    clipboard.readText = (type?: string) => host.clipboard!.readText(type);
    clipboard.writeText = (text: string, type?: string) => host.clipboard!.writeText(text, type);
    if (host.clipboard.hasFormat) clipboard.has = (...args: unknown[]) => {
      if (args.length < 1 || args.length > 2) throw new TypeError("clipboard.has expects a format and optional clipboard type");
      const format = clipboardFormat(args[0]);
      clipboardSelection(args[1]);
      const result = host.clipboard!.hasFormat!(format);
      if (typeof result !== "boolean") throw new Error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE: Invalid clipboard format availability response");
      return result;
    };
    if (host.clipboard.readFormat) clipboard.read = (...args: unknown[]) => {
      if (args.length !== 1) throw new TypeError("clipboard.read expects exactly one format");
      const format = clipboardFormat(args[0]);
      const result = host.clipboard!.readFormat!(format);
      if (typeof result !== "string") throw new Error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE: Invalid clipboard format data response");
      return result;
    };
    if (host.clipboard.readBuffer) clipboard.readBuffer = (...args: unknown[]) => {
      if (args.length !== 1) throw new TypeError("clipboard.readBuffer expects exactly one format");
      const format = clipboardFormat(args[0]);
      if (typeof host.createBuffer !== "function") throw unavailable("clipboard.readBuffer requires the local Buffer factory");
      const bytes = host.clipboard!.readBuffer!(format);
      if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]") {
        throw new Error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE: Invalid clipboard binary data response");
      }
      const buffer = host.createBuffer(bytes);
      const isBuffer = typeof host.isBuffer === "function"
        ? host.isBuffer(buffer) === true
        : !!buffer && typeof buffer === "object" && typeof (buffer as { toJSON?: unknown }).toJSON === "function"
          && typeof (buffer as { equals?: unknown }).equals === "function";
      if (!isBuffer || !ArrayBuffer.isView(buffer) || Object.prototype.toString.call(buffer) !== "[object Uint8Array]"
        || (buffer as Uint8Array).byteLength !== bytes.byteLength
        || (buffer as Uint8Array).some((byte, index) => byte !== bytes[index])) {
        throw new Error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE: Buffer factory must return a recognized local Buffer");
      }
      return buffer;
    };
    if (host.clipboard.writeContent && typeof decodeFileClipboardBuffer === "function") clipboard.writeBuffer = (...args: unknown[]): void => {
      if (args.length < 2 || args.length > 3) {
        throw new TypeError("clipboard.writeBuffer expects a format, Uint8Array and optional clipboard type");
      }
      const format = clipboardFormat(args[0]);
      clipboardSelection(args[2]);
      const paths = decodeFileClipboardBuffer(format, args[1]);
      const writeContent = host.clipboard!.writeContent;
      if (typeof writeContent !== "function") throw unavailable("clipboard.writeBuffer requires the typed file-write host");
      const result = writeContent.call(host.clipboard, { kind: "files", paths });
      if (result !== undefined) {
        if (((typeof result === "object" && result !== null) || typeof result === "function")
          && typeof (result as { then?: unknown }).then === "function") {
          Promise.resolve(result).catch(() => undefined);
        }
        throw new Error("ERR_ATOOLS_HOST_CLIPBOARD_RESPONSE: Invalid synchronous clipboard file write response");
      }
    };
    if (host.clipboard.write) clipboard.write = (data: { text?: string; html?: string }, type?: string): void => {
      clipboardSelection(type);
      host.clipboard!.write!(data, type);
    };
    if (host.clipboard.writeHTML) clipboard.writeHTML = (markup: string, type?: string): void => {
      clipboardSelection(type);
      host.clipboard!.writeHTML!(markup, type);
    };
    if (host.clipboard.readImage) clipboard.readImage = (type?: string) => {
      if (type !== undefined && type !== "clipboard") throw new TypeError("ERR_ATOOLS_HOST_CLIPBOARD_UNSUPPORTED: Selection clipboard is unavailable");
      if (nativeImages) return nativeImages.fromPayload(host.clipboard!.readImage!(type));
      if (!host.createNativeImage) throw unavailable("clipboard.readImage requires the NativeImage host");
      return host.createNativeImage(host.clipboard!.readImage!(type));
    };
    if (host.clipboard.writeImage && nativeImages) clipboard.writeImage = (image: unknown, type?: string) => {
      if (type !== undefined && type !== "clipboard") throw new TypeError("ERR_ATOOLS_HOST_CLIPBOARD_UNSUPPORTED: Selection clipboard is unavailable");
      const payload = nativeImages.payloadForWrite(image);
      host.clipboard!.writeImage!(payload);
    };
  }
  const nativeImage: Record<string, (...args: unknown[]) => unknown> = {};
  for (const method of ["createEmpty", "createFromPath", "createFromDataURL", "createFromBuffer", "createFromBitmap", "createFromNamedImage"]) {
    nativeImage[method] = unsupported("nativeImage." + method);
  }
  if (nativeImages && host.nativeImagePath) {
    nativeImage.createFromPath = (path: unknown, ...options: unknown[]) => host.nativeImagePath!(path, ...options);
  }
  if (nativeImages) {
    nativeImage.createEmpty = (...args: unknown[]) => nativeImages.createEmpty(...args);
    nativeImage.createFromBuffer = (value: unknown, ...args: unknown[]) => nativeImages.createFromBuffer(value, ...args);
    nativeImage.createFromDataURL = (value: unknown, ...args: unknown[]) => nativeImages.createFromDataURL(value, ...args);
  }
  nativeImage.createThumbnailFromPath = () => Promise.reject(unavailable("nativeImage.createThumbnailFromPath"));
  const dialog = {
    showOpenDialogSync(options?: unknown, parentOptions?: unknown) { if (!host.dialog || parentOptions !== undefined) throw unavailable("dialog.showOpenDialogSync requires an authorized host dialog without a BaseWindow argument"); return host.dialog.showOpenDialogSync(options); },
    showSaveDialogSync(options?: unknown, parentOptions?: unknown) { if (!host.dialog || parentOptions !== undefined) throw unavailable("dialog.showSaveDialogSync requires an authorized host dialog without a BaseWindow argument"); return host.dialog.showSaveDialogSync(options); },
    showOpenDialog(options?: unknown, parentOptions?: unknown) { if (!host.dialog || parentOptions !== undefined) return Promise.reject(unavailable("dialog.showOpenDialog requires an authorized host dialog without a BaseWindow argument")); return host.dialog.showOpenDialog(options); },
    showSaveDialog(options?: unknown, parentOptions?: unknown) { if (!host.dialog || parentOptions !== undefined) return Promise.reject(unavailable("dialog.showSaveDialog requires an authorized host dialog without a BaseWindow argument")); return host.dialog.showSaveDialog(options); },
  };
  const webFrame: PluginElectronWebFrame = host.webFrame ?? {
    getZoomFactor: unsupported("webFrame.getZoomFactor requires the current document host"),
    setZoomFactor: unsupported("webFrame.setZoomFactor requires the current document host"),
  };
  const safeStorage: PluginElectronSafeStorage = host.safeStorage ?? {
    isEncryptionAvailable: unsupported("safeStorage requires a preflighted authorized session"),
    encryptString: unsupported("safeStorage requires a preflighted authorized session"),
    decryptString: unsupported("safeStorage requires a preflighted authorized session"),
  };
  const nativeTheme: PluginNativeTheme = host.nativeTheme ?? (() => {
    const fail = unsupported("nativeTheme requires the current plugin document");
    return {
      get shouldUseDarkColors(): boolean { return fail() as never; },
      get themeSource(): PluginNativeThemeSource { return fail() as never; },
      on: fail, addListener: fail, once: fail, off: fail, removeListener: fail, removeAllListeners: fail,
    } as unknown as PluginNativeTheme;
  })();
  return {
    dialog,
    app: {
      getName: () => text(host.application.name, "Host application name"),
      getVersion: () => text(host.application.version, "Host application version"),
      getPath: host.getPath ?? unsupported("app.getPath requires a synchronous host transport"),
    },
    shell: {
      openExternal(url: string, options?: Record<string, unknown>): Promise<void> {
        text(url, "URL");
        if (options != null && (typeof options !== "object" || Object.keys(options).length)) {
          return Promise.reject(unavailable("shell.openExternal options"));
        }
        return native("shellOpenExternal", { url });
      },
      openPath(path: string): Promise<string> {
        text(path, "Path");
        if (!host.invokeNative) return Promise.reject(unavailable("shell.openPath"));
        // Electron resolves an error message on an OS/permission failure.
        return native("shellOpenPath", { path }).then(() => "", (error) => String(error?.message || error));
      },
      showItemInFolder(path: string, options?: unknown): void {
        const value = filePath(path);
        if (options !== undefined) throw unavailable("shell.showItemInFolder options");
        if (typeof host.invokeNative !== "function") throw unavailable("shell.showItemInFolder requires an authorized host transport");
        // Electron exposes no completion value. Observe rejection without claiming
        // the OS completed the operation or retaining it for an automatic retry.
        void native("shellShowItemInFolder", { path: value }).catch(reportRevealFailure);
      },
      async trashItem(path: string, options?: unknown): Promise<void> {
        const value = filePath(path);
        if (options !== undefined) throw unavailable("shell.trashItem options");
        if (typeof host.invokeNative !== "function") throw unavailable("shell.trashItem requires an authorized host transport");
        await native("shellTrashItem", { path: value });
      },
      beep: unsupported("shell.beep requires a synchronous host transport"),
    },
    ipcRenderer, clipboard, nativeImage, webFrame, safeStorage, nativeTheme,
    desktopCapturer: {
      getSources(options?: Record<string, unknown>): Promise<unknown[]> {
        if (typeof host.desktopCapturer?.getSources === "function") {
          return Promise.resolve().then(() => host.desktopCapturer!.getSources(options)).then(
            (list) => (Array.isArray(list) ? list : []),
            () => [],
          );
        }
        return Promise.resolve([]);
      },
    },
    webUtils: { getPathForFile: host.webUtils?.getPathForFile ?? unsupported("webUtils.getPathForFile requires a native-approved dropped File") },
    screen: host.screen ?? { getPrimaryDisplay: unsupported("screen requires an authorized display transport"), getAllDisplays: unsupported("screen requires an authorized display transport"), getCursorScreenPoint: unsupported("screen requires an authorized display transport"), getDisplayNearestPoint: unsupported("screen requires an authorized display transport"), getDisplayMatching: unsupported("screen requires an authorized display transport") },
  };
}

/** Install after the existing host bridge and before any original preload. */
export function pluginElectronAdapterScript(themeSource: PluginNativeThemeSource = "system"): string {
  return [
    '<script data-atools-electron-adapter>',
    '(function(){',
    'var localRequire=window.require;',
    "var broker=localRequire('electron').ipcRenderer;",
    'var webFrame=window.document?(' + createPluginElectronWebFrame.toString() + ')(window.document):null;',
    'var browserBuffer=(' + browserBufferFactoryScript() + ')();',
    'var nativeTheme=(' + createPluginNativeTheme.toString() + ')(window,' + JSON.stringify(themeSource) + ');',
    'var normalizePluginContextMenu=(' + normalizePluginContextMenu.toString() + ');',
    'var decodePluginFileClipboardBuffer=(' + decodePluginFileClipboardBuffer.toString() + ');',
    'var dynamicFeatureIpc=(' + createPluginElectronDynamicFeatureIpc.toString() + ')(window.__atoolsPluginData&&window.utools?window.utools:null);',
    // Internal image bytes must use the active Node codec's recognized local Buffer identity.
    'var nativeImageBuffer=function(){var session=window.__atoolsNodeModuleRequire;if(!session||typeof session.createLocalBuffer!=="function")return window.Buffer||browserBuffer;return {from:function(value,encoding){return session.createLocalBuffer(value,encoding);},isBuffer:function(value){return typeof session.isLocalBuffer==="function"&&session.isLocalBuffer(value);}};};',
    'var nativeImageTransform=(' + createPluginNativeImageTransformProvider.toString() + ')(function(){return window.__atoolsNodeModuleRequire;},nativeImageBuffer);',
    'var nativeImageFactories=(' + createPluginNativeImageFactories.toString() + ')((' + validatePluginClipboardImagePayload.toString() + '),(' + createPluginNativeImageFromBytes.toString() + '),function(){return window.Buffer;},function(){return browserBuffer;},function(image,snapshot){return nativeImageTransform.decorateLocal(image,snapshot);},function(bytes){return nativeImageTransform.openBuffer(bytes);},function(dataUrl){return nativeImageTransform.fromDataUrl(dataUrl);},function(image){return nativeImageTransform.payloadForWrite(image);});',
    'var nativeImagePath=(' + createPluginNativeImagePathFactory.toString() + ')(function(path){var session=window.__atoolsNodeModuleRequire;if(!session||typeof session.readPngPath!=="function"){var error=new Error("Active Node file-read session required");error.code="ERR_ATOOLS_IMAGE_PATH_UNAVAILABLE";throw error;}return session.readPngPath(path);},browserBuffer,function(bytes){return nativeImageFactories.createFromBrowserBuffer(bytes);},{supports:function(){var session=window.__atoolsNodeModuleRequire;return !!session&&typeof session.nativeImageRequestSync==="function";},openPath:function(path){return nativeImageTransform.openPath(path);}});',
    'var electron=(' + createPluginElectronAdapter.toString() + ')({',
    'application:{name:window.utools.getAppName(),version:window.utools.getAppVersion()},',
    'ipcRenderer:broker,',
    'showContextMenu:function(items){if(!window.utools||typeof window.utools.__atoolsShowContextMenu!=="function")return Promise.reject(new Error("ERR_ATOOLS_CONTEXT_MENU: host route unavailable"));return window.utools.__atoolsShowContextMenu(items);},',
    'createNativeImage:function(value){return nativeImageFactories.fromPayload(value);},',
    'nativeImagePath:nativeImagePath,',
    'webFrame:webFrame,',
    'screen:window.__atoolsNativeDisplay,',
    'webUtils:window.__ATOOLS_FILE_DROP_IDENTITY__?{getPathForFile:window.__ATOOLS_FILE_DROP_IDENTITY__.getPathForFile}:undefined,',
    'clipboard:window.__atoolsHostClipboard,',
    'createBuffer:function(bytes){return nativeImageBuffer().from(bytes);},',
    'isBuffer:function(value){var codec=nativeImageBuffer();return typeof codec.isBuffer==="function"&&codec.isBuffer(value);},',
    'safeStorage:window.__atoolsSafeStorage,',
    'nativeTheme:nativeTheme,',
    'dynamicFeatureIpc:dynamicFeatureIpc,',
    'startupRegistration:window.__atoolsPluginData&&window.__atoolsPluginData.startupRegistration,',
    'dialog:window.__atoolsNativeDialog&&window.__atoolsNativeDialog.electron,',
    'getPath:window.__atoolsSystemPaths&&window.__atoolsSystemPaths.getPath,',
    'desktopCapturer:{getSources:function(options){return window.utools&&typeof window.utools.desktopCaptureSources==="function"?Promise.resolve().then(function(){return window.utools.desktopCaptureSources(options||{});}).then(function(list){return Array.isArray(list)?list:[];},function(){return [];}):Promise.resolve([]);}},',
    'reportError:function(error,method){window.console.error("[ATools electron "+method+"]",error);},',
    'invokeNative:function(method,args){',
    'switch(method){',
    'case "shellOpenExternal":if(typeof window.utools.shellOpenExternal==="function")return window.utools.shellOpenExternal(args.url);break;',
    'case "shellOpenPath":if(typeof window.utools.shellOpenPath==="function")return window.utools.shellOpenPath(args.path);break;',
    'case "shellShowItemInFolder":if(typeof window.utools.shellShowItemInFolder==="function")return window.utools.shellShowItemInFolder(args.path);break;',
    'case "shellTrashItem":if(typeof window.utools.shellTrashItem==="function")return window.utools.shellTrashItem(args.path);break;',
    'default:return Promise.reject(new Error("ERR_ATOOLS_ELECTRON_UNSUPPORTED: native shell method"));',
    '}',
    'return Promise.reject(new Error("ERR_ATOOLS_ELECTRON_UNSUPPORTED: "+method));',
    '}',
    '},nativeImageFactories,normalizePluginContextMenu,decodePluginFileClipboardBuffer);',
    'window.require=function(specifier){return specifier==="electron"?electron:localRequire(specifier);};',
    '})();',
    '<\/script>',
  ].join("\n");
}
