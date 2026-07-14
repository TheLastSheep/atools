export const DESKTOP_BROWSER_WINDOW_ISOLATION_CHECK_IDS = [
  "desktop-browser-window-created",
  "desktop-browser-window-child-origin-opaque",
  "desktop-browser-window-self-tauri-unavailable",
  "desktop-browser-window-parent-tauri-unavailable",
  "desktop-browser-window-parent-document-blocked",
  "desktop-browser-window-send-to-parent",
  "desktop-browser-window-execute-javascript",
  "desktop-browser-window-ipc-roundtrip",
  "desktop-browser-window-cleanup",
] as const;

export const DESKTOP_BROWSER_WINDOW_PROBE_CONTRACT_FAILED_ID =
  "desktop-browser-window-probe-contract-invalid";

export function desktopBrowserWindowSmokeQueueEnabled(
  expectedSamples: unknown,
  onRender: unknown,
) {
  return Number.isSafeInteger(expectedSamples)
    && Number(expectedSamples) > 0
    && typeof onRender === "function";
}

export function normalizeDesktopBrowserWindowProbeContract(value: unknown) {
  const reported = Array.isArray(value);
  const probes = reported ? value : [];
  const normalized = probes.map((probe) => {
    if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
      return { id: "unknown", passed: false };
    }
    const record = probe as Record<string, unknown>;
    return {
      id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : "unknown",
      passed: record.passed === true,
    };
  });
  const expectedIds = DESKTOP_BROWSER_WINDOW_ISOLATION_CHECK_IDS as readonly string[];
  const ids = normalized.map((probe) => probe.id);
  const contractValid = reported
    && ids.length === expectedIds.length
    && new Set(ids).size === expectedIds.length
    && ids.every((id, index) => id === expectedIds[index]);
  const failedIds = normalized
    .filter((probe) => !probe.passed)
    .map((probe) => probe.id);
  if (!contractValid) failedIds.push(DESKTOP_BROWSER_WINDOW_PROBE_CONTRACT_FAILED_ID);
  return {
    reported,
    passed: contractValid && failedIds.length === 0,
    checks: normalized.length,
    passedChecks: normalized.filter((probe) => probe.passed).length,
    failedIds: [...new Set(failedIds)],
  };
}

const DESKTOP_BROWSER_WINDOW_ISOLATION_CANARY_KEY =
  "__atools_browser_window_isolation_probe__";
const DESKTOP_BROWSER_WINDOW_ISOLATION_TIMEOUT_MS = 7_000;

type DesktopBrowserWindowIsolationProbeSourceOptions = {
  mainUrl: string;
  sampleIndex: number;
  timeoutMs?: number;
};

type DesktopBrowserWindowIsolationRuntimeConfig = {
  mainUrl: string;
  sampleIndex: number;
  timeoutMs: number;
  checkIds: string[];
  canaryKey: string;
  sendChannel: string;
  ipcChannel: string;
  ipcPongChannel: string;
};

/**
 * This function is serialized into the opaque main plugin iframe. Keep every
 * helper and constant local so its toString() output has no module closure.
 */
