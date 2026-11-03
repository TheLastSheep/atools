(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_JOURNEY_MAIN__) return;

  const input = () => document.querySelector("input.search-input");
  const hostSnapshot = () => {
    try {
      return window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.() ?? null;
    } catch (_) {
      return null;
    }
  };
  const number = (value) => Number.isInteger(value) && value >= 0 && value <= 128 ? value : null;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let placeholderNotificationsBeforeSave = null;
  const settingsFailures = [
    "openFailures",
    "closeFailures",
    "invalidPayloads",
    "registrationErrors",
    "lateListenerUnlistens",
    "cleanupErrors",
  ];
  const preferenceFields = [
    "showRecentInSearch",
    "recentRows",
    "pinnedRows",
    "searchMode",
    "showMatchRecommendation",
    "tabKeyFunction",
    "tabTargetCommand",
    "spaceOpenCommand",
  ];
  const coldStartupFields = [
    "placeholder",
    "theme",
    "primaryColor",
    "customColor",
    "autoClear",
    ...preferenceFields,
  ];

  async function waitFor(predicate, timeoutMs = 12000, intervalMs = 25) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(intervalMs);
    }
    return Boolean(predicate());
  }

  async function send(operation, generation, evidence) {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") return false;
    try {
      await invoke("settings_journey_probe", {
        token: window.__ATOOLS_SETTINGS_JOURNEY_TOKEN__,
        operation,
        generation,
        evidence,
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  function searchMode() {
    const avatar = document.querySelector(".avatar-wrapper");
    const capsule = document.querySelector('.plugin-tag-close[title="返回搜索"]');
    if (!avatar || capsule) return false;
    const bounds = avatar.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function pluginViewMode() {
    const avatar = document.querySelector(".avatar-wrapper");
    const capsule = document.querySelector('.plugin-tag-close[title="返回搜索"]');
    if (!avatar || !capsule) return false;
    const avatarBounds = avatar.getBoundingClientRect();
    const capsuleBounds = capsule.getBoundingClientRect();
    return avatarBounds.width > 0 && avatarBounds.height > 0 &&
      capsuleBounds.width > 0 && capsuleBounds.height > 0;
  }

  function settingsSnapshot() {
    return hostSnapshot()?.settingsView ?? null;
  }

  function healthySettingsSnapshot(snapshot) {
    return Boolean(
      snapshot && snapshot.version === 1 && snapshot.listenerState === "listening" &&
      snapshot.pendingOpen === false &&
      settingsFailures.every((key) => Number.isInteger(snapshot[key]) && snapshot[key] === 0),
    );
  }

  async function waitForLoadedTransition(before, allowedPriorPhases) {
    if (!healthySettingsSnapshot(before) || !allowedPriorPhases.includes(before.activePhase)) {
      return false;
    }
    return waitFor(() => {
      const current = settingsSnapshot();
      return healthySettingsSnapshot(current) && current.activePhase === "loaded" &&
        pluginViewMode();
    });
  }

  function preferenceSnapshot() {
    const snapshot = hostSnapshot();
    const count = number(snapshot?.generalPreferenceEvents?.notifiedFields?.placeholder);
    return count;
  }

  async function openButton(generation) {
    const avatar = document.querySelector(".avatar-wrapper");
    const before = settingsSnapshot();
    const found = Boolean(avatar && searchMode());
    if (found) avatar.click();
    const opened = found && await waitForLoadedTransition(before, [null]);
    placeholderNotificationsBeforeSave = preferenceSnapshot();
    await send("entryButton", generation, {
      mainPluginMode: opened && pluginViewMode(),
      buttonLocated: found,
      buttonClicked: found,
      openCallObserved: opened,
      placeholderNotificationCount: placeholderNotificationsBeforeSave,
    });
  }

  async function openKeyboard(generation) {
    const search = input();
    const before = settingsSnapshot();
    const located = Boolean(search && searchMode());
    let event = null;
    if (located) {
      event = new KeyboardEvent("keydown", {
        key: ",",
        code: "Comma",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      });
      search.dispatchEvent(event);
    }
    const opened = located && await waitForLoadedTransition(before, ["closed", "back-to-search"]);
    await send("entryKeyboard", generation, {
      mainPluginMode: opened && pluginViewMode(),
      inputLocated: located,
      eventDispatched: Boolean(event),
      defaultPrevented: event?.defaultPrevented === true,
      syntheticDom: true,
      openCallObserved: opened,
    });
  }

  async function exitButton(generation) {
    const button = document.querySelector('.plugin-tag-close[title="返回搜索"]');
    const before = settingsSnapshot();
    const loadedBefore = healthySettingsSnapshot(before) && before.activePhase === "loaded";
    const found = Boolean(
      loadedBefore && button && pluginViewMode(),
    );
    if (found) button.click();
    const closedPhaseObserved = found && await waitFor(() => {
      const current = settingsSnapshot();
      return healthySettingsSnapshot(current) && current.activePhase === "closed";
    }, 12000, 1);
    await waitFor(() => input()?.value === "" && document.activeElement === input());
    await waitFor(() => {
      const count = preferenceSnapshot();
      const visible = document.querySelector(".placeholder-text")?.textContent?.trim();
      return placeholderNotificationsBeforeSave !== null && count !== null &&
        count > placeholderNotificationsBeforeSave && visible === "atools-native-settings-fixed";
    });
    const currentInput = input();
    const placeholderText = document.querySelector(".placeholder-text")?.textContent?.trim();
    const notifications = preferenceSnapshot();
    await send("exitButton", generation, {
      buttonLocated: found,
      buttonClicked: found,
      searchQueryEmpty: Boolean(currentInput && currentInput.value === ""),
      searchFocused: Boolean(currentInput && document.activeElement === currentInput && document.hasFocus()),
      visiblePlaceholderMatches: placeholderText === "atools-native-settings-fixed",
      placeholderNotificationCount: notifications,
      closedPhaseObserved,
    });
  }

  async function afterEscape(generation) {
    const backPhaseObserved = await waitFor(() => {
      const snapshot = settingsSnapshot();
      return healthySettingsSnapshot(snapshot) && snapshot.activePhase === "back-to-search";
    });
    const searchRestored = await waitFor(() => {
      const search = input();
      return Boolean(search && search.value === "" && document.activeElement === search && document.hasFocus());
    });
    const search = input();
    await send("afterEscapeExit", generation, {
      searchQueryEmpty: searchRestored && Boolean(search && search.value === ""),
      searchFocused: searchRestored && Boolean(search && document.activeElement === search && document.hasFocus()),
      backToSearchObserved: backPhaseObserved,
    });
  }

  function piniaWindowStore() {
    try {
      const app = document.querySelector("#app")?.__vue_app__;
      const pinia = app?.config?.globalProperties?.$pinia;
      return {
        piniaAppFound: Boolean(app && pinia),
        windowStore: pinia?._s?.get("window") ?? null,
      };
    } catch (_) {
      return { piniaAppFound: false, windowStore: null };
    }
  }

  function safeWindowStoreValue(store, field) {
    try {
      if (!store) return null;
      const state = store.$state;
      const hasStateValue = state && Object.hasOwn(state, field);
      const hasStoreValue = Object.hasOwn(store, field);
      if (!hasStateValue && !hasStoreValue) return null;
      const value = hasStateValue ? state[field] : store[field];
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
      if (typeof value === "string") {
        return value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
      }
      return null;
    } catch (_) {
      return null;
    }
  }

  function windowStoreSnapshot(fields) {
    const inspected = piniaWindowStore();
    const store = inspected.windowStore;
    const values = Object.create(null);
    const presentFields = [];
    for (const field of fields) {
      const value = safeWindowStoreValue(store, field);
      values[field] = value;
      if (value !== null) presentFields.push(field);
    }
    return {
      piniaAppFound: inspected.piniaAppFound,
      windowStoreFound: Boolean(store),
      values,
      presentFields,
    };
  }

  function valuesMatch(actual, expected, fields) {
    return Boolean(expected && typeof expected === "object" && fields.every((field) =>
      Object.hasOwn(expected, field) && actual[field] !== null && actual[field] === expected[field],
    ));
  }

  function visibleElement(element) {
    if (!element?.isConnected || element.getClientRects().length === 0) return false;
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0;
  }

  function visibleSearchResultCount() {
    const items = document.querySelectorAll(".aggregate-view .search-results .app-item");
    let count = 0;
    for (const item of items) {
      if (visibleElement(item)) count = Math.min(1024, count + 1);
    }
    return count;
  }

  function candidateSearchQueries(apps) {
    if (!Array.isArray(apps)) return [];
    const seen = new Set();
    const candidates = [];
    for (const app of apps) {
      const name = typeof app?.name === "string" ? app.name.trim() : "";
      if (!name || name.length > 128 || /[\\/\u0000-\u001f\u007f]/.test(name) || seen.has(name)) continue;
      seen.add(name);
      candidates.push(name);
      if (candidates.length === 4) break;
    }
    return candidates;
  }

  function dispatchSearchInput(search, value, inputType) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (typeof setter !== "function" || !(search instanceof HTMLInputElement)) return false;
    try {
      setter.call(search, value);
      const event = new InputEvent("input", {
        bubbles: true,
        inputType,
        data: inputType === "insertText" ? value : null,
      });
      return search.dispatchEvent(event) !== false;
    } catch (_) {
      return false;
    }
  }

  async function observeSearchModeStructure(mode, selector) {
    const evidence = {
      mode: mode === "aggregate" || mode === "list" ? mode : null,
      selector,
      visible: false,
      rowCountClaimed: false,
      queryInjected: false,
      queryRestored: false,
      resultCount: 0,
      unavailableReason: "results-timeout",
    };
    const search = input();
    if (!search || !(search instanceof HTMLInputElement)) {
      evidence.unavailableReason = "input-unavailable";
      return evidence;
    }

    const getApps = window.ztools?.getApps;
    if (typeof getApps !== "function") {
      evidence.unavailableReason = "api-unavailable";
    } else {
      let timeout;
      let apps;
      try {
        const unavailable = Symbol("getApps-timeout");
        apps = await Promise.race([
          Promise.resolve().then(() => getApps.call(window.ztools)),
          new Promise((resolve) => { timeout = setTimeout(() => resolve(unavailable), 2500); }),
        ]);
        if (apps === unavailable) apps = null;
      } catch (_) {
        apps = null;
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
      if (apps === null) {
        evidence.unavailableReason = "api-unavailable";
      } else if (!Array.isArray(apps)) {
        evidence.unavailableReason = "api-unavailable";
      } else {
        const candidates = candidateSearchQueries(apps);
        if (apps.length === 0) {
          evidence.unavailableReason = "catalog-empty";
        } else if (candidates.length === 0) {
          evidence.unavailableReason = "api-unavailable";
        } else if (mode === "aggregate") {
          for (const query of candidates) {
            if (!dispatchSearchInput(search, query, "insertText")) {
              evidence.unavailableReason = "input-unavailable";
              break;
            }
            evidence.queryInjected = true;
            let observedResultCount = 0;
            const found = await waitFor(() => {
              const resultCount = visibleSearchResultCount();
              const container = document.querySelector(".aggregate-view");
              if (resultCount === 0 || !visibleElement(container)) return false;
              observedResultCount = resultCount;
              return true;
            }, 1800, 25);
            if (found) {
              evidence.visible = true;
              evidence.resultCount = observedResultCount;
              evidence.unavailableReason = "none";
              break;
            }
          }
        }
      }
    }

    const restoredInputEvent = dispatchSearchInput(search, "", "deleteContentBackward");
    try {
      search.focus();
    } catch (_) {
      // Focus evidence remains false if the real input cannot be focused.
    }
    evidence.queryRestored = restoredInputEvent && await waitFor(() =>
      search.value === "" && document.activeElement === search && visibleSearchResultCount() === 0,
      1600,
      25,
    );
    if (!evidence.queryRestored) evidence.unavailableReason = "restore-failed";
    return evidence;
  }

  async function observePreferences(generation, expected) {
    await waitFor(() => {
      const current = windowStoreSnapshot(preferenceFields);
      return current.piniaAppFound && current.windowStoreFound &&
        valuesMatch(current.values, expected, preferenceFields);
    }, 6000, 30);
    const snapshot = windowStoreSnapshot(preferenceFields);
    const mode = snapshot.values.searchMode;
    const selector = mode === "aggregate" ? ".aggregate-view"
      : mode === "list" ? ".list-mode-results" : null;
    const searchModeStructure = await observeSearchModeStructure(mode, selector);
    await send("observePreferences", generation, {
      piniaAppFound: snapshot.piniaAppFound,
      windowStoreFound: snapshot.windowStoreFound,
      presentFields: snapshot.presentFields,
      values: snapshot.values,
      searchModeStructure,
    });
  }

  async function observeColdStartup(generation, expected) {
    await waitFor(() => {
      const current = windowStoreSnapshot(coldStartupFields);
      return current.piniaAppFound && current.windowStoreFound &&
        valuesMatch(current.values, expected, coldStartupFields);
    }, 6000, 30);
    const snapshot = windowStoreSnapshot(coldStartupFields);
    const fieldMatches = Object.create(null);
    for (const field of coldStartupFields) {
      fieldMatches[field] = Object.hasOwn(expected ?? {}, field) &&
        snapshot.values[field] !== null && snapshot.values[field] === expected[field];
    }
    const target = snapshot.values.tabTargetCommand;
    await send("observeColdStartup", generation, {
      piniaAppFound: snapshot.piniaAppFound,
      windowStoreFound: snapshot.windowStoreFound,
      fieldCount: snapshot.presentFields.length,
      fieldMatches,
      tabTargetCommandBytes: typeof target === "string"
        ? new TextEncoder().encode(target).byteLength
        : 0,
    });
  }

  Object.defineProperty(window, "__ATOOLS_SETTINGS_JOURNEY_MAIN__", {
    value: Object.freeze({
      openButton,
      openKeyboard,
      exitButton,
      afterEscape,
      observePreferences,
      observeColdStartup,
    }),
    configurable: false,
    writable: false,
  });
})();
