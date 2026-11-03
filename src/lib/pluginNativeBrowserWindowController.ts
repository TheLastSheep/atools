import { listen } from "@tauri-apps/api/event";
import { convertFileSrc, isTauri } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginHostedDocumentLease } from "./pluginHostedIpcRouter";
import type { PluginNativeBrowserWindowEvent } from "./pluginNativeBrowserWindowTypes";
import type { PluginNativeBrowserWindowBinding } from "./pluginNativeBrowserWindowBindings";
import { createPluginNativeBrowserWindowBindings } from "./pluginNativeBrowserWindowBindings";
import { createPluginNativeBrowserWindowShellHost } from "./pluginNativeBrowserWindowShellHost";
import { createPluginNativeBrowserWindowState } from "./pluginNativeBrowserWindowStateFactory";
import { nativePluginBrowserWindowOptions } from "./pluginNativeBrowserWindowOptions";
import { readPluginNativeBrowserWindowSnapshot, applyPluginNativeBrowserWindowSnapshot } from "./pluginNativeBrowserWindowSnapshot";
import { pluginNativeBrowserWindowTool, validatePluginNativeBrowserWindowIntent, waitForPluginNativeBrowserWindowRun } from "./pluginNativeBrowserWindowTaskRun";
import { appendPluginNativeWindowDocumentId, preparePluginNativeWindowDocument } from "./pluginNativeBrowserWindowDocument";
import { dispatchPluginNativeBrowserWindowMessage, registerPluginNativeBrowserWindowRendererReady } from "./pluginNativeBrowserWindowCallbacks";
import { browserWindowTitle } from "./pluginBrowserWindowPresentation";
import {
  NATIVE_BROWSER_WINDOW_NAVIGATION_ACTIONS as NAVIGATION_ACTIONS,
  runNativeBrowserWindowNavigationAction,
} from "./pluginNativeBrowserWindowNavigationActions";
import {
  NATIVE_BROWSER_WINDOW_LABEL as LABEL,
  NATIVE_BROWSER_WINDOW_TOKEN as TOKEN,
  nativeBrowserWindowOwnerKey as ownerKey,
  type PluginNativeBrowserWindowRecord as RecordEntry,
  type PluginNativeBrowserWindowActionResult as ActionResult,
  type PluginNativeBrowserWindowOpenResult as OpenResult,
  type PluginNativeBrowserWindowControllerPorts as Ports,
  type PluginNativeBrowserWindowReservation as NativeReservation,
} from "./pluginNativeBrowserWindowControllerTypes";
const failure = (code: string) => Error(`ERR_ATOOLS_NATIVE_BROWSER_WINDOW_${code}`);
const objectRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Owns the production native-window route while reusing panel source, RPC and readiness registries. */
export function createPluginNativeBrowserWindowController(ports: Ports) {
  const shellHost = createPluginNativeBrowserWindowShellHost();
  const windows = new Map<string, RecordEntry>();
  const reservations = new Set<NativeReservation>();
  let eventUnlisten: (() => void) | undefined;
  let eventListener: Promise<void> | undefined;
  let eventEpoch = 0;
  let invalidating: Promise<void> | undefined;
  let disposed = false;
  const bindings = createPluginNativeBrowserWindowBindings({
    pluginId: ports.pluginId, resources: ports.resources, invoke: ports.invoke, sources: ports.sources,
    onRevoked: entry => { for (const record of [...windows.values()]) if (record.sourceBinding === entry) disposeRecord(record); },
  });

  function nativeEnabled() {
    const path = ports.pluginPath().trim();
    return (ports.isTauri?.() ?? isTauri()) && path !== "" && path !== ports.previewPluginPath;
  }
  function ensureEventListener() {
    if (disposed) return Promise.reject(failure("CONTROLLER_DESTROYED"));
    if (eventListener) return eventListener;
    const epoch = eventEpoch, subscribe = ports.listen ?? listen;
    let pending!: Promise<void>;
    pending = subscribe<PluginNativeBrowserWindowEvent>("plugin-native-browser-window-event", event => {
      handleNativeEvent(event.payload);
    }).then(unlisten => {
      if (disposed || epoch !== eventEpoch) unlisten();
      else eventUnlisten = unlisten;
    }).catch(error => {
      if (eventListener === pending) eventListener = undefined;
      throw error;
    });
    eventListener = pending;
    return pending;
  }
  function nativeCount() {
    return [...windows.values()].filter(record => !record.disposed && record.nativeCreated).length
      + [...reservations].filter(reservation => !reservation.nativeCreated).length;
  }
  function nativeOwnerCount(key: string) {
    return [...windows.values()].filter(record => !record.disposed && record.nativeCreated && record.ownerKey === key).length
      + [...reservations].filter(reservation => !reservation.nativeCreated && reservation.ownerKey === key).length;
  }
  function getWindow(id: string) { return ports.windows.find(candidate => candidate.id === id); }
  function setWindow(window: PluginBrowserWindowState) {
    ports.setWindows(ports.windows.map(candidate => candidate.id === window.id ? window : candidate));
  }
  function assertBinding(binding: PluginNativeBrowserWindowBinding) {
    binding.lease.assertCurrent();
    if (!bindings.isEntryCurrent(binding)) throw failure("SOURCE_STALE");
  }
  function assertRecord(record: RecordEntry) {
    assertBinding(record.sourceBinding);
    if (disposed || record.disposed || windows.get(record.id) !== record || ports.hostGeneration !== record.hostGeneration)
      throw failure("WINDOW_STALE");
  }
  function assertCaller(creator: PluginBrowserWindowCreator | undefined, lease: PluginHostedDocumentLease | undefined): asserts lease is PluginHostedDocumentLease {
    if (!creator || !lease || creator.source !== lease.source || !ports.sources.isCurrent(creator.source, creator.identity))
      throw failure("CREATOR_STALE");
    lease.assertCurrent();
    if (!ports.sources.isCurrent(lease.source, lease.identity)) throw failure("CREATOR_STALE");
  }

  async function audited<T extends OpenResult | ActionResult>(
    binding: PluginNativeBrowserWindowBinding, operation: "open" | "action", windowId: string,
    options: Record<string, unknown> | undefined, action: string | undefined, actionArgs: unknown[],
    assertAdditional: () => void = () => undefined,
  ): Promise<T> {
    const assertCurrent = () => { assertBinding(binding); assertAdditional(); };
    assertCurrent();
    const command = operation === "open" ? "prepare_plugin_browser_window" : "prepare_plugin_browser_window_action";
    const invokeArgs = operation === "open"
      ? { sourceBindingId: binding.sourceBindingId, windowId, options: options ?? {} }
      : { sourceBindingId: binding.sourceBindingId, windowId, action: action ?? "", args: actionArgs };
    const expectedTool = await pluginNativeBrowserWindowTool(binding.pluginId);
    assertCurrent();
    const raw = await ports.invoke(command, invokeArgs);
    let prepared: ReturnType<typeof validatePluginNativeBrowserWindowIntent>;
    try { prepared = validatePluginNativeBrowserWindowIntent(raw, operation, (objectRecord(raw)?.intentId as string) ?? "", expectedTool); }
    catch (error) {
      const intentId = objectRecord(raw)?.intentId;
      if (typeof intentId === "string" && TOKEN.test(intentId)) await ports.invoke("cancel_plugin_browser_window_intent", { intentId }).catch(() => undefined);
      throw error;
    }
    assertCurrent();
    bindings.trackIntent(binding, prepared.intentId);
    let taken = false;
    try {
      await waitForPluginNativeBrowserWindowRun({
        opened: prepared, operation, intentId: prepared.intentId, invoke: ports.invoke,
        assertCurrent, listen: ports.listen,
      });
      assertCurrent();
      const result = await ports.invoke<T>("take_plugin_browser_window_result", { intentId: prepared.intentId });
      assertCurrent();
      taken = true;
      return result;
    } finally {
      bindings.finishIntent(binding, prepared.intentId);
      if (!taken) await ports.invoke("cancel_plugin_browser_window_intent", { intentId: prepared.intentId }).catch(() => undefined);
    }
  }

  async function prepareDocument(record: RecordEntry, url: string, generation: number, preload: string, geometry: unknown) {
    assertRecord(record);
    const binding = record.sourceBinding;
    const document = await preparePluginNativeWindowDocument({
      pluginRoot: binding.pluginRoot, mainUrl: ports.mainUrl(), requestedUrl: url,
      resourceSessionId: binding.resourceSessionId,
      resourceOrigin: ports.resourceOrigin?.() ?? convertFileSrc("", "atools-plugin"),
      readTextFile, resolveModuleSrc: ports.resources()?.resolveModuleSrc,
      warn: (message, error) => console.warn(`[PluginPanel] ${message}`, error),
    });
    assertRecord(record);
    const html = ports.injectBridge(document.html, "browserWindow", record.id, preload, geometry, "native", undefined,
      getWindow(record.id)?.backgroundThrottling ?? true);
    const response = await ports.invoke<{ documentId?: unknown }>("prepare_plugin_window_document", {
      sourceBindingId: binding.sourceBindingId, nativeLabel: record.nativeLabel,
      documentGeneration: generation, relativePath: document.relativePath, html,
    });
    assertRecord(record);
    if (typeof response?.documentId !== "string" || !TOKEN.test(response.documentId)) throw failure("DOCUMENT_ID");
    return { html, resourceUrl: appendPluginNativeWindowDocumentId(document.resourceUrl, response.documentId) };
  }

  async function cleanupFailedOpen(record: RecordEntry) {
    if (record.openRequested && bindings.isEntryCurrent(record.sourceBinding)) {
      try {
        await audited<ActionResult>(record.sourceBinding, "action", record.id, undefined, "destroy", []);
      } catch { /* Failed opens may have no native record to destroy. */ }
    }
  }

  async function create(args: Record<string, unknown>, creator: PluginBrowserWindowCreator, lease: PluginHostedDocumentLease) {
    if (!nativeEnabled()) throw failure("NATIVE_HOST_UNAVAILABLE");
    assertCaller(creator, lease);
    if (invalidating) await invalidating;
    if (disposed) throw failure("CONTROLLER_DESTROYED");
    if (nativeCount() >= 16) throw failure("GLOBAL_WINDOW_LIMIT");
    const reservation: NativeReservation = { nativeCreated: false };
    reservations.add(reservation);
    ports.setCreatingCount(ports.creatingCount + 1);
    const hostGeneration = ports.hostGeneration;
    let record: RecordEntry | undefined;
    let binding: PluginNativeBrowserWindowBinding | undefined;
    try {
      await ensureEventListener();
      lease.assertCurrent();
      if (ports.hostGeneration !== hostGeneration) throw failure("OWNER_CHANGED");
      const originalOptions = args.options && typeof args.options === "object" && !Array.isArray(args.options)
        ? args.options as Record<string, unknown> : {};
      const { nativeOptions, preloadOptions } = nativePluginBrowserWindowOptions(originalOptions);
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) throw Error("createBrowserWindow requires a non-empty url");
      binding = await bindings.ensure(lease);
      assertBinding(binding);
      if (ports.hostGeneration !== hostGeneration) throw failure("OWNER_CHANGED");
      reservation.ownerKey = ownerKey(binding);
      if (nativeOwnerCount(reservation.ownerKey) > 4) throw failure("OWNER_WINDOW_LIMIT");
      const windowSequence = ports.windowSequence + 1;
      ports.setWindowSequence(windowSequence);
      const id = `plugin-browser-window-${windowSequence}`;
      const clientCreateId = typeof args.clientCreateId === "string"
        && /^atools-browser-window-create-[a-z0-9-]{1,80}$/i.test(args.clientCreateId)
        ? args.clientCreateId : `atools-browser-window-create-host-${windowSequence}`;
      const navigationGeneration = ports.navigation.begin(id);
      const route = shellHost.register({ sourceBindingId: binding.sourceBindingId, windowId: id,
        isCurrent: () => !disposed && ports.hostGeneration === hostGeneration && bindings.isEntryCurrent(binding!),
        onChildMessage: event => dispatchPluginNativeBrowserWindowMessage(event),
      });
      record = { id, nativeLabel: "", sourceBinding: binding, creator, creatorLease: lease, route, ownerKey: reservation.ownerKey,
        hostGeneration, rendered: false, nativeCreated: false, openRequested: true, active: false, disposed: false };
      windows.set(id, record);
      const opened = await audited<OpenResult>(binding, "open", id, nativeOptions, undefined, [], () => assertRecord(record!));
      record.nativeCreated = true;
      reservation.nativeCreated = true;
      if (opened.windowId !== id || typeof opened.nativeLabel !== "string" || !LABEL.test(opened.nativeLabel)) throw failure("OPEN_RESULT");
      record.nativeLabel = opened.nativeLabel;
      assertRecord(record);
      const snapshot = readPluginNativeBrowserWindowSnapshot(opened.snapshot);
      if ("closed" in snapshot) throw failure("OPEN_CLOSED");
      bindings.trackWindow(binding, id);
      const hostedWebContentsId = ports.hostedIpc.reserve({ kind: "child", windowId: id });
      const preloadScript = await ports.preparePreload(preloadOptions, () => {
        try { binding!.lease.assertCurrent(); return bindings.isEntryCurrent(binding!); } catch { return false; }
      });
      assertRecord(record);
      const shell = await route.waitForShell(120_000);
      assertRecord(record);
      record.shell = shell;
      const state = createPluginNativeBrowserWindowState({ id, clientCreateId, url,
        title: snapshot.title || browserWindowTitle(url, preloadOptions), srcdoc: "", documentGeneration: navigationGeneration,
        preloadOptions, snapshot, windowSequence, webContentsId: hostedWebContentsId });
      ports.creators.set(id, creator);
      ports.setWindows([...ports.windows, state]);
      record.active = true;
      if (record.pendingEvent) { const pending = record.pendingEvent; record.pendingEvent = undefined; handleNativeEvent(pending); }
      assertRecord(record);
      const geometrySnapshot = ports.geometry.snapshot(getWindow(id)!);
      if (!geometrySnapshot) throw failure("GEOMETRY_INITIALIZATION");
      const document = await prepareDocument(record, url, navigationGeneration, preloadScript, geometrySnapshot);
      const current = getWindow(id);
      if (!current) throw failure("WINDOW_CLOSED");
      const entry = { ...current, srcdoc: document.html,
        history: [{ url, title: current.title, srcdoc: document.html }] };
      setWindow(entry);
      record.unregisterRenderer = registerPluginNativeBrowserWindowRendererReady(shell.frame.contentWindow, id,
        readyLease => finalizeRenderer(record!, readyLease));
      record.mount = ports.mountFrame(shell.frame, id, shell.replyTarget);
      assertRecord(record);
      shell.setLocation(document.resourceUrl);
      const response = { ...entry, hostKind: "native", geometrySnapshot, type: "browserWindow", windowType: "browserWindow" } as Record<string, unknown>;
      delete response.processId; delete response.osProcessId; delete response.mediaSourceId; delete response.webContentsMediaSourceId;
      delete response.webContentsId;
      return response;
    } catch (error) {
      if (record) {
        await cleanupFailedOpen(record);
        disposeRecord(record);
      }
      throw error;
    } finally {
      reservations.delete(reservation);
      ports.setCreatingCount(Math.max(0, ports.creatingCount - 1));
    }
  }

  function finalizeRenderer(record: RecordEntry, lease: PluginHostedDocumentLease) {
    if (record.rendered) return Promise.resolve();
    if (record.renderPromise) return record.renderPromise;
    const promise = (async () => {
      const assertRendererCurrent = () => {
        lease.assertCurrent();
        if (lease.identity.kind !== "child" || lease.identity.windowId !== record.id
          || !ports.sources.isCurrent(lease.source, lease.identity)) throw failure("RENDERER_LEASE");
      };
      try { assertRendererCurrent(); }
      catch { throw failure("RENDERER_LEASE"); }
      if (lease.identity.kind !== "child" || lease.identity.windowId !== record.id)
        throw failure("RENDERER_LEASE");
      assertRecord(record);
      record.creatorLease.assertCurrent();
      const result = await audited<ActionResult>(record.sourceBinding, "action", record.id, undefined, "__renderReady", [], assertRendererCurrent);
      assertRendererCurrent();
      if (result.windowId !== record.id || result.nativeLabel !== record.nativeLabel) throw failure("RENDER_READY_RESULT");
      assertRecord(record);
      applyResult(record, result.snapshot);
      if (record.disposed) throw failure("WINDOW_CLOSED");
      record.rendered = true;
    })().finally(() => { if (record.renderPromise === promise) record.renderPromise = undefined; });
    record.renderPromise = promise;
    return promise;
  }

  function emitClosed(record: RecordEntry) {
    ports.dispatchWindowEvent(record.id, "closed", [{ visible: false, focused: false, closed: true }]);
  }
  function applyResult(record: RecordEntry, value: unknown) {
    if (record.disposed) return;
    const snapshot = readPluginNativeBrowserWindowSnapshot(value);
    if ("closed" in snapshot) { emitClosed(record); disposeRecord(record); return; }
    const current = getWindow(record.id);
    if (!current || current.hostKind !== "native") return;
    const updated = applyPluginNativeBrowserWindowSnapshot(current, snapshot);
    if (updated) { setWindow(updated); ports.geometry.publish(updated); }
  }
  function handleNativeEvent(event: PluginNativeBrowserWindowEvent) {
    if (!event || typeof event.windowId !== "string" || typeof event.nativeLabel !== "string") return;
    const record = windows.get(event.windowId);
    if (!record || record.disposed) return;
    if (!record.nativeLabel || !record.active) {
      if (event.kind === "Destroyed" || record.pendingEvent?.kind !== "Destroyed") record.pendingEvent = event;
      return;
    }
    if (record.nativeLabel !== event.nativeLabel) return;
    if (event.kind === "Destroyed") { emitClosed(record); disposeRecord(record); return; }
    try {
      const current = getWindow(record.id);
      if (!current) return;
      const updated = applyPluginNativeBrowserWindowSnapshot(current, event.snapshot);
      if (!updated) return;
      setWindow(updated);
      ports.geometry.publish(updated);
      const args = [{ x: updated.x, y: updated.y, width: updated.width, height: updated.height,
        visible: updated.visible, focused: updated.focused, alwaysOnTop: updated.alwaysOnTop,
        minimized: updated.minimized, maximized: updated.maximized, fullScreen: updated.fullScreen, closed: false }];
      for (const kind of event.kinds) {
        if (kind === "Moved") ports.dispatchWindowEvent(record.id, "move", args);
        else if (kind === "Resized" || kind === "ScaleFactorChanged") ports.dispatchWindowEvent(record.id, "resize", args);
        else if (kind === "Focused") ports.dispatchWindowEvent(record.id, updated.focused ? "focus" : "blur", args);
      }
    } catch { /* Malformed app events cannot interrupt other Tauri event handlers. */ }
  }

  function disposeRecord(record: RecordEntry) {
    if (record.disposed) return;
    record.disposed = true;
    windows.delete(record.id);
    record.unregisterRenderer?.();
    record.mount?.destroy?.();
    record.route.dispose();
    ports.hostedIpc.invalidate({ kind: "child", windowId: record.id }, true);
    ports.sources.unregisterChild(record.id);
    ports.rpc.close(record.id);
    ports.navigation.close(record.id);
    ports.geometry.remove(record.id);
    ports.frames.delete(record.id);
    ports.creators.delete(record.id);
    ports.clearInsertedCss(record.id);
    bindings.finishWindow(record.sourceBinding, record.id);
    ports.setWindows(ports.windows.filter(window => window.id !== record.id));
  }

  async function navigate(record: RecordEntry, url: string, reloaded: boolean, ignoreCache: boolean, historyIndex?: number) {
    assertRecord(record);
    const current = getWindow(record.id);
    if (!current || !record.shell) throw failure("WINDOW_CLOSED");
    const nextUrl = url.trim();
    if (!nextUrl) throw failure("NAVIGATION_URL");
    const navigationGeneration = ports.navigation.begin(record.id);
    let locationChanged = false;
    ports.hostedIpc.invalidate({ kind: "child", windowId: record.id });
    ports.sources.unregisterChild(record.id);
    ports.rpc.invalidate(record.id, "reloaded");
    ports.clearInsertedCss(record.id);
    const changed = { ...current, url: nextUrl, documentGeneration: navigationGeneration, loading: true, crashed: false };
    setWindow(changed);
    try {
      const geometrySnapshot = ports.geometry.snapshot(changed);
      if (!geometrySnapshot) throw failure("GEOMETRY_INITIALIZATION");
      const preload = await ports.preparePreload(current.preloadOptions, () => bindings.isEntryCurrent(record.sourceBinding));
      ports.navigation.assertCurrent(record.id, navigationGeneration);
      assertRecord(record);
      const document = await prepareDocument(record, nextUrl, navigationGeneration, preload, geometrySnapshot);
      ports.navigation.assertCurrent(record.id, navigationGeneration);
      assertRecord(record);
      record.shell.setLocation(document.resourceUrl);
      locationChanged = true;
      const title = reloaded ? current.title : browserWindowTitle(nextUrl, {});
      const history = [...current.history];
      const index = historyIndex ?? (reloaded ? current.historyIndex : current.historyIndex + 1);
      if (!Number.isSafeInteger(index) || index < 0) throw failure("HISTORY_INDEX");
      if (reloaded && history[index]) history[index] = { url: nextUrl, title, srcdoc: document.html };
      else history.splice(index, history.length - index, { url: nextUrl, title, srcdoc: document.html });
      const afterSet = getWindow(record.id);
      if (!afterSet) throw failure("WINDOW_CLOSED");
      setWindow({ ...afterSet, ...changed, srcdoc: document.html, title, history, historyIndex: index });
      await ports.rpc.waitReady(record.id);
      ports.navigation.assertCurrent(record.id, navigationGeneration);
      assertRecord(record);
      const finalTitle = await ports.pageTitle(record.id, title);
      ports.navigation.assertCurrent(record.id, navigationGeneration);
      const finished = getWindow(record.id);
      if (!finished) throw failure("WINDOW_CLOSED");
      setWindow({ ...finished, title: finalTitle, loading: false,
        history: finished.history.map((item, at) => at === index ? { ...item, title: finalTitle } : item) });
      const finalState = getWindow(record.id);
      if (finalState) ports.geometry.publish(finalState);
      return { url: nextUrl, title: finalTitle, historyIndex: index, historyLength: history.length, loading: false, crashed: false, reloaded, ignoreCache };
    } catch (error) {
      if (ports.navigation.isCurrent(record.id, navigationGeneration) && !record.disposed) {
        const failed = getWindow(record.id);
        if (failed) setWindow(locationChanged ? { ...failed, loading: false, crashed: true } : current);
      }
      throw error;
    }
  }

  function navigateHistory(record: RecordEntry, actionName: string, args: unknown[]) {
    const state = getWindow(record.id);
    if (!state) throw failure("WINDOW_CLOSED");
    let index = state.historyIndex + (actionName.endsWith("Back") ? -1 : 1);
    if (actionName.endsWith("goToIndex")) index = Math.trunc(Number(args[0]));
    if (actionName.endsWith("goToOffset")) index = state.historyIndex + Math.trunc(Number(args[0]));
    if (!Number.isSafeInteger(index) || index < 0 || index >= state.history.length) throw failure("HISTORY_INDEX");
    return navigate(record, state.history[index].url, true, false, index);
  }
  function clearHistory(record: RecordEntry) {
    const state = getWindow(record.id);
    if (!state) throw failure("WINDOW_CLOSED");
    const history = state.url ? [{ url: state.url, title: state.title, srcdoc: state.srcdoc }] : [];
    const historyIndex = history.length ? 0 : -1;
    setWindow({ ...state, history, historyIndex });
    return { url: state.url, title: state.title, historyIndex, historyLength: history.length, loading: state.loading, crashed: state.crashed };
  }
  async function action(args: Record<string, unknown>, creator?: PluginBrowserWindowCreator, lease?: PluginHostedDocumentLease) {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const name = typeof args.action === "string" ? args.action.trim() : "";
    const record = windows.get(id), state = getWindow(id);
    if (!record || !state || state.hostKind !== "native") return undefined;
    if (name === "__renderReady" || name.startsWith("__")) throw failure("PRIVATE_ACTION");
    assertCaller(creator, lease);
    const actionHostGeneration = ports.hostGeneration;
    const binding = await bindings.ensure(lease);
    assertBinding(binding);
    if (ports.hostGeneration !== actionHostGeneration) throw failure("OWNER_CHANGED");
    if (ownerKey(binding) !== record.ownerKey) throw failure("SOURCE_OWNER");
    assertRecord(record);
    const actionArgs = Array.isArray(args.args) ? args.args : [];
    const navigation = await runNativeBrowserWindowNavigationAction({
      windowId: id, action: name, actionArgs,
      currentUrl: windowId => getWindow(windowId)?.url,
      navigate: (url, reloaded, ignoreCache) => navigate(record, url, reloaded, ignoreCache),
      navigateHistory: (actionName, navigationArgs) => navigateHistory(record, actionName, navigationArgs),
      clearHistory: () => clearHistory(record), failure,
    });
    if (navigation.handled) return navigation.value;
    if (name.startsWith("webContents.")) return undefined;
    const result = await audited<ActionResult>(binding, "action", id, undefined, name, actionArgs, () => {
      if (ports.hostGeneration !== actionHostGeneration) throw failure("OWNER_CHANGED");
    });
    if (result.windowId !== id || result.nativeLabel !== record.nativeLabel) throw failure("ACTION_RESULT");
    applyResult(record, result.snapshot);
    return result.value;
  }

  async function closeNative(id: string) {
    const record = windows.get(id);
    if (!record) return;
    assertRecord(record);
    const result = await audited<ActionResult>(record.sourceBinding, "action", id, undefined, "close", [], () => assertRecord(record));
    if (result.windowId !== id || result.nativeLabel !== record.nativeLabel) throw failure("ACTION_RESULT");
    applyResult(record, result.snapshot);
    if (!record.disposed) { emitClosed(record); disposeRecord(record); }
  }

  function handlesAction(args: Record<string, unknown>) {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const name = typeof args.action === "string" ? args.action.trim() : "";
    const record = windows.get(id);
    if (!record || record.disposed || !record.nativeCreated) return false;
    if (name === "webContents.send" || name === "webContents.executeJavaScript" || name.startsWith("webContents."))
      return NAVIGATION_ACTIONS.has(name);
    return name.length > 0;
  }

  function invalidate() {
    if (invalidating) return invalidating;
    ports.navigation.closeAll();
    const operation = (async () => {
      try { await bindings.closeAll(); }
      finally {
        for (const record of [...windows.values()]) disposeRecord(record);
        shellHost.dispose();
        eventEpoch += 1;
        eventUnlisten?.(); eventUnlisten = undefined; eventListener = undefined;
      }
    })();
    const wrapped = operation.finally(() => { if (invalidating === wrapped) invalidating = undefined; });
    invalidating = wrapped;
    return wrapped;
  }

  return {
    nativeEnabled, create, action, handlesAction,
    close: (id: string) => { void closeNative(id).catch(error => console.warn("[PluginPanel] native BrowserWindow close failed", error)); },
    invalidate,
    async destroy() {
      if (disposed) return;
      disposed = true;
      await invalidate();
    },
  };
}