function desktopBrowserWindowIsolationProbeRuntime(
  config: DesktopBrowserWindowIsolationRuntimeConfig,
) {
  const mainRuntimeWindow = window as typeof window & {
    utools?: {
      createBrowserWindow?: (
        url: string,
        options: { show: boolean },
        callback: (channel: unknown, payload: unknown) => void,
      ) => Promise<unknown> | unknown;
    };
  };
  const expected = config.sampleIndex === 0;
  const state = {
    created: false,
    childOriginOpaque: false,
    selfTauriUnavailable: false,
    parentTauriUnavailable: false,
    parentDocumentBlocked: false,
    sendToParentChecked: false,
    executeJavascriptChecked: false,
    ipcRoundtripChecked: false,
    cleanupChecked: false,
  };
  let browserWindow: {
    id?: string;
    type?: string;
    windowType?: string;
    webContents?: {
      executeJavaScript?: (code: string) => Promise<unknown> | unknown;
      send?: (channel: string, payload: unknown) => Promise<unknown> | unknown;
    };
    close?: () => Promise<unknown> | unknown;
    isDestroyed?: () => boolean;
  } | null = null;
  let closePromise: Promise<boolean> | null = null;
  let finishing = false;
  let failureDetail = "";

  function probeResult(id: string, passed: boolean) {
    return {
      id,
      passed: passed === true,
      detail: passed === true ? "" : failureDetail,
    };
  }

  function result() {
    if (!expected) {
      return {
        expected: false,
        reported: false,
        probes: [],
        ...state,
      };
    }
    const values = [
      state.created,
      state.childOriginOpaque,
      state.selfTauriUnavailable,
      state.parentTauriUnavailable,
      state.parentDocumentBlocked,
      state.sendToParentChecked,
      state.executeJavascriptChecked,
      state.ipcRoundtripChecked,
      state.cleanupChecked,
    ];
    return {
      expected: true,
      reported: true,
      probes: config.checkIds.map((id, index) => probeResult(id, values[index] === true)),
      ...state,
    };
  }

  if (!expected) return Promise.resolve(result());

  function withTimeout<T>(promise: Promise<T> | T, timeoutMs: number, label: string) {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      Promise.resolve(promise).then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      }, (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  let resolveSendToParent!: (passed: boolean) => void;
  let resolveIpcRoundtrip!: (passed: boolean) => void;
  const sendToParentPromise = new Promise<boolean>((resolve) => {
    resolveSendToParent = resolve;
  });
  const ipcRoundtripPromise = new Promise<boolean>((resolve) => {
    resolveIpcRoundtrip = resolve;
  });

  function handleChildMessage(channel: unknown, payload: unknown) {
    const record = payload && typeof payload === "object"
      ? payload as Record<string, unknown>
      : {};
    if (channel === config.sendChannel) {
      resolveSendToParent(record.ok === true && record.origin === "null");
    }
    if (channel === config.ipcPongChannel) {
      resolveIpcRoundtrip(record.ok === true && record.value === 42);
    }
  }

  function closeBrowserWindow() {
    if (!browserWindow) return Promise.resolve(false);
    if (closePromise) return closePromise;
    const current = browserWindow;
    const closeTimeoutMs = Math.max(10, Math.min(1_500, config.timeoutMs));
    const closeOperation = Promise.resolve().then(() => {
        if (typeof current.close !== "function") return null;
        return current.close();
      });
    closePromise = withTimeout(
      closeOperation,
      closeTimeoutMs,
      "desktop BrowserWindow cleanup",
    )
      .then((closeResult) => {
        const record = closeResult && typeof closeResult === "object"
          ? closeResult as Record<string, unknown>
          : {};
        return record.closed === true
          && typeof current.isDestroyed === "function"
          && current.isDestroyed() === true;
      })
      .catch(() => false);
    return closePromise;
  }

  function childBrowserWindowRuntime(childConfig: {
    canaryKey: string;
    sendChannel: string;
    ipcChannel: string;
    ipcPongChannel: string;
  }) {
    const childRuntimeWindow = window as typeof window & {
      require?: (name: string) => {
        ipcRenderer?: {
          once?: (channel: string, listener: (_event: unknown, payload: unknown) => void) => unknown;
        };
      };
      utools?: {
        sendToParent?: (channel: string, payload: unknown) => Promise<unknown> | unknown;
      };
    };
    function rawTauriInvoker(targetProvider: () => unknown) {
      try {
        const target = targetProvider() as Record<string, unknown> | null;
        if (!target) return null;
        const internals = target.__TAURI_INTERNALS__ as Record<string, unknown> | undefined;
        if (internals && typeof internals.invoke === "function") {
          return { receiver: internals, invoke: internals.invoke as (...args: unknown[]) => unknown };
        }
        const tauri = target.__TAURI__ as Record<string, unknown> | undefined;
        const core = tauri?.core as Record<string, unknown> | undefined;
        if (core && typeof core.invoke === "function") {
          return { receiver: core, invoke: core.invoke as (...args: unknown[]) => unknown };
        }
        if (tauri && typeof tauri.invoke === "function") {
          return { receiver: tauri, invoke: tauri.invoke as (...args: unknown[]) => unknown };
        }
      } catch {
        return null;
      }
      return null;
    }

    function rawTauriUnavailable(targetProvider: () => unknown) {
      const candidate = rawTauriInvoker(targetProvider);
      if (!candidate) return Promise.resolve(true);
      try {
        return Promise.resolve(candidate.invoke.call(
          candidate.receiver,
          "get_setting",
          { key: childConfig.canaryKey },
        )).then(() => false, () => false);
      } catch {
        return Promise.resolve(false);
      }
    }

    let parentDocumentBlocked = false;
    try {
      const parentDocument = window.parent.document;
      void parentDocument.documentElement;
    } catch {
      parentDocumentBlocked = true;
    }

    let ipcRegistered = false;
    try {
      const ipcRenderer = typeof childRuntimeWindow.require === "function"
        ? childRuntimeWindow.require("electron").ipcRenderer
        : null;
      if (ipcRenderer && typeof ipcRenderer.once === "function") {
        ipcRenderer.once(childConfig.ipcChannel, (_event: unknown, payload: unknown) => {
          const record = payload && typeof payload === "object"
            ? payload as Record<string, unknown>
            : {};
          const ok = record.probe === "desktop-browser-window-ipc" && record.value === 42;
          Promise.resolve(childRuntimeWindow.utools?.sendToParent?.(childConfig.ipcPongChannel, {
            ok,
            value: record.value,
          })).catch(() => undefined);
        });
        ipcRegistered = true;
      }
    } catch {
      ipcRegistered = false;
    }

    return Promise.all([
      rawTauriUnavailable(() => window),
      rawTauriUnavailable(() => window.parent),
    ]).then(([selfTauriUnavailable, parentTauriUnavailable]) => {
      const childResult = {
        childOriginOpaque: window.location.origin === "null",
        selfTauriUnavailable,
        parentTauriUnavailable,
        parentDocumentBlocked,
        ipcRegistered,
      };
      if (!childRuntimeWindow.utools || typeof childRuntimeWindow.utools.sendToParent !== "function") {
        return childResult;
      }
      return Promise.resolve(childRuntimeWindow.utools.sendToParent(childConfig.sendChannel, {
        ok: true,
        origin: window.location.origin,
      })).then(() => childResult);
    });
  }

  const childCode = `(${childBrowserWindowRuntime.toString()})(${JSON.stringify({
    canaryKey: config.canaryKey,
    sendChannel: config.sendChannel,
    ipcChannel: config.ipcChannel,
    ipcPongChannel: config.ipcPongChannel,
  })})`;

  const run = Promise.resolve()
    .then(() => {
      if (!mainRuntimeWindow.utools || typeof mainRuntimeWindow.utools.createBrowserWindow !== "function") {
        throw new Error("utools.createBrowserWindow is unavailable");
      }
      return mainRuntimeWindow.utools.createBrowserWindow(
        config.mainUrl,
        { show: false },
        handleChildMessage,
      );
    })
    .then((createdWindow) => {
      browserWindow = createdWindow as typeof browserWindow;
      state.created = Boolean(
        browserWindow
        && browserWindow.id
        && browserWindow.type === "browserWindow"
        && browserWindow.windowType === "browserWindow"
        && browserWindow.webContents
        && typeof browserWindow.webContents.executeJavaScript === "function"
        && typeof browserWindow.webContents.send === "function"
        && typeof browserWindow.close === "function",
      );
      if (finishing) {
        return closeBrowserWindow().then(() => {
          throw new Error("desktop BrowserWindow isolation probe already finished");
        });
      }
      if (!state.created || !browserWindow?.webContents?.executeJavaScript) {
        throw new Error("createBrowserWindow returned an incomplete handle");
      }
      return browserWindow.webContents.executeJavaScript(childCode);
    })
    .then((childResult) => {
      const record = childResult && typeof childResult === "object"
        ? childResult as Record<string, unknown>
        : {};
      state.childOriginOpaque = record.childOriginOpaque === true;
      state.selfTauriUnavailable = record.selfTauriUnavailable === true;
      state.parentTauriUnavailable = record.parentTauriUnavailable === true;
      state.parentDocumentBlocked = record.parentDocumentBlocked === true;
      if (record.ipcRegistered !== true) {
        throw new Error("child ipcRenderer.once registration failed");
      }
      return browserWindow?.webContents?.executeJavaScript?.("40 + 2");
    })
    .then((answer) => {
      state.executeJavascriptChecked = answer === 42;
      return sendToParentPromise;
    })
    .then((sendToParentChecked) => {
      state.sendToParentChecked = sendToParentChecked === true;
      if (!browserWindow?.webContents?.send) {
        throw new Error("BrowserWindow webContents.send is unavailable");
      }
      return browserWindow.webContents.send(config.ipcChannel, {
        probe: "desktop-browser-window-ipc",
        value: 42,
      });
    })
    .then(() => ipcRoundtripPromise)
    .then((ipcRoundtripChecked) => {
      state.ipcRoundtripChecked = ipcRoundtripChecked === true;
    });

  return withTimeout(run, config.timeoutMs, "desktop BrowserWindow isolation probe")
    .catch((error) => {
      failureDetail = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      finishing = true;
      return closeBrowserWindow().then((cleanupChecked) => {
        state.cleanupChecked = cleanupChecked === true;
      });
    })
    .then(result);
}

export function desktopBrowserWindowIsolationProbeSource(
  options: DesktopBrowserWindowIsolationProbeSourceOptions,
) {
  const sampleIndex = Number.isSafeInteger(options.sampleIndex) && options.sampleIndex >= 0
    ? options.sampleIndex
    : 0;
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.max(10, Math.round(requestedTimeout))
    : DESKTOP_BROWSER_WINDOW_ISOLATION_TIMEOUT_MS;
  const config: DesktopBrowserWindowIsolationRuntimeConfig = {
    mainUrl: String(options.mainUrl || "index.html"),
    sampleIndex,
    timeoutMs,
    checkIds: [...DESKTOP_BROWSER_WINDOW_ISOLATION_CHECK_IDS],
    canaryKey: DESKTOP_BROWSER_WINDOW_ISOLATION_CANARY_KEY,
    sendChannel: "atools:desktop-smoke:browser-window-send-to-parent",
    ipcChannel: "atools:desktop-smoke:ping",
    ipcPongChannel: "atools:desktop-smoke:pong",
  };
  return `(${desktopBrowserWindowIsolationProbeRuntime.toString()})(${JSON.stringify(config)})`
    .replace(/<\/script/gi, "<\\/script");
}
