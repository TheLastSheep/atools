(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_CHILD__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let initialBaseline = null;
  let initialTargetUnique = false;

  async function waitFor(predicate, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(25);
    }
    return Boolean(predicate());
  }

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
    return cards().filter((card) =>
      card.getAttribute("title") === path &&
      card.querySelector(".command-title")?.textContent?.trim() === name);
  }

  function documentEvidence() {
    return {
      documentHidden: document.hidden === true,
      documentHasFocus: document.hasFocus() === true,
    };
  }

  function commandEvidence(name, path, restored = null) {
    const allCards = cards();
    const currentPath = routePath();
    const targetRows = exactTargetRows(name, path);
    const targetUnique = initialBaseline === null
      ? targetRows.length === 1
      : initialTargetUnique;
    const routeValid = currentPath === "/allCommands";
    const queryMatches = targetUnique &&
      (allCards.length === initialBaseline || allCards.length === 1 || allCards.length === 0);
    return {
      routeValid,
      baselineCount: initialBaseline ?? allCards.length,
      filteredCount: allCards.length,
      matchedCount: allCards.length,
      restoredCount: restored,
      queryMatches,
      targetUnique,
      ...documentEvidence(),
    };
  }

  async function clickMenu(label) {
    const menu = Array.from(document.querySelectorAll(".menu-item")).find((item) =>
      item.querySelector(".menu-label")?.textContent?.trim() === label);
    if (!menu) return false;
    menu.click();
    return true;
  }

  async function inspectBaseline(probeId, operation, name, path) {
    await clickMenu("所有指令");
    const ready = await waitFor(() => routePath() === "/allCommands" &&
      document.querySelector(".source-item.active .source-name")?.textContent?.trim() === "系统应用" &&
      cards().length > 0);
    const baseline = cards().length;
    const targetUnique = exactTargetRows(name, path).length === 1;
    if (ready) {
      initialBaseline = baseline;
      initialTargetUnique = targetUnique;
    }
    await send(operation, {
      ...commandEvidence(name, path),
      routeValid: ready && routePath() === "/allCommands",
      baselineCount: baseline,
      filteredCount: cards().length,
      matchedCount: cards().length,
      restoredCount: null,
      queryMatches: ready && targetUnique && cards().length === baseline,
      targetUnique,
    }, probeId);
  }

  async function inspectTarget(probeId, name, path) {
    const matched = await waitFor(() => routePath() === "/allCommands" &&
      cards().length === 1 && exactTargetRows(name, path).length === 1);
    await send("childTarget", {
      ...commandEvidence(name, path),
      routeValid: routePath() === "/allCommands",
      filteredCount: cards().length,
      matchedCount: cards().length,
      restoredCount: null,
      queryMatches: matched && initialTargetUnique,
      targetUnique: initialTargetUnique,
    }, probeId);
  }

  async function inspectNoMatch(probeId) {
    const matched = await waitFor(() => routePath() === "/allCommands" && cards().length === 0 &&
      Boolean(document.querySelector(".commands-content .empty-state")));
    await send("childNoMatch", {
      routeValid: routePath() === "/allCommands",
      baselineCount: initialBaseline ?? 0,
      filteredCount: cards().length,
      matchedCount: cards().length,
      restoredCount: null,
      queryMatches: matched && initialTargetUnique,
      targetUnique: initialTargetUnique,
      ...documentEvidence(),
    }, probeId);
  }

  async function inspectClear(probeId) {
    const restored = await waitFor(() => routePath() === "/allCommands" &&
      initialBaseline !== null && cards().length === initialBaseline);
    await send("childClear", {
      routeValid: routePath() === "/allCommands",
      baselineCount: initialBaseline ?? 0,
      filteredCount: cards().length,
      matchedCount: cards().length,
      restoredCount: restored ? cards().length : null,
      queryMatches: restored && initialTargetUnique,
      targetUnique: initialTargetUnique,
      ...documentEvidence(),
    }, probeId);
  }

  async function rotateOwner(probeId, name, path) {
    const clicked = await clickMenu("快捷键");
    const routeValid = clicked && await waitFor(() => routePath() === "/shortcuts");
    await send("childOwnerRoute", {
      routeValid,
      targetUnique: initialTargetUnique || exactTargetRows(name, path).length === 1,
      ...documentEvidence(),
    }, probeId);
  }

  async function setValue(probeId, value) {
    let apiAvailable = typeof window.ztools?.setSubInputValue === "function";
    let acknowledged = false;
    if (apiAvailable) {
      try {
        acknowledged = await window.ztools.setSubInputValue(value) === true;
      } catch (_) {}
    }
    await send("childValue", { apiAvailable, acknowledged }, probeId);
  }

  function exactKeys(value, keys) {
    return value !== null && typeof value === "object" && !Array.isArray(value) &&
      Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  }

  async function sendStaleControl(
    probeId,
    oldGeneration,
    currentGeneration,
    sequence,
    revision,
    valueVersion,
  ) {
    let reply = null;
    try {
      const config = window.__ATOOLS_SETTINGS_VIEW_CONFIG__;
      reply = await window.__TAURI_INTERNALS__.invoke("call_renderer_settings", {
        sessionId: config.sessionId,
        operation: "updateSubInput",
        payload: {
          action: "set",
          generation: oldGeneration,
          sequence,
          placeholder: "stale-owner-probe",
          focus: false,
        },
      });
    } catch (_) {}
    const replyValid = exactKeys(reply, ["version", "generation", "revision", "valueVersion", "applied"]) &&
      reply.version === 1 && Number.isSafeInteger(reply.generation) &&
      Number.isSafeInteger(reply.revision) && Number.isSafeInteger(reply.valueVersion) &&
      typeof reply.applied === "boolean";
    const applied = replyValid ? reply.applied : false;
    const replyMatchesCurrent = replyValid && reply.generation === currentGeneration &&
      reply.revision === revision && reply.valueVersion === valueVersion;
    await send("childStale", { replyValid, applied, replyMatchesCurrent }, probeId);
  }

  async function replayRetiredSession(probeId, retiredSessionId, generation, sequence) {
    let rejected = false;
    let expectedCode = false;
    try {
      await window.__TAURI_INTERNALS__.invoke("call_renderer_settings", {
        sessionId: retiredSessionId,
        operation: "updateSubInput",
        payload: {
          action: "set",
          generation,
          sequence,
          placeholder: "retired-session-probe",
          focus: false,
        },
      });
    } catch (error) {
      rejected = true;
      expectedCode = error !== null && typeof error === "object" &&
        error.code === "SETTINGS_CALLER_REJECTED";
    }
    await send("childRetiredSession", { rejected, expectedCode }, probeId);
  }

  async function outAvailable(probeId) {
    await send("childOut", { available: typeof window.ztools?.outPlugin === "function" }, probeId);
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

  async function readBackPin(name, path, shouldBePinned, deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    const read = Promise.resolve().then(async () => {
      const dbGet = window.ztools?.internal?.dbGet;
      if (typeof dbGet !== "function") return false;
      try {
        const rows = await dbGet.call(window.ztools.internal, "pinned-commands");
        if (!Array.isArray(rows)) return false;
        const matches = rows.filter((row) => row !== null && typeof row === "object" &&
          !Array.isArray(row) && row.path === path && row.name === name &&
          row.type === "direct" && row.subType === "app");
        return shouldBePinned ? rows.length === 1 && matches.length === 1 : rows.length === 0;
      } catch (_) {
        return false;
      }
    });
    let timer = null;
    try {
      return await Promise.race([
        read,
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining); }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async function changeSearchPin(probeId, action, name, path) {
    const deadline = Date.now() + 8000;
    const pinning = action === "pin";
    const oldLabel = pinning ? "固定到搜索" : "取消固定搜索";
    const newLabel = pinning ? "取消固定搜索" : "固定到搜索";
    const rows = exactTargetRows(name, path);
    const card = rows.length === 1 ? rows[0] : null;
    const button = card?.querySelector("button.card-more-btn");
    const owner = button?.closest(".tag-dropdown");
    let menuOpened = false;
    let menuItemFound = false;
    let clickDispatched = false;
    let menuStateReflected = false;
    let readBack = false;

    if ((action === "pin" || action === "unpin") && routePath() === "/allCommands" && button && owner) {
      button.click();
      menuOpened = await waitUntil(() => currentOwnerMenuItems(owner, oldLabel).length > 0, deadline);
      const initialItems = currentOwnerMenuItems(owner, oldLabel);
      menuItemFound = menuOpened && initialItems.length === 1;
      if (menuItemFound) {
        initialItems[0].click();
        clickDispatched = true;
        await waitUntil(() => !owner.classList.contains("open"), deadline);
        if (Date.now() < deadline) {
          button.click();
          menuStateReflected = await waitUntil(
            () => currentOwnerMenuItems(owner, newLabel).length === 1,
            deadline,
          );
          if (menuStateReflected) readBack = await readBackPin(name, path, pinning, deadline);
        }
      }
    }
    if (owner?.classList.contains("open")) button.click();

    await send(pinning ? "childPinSearch" : "childUnpinSearch", {
      menuOpened,
      menuItemFound,
      clickDispatched,
      menuStateReflected,
      readBack,
      ...commandEvidence(name, path),
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_CHILD__ = Object.freeze({
    inspectBaseline,
    inspectTarget,
    inspectNoMatch,
    inspectClear,
    rotateOwner,
    setValue,
    sendStaleControl,
    replayRetiredSession,
    outAvailable,
    changeSearchPin,
  });
})();
