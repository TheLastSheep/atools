(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_COMMAND_ALIASES__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const WAIT_MS = 8000;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  async function send(operation, evidence, probeId) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return false;
    try {
      await invoke("settings_input_probe", { token, operation, probeId, evidence });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function waitFor(predicate, timeoutMs = WAIT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    return Boolean(predicate());
  }

  function exactText(element) {
    return element?.textContent?.trim() ?? "";
  }

  function mainSearchViewReady() {
    return document.querySelector(
      ".app-container:not(.app-container__plugin) .scrollable-content",
    ) !== null && document.querySelector(".plugin-placeholder") === null;
  }

  function searchInput() {
    if (!mainSearchViewReady()) return null;
    const inputs = Array.from(document.querySelectorAll(
      ".app-container:not(.app-container__plugin) input.search-input",
    ));
    return inputs.length === 1 ? inputs[0] : null;
  }

  function commandDataStore() {
    const root = document.getElementById("app");
    if (!root || document.querySelectorAll("#app").length !== 1) return null;
    const provides = root.__vue_app__?._context?.provides;
    if (!provides || typeof provides !== "object") return null;
    try {
      const candidates = Reflect.ownKeys(provides)
        .map((key) => provides[key])
        .filter((value) => value !== null && typeof value === "object" &&
          value._s instanceof Map && value._s.has("commandData"));
      if (candidates.length !== 1) return null;
      const store = candidates[0]._s.get("commandData");
      return store?.$id === "commandData" ? store : null;
    } catch (_) {
      return null;
    }
  }

  function storeTargetCount(store, query, name, path) {
    try {
      if (typeof store?.search !== "function") return null;
      const result = store.search(query);
      if (!Array.isArray(result?.bestMatches)) return null;
      const matches = result.bestMatches.filter((item) =>
        item?.type === "direct" && item.subType === "app" && item.name === query &&
        item.originalName === name && item.path === path);
      return matches.length <= 4096 ? matches.length : null;
    } catch (_) {
      return null;
    }
  }

  function renderedAliasRows(query) {
    const aggregateRows = Array.from(document.querySelectorAll(
      ".scrollable-content .search-results .app-item",
    )).filter((row) => exactText(row.querySelector(".app-name")) === query);
    const listRows = Array.from(document.querySelectorAll(
      ".scrollable-content .list-mode-results .list-item",
    )).filter((row) => exactText(row.querySelector(".item-title")) === query);
    return [...aggregateRows, ...listRows];
  }

  function setSearchValue(input, query) {
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (typeof setter !== "function") return false;
    setter.call(input, query);
    return input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: query,
    }));
  }

  async function searchAlias(probeId, query, name, path, expectedCount) {
    let input = searchInput();
    let eventDispatched = false;
    const validArgs = typeof query === "string" && query.length > 0 &&
      typeof name === "string" && name.length > 0 && typeof path === "string" && path.length > 0 &&
      (expectedCount === 0 || expectedCount === 1);
    if (validArgs) {
      input = await waitFor(() => searchInput() !== null) ? searchInput() : null;
      eventDispatched = setSearchValue(input, query);
    }
    const valueMatches = validArgs && await waitFor(() => searchInput()?.value === query);
    if (validArgs) {
      await waitFor(() => {
        const renderedCount = renderedAliasRows(query).length;
        const currentStoreCount = storeTargetCount(commandDataStore(), query, name, path);
        return renderedCount === expectedCount && currentStoreCount === expectedCount;
      });
    }
    const resultCount = renderedAliasRows(query).length;
    const finalStoreCount = validArgs ? storeTargetCount(commandDataStore(), query, name, path) : null;
    if (!Number.isSafeInteger(resultCount) || resultCount > 4096) return;
    const matchedTarget = resultCount === 1 && finalStoreCount === 1;
    await send("mainAliasSearch", {
      inputFound: input instanceof HTMLInputElement,
      eventDispatched,
      valueMatches,
      resultCount,
      matchedTarget,
      storeTargetCount: finalStoreCount,
    }, probeId);
  }

  function knownListenerState(value) {
    return ["idle", "registering", "listening", "failed", "disposed"].includes(value);
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= 4096 ? value : null;
  }

  async function inspect(probeId) {
    let eventSourceListening = null;
    let aliasEvents = null;
    let appListReads = null;
    try {
      const snapshot = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.();
      const events = snapshot?.commandAliasEvents;
      if (knownListenerState(events?.listenerState)) {
        eventSourceListening = events.listenerState === "listening";
        if (eventSourceListening) aliasEvents = count(events.deliveredEvents);
      }
      appListReads = count(snapshot?.nativeCalls?.list_launcher_apps);
    } catch (_) {}
    await send("mainAliasInspect", { eventSourceListening, aliasEvents, appListReads }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_COMMAND_ALIASES__ = Object.freeze({
    commandAliasesSearch: searchAlias,
    commandAliasesInspect: inspect,
  });
})();
