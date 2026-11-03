(async function rendererDesktopSmokeProbe(token, autoClear) {
  "use strict";

  const QUERY = "ATools native focus fixture";
  const TOKEN = token;
  const AUTO_CLEAR = autoClear;
  const STAGES = new Set([
    "shown",
    "prepared",
    "hidden",
    "reshown",
    "prepared-blur",
    "blur-hidden",
    "blur-return",
    "disposed",
    "disposed-return",
  ]);

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const inputElement = () => document.querySelector("input.search-input");
  const hostAdapter = () => window.__ATOOLS_ZTOOLS_HOST_ADAPTER__;

  function nativeInvoke() {
    const invoke = window.__TAURI__?.core?.invoke;
    return typeof invoke === "function" ? invoke.bind(window.__TAURI__.core) : undefined;
  }

  function summarizeEventSource(source) {
    if (!source || typeof source !== "object") return null;
    return {
      subscribers: Number.isInteger(source.subscribers) ? source.subscribers : null,
      listenerState: typeof source.listenerState === "string" ? source.listenerState : null,
      deliveredEvents: Number.isInteger(source.deliveredEvents) ? source.deliveredEvents : null,
      registrationErrors: Number.isInteger(source.registrationErrors) ? source.registrationErrors : null,
      callbackErrors: Number.isInteger(source.callbackErrors) ? source.callbackErrors : null,
      registrationsPending: Number.isInteger(source.registrationsPending) ? source.registrationsPending : null,
      cleanupPending: Number.isInteger(source.cleanupPending) ? source.cleanupPending : null,
      cleanupErrors: Number.isInteger(source.cleanupErrors) ? source.cleanupErrors : null,
    };
  }

  function summarizeAdapter() {
    const adapter = hostAdapter();
    if (!adapter || typeof adapter.snapshot !== "function") return null;
    try {
      const snapshot = adapter.snapshot();
      const appState = snapshot?.appState;
      const contextMenu = snapshot?.contextMenu;
      const nativeCalls = snapshot?.nativeCalls && typeof snapshot.nativeCalls === "object"
        ? { ...snapshot.nativeCalls }
        : {};
      return {
        disposed: snapshot?.disposed === true,
        outstandingNativeCalls: Number.isInteger(snapshot?.outstandingNativeCalls)
          ? snapshot.outstandingNativeCalls
          : null,
        nativeCalls,
        focusEvents: summarizeEventSource(snapshot?.focusEvents),
        appCatalog: snapshot?.appCatalog && typeof snapshot.appCatalog === "object"
          ? {
              cachedApps: Number.isInteger(snapshot.appCatalog.cachedApps) ? snapshot.appCatalog.cachedApps : null,
              readPending: typeof snapshot.appCatalog.readPending === "boolean" ? snapshot.appCatalog.readPending : null,
              eventSource: summarizeEventSource(snapshot.appCatalog.eventSource),
            }
          : null,
        settingsSnapshot: snapshot?.settingsSnapshot && typeof snapshot.settingsSnapshot === "object"
          ? {
              cached: Number.isInteger(snapshot.settingsSnapshot.cached) ? snapshot.settingsSnapshot.cached : null,
              inFlight: snapshot.settingsSnapshot.inFlight === true,
              requests: Number.isInteger(snapshot.settingsSnapshot.requests) ? snapshot.settingsSnapshot.requests : null,
              failures: Number.isInteger(snapshot.settingsSnapshot.failures) ? snapshot.settingsSnapshot.failures : null,
              disposed: snapshot.settingsSnapshot.disposed === true,
            }
          : null,
        appState: appState && typeof appState === "object"
          ? {
              historySubscribers: Number.isInteger(appState.historySubscribers) ? appState.historySubscribers : null,
              pinnedSubscribers: Number.isInteger(appState.pinnedSubscribers) ? appState.pinnedSubscribers : null,
              queuedMutations: Number.isInteger(appState.queuedMutations) ? appState.queuedMutations : null,
              disposed: appState.disposed === true,
              eventSource: summarizeEventSource(appState.eventSource),
            }
          : null,
        contextMenu: contextMenu && typeof contextMenu === "object"
          ? {
              subscribers: Number.isInteger(contextMenu.subscribers) ? contextMenu.subscribers : null,
              disposed: contextMenu.disposed === true,
              eventSource: summarizeEventSource(contextMenu.eventSource),
            }
          : null,
      };
    } catch (_) {
      return null;
    }
  }

  function summarizeDisposeCounters(adapter) {
    const entries = adapter?.nativeCalls && typeof adapter.nativeCalls === "object"
      ? Object.entries(adapter.nativeCalls)
      : null;
    if (!entries || entries.length === 0 || entries.length > 32) return null;
    const nativeCalls = {};
    let totalNativeCalls = 0;
    for (const [name, count] of entries) {
      if (typeof name !== "string" || name.length === 0 || name.length > 128 ||
          !Number.isInteger(count) || count < 0 || count > 128) return null;
      totalNativeCalls += count;
      if (totalNativeCalls > 128) return null;
      nativeCalls[name] = count;
    }
    const eventSourceDeliveredEvents = {
      focusEvents: adapter.focusEvents?.deliveredEvents,
      appState: adapter.appState?.eventSource?.deliveredEvents,
      contextMenu: adapter.contextMenu?.eventSource?.deliveredEvents,
      appCatalog: adapter.appCatalog?.eventSource?.deliveredEvents,
    };
    if (Object.values(eventSourceDeliveredEvents).some((count) =>
      !Number.isInteger(count) || count < 0 || count > 128
    )) return null;
    return { nativeCalls, eventSourceDeliveredEvents };
  }

  function readinessEvidence() {
    const input = inputElement();
    const adapter = hostAdapter();
    const snapshot = summarizeAdapter();
    const sources = [snapshot?.focusEvents, snapshot?.appState?.eventSource, snapshot?.contextMenu?.eventSource, snapshot?.appCatalog?.eventSource];
    const nativeListenersListening = sources.every((source) =>
      source?.listenerState === "listening" && source.subscribers > 0 &&
      source.registrationsPending === 0 && source.registrationErrors === 0 && source.cleanupErrors === 0
    );
    const settingsCacheCount = snapshot?.settingsSnapshot?.cached ?? null;
    const nativeInvocationCount = Object.values(snapshot?.nativeCalls ?? {}).reduce(
      (total, count) => total + (Number.isInteger(count) && count >= 0 ? count : 0),
      0,
    );
    const appCatalogReadCount = snapshot?.nativeCalls?.list_launcher_apps ?? 0;
    const appStateSubscriberCounts = [
      snapshot?.appState?.historySubscribers ?? null,
      snapshot?.appState?.pinnedSubscribers ?? null,
    ];
    const contextMenuSubscriberCount = snapshot?.contextMenu?.subscribers ?? null;
    const ready = Boolean(
      input && adapter && nativeListenersListening && settingsCacheCount === 14 &&
      snapshot?.settingsSnapshot?.inFlight === false && snapshot?.appCatalog?.readPending === false &&
      Number.isInteger(appCatalogReadCount) && appCatalogReadCount > 0 && appCatalogReadCount <= nativeInvocationCount && nativeInvocationCount > 0 &&
      nativeInvocationCount <= 128 && snapshot?.outstandingNativeCalls === 0 &&
      appStateSubscriberCounts.every((count) => Number.isInteger(count) && count > 0) &&
      Number.isInteger(contextMenuSubscriberCount) && contextMenuSubscriberCount > 0
    );
    return {
      schemaVersion: 1,
      ready,
      inputFound: Boolean(input),
      adapterPresent: Boolean(adapter && typeof adapter.snapshot === "function"),
      nativeListenersListening,
      eventSourceSubscribers: sources.map((source) => source?.subscribers ?? null),
      appStateSubscriberCounts,
      contextMenuSubscriberCount,
      settingsCacheCount,
      nativeInvocationCount,
      appCatalogReadCount,
      outstandingNativeCalls: snapshot?.outstandingNativeCalls ?? null,
    };
  }

  function currentDom(stage, stageReady, stageWaitMs, disposeError) {
    const input = inputElement();
    const adapter = summarizeAdapter();
    const selectionStart = input && Number.isInteger(input.selectionStart) ? input.selectionStart : null;
    const selectionEnd = input && Number.isInteger(input.selectionEnd) ? input.selectionEnd : null;
    return {
      schemaVersion: 1,
      stage,
      stageReady,
      stageWaitMs,
      inputFound: Boolean(input),
      documentVisibility: document.visibilityState,
      documentHasFocus: document.hasFocus(),
      inputFocused: Boolean(input && document.activeElement === input),
      inputValue: input ? String(input.value).slice(0, 65) : null,
      selectionStart,
      selectionEnd,
      adapter,
      preDisposeCounters,
      disposeError,
    };
  }

  function returnedStateReady(input) {
    if (!input || !document.hasFocus() || document.visibilityState !== "visible") return false;
    if (AUTO_CLEAR === "immediately") return input.value === "";
    return input.value === QUERY && input.selectionStart === 0 && input.selectionEnd === QUERY.length;
  }

  function stageReady(stage) {
    const input = inputElement();
    const adapter = summarizeAdapter();
    if (!input) return false;
    if (stage === "hidden" || stage === "blur-hidden") {
      return document.visibilityState === "hidden" && !document.hasFocus();
    }
    if (stage === "reshown" || stage === "blur-return") {
      return returnedStateReady(input) && document.activeElement === input;
    }
    if (stage === "prepared" || stage === "prepared-blur") return input.value === QUERY;
    if (stage === "disposed") {
      const sources = [adapter?.focusEvents, adapter?.appState?.eventSource, adapter?.contextMenu?.eventSource, adapter?.appCatalog?.eventSource];
      return adapter?.disposed === true && adapter?.outstandingNativeCalls === 0 &&
        preDisposeCounters !== null &&
        adapter?.appCatalog?.cachedApps === 0 && adapter?.appCatalog?.readPending === false &&
        sources.length === 4 && sources.every((source) =>
          source?.listenerState === "disposed" && source.subscribers === 0 &&
          source.registrationsPending === 0 && source.cleanupPending === 0 && source.cleanupErrors === 0 &&
          source.registrationErrors === 0 && source.callbackErrors === 0
        ) && disposeError === null;
    }
    if (stage === "disposed-return") {
      return document.visibilityState === "visible" && document.hasFocus() &&
        adapter?.disposed === true && preDisposeCounters !== null;
    }
    return document.visibilityState === "visible";
  }

  async function waitForStage(stage, disposeError) {
    const started = Date.now();
    const deadline = started + 2500;
    let ready = stageReady(stage);
    while (!ready && Date.now() < deadline) {
      await delay(30);
      ready = stageReady(stage);
    }
    return currentDom(stage, ready, Date.now() - started, disposeError);
  }

  let disposeError = null;
  let preDisposeCounters = null;
  const probe = Object.freeze({
    async setFixtureQuery() {
      const input = inputElement();
      if (!input) throw new Error("search input missing");
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      if (!descriptor || typeof descriptor.set !== "function") throw new Error("native input value setter missing");
      descriptor.set.call(input, QUERY);
      const event = typeof InputEvent === "function"
        ? new InputEvent("input", { bubbles: true, inputType: "insertText", data: QUERY })
        : new Event("input", { bubbles: true });
      input.dispatchEvent(event);
      await Promise.resolve();
      await delay(0);
    },
    async capture(stage) {
      if (!STAGES.has(stage)) return;
      if (stage === "disposed") {
        const adapter = hostAdapter();
        preDisposeCounters = summarizeDisposeCounters(summarizeAdapter());
        try {
          if (!preDisposeCounters) disposeError = "adapter-pre-dispose-counter-snapshot-missing";
          if (adapter && typeof adapter.dispose === "function") adapter.dispose();
          else disposeError = "adapter-dispose-unavailable";
        } catch (_) {
          disposeError = "adapter-dispose-threw";
        }
      }
      const dom = await waitForStage(stage, disposeError);
      const invoke = nativeInvoke();
      if (invoke) {
        try {
          await invoke("renderer_probe_observe", { token: TOKEN, stage, dom });
        } catch (_) {
          // Rust records protocol failures; never retry a stage or synthesize an observation.
        }
      }
    },
  });

  Object.defineProperty(window, "__ATOOLS_RENDERER_DESKTOP_SMOKE__", {
    value: probe,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  const invoke = nativeInvoke();
  if (!invoke) return;
  const deadline = Date.now() + 12000;
  let evidence = readinessEvidence();
  while (!evidence.ready && Date.now() < deadline) {
    await delay(50);
    evidence = readinessEvidence();
  }
  try {
    await invoke("renderer_probe_ready", { token: TOKEN, evidence });
  } catch (_) {
    // The app watchdog owns timeout and report creation.
  }
})("__ATOOLS_RENDERER_SMOKE_TOKEN__", "__ATOOLS_RENDERER_SMOKE_AUTO_CLEAR__");
