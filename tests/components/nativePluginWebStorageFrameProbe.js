(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_PANEL_TOKEN__", events = [];
  const errors = [];
  window.addEventListener("error", event => { if (errors.length < 8) errors.push(String(event.error?.name || "Error")); });
  window.addEventListener("unhandledrejection", event => { if (errors.length < 8) errors.push(String(event.reason?.name || "Error")); });
  window.addEventListener("storage", event => {
    if (events.length < 16) events.push({ key: event.key, oldValue: event.oldValue, newValue: event.newValue,
      urlMatches: event.url === location.href, storageAreaMatches: event.storageArea === window.localStorage });
  });
  const state = () => ({ opaque: location.origin === "null", noTauri: !("__TAURI_INTERNALS__" in window),
    ready: typeof window.__AToolsRunStorageFixture === "function" || typeof window.__AToolsStorageB === "object",
    eventCount: events.length, errors: errors.length });
  const responseCache = new Map();
  window.addEventListener("message", async event => {
    const message = event.data;
    if (event.source !== window.parent || message?.kind !== "atools-web-storage-probe" || message.token !== token
      || typeof message.id !== "string" || responseCache.has(message.id)) return;
    responseCache.set(message.id, true);
    let result = {}, error = "";
    try {
      switch (message.operation) {
        case "state": break;
        case "theme-ui": result = window.__AToolsRunStorageFixture(); break;
        case "seed":
          localStorage.setItem("event-probe", "old");
          localStorage.setItem("namespace-check", "A");
          result = { seeded: localStorage.getItem("event-probe") === "old" }; break;
        case "writer-update":
          localStorage.setItem("event-probe", "next");
          result = { selfEventCount: events.length }; break;
        case "same-value": {
          const before = events.length;
          localStorage.setItem("event-probe", "next");
          result = { selfEventCount: events.length - before }; break;
        }
        case "event-peek": {
          const index = events.findIndex(value => value.key === "event-probe"
            && value.oldValue === "old" && value.newValue === "next");
          const value = index < 0 ? null : events[index];
          result = { present: !!value, keyMatches: value?.key === "event-probe", oldMatches: value?.oldValue === "old",
            newMatches: value?.newValue === "next", urlMatches: value?.urlMatches === true,
            storageAreaMatches: value?.storageAreaMatches === true }; break;
        }
        case "event-consume": {
          const index = events.findIndex(value => value.key === "event-probe"
            && value.oldValue === "old" && value.newValue === "next");
          if (index >= 0) events.splice(index, 1);
          result = { consumed: index >= 0 }; break;
        }
        case "event-count": {
          result = { count: events.length, targetCount: events.filter(value => value.key === "event-probe"
            && value.oldValue === "old" && value.newValue === "next").length }; break;
        }
        case "drain-events": { const count = events.length; events.length = 0; result = { drained: true, count }; break; }
        case "namespace": {
          const local = localStorage.getItem("namespace-check");
          const db = window.utools.dbStorage.getItem("namespace-check");
          window.utools.dbStorage.setItem("namespace-check", "db-only");
          result = { localMatches: local === (message.expected === "A" ? "A" : null),
            localStillMatches: localStorage.getItem("namespace-check") === local,
            dbSeparated: localStorage.getItem("namespace-check") !== window.utools.dbStorage.getItem("namespace-check") }; break;
        }
        case "utf16": {
          const key = "utf16-key-\ud800", value = "utf16-value-\udfff";
          localStorage.setItem(key, value);
          result = { roundtrip: localStorage.getItem(key) === value }; break;
        }
        case "quota": {
          localStorage.setItem("quota-probe", "old");
          let name = "";
          try { localStorage.setItem("quota-probe", "x".repeat(70 * 1024)); } catch (failure) { name = String(failure?.name || ""); }
          result = { quota: name === "QuotaExceededError", oldPreserved: localStorage.getItem("quota-probe") === "old" }; break;
        }
        case "persist": result = { theme: localStorage.getItem("theme_preference") === "dark",
          sidebar: localStorage.getItem("sidebarCollapsed") === "true", namespace: localStorage.getItem("namespace-check") === "A" }; break;
        case "restore-classes": {
          const theme = new window.__AToolsThemeManager();
          const manager = new window.__AToolsUIManager({});
          manager.initSidebarState();
          result = { themeApplied: document.documentElement.dataset.theme === "dark",
            themeRadioChecked: document.querySelector('input[name="theme"][value="dark"]').checked,
            sidebarRestored: document.querySelector(".sidebar").classList.contains("collapsed"),
            iconRestored: document.getElementById("collapseIcon").className === "mdi mdi-menu-right",
            themeInstance: theme instanceof window.__AToolsThemeManager, uiInstance: manager instanceof window.__AToolsUIManager };
          break;
        }
        case "measure-128": {
          const prefix = "synthetic-perf-", count = 128;
          for (let index = 0; index < count; index++) localStorage.setItem(prefix + index, "v");
          const bridge = window.__atoolsPluginData?.webStorage;
          if (!bridge || typeof bridge.entries !== "function") throw Error("MissingStorageBridge");
          let entriesCalls = 0;
          const original = bridge.entries;
          bridge.entries = function (...args) { entriesCalls++; return original.apply(this, args); };
          const start = performance.now();
          let enumerated = 0;
          try { enumerated = Object.keys(localStorage).filter(key => key.startsWith(prefix)).length; }
          finally { bridge.entries = original; }
          result = { syntheticKeys: count, enumeratedSyntheticKeys: enumerated, entriesCalls,
            elapsedMs: Math.max(0, performance.now() - start) };
          break;
        }
        case "write-b": window.__AToolsStorageB.write(); result = { wrote: true }; break;
        default: throw Error("UnknownFixtureOperation");
      }
    } catch (failure) { error = String(failure?.name || "FixtureOperationError"); }
    window.parent.postMessage({ kind: "atools-web-storage-result", token, id: message.id, state: state(), result, error }, "*");
  });
})();
