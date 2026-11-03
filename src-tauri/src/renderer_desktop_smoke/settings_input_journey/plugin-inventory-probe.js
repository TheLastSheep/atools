(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_PLUGIN_INVENTORY__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const MAX_COUNT = 4096;

  async function send(probeId, evidence) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return false;
    try {
      await invoke("settings_input_probe", {
        token,
        operation: "mainPluginInventory",
        probeId,
        evidence,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function count(value) {
    return Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT ? value : null;
  }

  function adapter() {
    try {
      const value = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.();
      return value && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function store() {
    const root = document.getElementById("app");
    const provides = root?.__vue_app__?._context?.provides;
    if (!provides || typeof provides !== "object") return null;
    const piniaStores = Reflect.ownKeys(provides)
      .map((key) => provides[key])
      .filter((value) => value !== null && typeof value === "object" &&
        value._s instanceof Map && value._s.has("commandData"));
    if (piniaStores.length !== 1) return null;
    const value = piniaStores[0]._s.get("commandData");
    return value?.$id === "commandData" ? value : null;
  }

  function ready(value) {
    return value !== null && value.isInitialized === true && value.loading === false &&
      Array.isArray(value.commands) && typeof value.search === "function";
  }

  function searchedRows(value, query) {
    try {
      const result = value.search(query);
      if (!result || !Array.isArray(result.bestMatches) || !Array.isArray(result.regexMatches)) {
        return null;
      }
      return [...result.bestMatches, ...result.regexMatches];
    } catch (_) {
      return null;
    }
  }

  function evidence(name, path) {
    const state = adapter();
    const pluginCatalog = state?.pluginCatalog;
    const eventSource = pluginCatalog?.eventSource;
    const commandStore = store();
    const storeReady = commandStore === null ? null : ready(commandStore);
    let timestampMatchCount = null;
    let targetAppCount = null;
    if (storeReady === true) {
      const timestamp = searchedRows(commandStore, "时间戳");
      const target = searchedRows(commandStore, name);
      if (timestamp !== null) {
        timestampMatchCount = count(timestamp.filter((row) => row?.type === "plugin" &&
          row.pluginName === "timestamp" && row.featureCode === "timestamp" &&
          row.cmdType === "text" && row.name === "时间戳").length);
      }
      if (target !== null) {
        targetAppCount = count(target.filter((row) => row?.type === "direct" &&
          row.subType === "app" && row.name === name && row.path === path).length);
      }
    }
    return {
      storeReady,
      timestampMatchCount,
      targetAppCount,
      listReadCount: count(state?.nativeCalls?.list_plugins),
      pendingNativeCalls: count(state?.outstandingNativeCalls),
      cachedPlugins: count(pluginCatalog?.cachedPlugins),
      catalogReadPending: typeof pluginCatalog?.readPending === "boolean"
        ? pluginCatalog.readPending : null,
      catalogLateChangePending: typeof pluginCatalog?.lateChangePending === "boolean"
        ? pluginCatalog.lateChangePending : null,
      pluginCallbackErrors: count(pluginCatalog?.callbackErrors),
      invalidPayloads: count(pluginCatalog?.invalidPayloads),
      listenerState: ["idle", "registering", "listening", "failed", "disposed"]
        .includes(eventSource?.listenerState) ? eventSource.listenerState : null,
      eventDeliveredEvents: count(eventSource?.deliveredEvents),
      registrationErrors: count(eventSource?.registrationErrors),
      listenerCallbackErrors: count(eventSource?.callbackErrors),
      registrationsPending: count(eventSource?.registrationsPending),
      cleanupErrors: count(eventSource?.cleanupErrors),
    };
  }

  function settled(value) {
    return value.storeReady === true && value.cachedPlugins === 1 &&
      value.catalogReadPending === false && value.catalogLateChangePending === false &&
      value.listenerState === "listening" && value.registrationsPending === 0 &&
      value.pluginCallbackErrors === 0 && value.registrationErrors === 0 &&
      value.listenerCallbackErrors === 0 && value.cleanupErrors === 0;
  }

  async function inspect(probeId, name, path, expectedTimestampCount, expectedEventCount,
    expectedListReadCount) {
    const deadline = Date.now() + 10000;
    let current = evidence(name, path);
    const shouldWait = expectedTimestampCount === 0 || expectedTimestampCount === 1;
    while (shouldWait && Date.now() < deadline) {
      current = evidence(name, path);
      if (settled(current) && current.timestampMatchCount === expectedTimestampCount &&
          current.targetAppCount === 1 &&
          (expectedEventCount < 0 || current.eventDeliveredEvents >= expectedEventCount) &&
          (expectedListReadCount < 0 || current.listReadCount >= expectedListReadCount)) {
        break;
      }
      await delay(25);
    }
    await send(probeId, current);
  }

  window.__ATOOLS_SETTINGS_INPUT_PLUGIN_INVENTORY__ = Object.freeze({
    pluginInventoryInspect: inspect,
  });
})();
