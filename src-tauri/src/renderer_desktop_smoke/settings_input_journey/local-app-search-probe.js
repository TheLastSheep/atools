(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_LOCAL_APP_SEARCH__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
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

  function routeGeneral() {
    return window.location.hash.slice(1).split("?")[0] === "/generalSetting";
  }

  function generalToggle() {
    const rows = Array.from(document.querySelectorAll(".setting-item")).filter((row) =>
      row.querySelector(".setting-label > span")?.textContent?.trim() === "本地应用搜索");
    const controls = rows.length === 1
      ? Array.from(rows[0].querySelectorAll('input[type="checkbox"]'))
      : [];
    return { unique: rows.length === 1 && controls.length === 1, input: controls[0] ?? null };
  }

  async function storedSetting() {
    const internal = window.ztools?.internal;
    if (typeof internal?.dbGet !== "function") return { object: false, hasBoolean: false, enabled: false };
    try {
      const value = await internal.dbGet("settings-general");
      const object = value !== null && typeof value === "object" && !Array.isArray(value);
      const hasBoolean = object && typeof value.localAppSearch === "boolean";
      return {
        object,
        hasBoolean,
        enabled: hasBoolean && value.localAppSearch === true,
      };
    } catch (_) {
      return { object: false, hasBoolean: false, enabled: false };
    }
  }

  function documentEvidence() {
    return {
      documentHidden: document.hidden === true,
      documentHasFocus: document.hasFocus() === true,
    };
  }

  async function inspect(probeId) {
    const { unique, input } = generalToggle();
    const setting = await storedSetting();
    await send("childLocalAppSearchInspect", {
      routeGeneral: routeGeneral(),
      controlUnique: unique,
      checked: unique && input.checked === true,
      settingsObject: setting.object,
      settingsHasBoolean: setting.hasBoolean,
      settingsEnabled: setting.enabled,
      ...documentEvidence(),
    }, probeId);
  }

  async function toggle(probeId, expectedEnabled) {
    const before = generalToggle();
    const beforeChecked = before.unique && before.input.checked === true;
    const canClick = routeGeneral() && before.unique && beforeChecked === expectedEnabled;
    let clickDispatched = false;
    if (canClick) {
      before.input.click();
      clickDispatched = true;
    }

    const wantedEnabled = !expectedEnabled;
    const deadline = Date.now() + 8000;
    let control = generalToggle();
    let setting = await storedSetting();
    while (clickDispatched && Date.now() < deadline &&
      !(control.unique && control.input.checked === wantedEnabled &&
        setting.hasBoolean && setting.enabled === wantedEnabled)) {
      await delay(Math.min(30, Math.max(0, deadline - Date.now())));
      control = generalToggle();
      setting = await storedSetting();
    }

    await send("childLocalAppSearchToggle", {
      routeGeneral: routeGeneral(),
      controlUnique: before.unique && control.unique,
      beforeChecked,
      clickDispatched,
      afterChecked: control.unique && control.input.checked === true,
      settingsObject: setting.object,
      settingsHasBoolean: setting.hasBoolean,
      settingsEnabled: setting.enabled,
      ...documentEvidence(),
    }, probeId);
  }

  function commandDataStore() {
    const roots = document.querySelectorAll("#app");
    if (roots.length !== 1) return null;
    const provides = document.getElementById("app")?.__vue_app__?._context?.provides;
    if (!provides || typeof provides !== "object") return null;
    const pinia = Reflect.ownKeys(provides)
      .map((key) => provides[key])
      .filter((value) => value !== null && typeof value === "object" &&
        value._s instanceof Map && value._s.has("commandData"));
    if (pinia.length !== 1) return null;
    const store = pinia[0]._s.get("commandData");
    return store?.$id === "commandData" ? store : null;
  }

  function searchRows(store, query) {
    try {
      const result = store.search(query);
      if (!result || !Array.isArray(result.bestMatches) || !Array.isArray(result.regexMatches)) {
        return null;
      }
      return [...result.bestMatches, ...result.regexMatches].filter((command) =>
        command !== null && typeof command === "object");
    } catch (_) {
      return null;
    }
  }

  function appTargetCount(store, name, path) {
    const rows = searchRows(store, name);
    if (rows === null) return null;
    return rows.filter((command) => command.type === "direct" && command.subType === "app" &&
      command.name === name && command.path === path).length;
  }

  function timestampIdentity(store, expectedPath) {
    const rows = searchRows(store, "时间戳");
    if (rows === null) return { count: null, path: null, valid: false };
    const controls = rows.filter((command) => command.type === "plugin" &&
      command.pluginName === "timestamp" && command.featureCode === "timestamp" &&
      command.cmdType === "text" && command.name === "时间戳" &&
      typeof command.path === "string" && command.path.length > 0);
    const path = controls.length === 1 ? controls[0].path : null;
    return {
      count: controls.length,
      path,
      valid: path !== null && (expectedPath === "" || path === expectedPath),
    };
  }

  async function mainSearch(probeId, name, path, shouldBePresent, expectedTimestampPath) {
    const deadline = Date.now() + 8000;
    let store = null;
    let storeUnique = false;
    let storeReady = false;
    let searchCallable = false;
    let targetCount = null;
    let timestamp = { count: null, path: null, valid: false };

    while (Date.now() < deadline) {
      store = commandDataStore();
      storeUnique = store !== null;
      storeReady = storeUnique && store.isInitialized === true && store.loading === false &&
        Array.isArray(store.commands);
      searchCallable = storeUnique && typeof store.search === "function";
      targetCount = storeReady && searchCallable ? appTargetCount(store, name, path) : null;
      timestamp = storeReady && searchCallable
        ? timestampIdentity(store, expectedTimestampPath)
        : { count: null, path: null, valid: false };
      const targetMatched = Number.isInteger(targetCount) &&
        (shouldBePresent ? targetCount === 1 : targetCount === 0);
      if (targetMatched) break;
      await delay(30);
    }

    const input = document.querySelector("input.search-input");
    await send("mainLocalAppSearchSearch", {
      storeUnique,
      storeReady,
      searchCallable,
      appTargetCount: Number.isInteger(targetCount) && targetCount <= 4096 ? targetCount : null,
      timestampMatchCount: Number.isInteger(timestamp.count) && timestamp.count <= 4096
        ? timestamp.count
        : null,
      timestampIdentityValid: timestamp.valid,
      timestampPath: timestamp.path,
      inputFound: input instanceof HTMLInputElement,
      inputEmpty: input instanceof HTMLInputElement && input.value.length === 0,
      ...documentEvidence(),
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_LOCAL_APP_SEARCH__ = Object.freeze({
    localAppSearchInspect: inspect,
    localAppSearchToggle: toggle,
    localAppSearchMainSearch: mainSearch,
  });
})();
