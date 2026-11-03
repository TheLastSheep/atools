(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_AVAILABILITY__) return;

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

  function routePath() {
    return window.location.hash.slice(1).split("?")[0];
  }

  function cards() {
    return Array.from(document.querySelectorAll(".commands-content .command-card"));
  }

  function exactTargetRows(name, path) {
    return cards().filter((card) => card.getAttribute("title") === path &&
      card.querySelector(".command-title")?.textContent?.trim() === name);
  }

  function documentEvidence() {
    return {
      documentHidden: document.hidden === true,
      documentHasFocus: document.hasFocus() === true,
    };
  }

  function currentOwnerMenuItems(owner, label) {
    if (!owner || !owner.classList.contains("open")) return [];
    const openOwners = Array.from(document.querySelectorAll(".tag-dropdown.open"));
    if (openOwners.length !== 1 || openOwners[0] !== owner) return [];
    const rect = owner.getBoundingClientRect();
    const expectedLeft = rect.left + 160 > window.innerWidth ? rect.right - 160 : rect.left;
    const menus = Array.from(document.querySelectorAll(".dropdown-menu")).filter((menu) =>
      !menu.classList.contains("dropdown-menu-leave-from") &&
      !menu.classList.contains("dropdown-menu-leave-active") &&
      !menu.classList.contains("dropdown-menu-leave-to") &&
      menu.style.position === "fixed" &&
      Math.abs(Number.parseFloat(menu.style.left) - expectedLeft) < 1 &&
      Math.abs(Number.parseFloat(menu.style.top) - expectedMenuTop(rect, menu)) < 1);
    if (menus.length !== 1) return [];
    return Array.from(menus[0].querySelectorAll(".dropdown-item")).filter((item) =>
      item.querySelector(".item-label")?.textContent?.trim() === label);
  }

  function expectedMenuTop(rect, menu) {
    const menuHeight = menu.querySelectorAll(".dropdown-item").length * 36;
    return rect.bottom + 4 + menuHeight > window.innerHeight
      ? rect.top - 4 - menuHeight
      : rect.bottom + 4;
  }

  async function waitUntil(predicate, deadline) {
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    return Date.now() <= deadline && Boolean(predicate());
  }

  async function childBaseline(probeId, name, path) {
    await waitUntil(() => routePath() === "/allCommands", Date.now() + 8000);
    const evidence = {
      routeAllCommands: routePath() === "/allCommands",
      targetCount: exactTargetRows(name, path).length,
      openMenuCount: document.querySelectorAll(".tag-dropdown.open").length,
      ...documentEvidence(),
    };
    await send("childAvailabilityBaseline", evidence, probeId);
  }

  async function toggleDisabled(probeId, action, name, path) {
    const deadline = Date.now() + 8000;
    const disabling = action === "disable";
    const requestedLabel = disabling ? "禁用指令" : "启用指令";
    const alreadyLabel = disabling ? "启用指令" : "禁用指令";
    const rows = exactTargetRows(name, path);
    const card = rows.length === 1 ? rows[0] : null;
    const button = card?.querySelector("button.card-more-btn");
    const owner = button?.closest(".tag-dropdown");
    const routeAllCommands = routePath() === "/allCommands";
    let menuOpened = false;
    let menuItemFound = false;
    let clickDispatched = false;
    let menuStateReflected = false;
    let alreadyDesired = false;

    if (routeAllCommands && rows.length === 1 && button && owner) {
      button.click();
      menuOpened = await waitUntil(() => currentOwnerMenuItems(owner, requestedLabel).length === 1 ||
        currentOwnerMenuItems(owner, alreadyLabel).length === 1, deadline);
      const requestedItems = currentOwnerMenuItems(owner, requestedLabel);
      const alreadyItems = currentOwnerMenuItems(owner, alreadyLabel);
      if (requestedItems.length === 1 && alreadyItems.length === 0) {
        menuItemFound = true;
        requestedItems[0].click();
        clickDispatched = true;
        await waitUntil(() => !owner.classList.contains("open"), deadline);
        if (Date.now() < deadline) {
          button.click();
          menuStateReflected = await waitUntil(
            () => currentOwnerMenuItems(owner, alreadyLabel).length === 1 &&
              currentOwnerMenuItems(owner, requestedLabel).length === 0,
            deadline,
          );
        }
      } else if (alreadyItems.length === 1 && requestedItems.length === 0) {
        alreadyDesired = true;
        menuStateReflected = true;
      }
    }
    if (owner?.classList.contains("open")) button.click();

    await send(disabling ? "childAvailabilityDisable" : "childAvailabilityEnable", {
      routeAllCommands,
      targetCount: rows.length,
      menuOpened,
      menuItemFound,
      clickDispatched,
      menuStateReflected,
      alreadyDesired,
      ...documentEvidence(),
    }, probeId);
  }

  async function readDisabled(probeId, commandId, shouldBeDisabled) {
    const deadline = Date.now() + 8000;
    let arrayValue = false;
    let readBack = false;
    let entryCount = 0;
    const dbGet = window.ztools?.internal?.dbGet;

    if (typeof dbGet === "function") {
      while (Date.now() < deadline) {
        try {
          const value = await dbGet.call(window.ztools.internal, "disable-commands");
          arrayValue = Array.isArray(value) && value.every((item) =>
            typeof item === "string" && item.length > 0);
          entryCount = arrayValue ? value.length : 0;
          readBack = arrayValue && (shouldBeDisabled
            ? value.length === 1 && value[0] === commandId
            : value.length === 0);
          if (readBack || !arrayValue) break;
        } catch (_) {
          arrayValue = false;
          entryCount = 0;
          readBack = false;
        }
        await delay(40);
      }
    }

    await send(shouldBeDisabled
      ? "childAvailabilityDisabledReadBack"
      : "childAvailabilityEnabledReadBack", {
      routeAllCommands: routePath() === "/allCommands",
      arrayValue,
      readBack,
      entryCount,
      ...documentEvidence(),
    }, probeId);
  }

  function commandDataStore() {
    const appRoots = document.querySelectorAll("#app");
    if (appRoots.length !== 1) return null;
    const appRoot = document.getElementById("app");
    const provides = appRoot?.__vue_app__?._context?.provides;
    if (!provides || typeof provides !== "object") return null;
    const piniaCandidates = Reflect.ownKeys(provides)
      .map((key) => provides[key])
      .filter((value) => value !== null && typeof value === "object" &&
        value._s instanceof Map && value._s.has("commandData"));
    if (piniaCandidates.length !== 1) return null;
    const stores = piniaCandidates[0]._s;
    const store = stores.get("commandData");
    if (!store || store.$id !== "commandData") return null;
    return store;
  }

  function targetResultCount(store, query, path) {
    try {
      const result = store.search(query);
      if (!result || !Array.isArray(result.bestMatches) || !Array.isArray(result.regexMatches)) {
        return null;
      }
      return [...result.bestMatches, ...result.regexMatches].filter((command) =>
        command !== null && typeof command === "object" &&
        command.type === "direct" && command.subType === "app" && command.path === path).length;
    } catch (_) {
      return null;
    }
  }

  async function mainSearch(probeId, query, path, shouldBePresent) {
    const deadline = Date.now() + 8000;
    let store = null;
    let storeUnique = false;
    let storeReady = false;
    let searchCallable = false;
    let targetCount = null;

    while (Date.now() < deadline) {
      store = commandDataStore();
      storeUnique = store !== null;
      storeReady = storeUnique && store.isInitialized === true && store.loading === false &&
        Array.isArray(store.commands) && store.commands.length > 0;
      searchCallable = storeUnique && typeof store.search === "function";
      const count = storeReady && searchCallable ? targetResultCount(store, query, path) : null;
      targetCount = Number.isInteger(count) && count <= 4096 ? count : null;
      if (targetCount !== null && (shouldBePresent ? count > 0 : count === 0)) break;
      await delay(30);
    }

    const input = document.querySelector("input.search-input");
    await send("mainCommandAvailability", {
      storeUnique,
      storeReady,
      searchCallable,
      targetCount,
      inputFound: input instanceof HTMLInputElement,
      inputEmpty: input instanceof HTMLInputElement && input.value.length === 0,
      ...documentEvidence(),
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_AVAILABILITY__ = Object.freeze({
    commandAvailabilityChildBaseline: childBaseline,
    commandAvailabilityToggleDisabled: toggleDisabled,
    commandAvailabilityReadDisabled: readDisabled,
    commandAvailabilityMainSearch: mainSearch,
  });
})();
