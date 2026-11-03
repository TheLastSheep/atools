(function installCatalogJourneyProbe(token) {
  "use strict";

  const TOKEN = token;
  const QUERY = "ATools Catalog";
  const BASELINE_STABLE_MS = 1600;
  const BASELINE_TIMEOUT_MS = 9000;
  const EVENT_NAME = "atools://renderer-apps-changed";
  const TITLES = Object.freeze({
    initial: ["ATools Catalog Initial"],
    added: ["ATools Catalog Added", "ATools Catalog Initial"],
    removed: ["ATools Catalog Initial"],
    disposed: ["ATools Catalog Initial"],
    "post-dispose": ["ATools Catalog Initial"],
  });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const invoke = () => {
    const core = window.__TAURI__?.core;
    return typeof core?.invoke === "function" ? core.invoke.bind(core) : null;
  };
  const adapterSnapshot = () => {
    try {
      return window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.() ?? null;
    } catch (_) {
      return null;
    }
  };
  const integer = (value) => Number.isSafeInteger(value) && value >= 0 ? value : Number.MAX_SAFE_INTEGER;
  const eventSnapshot = (source) => {
    const valid = source && typeof source === "object" && !Array.isArray(source);
    return {
      subscribers: valid ? integer(source.subscribers) : Number.MAX_SAFE_INTEGER,
      listenerState: valid && ["idle", "registering", "listening", "failed", "disposed"].includes(source.listenerState)
        ? source.listenerState
        : "failed",
      deliveredEvents: valid ? integer(source.deliveredEvents) : Number.MAX_SAFE_INTEGER,
      registrationErrors: valid ? integer(source.registrationErrors) : Number.MAX_SAFE_INTEGER,
      callbackErrors: valid ? integer(source.callbackErrors) : Number.MAX_SAFE_INTEGER,
      registrationsPending: valid ? integer(source.registrationsPending) : Number.MAX_SAFE_INTEGER,
      cleanupPending: valid ? integer(source.cleanupPending) : Number.MAX_SAFE_INTEGER,
      cleanupErrors: valid ? integer(source.cleanupErrors) : Number.MAX_SAFE_INTEGER,
    };
  };
  const inputElement = () => document.querySelector("input.search-input");
  const listTitles = () => Array.from(
    document.querySelectorAll(".list-mode-results .list-item .item-title"),
    (element) => element.textContent?.trim() ?? "",
  ).sort();
  const exactTitles = (actual, expected) => actual.length === expected.length &&
    actual.every((title, index) => title === expected[index]);
  const selectedAdapterData = () => {
    const snapshot = adapterSnapshot();
    const nativeCalls = snapshot?.nativeCalls;
    const appCatalog = snapshot?.appCatalog;
    const appCatalogEvents = appCatalog?.eventSource;
    const settingsView = snapshot?.settingsView;
    const appListCalls = nativeCalls && Object.hasOwn(nativeCalls, "list_launcher_apps")
      ? integer(nativeCalls.list_launcher_apps)
      : Number.MAX_SAFE_INTEGER;
    return {
      snapshot,
      appListCalls,
      appCatalogEvents,
      settingsView,
    };
  };

  let nativeCatalogEvents = 0;
  let witnessUnlisten = null;
  let witnessStopped = false;
  let lastDom = null;
  let observeInFlight = false;

  async function installEventWitness() {
    const listen = window.__TAURI__?.event?.listen;
    if (typeof listen !== "function") return;
    try {
      witnessUnlisten = await listen(EVENT_NAME, () => {
        nativeCatalogEvents += 1;
      }, { target: { kind: "Webview", label: "main" } });
    } catch (_) {
      witnessUnlisten = null;
    }
  }

  function setSearchInput() {
    const input = inputElement();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (!input || typeof setter !== "function" || typeof InputEvent !== "function") return false;
    setter.call(input, QUERY);
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: QUERY,
    }));
    return input.value === QUERY;
  }

  async function waitUntil(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        if (predicate() === true) return true;
      } catch (_) {
        // The real Vue tree and adapter can be between reactive updates.
      }
      await delay(25);
    }
    return false;
  }

  async function waitForStableBaseline() {
    const deadline = Date.now() + BASELINE_TIMEOUT_MS;
    let stableSince = null;
    let previous = collectDom(null);
    while (Date.now() < deadline) {
      await delay(40);
      const current = collectDom(null);
      const stable = exactTitles(current.titles, TITLES.initial) &&
        current.appListCalls === previous.appListCalls &&
        current.catalogDeliveredEvents === previous.catalogDeliveredEvents &&
        current.nativeCatalogEvents === previous.nativeCatalogEvents &&
        current.pendingNativeCalls === 0 && !current.appReadPending;
      if (stable) {
        stableSince ??= Date.now();
        if (Date.now() - stableSince >= BASELINE_STABLE_MS) return true;
      } else {
        stableSince = null;
      }
      previous = current;
    }
    return false;
  }

  async function analyzeRowIcon(title) {
    let image = null;
    try {
      const row = Array.from(document.querySelectorAll(".list-mode-results .list-item"))
        .find((item) => item.querySelector(".item-title")?.textContent?.trim() === title);
      image = row?.querySelector("img") ?? null;
      if (!image) return { complete: false, width: 0, height: 0, analysisSucceeded: false };
      await Promise.race([image.decode(), delay(3000).then(() => { throw new Error("decode timeout"); })]);
      const url = image.currentSrc || image.src;
      if (!/^atools-app-icon:\/\/localhost\/[a-f0-9]{64}\.png$/.test(url)) {
        return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, analysisSucceeded: false };
      }
      const api = window.ztools;
      if (typeof api?.analyzeImage !== "function") {
        return { complete: image.complete, width: image.naturalWidth, height: image.naturalHeight, analysisSucceeded: false };
      }
      const result = await Promise.race([
        api.analyzeImage(url),
        delay(3000).then(() => { throw new Error("analysis timeout"); }),
      ]);
      const analysisSucceeded = result && typeof result === "object" &&
        Object.keys(result).length === 4 && typeof result.isSimpleIcon === "boolean" &&
        (result.mainColor === null || typeof result.mainColor === "string") &&
        typeof result.isDark === "boolean" && typeof result.needsAdaptation === "boolean";
      return {
        complete: image.complete,
        width: image.naturalWidth,
        height: image.naturalHeight,
        analysisSucceeded: analysisSucceeded === true,
      };
    } catch (_) {
      return {
        complete: image?.complete === true,
        width: Number.isInteger(image?.naturalWidth) ? image.naturalWidth : 0,
        height: Number.isInteger(image?.naturalHeight) ? image.naturalHeight : 0,
        analysisSucceeded: false,
      };
    }
  }

  function collectDom(icon) {
    const data = selectedAdapterData();
    const snapshot = data.snapshot;
    const source = (key) => eventSnapshot(snapshot?.[key]?.eventSource ?? snapshot?.[key]);
    const settings = data.settingsView;
    const hasSettings = settings && typeof settings === "object" && !Array.isArray(settings);
    const input = inputElement();
    const titleValues = listTitles();
    const appCatalogEvents = eventSnapshot(data.appCatalogEvents);
    return {
      inputFound: input !== null,
      inputValue: input ? String(input.value).slice(0, 64) : "",
      titles: titleValues.slice(0, 16),
      documentVisibility: typeof document.visibilityState === "string" ? document.visibilityState : "unknown",
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : true,
      appListCalls: data.appListCalls,
      catalogDeliveredEvents: appCatalogEvents.deliveredEvents,
      catalogSubscriberCount: appCatalogEvents.subscribers,
      pendingNativeCalls: snapshot ? integer(snapshot.outstandingNativeCalls) : Number.MAX_SAFE_INTEGER,
      appReadPending: snapshot?.appCatalog?.readPending === false ? false : true,
      disposed: snapshot?.disposed === true && snapshot?.appCatalog?.cachedApps === 0,
      icon,
      eventSources: {
        focusEvents: source("focusEvents"),
        appState: source("appState"),
        contextMenu: source("contextMenu"),
        appCatalog: appCatalogEvents,
      },
      settingsView: {
        listenerState: hasSettings && ["idle", "registering", "listening", "failed", "disposed"].includes(settings.listenerState)
          ? settings.listenerState
          : "failed",
        registrationErrors: hasSettings ? integer(settings.registrationErrors) : Number.MAX_SAFE_INTEGER,
        cleanupErrors: hasSettings ? integer(settings.cleanupErrors) : Number.MAX_SAFE_INTEGER,
      },
      nativeCatalogEvents: integer(nativeCatalogEvents),
      witnessStopped,
    };
  }

  async function initialize() {
    await installEventWitness();
    await waitUntil(() => {
      const input = inputElement();
      const appCatalog = selectedAdapterData().appCatalogEvents;
      return input !== null && appCatalog?.listenerState === "listening" &&
        integer(appCatalog.subscribers) >= 2 && selectedAdapterData().appListCalls > 0;
    }, 8000);
    setSearchInput();
    await waitUntil(() => exactTitles(listTitles(), TITLES.initial), 8000);
    if (!(await waitForStableBaseline())) return;
    const icon = await analyzeRowIcon(TITLES.initial[0]);
    const dom = collectDom(icon);
    lastDom = dom;
    const call = invoke();
    if (call) {
      try { await call("catalog_probe_ready", { token: TOKEN, dom }); } catch (_) {}
    }
  }

  async function settleForStage(stage) {
    const expected = TITLES[stage];
    const previous = lastDom;
    if (!expected || !previous) return;
    if (stage === "added" || stage === "removed") {
      await waitUntil(() => {
        const current = collectDom(null);
        return exactTitles(current.titles, expected) &&
          current.appListCalls > previous.appListCalls &&
          current.catalogDeliveredEvents > previous.catalogDeliveredEvents &&
          current.nativeCatalogEvents > previous.nativeCatalogEvents;
      }, 9000);
      return;
    }
    if (stage === "disposed") {
      try { window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.dispose?.(); } catch (_) {}
      await waitUntil(() => {
        const current = collectDom(null);
        const sources = Object.values(current.eventSources);
        const listenerReady = sources.length === 4 && sources.every((source) =>
          source.listenerState === "disposed" && source.subscribers === 0 &&
          source.registrationsPending === 0 && source.cleanupPending === 0 &&
          source.registrationErrors === 0 && source.callbackErrors === 0 && source.cleanupErrors === 0);
        return current.disposed && listenerReady && current.settingsView.listenerState === "disposed" &&
          current.settingsView.registrationErrors === 0 && current.settingsView.cleanupErrors === 0 &&
          current.pendingNativeCalls === 0 && !current.appReadPending;
      }, 4000);
      return;
    }
    if (stage === "post-dispose") {
      await waitUntil(() => nativeCatalogEvents > previous.nativeCatalogEvents, 9000);
      if (typeof witnessUnlisten === "function") {
        try {
          await witnessUnlisten();
          witnessStopped = true;
        } catch (_) {
          witnessStopped = false;
        }
        witnessUnlisten = null;
      }
    }
  }

  async function observe(stage) {
    if (observeInFlight || !TITLES[stage]) return;
    observeInFlight = true;
    try {
      await settleForStage(stage);
      const icon = stage === "added"
        ? await analyzeRowIcon("ATools Catalog Added")
        : null;
      const dom = collectDom(icon);
      const call = invoke();
      if (call) {
        await call("catalog_probe_observe", { token: TOKEN, stage, dom });
        lastDom = dom;
      }
    } catch (_) {
      // The Native receipt remains authoritative and will fail its bounded wait.
    } finally {
      observeInFlight = false;
    }
  }

  async function staleLaunch(target) {
    const call = invoke();
    let rejected = false;
    if (call && target && typeof target.path === "string" && typeof target.name === "string") {
      try {
        await call("launch_renderer_app", { target });
      } catch (error) {
        const message = error && typeof error === "object" && typeof error.message === "string"
          ? error.message
          : String(error);
        rejected = message === "Application is not in the native launcher catalog";
      }
    }
    if (call) {
      try { await call("catalog_probe_stale_launch", { token: TOKEN, rejected }); } catch (_) {}
    }
  }

  if (window.__ATOOLS_RENDERER_CATALOG_PROBE__) return;
  window.__ATOOLS_RENDERER_CATALOG_PROBE__ = Object.freeze({ observe, staleLaunch });
  void initialize();
})("__ATOOLS_RENDERER_CATALOG_TOKEN__");
