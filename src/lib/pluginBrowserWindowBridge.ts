/** Synchronous BrowserWindow handles over the asynchronous hosted-window transport. */
type BrowserWindowRecord = Record<string, unknown> & { id?: unknown };
type HandleLike = Record<string, unknown> & {
  close?: () => Promise<unknown> | unknown;
  on?: (name: string, listener: (...args: unknown[]) => void) => unknown;
  webContents?: Record<string, unknown>;
};

type Operation = {
  target: "window" | "webContents" | "navigationHistory";
  method: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type WindowState = {
  pendingId: string;
  clientCreateId: string;
  id: string;
  url: string;
  title: string;
  phase: "creating" | "created" | "ready" | "closing" | "closed";
  handle: HandleLike | null;
  geometrySnapshot?: Record<string, unknown>;
  observedClose?: Record<string, unknown>;
  operations: Operation[];
  operationChain: Promise<void>;
  inFlightOperations: number;
  readyCallbacks: Array<(handle: unknown) => void>;
  callback?: () => void;
  callbackCalled: boolean;
  resolveReady: (handle: unknown) => void;
  rejectReady: (error: Error) => void;
  ready: Promise<unknown>;
  closePromise?: Promise<unknown>;
  closeResolve?: (value: unknown) => void;
  closeReject?: (error: Error) => void;
  closePreviousPhase?: "created" | "ready";
  facade?: object;
  webContentsProxy?: object;
  historyProxy?: object;
  readyObserved: boolean;
  readyObservedWindowId?: string;
  pendingCounted: boolean;
};

type PluginBrowserWindowBridgeOptions = {
  invoke: (method: string, args: Record<string, unknown>) => Promise<unknown>;
  createResolvedHandle: (record: BrowserWindowRecord) => HandleLike;
  maxPendingCreates?: number;
  maxQueuedOperations?: number;
  onError?: (error: unknown) => void;
};

/**
 * Calls are admitted synchronously. The facade is not thenable: `await handle`
 * returns immediately for compatibility, while `handle.ready` means the child
 * document loaded and completed its hosted RPC handshake.
 */
export function createPluginBrowserWindowBridge(
  hostWindow: Window,
  options: PluginBrowserWindowBridgeOptions,
) {
  const WINDOW_METHODS = new Set((
    "show hide focus close destroy isDestroyed isVisible isFocused showInactive blur getTitle setTitle getURL loadURL reload "
    + "minimize isMinimized restore maximize unmaximize isMaximized isAlwaysOnTop setAlwaysOnTop getBackgroundColor setBackgroundColor "
    + "setAutoHideMenuBar isMenuBarAutoHide setMenuBarVisibility isMenuBarVisible removeMenu setMenu setWindowButtonVisibility "
    + "setWindowButtonPosition getWindowButtonPosition setVibrancy setBackgroundMaterial setSheetOffset isNormal isModal "
    + "setDocumentEdited isDocumentEdited setRepresentedFilename getRepresentedFilename setParentWindow getParentWindow getChildWindows "
    + "getBounds setBounds getSize setSize getContentSize setContentSize getMinimumSize setMinimumSize getMaximumSize setMaximumSize "
    + "setAspectRatio getPosition setPosition center isResizable setResizable isMovable setMovable isClosable setClosable "
    + "isMinimizable setMinimizable isMaximizable setMaximizable isFullScreen setFullScreen isFullScreenable setFullScreenable "
    + "getOpacity setOpacity hasShadow setHasShadow invalidateShadow setSkipTaskbar setKiosk isKiosk setVisibleOnAllWorkspaces "
    + "isVisibleOnAllWorkspaces setContentProtection isContentProtected setFocusable isFocusable flashFrame setProgressBar "
    + "getMediaSourceId moveTop moveAbove on addListener once off removeListener removeAllListeners"
  ).split(/\s+/));
  const WEB_CONTENTS_METHODS = new Set((
    "send executeJavaScript sendInputEvent insertCSS removeInsertedCSS findInPage stopFindInPage getURL getTitle isLoading "
    + "isLoadingMainFrame isWaitingForResponse canGoBack canGoForward loadURL reload goBack goForward reloadIgnoringCache stop "
    + "isDestroyed getType isCrashed forcefullyCrashRenderer focus isFocused getOwnerBrowserWindow getMediaSourceId isBeingCaptured "
    + "setIgnoreMenuShortcuts openDevTools closeDevTools toggleDevTools isDevToolsOpened isDevToolsFocused inspectElement capturePage "
    + "print printToPDF savePage getUserAgent setUserAgent getFrameRate setFrameRate getBackgroundThrottling setBackgroundThrottling "
    + "getOSProcessId getProcessId centerSelection scrollToTop scrollToBottom adjustSelection insertText undo redo cut copy paste "
    + "pasteAndMatchStyle delete selectAll unselect replace replaceMisspelling setZoomFactor getZoomFactor setZoomLevel getZoomLevel "
    + "setVisualZoomLevelLimits setAudioMuted isAudioMuted isCurrentlyAudible on addListener once off removeListener removeAllListeners"
  ).split(/\s+/));
  const HISTORY_METHODS = new Set("canGoBack canGoForward goBack goForward goToIndex canGoToOffset goToOffset clear".split(" "));
  const SYNC_GETTERS = new Set((
    "getBackgroundColor isMenuBarAutoHide isMenuBarVisible getWindowButtonPosition isNormal isModal isDocumentEdited "
    + "getRepresentedFilename getParentWindow getChildWindows getBounds getSize getContentSize getMinimumSize getMaximumSize getPosition"
  ).split(/\s+/));
  const IPC_METHODS = new Set("on addListener once off removeListener removeAllListeners".split(" "));
  const NOT_READY = "ERR_ATOOLS_BROWSER_WINDOW_NOT_READY";
  function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
  function browserWindowError(code: string, detail: string) {
    return new Error(`${code}: ${detail}`);
  }

  function requireCloseConfirmation(result: unknown) {
    if (!result || typeof result !== "object" || (result as Record<string, unknown>).closed !== true) {
      throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSE_UNCONFIRMED", "native host did not confirm closed=true");
    }
    return result;
  }
  const maxPendingCreates = Math.max(1, Math.min(32, options.maxPendingCreates ?? 8));
  const maxQueuedOperations = Math.max(1, Math.min(64, options.maxQueuedOperations ?? 32));
  const states = new Map<string, WindowState>();
  const statesById = new Map<string, WindowState>();
  const statesByCreateId = new Map<string, WindowState>();
  const frameCreateNonce = (() => {
    try {
      if (typeof hostWindow.crypto?.randomUUID === "function") return hostWindow.crypto.randomUUID().replace(/-/g, "");
      if (typeof hostWindow.crypto?.getRandomValues === "function") {
        const bytes = hostWindow.crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      }
    } catch { /* use a local fallback in restricted WebViews */ }
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  })();
  let sequence = 0;
  let pendingCreates = 0;
  let disposed = false;
  function releasePendingCreate(state: WindowState) {
    if (!state.pendingCounted) return;
    state.pendingCounted = false;
    pendingCreates = Math.max(0, pendingCreates - 1);
  }
  function report(error: unknown) {
    try { options.onError?.(error); } catch { /* diagnostics cannot break window cleanup */ }
  }
  function rejectQueued(state: WindowState, error: Error) {
    const operations = state.operations.splice(0);
    for (const operation of operations) {
      operation.reject(error);
      state.inFlightOperations = Math.max(0, state.inFlightOperations - 1);
    }
  }
  function operationSettled(state: WindowState) {
    state.inFlightOperations = Math.max(0, state.inFlightOperations - 1);
    if (state.readyObserved && state.inFlightOperations === 0) completeReady(state);
  }
  function scheduleOperation(state: WindowState, target: Operation["target"], method: string, args: unknown[]) {
    if (state.inFlightOperations >= maxQueuedOperations) {
      return Promise.reject(browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_QUEUE_LIMIT", `${maxQueuedOperations} operations per window`));
    }
    if (state.phase === "ready" && state.inFlightOperations === 0) {
      state.inFlightOperations = 1;
      let immediateResult: unknown;
      try { immediateResult = callHandle(state, target, method, args); }
      catch (error) {
        state.inFlightOperations = 0;
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (!immediateResult || typeof (immediateResult as Promise<unknown>).then !== "function") {
        state.inFlightOperations = 0;
        return immediateResult;
      }
      const immediate = Promise.resolve(immediateResult);
      state.operationChain = immediate.then(() => undefined, () => undefined);
      void immediate.then(() => operationSettled(state), () => operationSettled(state));
      return immediate;
    }
    state.inFlightOperations += 1;
    const result = state.operationChain.then(() => {
      if (state.phase === "closing" || state.phase === "closed") {
        throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id || state.pendingId);
      }
      return callHandle(state, target, method, args);
    });
    state.operationChain = result.then(() => undefined, () => undefined);
    void result.then(() => operationSettled(state), () => operationSettled(state));
    return result;
  }
  function finishClosed(state: WindowState) {
    if (state.phase !== "ready") {
      state.rejectReady(browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id || state.pendingId));
    }
    state.phase = "closed";
    state.geometrySnapshot = undefined;
    state.observedClose = undefined;
    if (state.id) statesById.delete(state.id);
    statesByCreateId.delete(state.clientCreateId);
    states.delete(state.pendingId);
    state.readyCallbacks = [];
    state.callback = undefined;
    rejectQueued(state, browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id || state.pendingId));
  }
  function callHandle(state: WindowState, target: Operation["target"], method: string, args: unknown[]) {
    const handle = state.handle;
    if (!handle) throw browserWindowError(NOT_READY, `${method} cannot run before native creation`);
    if (target === "window" && method === "isDestroyed") return state.phase === "closed";
    if (target === "window" && method === "destroy") method = "close";
    const receiver = (target === "window"
      ? handle
      : target === "webContents"
        ? handle.webContents
        : handle.webContents?.navigationHistory) as Record<string, unknown> | undefined;
    const action = receiver && receiver[method];
    if (typeof action !== "function") {
      throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_UNSUPPORTED", `${target}.${method}`);
    }
    return action.apply(receiver, args);
  }
  function enqueue(state: WindowState, target: Operation["target"], method: string, args: unknown[]) {
    if (state.phase === "closed" || state.phase === "closing") {
      return Promise.reject(browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id || state.pendingId));
    }
    if (state.phase !== "creating") return scheduleOperation(state, target, method, args);
    if (state.inFlightOperations >= maxQueuedOperations) {
      return Promise.reject(browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_QUEUE_LIMIT", `${maxQueuedOperations} operations per pending window`));
    }
    state.inFlightOperations += 1;
    const promise = new Promise<unknown>((resolve, reject) => {
      state.operations.push({ target, method, args, resolve, reject });
    });
    void promise.catch(() => undefined);
    return promise;
  }
  function createProxy(state: WindowState, target: Operation["target"]): object {
    const methods = target === "window" ? WINDOW_METHODS : target === "webContents" ? WEB_CONTENTS_METHODS : HISTORY_METHODS;
    const backing = {} as Record<string, unknown>;
    if (target === "window") {
      for (const key of ["id", "type", "windowType", "url", "title"]) {
        Object.defineProperty(backing, key, { configurable: true, enumerable: true, get: () => state.facade && Reflect.get(state.facade, key) });
      }
    }
    return new Proxy(backing, {
      get(_target, property) {
        if (typeof property !== "string") return undefined;
        if (property === "then") return undefined;
        if (target === "window") {
          if (property === "id") return state.id;
          if (property === "type" || property === "windowType") return "browserWindow";
          if (property === "url") return state.url;
          if (property === "title") return state.title;
          if (property === "ready") return state.ready;
          if (property === "onReady") return (listener: (handle: unknown) => void) => {
            if (typeof listener !== "function") return state.facade;
            if (disposed || state.phase === "closing" || state.phase === "closed") throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id);
            if (state.phase === "ready") queueMicrotask(() => {
              if (state.phase === "ready" && !disposed) try { listener(state.facade); } catch (error) { report(error); }
            });
            else if (state.readyCallbacks.length >= maxQueuedOperations) throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_QUEUE_LIMIT", `${maxQueuedOperations} ready callbacks per window`);
            else state.readyCallbacks.push(listener);
            return state.facade;
          };
          if (property === "isDestroyed") return () => state.phase === "closed";
          if (property === "webContents") return state.handle?.webContents || state.webContentsProxy;
          if (property === "destroy") return (...args: unknown[]) => closeState(state, args);
          if (property === "close") return (...args: unknown[]) => closeState(state, args);
        }
        if (target === "webContents" && property === "navigationHistory") {
          return state.handle?.webContents?.navigationHistory || state.historyProxy;
        }
        if (methods.has(property)) {
          return (...args: unknown[]) => {
            if (target === "window" && (property === "close" || property === "destroy")) return closeState(state, args);
            if (IPC_METHODS.has(property) && state.phase !== "creating") {
              callHandle(state, target, property, args);
              return target === "window" ? state.facade : state.webContentsProxy;
            }
            if (target === "window" && SYNC_GETTERS.has(property) && state.phase === "creating") {
              throw browserWindowError(NOT_READY, `${property} has no native state yet`);
            }
            let result: unknown;
            if (target === "window" && SYNC_GETTERS.has(property) && state.phase !== "creating") {
              if (state.phase === "closed" || state.phase === "closing") throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id);
              result = callHandle(state, target, property, args);
            } else result = enqueue(state, target, property, args);
            if (target === "window" && IPC_METHODS.has(property)) return state.facade;
            if (target === "webContents" && IPC_METHODS.has(property)) return state.webContentsProxy;
            if (target === "navigationHistory") return state.historyProxy;
            if (target === "window" && (property === "getParentWindow" || property === "getChildWindows")) {
              const mapHandle = (handle: unknown) => Array.isArray(handle)
                ? handle.map((entry) => facadeForHandle(entry))
                : facadeForHandle(handle);
              return result && typeof (result as Promise<unknown>).then === "function"
                ? (result as Promise<unknown>).then(mapHandle)
                : mapHandle(result);
            }
            if (target === "webContents" && property === "getOwnerBrowserWindow") {
              const mapHandle = (handle: unknown) => facadeForHandle(handle);
              return result && typeof (result as Promise<unknown>).then === "function"
                ? (result as Promise<unknown>).then(mapHandle)
                : mapHandle(result);
            }
            return result;
          };
        }
        const receiver = target === "window"
          ? state.handle
          : target === "webContents"
            ? state.handle?.webContents
            : state.handle?.webContents?.navigationHistory as Record<string, unknown> | undefined;
        if (receiver && property in receiver) return receiver[property];
        return undefined;
      },
    });
  }
  function closeState(state: WindowState, args: unknown[]) {
    if (state.phase === "closed") return Promise.resolve(undefined);
    if (state.closePromise) return state.closePromise;
    const previousPhase = state.phase;
    state.closePreviousPhase = previousPhase === "ready" ? "ready" : "created";
    state.phase = "closing";
    state.rejectReady(browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id || state.pendingId));
    state.readyCallbacks = [];
    state.callback = undefined;
    rejectQueued(state, browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id || state.pendingId));
    if (state.handle) {
      state.closePromise = Promise.resolve().then(() => callHandle(state, "window", "close", args)).then((result) => {
        requireCloseConfirmation(result);
        finishClosed(state);
        return result;
      }).catch((error) => {
        if (state.phase !== "closed") state.phase = state.closePreviousPhase || "created";
        state.closePromise = undefined;
        throw error;
      });
    } else {
      state.closePromise = new Promise((resolve, reject) => {
        const previousReady = state.ready;
        void previousReady.catch(() => undefined);
        state.closeResolve = resolve;
        state.closeReject = reject;
      });
    }
    void state.closePromise.catch(() => undefined);
    return state.closePromise;
  }
  function flush(state: WindowState) {
    const operations = state.operations.splice(0);
    for (const operation of operations) {
      const result = state.operationChain.then(() => {
        if (state.phase === "closing" || state.phase === "closed") {
          throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", state.id);
        }
        return callHandle(state, operation.target, operation.method, operation.args);
      });
      state.operationChain = result.then(() => undefined, () => undefined);
      void result.then(operation.resolve, operation.reject).then(
        () => operationSettled(state),
        () => operationSettled(state),
      );
    }
  }
  function createBrowserWindow(urlValue: unknown, windowOptions?: unknown, callback?: () => void) {
    const url = String(urlValue || "").trim();
    if (!url) throw new Error("createBrowserWindow requires a non-empty url");
    if (disposed) throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", "plugin bridge is disposed");
    if (pendingCreates >= maxPendingCreates) throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CREATE_LIMIT", `${maxPendingCreates} pending creates per plugin frame`);
    const pendingId = `atools-pending-browser-window-${++sequence}`;
    let resolveReady!: (handle: unknown) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<unknown>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    void ready.catch(() => undefined);
    const clientCreateId = `atools-browser-window-create-${frameCreateNonce}-${sequence}`;
    const state: WindowState = {
      pendingId, clientCreateId, id: pendingId, url, title: "", phase: "creating", handle: null, operations: [],
      operationChain: Promise.resolve(), inFlightOperations: 0,
      readyCallbacks: [], callback, callbackCalled: false, resolveReady, rejectReady, ready,
      readyObserved: false, pendingCounted: true,
    };
    states.set(pendingId, state);
    statesByCreateId.set(clientCreateId, state);
    state.facade = createProxy(state, "window");
    state.webContentsProxy = createProxy(state, "webContents");
    state.historyProxy = createProxy(state, "navigationHistory");
    pendingCreates += 1;

    Promise.resolve().then(() => {
      if (state.phase === "closing" || disposed) throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CLOSED", pendingId);
      return options.invoke("createBrowserWindow", {
        url,
        options: windowOptions && typeof windowOptions === "object" ? windowOptions as Record<string, unknown> : {},
        hasCallback: typeof callback === "function",
        clientCreateId,
      });
    }).then(async (value) => {
      releasePendingCreate(state);
      const record = value && typeof value === "object" ? value as BrowserWindowRecord : {};
      const id = typeof record.id === "string" ? record.id : "";
      if (!id) throw browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_CREATE_FAILED", "native host returned no window id");
      state.id = id;
      state.title = typeof record.title === "string" ? record.title : "";
      state.handle = options.createResolvedHandle(record);
      if (state.geometrySnapshot && typeof state.handle.__atoolsApplyGeometry === "function") state.handle.__atoolsApplyGeometry(state.geometrySnapshot);
      state.geometrySnapshot = undefined;
      state.phase = state.phase === "closing" ? "closing" : "created";
      statesById.set(id, state);
      if (state.handle.webContents && typeof state.handle.webContents.getOwnerBrowserWindow === "function") {
        state.handle.webContents.getOwnerBrowserWindow = () => state.facade;
      }
      state.handle.on?.("closed", () => finishClosed(state));
      if (state.observedClose && typeof state.handle.__atoolsObserveGeometryEvent === "function") state.handle.__atoolsObserveGeometryEvent(state.observedClose);
      state.observedClose = undefined;
      if (!states.has(state.pendingId)) return;
      flush(state);
      if (state.phase === "closing") {
        const closeResult = requireCloseConfirmation(await Promise.resolve(callHandle(state, "window", "close", [])));
        finishClosed(state);
        state.closeResolve?.(closeResult);
      }
      if (state.readyObserved && state.readyObservedWindowId === state.id) completeReady(state);
    }).catch((error) => {
      releasePendingCreate(state);
      const failure = error instanceof Error ? error : new Error(errorMessage(error));
      rejectQueued(state, failure);
      if (state.handle && state.closePromise) {
        if (state.phase !== "closed") state.phase = state.closePreviousPhase || "created";
        state.closePromise = undefined;
        state.closeReject?.(failure);
        state.closeResolve = undefined;
        state.closeReject = undefined;
        report(failure);
      } else if (state.phase === "closing") {
        state.rejectReady(failure);
        finishClosed(state);
        state.closeResolve?.(undefined);
      } else {
        state.rejectReady(failure);
        finishClosed(state);
        report(error);
      }
      state.closeReject?.(error instanceof Error ? error : new Error(errorMessage(error)));
    });
    return state.facade;
  }
  function completeReady(state: WindowState) {
    if (disposed || state.phase === "closed" || state.phase === "closing" || state.phase === "ready" || !state.handle
      || state.inFlightOperations > 0) return;
    state.phase = "ready";
    state.resolveReady(state.facade);
    if (!disposed && state.phase === "ready" && !state.callbackCalled && typeof state.callback === "function") {
      state.callbackCalled = true;
      try { state.callback(); } catch (error) { report(error); }
    }
    const listeners = state.readyCallbacks.splice(0);
    for (const listener of listeners) {
      if (disposed || state.phase !== "ready") break;
      try { listener(state.facade); } catch (error) { report(error); }
    }
  }
  function facadeForHandle(value: unknown) {
    if (!value || typeof value !== "object") return value;
    const id = typeof (value as Record<string, unknown>).id === "string" ? String((value as Record<string, unknown>).id) : "";
    return statesById.get(id)?.facade || value;
  }
  function onMessage(event: MessageEvent) {
    if (event.source !== hostWindow.parent) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const createId = typeof data.clientCreateId === "string" ? data.clientCreateId : "";
    const state = createId ? statesByCreateId.get(createId) : undefined;
    if (!state) return;
    if ((data.__atools_browser_window_geometry__ === true || data.__atools_browser_window_event__ === true) && state.phase === "creating") {
      const value = data.geometrySnapshot;
      if (value?.clientCreateId === state.clientCreateId && value.windowId === data.windowId && Number.isSafeInteger(value.revision)
        && Number(value.revision) >= Number(state.geometrySnapshot?.revision || 0)) {
        state.geometrySnapshot = value;
        if (data.__atools_browser_window_event__ === true && data.event === "closed") state.observedClose = data;
      }
    }
    if (data.__atools_browser_window_ready__ === true) {
      state.readyObserved = true;
      state.readyObservedWindowId = String(data.windowId || "");
      if (state.handle && String(data.windowId || "") === state.id) completeReady(state);
    }
    if (data.__atools_browser_window_failed__ === true && (!state.handle || String(data.windowId || "") === state.id)) {
      const error = browserWindowError("ERR_ATOOLS_BROWSER_WINDOW_LOAD_FAILED", errorMessage(data.error || "child RPC handshake failed"));
      state.rejectReady(error);
      state.phase = state.handle ? "created" : "closing";
      rejectQueued(state, error);
      void closeState(state, []).catch(report);
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    hostWindow.removeEventListener("message", onMessage);
    hostWindow.removeEventListener("pagehide", onDispose);
    hostWindow.removeEventListener("atools-plugin-out", onDispose as EventListener);
    for (const state of [...states.values()]) void closeState(state, []).catch(report);
  }
  function onDispose() { dispose(); }
  hostWindow.addEventListener("message", onMessage);
  hostWindow.addEventListener("pagehide", onDispose);
  hostWindow.addEventListener("atools-plugin-out", onDispose as EventListener);

  return {
    createBrowserWindow,
    dispose,
    getPendingCreateCount: () => pendingCreates,
    getPendingOperationCount: () => [...states.values()].reduce((total, state) => total + state.operations.length, 0),
  };
}
