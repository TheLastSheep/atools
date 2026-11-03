import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginHostedDocumentLease } from "./pluginHostedIpcRouter";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import { bindNativeBridgeArgsToSource, isPluginBridgeRequestId, nativePluginPermissionForMethod, postPluginFrameMessageIfCurrent, runPluginFrameOperation } from "./pluginInvokePolicy";
import { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
import { isPluginBrowserWindowTargetOwned } from "./pluginBrowserWindowReady";
import { validateShellFilePath, shellTrashAppleScript } from "./pluginSystemShellBridge";
import { desktopCaptureSourcesForDisplay } from "./pluginScreenBridge";
import { normalizePluginContextMenu } from "./pluginContextMenuSchema";

type HostedIpcRouter = ReturnType<typeof createPluginHostedIpcRouter>;
export type NativeBridgeCall = { __atools_native_call__: true; reqId: number; method: string; hostedDocumentNonce?: unknown; args?: Record<string, unknown> };

type NativeBridgeRouterDependencies = {
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  sources: PluginFrameSourceRegistry;
  hostedIpc: HostedIpcRouter;
  getBrowserWindows: () => PluginBrowserWindowState[];
  creatorFor: (id: string) => PluginBrowserWindowCreator | undefined;
  ensurePermission: (permission: string | null | undefined, source: Window | null) => Promise<void>;
  onclose: () => void;
  onredirect?: (label: unknown, payload: unknown) => boolean | Promise<boolean>;
  onsettingsredirect?: (menu: "shortcuts" | "ai", detail?: Record<string, unknown>) => boolean | Promise<boolean>;
  writePluginImage: (image: unknown) => Promise<void>;
  pathFromBridgeValue: (value: unknown) => string;
  pathsFromBridgeValue: (value: unknown) => string[];
  runAppleScript: (script: string, label: string) => Promise<string>;
  appleScriptString: (value: string) => string;
  normalizeCopiedFileEntries: (entries: unknown) => unknown[];
  runCommand: (program: string, args: string[], label: string) => Promise<string>;
  writeText: (value: string) => Promise<void>;
  hidePanelForPaste: (onclose: () => void) => Promise<void>;
  pluginFileClipboardAppleScript: (paths: string[]) => string;
  pickScreenColorWithEyeDropper: () => Promise<{ hex: string; rgb: string }>;
  dispatchPluginBrowserWindowParentMessage: (args: Record<string, unknown>) => unknown;
  handlePluginBrowserWindowAction: (args: Record<string, unknown>, creator?: PluginBrowserWindowCreator, lease?: PluginHostedDocumentLease) => unknown;
  createPluginBrowserWindow: (args: Record<string, unknown>, creator: PluginBrowserWindowCreator, lease?: PluginHostedDocumentLease) => Promise<unknown>;
  shouldUseNativeBrowserWindow?: (method: string, args: Record<string, unknown>, identity: PluginFrameIdentity) => boolean;
  shellOpen: (path: string) => Promise<void>;
  showContextMenu?: (items: unknown, source: unknown, identity: PluginFrameIdentity, onselect: (id: string) => void) => Promise<void>;
};

export function createPluginNativeBridgeRouter(dependencies: NativeBridgeRouterDependencies) {
  const { invoke, sources, hostedIpc, getBrowserWindows, creatorFor, ensurePermission, shouldUseNativeBrowserWindow, onclose,
    onredirect, onsettingsredirect, writePluginImage, pathFromBridgeValue, pathsFromBridgeValue, runAppleScript,
    appleScriptString, normalizeCopiedFileEntries, runCommand, writeText, hidePanelForPaste,
    pluginFileClipboardAppleScript, pickScreenColorWithEyeDropper, dispatchPluginBrowserWindowParentMessage,
    handlePluginBrowserWindowAction, createPluginBrowserWindow, shellOpen, showContextMenu } = dependencies;

async function handleNativeBridgeMethod(
  method: string,
  args: Record<string, unknown> = {},
  sourceContext?: PluginBrowserWindowCreator,
  onContextMenuSelect?: (id: string) => void,
  documentLease?: PluginHostedDocumentLease,
) {
  switch (method) {
    case "showOpenDialog":
    case "showSaveDialog":
      throw new Error("Native file dialogs require the synchronous authorized frame transport; reopen this plugin");
    case "copyImage": {
      await writePluginImage(args.image);
      return null;
    }
    case "copyFile": {
      const path = pathFromBridgeValue(args.file);
      await runAppleScript(
        `set the clipboard to (POSIX file ${appleScriptString(path)})`,
        "copyFile"
      );
      return null;
    }
    case "getCopyedFiles": {
      const output = await runAppleScript(`
set clipboardItems to the clipboard as list
set output to {}
repeat with itemRef in clipboardItems
try
  set end of output to POSIX path of itemRef
end try
end repeat
set AppleScript's text item delimiters to linefeed
return output as text
`, "getCopyedFiles");
      return normalizeCopiedFileEntries(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
    }
    case "readClipboardText":
      return invoke<string | null>("capture_current_clipboard_text");
    case "listClipboardHistory":
      return invoke("list_clipboard_history", {
        query: typeof args.query === "string" ? args.query : "",
        limit: typeof args.limit === "number" ? args.limit : 50,
      });
    case "getNativeIpSnapshot":
      return invoke("native_ip_snapshot");
    case "performNativeHttpRequest":
      return invoke("perform_native_http_request", {
        request: args.request && typeof args.request === "object" ? args.request : {},
      });
    case "translateNativeText":
      return invoke("translate_native_text", {
        request: args.request && typeof args.request === "object" ? args.request : {},
      });
    case "providersGetProviders":
      return invoke("list_plugin_providers", {
        providerType: typeof args.providerType === "string" ? args.providerType : null,
      });
    case "providersGetDefault":
      return invoke("get_default_plugin_provider", {
        providerType: typeof args.providerType === "string" ? args.providerType : "",
      });
    case "providersSetDefault":
      return invoke("set_default_plugin_provider", {
        providerType: typeof args.providerType === "string" ? args.providerType : "",
        providerId: typeof args.providerId === "string" ? args.providerId : "",
      });
    case "providersInvoke":
      return invoke("invoke_plugin_provider", {
        providerType: typeof args.providerType === "string" ? args.providerType : "",
        input: args.input && typeof args.input === "object" ? args.input : {},
        providerId: typeof args.providerId === "string" ? args.providerId : null,
      });
    case "readNativeHosts":
      return invoke("read_native_hosts");
    case "writeNativeHosts":
      return invoke("write_native_hosts", {
        content: typeof args.content === "string" ? args.content : "",
        confirmed: args.confirmed === true,
      });
    case "listNativeTodos":
      return invoke("list_native_todos");
    case "saveNativeTodo":
      return invoke("save_native_todo", {
        id: typeof args.id === "string" ? args.id : null,
        title: typeof args.title === "string" ? args.title : "",
        completed: typeof args.completed === "boolean" ? args.completed : null,
      });
    case "deleteNativeTodo":
      return invoke("delete_native_todo", {
        id: typeof args.id === "string" ? args.id : "",
        confirmed: args.confirmed === true,
      });
    case "calculateNativeSheet":
      return invoke("calculate_native_sheet", {
        input: typeof args.input === "string" ? args.input : "",
      });
    case "listNativeCalculationHistory":
      return invoke("list_native_calculation_history");
    case "clearNativeCalculationHistory":
      return invoke("clear_native_calculation_history", {
        confirmed: args.confirmed === true,
      });
    case "nativeCodecTransform":
      return invoke("native_codec_transform", {
        kind: typeof args.kind === "string" ? args.kind : "",
        input: typeof args.input === "string" ? args.input : "",
      });
    case "nativeTimeSnapshot":
      return invoke("native_time_snapshot");
    case "convertNativeTime":
      return invoke("convert_native_time", {
        mode: typeof args.mode === "string" ? args.mode : "",
        value: typeof args.value === "string" ? args.value : "",
        timezone: typeof args.timezone === "string" ? args.timezone : null,
      });
    case "generateNativeQr":
      return invoke("generate_native_qr", {
        text: typeof args.text === "string" ? args.text : "",
        size: typeof args.size === "number" ? args.size : 256,
        errorCorrection: typeof args.errorCorrection === "string" ? args.errorCorrection : "M",
      });
    case "nativeJsonTransform":
      return invoke("native_json_transform", {
        input: typeof args.input === "string" ? args.input : "",
      });
    case "convertNativeColor":
      return invoke("convert_native_color", {
        input: typeof args.input === "string" ? args.input : "",
      });
    case "listNativeProcesses":
      return invoke("list_native_processes", {
        query: typeof args.query === "string" ? args.query : "",
        limit: typeof args.limit === "number" ? args.limit : 300,
      });
    case "terminateNativeProcess":
      return invoke("terminate_native_process", {
        pid: typeof args.pid === "number" ? args.pid : Number(args.pid),
        confirmed: args.confirmed === true,
      });
    case "shellShowItemInFolder": {
      const path = validateShellFilePath(pathFromBridgeValue(args.path), "shellShowItemInFolder");
      await runCommand("open", ["-R", path], "shellShowItemInFolder");
      return null;
    }
    case "shellTrashItem": {
      const path = validateShellFilePath(pathFromBridgeValue(args.path), "shellTrashItem");
      await runAppleScript(shellTrashAppleScript(path), "shellTrashItem");
      return null;
    }
    case "shellBeep": {
      await runAppleScript("beep", "shellBeep");
      return true;
    }
    case "hideMainWindowPasteText": {
      await writeText(typeof args.text === "string" ? args.text : String(args.text ?? ""));
      await hidePanelForPaste(onclose);
      await runAppleScript(
        'tell application "System Events" to keystroke "v" using command down',
        "hideMainWindowPasteText"
      );
      return null;
    }
    case "hideMainWindowPasteImage": {
      await writePluginImage(args.image);
      await hidePanelForPaste(onclose);
      await runAppleScript(
        'tell application "System Events" to keystroke "v" using command down',
        "hideMainWindowPasteImage"
      );
      return null;
    }
    case "hideMainWindowPasteFile": {
      await runAppleScript(
        pluginFileClipboardAppleScript(pathsFromBridgeValue(args.file)),
        "hideMainWindowPasteFile"
      );
      await hidePanelForPaste(onclose);
      await runAppleScript(
        'tell application "System Events" to keystroke "v" using command down',
        "hideMainWindowPasteFile"
      );
      return null;
    }
    case "hideMainWindowTypeString": {
      await hidePanelForPaste(onclose);
      await runAppleScript(
        `tell application "System Events" to keystroke ${appleScriptString(String(args.text ?? ""))}`,
        "hideMainWindowTypeString"
      );
      return null;
    }
    case "screenCapture": {
      return invoke<string>("screen_capture");
    }
    case "screenColorPick": {
      return pickScreenColorWithEyeDropper();
    }
    case "desktopCaptureSources": {
      return desktopCaptureSourcesForDisplay(args.options, window.screen, window.devicePixelRatio);
    }
    case "readCurrentBrowserUrl": {
      const output = await runAppleScript(`
set frontApp to ""
tell application "System Events" to set frontApp to name of first application process whose frontmost is true
if frontApp is "Google Chrome" or frontApp is "Chromium" or frontApp is "Microsoft Edge" then
tell application frontApp to return URL of active tab of front window
else if frontApp is "Safari" then
tell application "Safari" to return URL of front document
else
return ""
end if
`, "readCurrentBrowserUrl");
      return output.trim() || null;
    }
    case "readCurrentFolderPath": {
      const output = await runAppleScript(`
tell application "Finder"
if (count of Finder windows) is 0 then
  return POSIX path of (path to desktop)
end if
return POSIX path of (target of front Finder window as alias)
end tell
`, "readCurrentFolderPath");
      return output.trim() || null;
    }
    case "simulateKeyboardTap": {
      const key = typeof args.key === "string" ? args.key.trim() : "";
      throw new Error(
        key
          ? `simulateKeyboardTap unsupported: keyboard automation is not available for ${key}`
          : "simulateKeyboardTap unsupported: keyboard automation is not available"
      );
    }
    case "startDrag": {
      throw new Error("startDrag unsupported: native file dragging is not available in the current WebView host");
    }
    case "redirect": {
      if (!onredirect) {
        throw new Error("redirect unsupported: plugin feature navigation is not available in the current host");
      }
      return await onredirect(args.label, Object.prototype.hasOwnProperty.call(args, "payload") ? args.payload : null);
    }
    case "redirectHotKeySetting": {
      if (!onsettingsredirect) {
        throw new Error("settings redirect unsupported: settings navigation is not available in the current host");
      }
      return await onsettingsredirect("shortcuts", {
        cmdLabel: typeof args.cmdLabel === "string" ? args.cmdLabel : String(args.cmdLabel ?? ""),
        autocopy: args.autocopy === true,
      });
    }
    case "redirectAiModelsSetting": {
      if (!onsettingsredirect) {
        throw new Error("settings redirect unsupported: settings navigation is not available in the current host");
      }
      return await onsettingsredirect("ai", {});
    }
    case "createBrowserWindow": {
      if (!sourceContext) throw new Error("createBrowserWindow requires a registered plugin frame source");
      return createPluginBrowserWindow(args, sourceContext, documentLease);
    }
    case "sendToParent": {
      return dispatchPluginBrowserWindowParentMessage(args);
    }
    case "browserWindowAction": {
      return handlePluginBrowserWindowAction(args, sourceContext, documentLease);
    }
    case "shellOpenPath":
    case "shellOpenExternal": {
      const path = pathFromBridgeValue(args.path || args.url);
      await shellOpen(path);
      return null;
    }
    case "showContextMenu": {
      if (!sourceContext) throw new Error("show-context-menu requires a registered plugin frame");
      if (typeof showContextMenu !== "function") throw new Error("ERR_ATOOLS_CONTEXT_MENU: host menu surface is unavailable");
      if (Object.keys(args).some(key => key !== "items") || !Object.prototype.hasOwnProperty.call(args, "items")) {
        throw new TypeError("ERR_ATOOLS_CONTEXT_MENU: request must contain only items");
      }
      const items = normalizePluginContextMenu(args.items);
      if (!onContextMenuSelect) throw new Error("ERR_ATOOLS_CONTEXT_MENU: selection delivery is unavailable");
      await showContextMenu(items, sourceContext.source, sourceContext.identity, onContextMenuSelect);
      return null;
    }
    default:
      throw new Error(`Unsupported native bridge method: ${method}`);
  }
}

async function handleNativeBridgeCall(
  e: MessageEvent,
  data: NativeBridgeCall,
  sourceIdentity: PluginFrameIdentity,
) {
  if (!isPluginBridgeRequestId(data.reqId)) return;
  let hostedMessage: ReturnType<typeof hostedIpc.captureNative>;
  let documentLease: ReturnType<typeof hostedIpc.captureDocumentLease> | undefined;
  let contextMenuResponsePosted = false, queuedContextMenuCommand: string | null = null, contextMenuSelectionUsed = false;
  const deliverContextMenuCommand = (id: string) => {
    if (!sources.isCurrent(e.source, sourceIdentity)) return;
    try {
      const event = hostedIpc.captureContextMenuCommand({ source: e.source, identity: sourceIdentity }, id);
      void event.deliver().catch(() => undefined);
    } catch { /* A selection for a closed or stale document is intentionally dropped. */ }
  };
  const onContextMenuSelect = (id: string) => {
    if (contextMenuSelectionUsed || data.method !== "showContextMenu") return;
    contextMenuSelectionUsed = true;
    if (contextMenuResponsePosted) deliverContextMenuCommand(id);
    else queuedContextMenuCommand = id;
  };
  try {
    const currentLease = documentLease = hostedIpc.captureDocumentLease({ source: e.source, identity: sourceIdentity }, data.hostedDocumentNonce);
    hostedMessage = hostedIpc.captureNative(data.method, data.args || {}, { source: e.source, identity: sourceIdentity }, data.hostedDocumentNonce);
    if (data.method === "browserWindowAction" && String(data.args?.action ?? "").trim() === "__renderReady")
      throw new Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_PRIVATE_ACTION");
    const permission = nativePluginPermissionForMethod(data.method);
    const nativeWindowCall = (data.method === "createBrowserWindow" || data.method === "browserWindowAction")
      && (shouldUseNativeBrowserWindow?.(data.method, data.args || {}, sourceIdentity) ?? false);
    if (!nativeWindowCall && (permission !== null || data.method !== "showContextMenu")) await ensurePermission(permission, e.source as Window | null);
    const result = await runPluginFrameOperation({
      source: e.source,
      identity: sourceIdentity,
      sources: sources,
      operation: () => {
        currentLease.assertCurrent();
        const args = bindNativeBridgeArgsToSource(data.method, data.args || {}, sourceIdentity, {
          authorizeBrowserWindowTarget: (targetId, identity) => isPluginBrowserWindowTargetOwned({
            targetId,
            source: e.source,
            identity,
            sources: sources,
            windows: getBrowserWindows(),
            creatorFor: (id) => creatorFor(id),
          }),
        });
        return hostedMessage ? hostedMessage.deliver() : handleNativeBridgeMethod(
          data.method, args, { source: e.source, identity: sourceIdentity }, onContextMenuSelect, currentLease,
        );
      },
    });
    currentLease.assertCurrent();
    const responsePosted = postPluginFrameMessageIfCurrent({
      source: e.source,
      identity: sourceIdentity,
      sources: sources,
      message: {
        __atools_native_response__: true,
        reqId: data.reqId,
        result,
      },
    });
    if (data.method === "showContextMenu") {
      contextMenuResponsePosted = responsePosted;
      if (responsePosted && queuedContextMenuCommand !== null) deliverContextMenuCommand(queuedContextMenuCommand);
    }
  } catch (err) {
    try { if (!documentLease) return; documentLease.assertCurrent(); } catch { return; }
    postPluginFrameMessageIfCurrent({
      source: e.source,
      identity: sourceIdentity,
      sources: sources,
      message: {
        __atools_native_response__: true,
        reqId: data.reqId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  } finally { hostedMessage?.dispose(); }
}


  return { handleNativeBridgeCall };
}
