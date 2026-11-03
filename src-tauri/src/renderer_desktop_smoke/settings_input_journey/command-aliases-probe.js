(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_COMMAND_ALIASES__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const GROUP_TITLE = "系统应用";
  const ALIAS_INPUT_SELECTOR = '.alias-dialog-main input.input[type="text"][placeholder="输入自定义别名"]';
  const WAIT_MS = 8000;
  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  let pendingAdd = null;
  let selectedTarget = null;
  let diagnosticTarget = null;
  let openAddDiagnostic = null;

  async function send(operation, evidence, probeId) {
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (typeof invoke !== "function") return "unavailable";
    try {
      await invoke("settings_input_probe", { token, operation, probeId, evidence });
      return "accepted";
    } catch (_) {
      return "rejected";
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

  async function waitUntil(predicate, deadline) {
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await delay(Math.min(25, Math.max(0, deadline - Date.now())));
    }
    return false;
  }

  function routePath() {
    return window.location.hash.slice(1).split("?")[0];
  }

  function exactText(element) {
    return element?.textContent?.trim() ?? "";
  }

  function clickMenu(label) {
    const matches = Array.from(document.querySelectorAll(".menu-item")).filter((item) =>
      exactText(item.querySelector(".menu-label")) === label);
    if (matches.length !== 1) return false;
    matches[0].click();
    return true;
  }

  function commandCards(name, path) {
    return Array.from(document.querySelectorAll(".commands-content .command-card")).filter((card) =>
      card.getAttribute("title") === path && exactText(card.querySelector(".command-title")) === name);
  }

  function expectedMenuTop(rect, menu) {
    const menuHeight = menu.querySelectorAll(".dropdown-item").length * 36;
    return rect.bottom + 4 + menuHeight > window.innerHeight
      ? rect.top - 4 - menuHeight
      : rect.bottom + 4;
  }

  function menuItems(owner, label) {
    if (!owner?.classList.contains("open")) return [];
    const owners = Array.from(document.querySelectorAll(".tag-dropdown.open"));
    if (owners.length !== 1 || owners[0] !== owner) return [];
    const rect = owner.getBoundingClientRect();
    const left = rect.left + 160 > window.innerWidth ? rect.right - 160 : rect.left;
    const menus = Array.from(document.querySelectorAll(".dropdown-menu")).filter((menu) =>
      !menu.classList.contains("dropdown-menu-leave-from") &&
      !menu.classList.contains("dropdown-menu-leave-active") &&
      !menu.classList.contains("dropdown-menu-leave-to") &&
      menu.style.position === "fixed" &&
      Math.abs(Number.parseFloat(menu.style.left) - left) < 1 &&
      Math.abs(Number.parseFloat(menu.style.top) - expectedMenuTop(rect, menu)) < 1);
    if (menus.length !== 1) return [];
    return Array.from(menus[0].querySelectorAll(".dropdown-item")).filter((item) =>
      exactText(item.querySelector(".item-label")) === label);
  }

  function activeAliasTab() {
    const tabs = Array.from(document.querySelectorAll(".tab-btn")).filter((button) =>
      exactText(button) === "指令别名");
    return tabs.length === 1 && tabs[0].classList.contains("active") ? tabs[0] : null;
  }

  async function openAliasTab() {
    if (routePath() !== "/shortcuts") {
      if (!clickMenu("快捷键") || !(await waitFor(() => routePath() === "/shortcuts"))) return false;
    }
    const tabsReady = await waitFor(() => Array.from(document.querySelectorAll(".tab-btn")).filter((button) =>
      exactText(button) === "指令别名").length === 1);
    if (!tabsReady) return false;
    const tab = Array.from(document.querySelectorAll(".tab-btn")).filter((button) =>
      exactText(button) === "指令别名");
    if (tab.length !== 1) return false;
    if (!tab[0].classList.contains("active")) tab[0].click();
    return await waitFor(() => routePath() === "/shortcuts" && activeAliasTab() !== null);
  }

  function aliasRows(alias) {
    return Array.from(document.querySelectorAll(".alias-table-row")).filter((row) =>
      exactText(row.querySelector(".alias-display-text")) === alias);
  }

  function targetFromRow(row) {
    const title = exactText(row?.querySelector(".alias-target-title"));
    const subtitle = exactText(row?.querySelector(".alias-target-subtitle"));
    const prefix = `${GROUP_TITLE} / `;
    if (!title.startsWith(prefix) || !subtitle) return null;
    return { name: title.slice(prefix.length), path: subtitle };
  }

  function matchingAliasRows(alias, name, path) {
    return aliasRows(alias).filter((row) => {
      const target = targetFromRow(row);
      return target?.name === name && target.path === path;
    });
  }

  function aliasDialog(mode, name, path) {
    const dialogs = Array.from(document.querySelectorAll(".alias-dialog-container")).filter((root) => {
      const title = exactText(root.closest(".detail-panel")?.querySelector(".detail-topbar .topbar-title"));
      return title === (mode === "edit" ? "编辑指令别名" : "添加指令别名");
    });
    if (dialogs.length !== 1) return null;
    const dialog = dialogs[0];
    const target = dialog.querySelector(".command-target-selector .target-card");
    const exactTarget = exactText(target?.querySelector(".target-card-title")) ===
      `${GROUP_TITLE} / ${name}` &&
      exactText(target?.querySelector(".target-card-subtitle")) === path;
    return exactTarget ? dialog : null;
  }

  function aliasInput(dialog) {
    const inputs = Array.from(dialog?.querySelectorAll(ALIAS_INPUT_SELECTOR) ?? []);
    return inputs.length === 1 ? inputs[0] : null;
  }

  function diagnosticCount(selector) {
    try {
      const length = document.querySelectorAll(selector).length;
      return Number.isSafeInteger(length) && length >= 0 ? Math.min(length, 4096) : null;
    } catch (_) {
      return null;
    }
  }

  function diagnosticRoute() {
    try {
      const path = routePath();
      if (path === "/generalSetting") return "general";
      if (path === "/allCommands") return "allCommands";
      if (path === "/shortcuts") return "shortcuts";
    } catch (_) {}
    return "other";
  }

  function openAddDiagnosticFacts(phase, sendState, hadException) {
    const target = diagnosticTarget;
    let cardCount = null;
    if (target) {
      try {
        cardCount = Math.min(commandCards(target.name, target.path).length, 4096);
      } catch (_) {}
    }
    let aliasTabActive = false;
    try {
      aliasTabActive = activeAliasTab() !== null;
    } catch (_) {}
    const inputCount = diagnosticCount(`.alias-dialog-container ${ALIAS_INPUT_SELECTOR}`);
    return {
      phase,
      sendState,
      route: diagnosticRoute(),
      cardCount,
      openDropdownCount: diagnosticCount(".tag-dropdown.open"),
      menuCount: diagnosticCount(".dropdown-menu"),
      dialogCount: diagnosticCount(".alias-dialog-container"),
      aliasTabActive,
      inputPresent: inputCount === 1,
      invokeAvailable: typeof window.__TAURI_INTERNALS__?.invoke === "function",
      hadException,
    };
  }

  function rememberOpenAdd(phase, sendState, hadException) {
    openAddDiagnostic = openAddDiagnosticFacts(phase, sendState, hadException);
  }

  function setInputValue(input, value) {
    if (!(input instanceof HTMLInputElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (typeof setter !== "function") return false;
    setter.call(input, value);
    return input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: value,
    }));
  }

  function saveButton(dialog) {
    const buttons = Array.from(dialog?.querySelectorAll(".dialog-footer button.btn-solid") ?? []).filter((button) =>
      exactText(button) === "保存" && button.disabled !== true);
    return buttons.length === 1 ? buttons[0] : null;
  }

  function click(button) {
    if (!button || button.disabled === true) return false;
    try {
      button.click();
      return true;
    } catch (_) {
      return false;
    }
  }

  async function openAdd(probeId, name, path, alias) {
    let menuDispatched = false;
    let dialogOpened = false;
    let phase = "arguments";
    let hadException = false;
    const deadline = Date.now() + 9000;
    const validArgs = [name, path, alias].every((value) => typeof value === "string" && value.length > 0);
    diagnosticTarget = typeof name === "string" && typeof path === "string" ? { name, path } : null;
    try {
      if (!validArgs) return;
      phase = "route";
      rememberOpenAdd(phase, "not-attempted", hadException);
      if (routePath() !== "/allCommands") clickMenu("所有指令");
      const onCommands = await waitUntil(() => routePath() === "/allCommands", deadline);
      rememberOpenAdd(phase, "not-attempted", hadException);
      if (!onCommands) return;

      phase = "card";
      rememberOpenAdd(phase, "not-attempted", hadException);
      const cardReady = await waitUntil(() => commandCards(name, path).length === 1, deadline);
      rememberOpenAdd(phase, "not-attempted", hadException);
      const rows = cardReady ? commandCards(name, path) : [];
      const card = rows.length === 1 ? rows[0] : null;
      const button = card?.querySelector("button.card-more-btn");
      const owner = button?.closest(".tag-dropdown");
      if (!button || !owner) return;

      phase = "menu";
      rememberOpenAdd(phase, "not-attempted", hadException);
      button.click();
      const menuReady = await waitUntil(() => menuItems(owner, "自定义别名").length === 1, deadline);
      rememberOpenAdd(phase, "not-attempted", hadException);
      const item = menuReady ? menuItems(owner, "自定义别名") : [];
      if (item.length !== 1) return;
      item[0].click();
      menuDispatched = true;

      phase = "dialog";
      rememberOpenAdd(phase, "not-attempted", hadException);
      dialogOpened = await waitUntil(() => {
        if (routePath() !== "/shortcuts" || activeAliasTab() === null) return false;
        const dialog = aliasDialog("create", name, path);
        return dialog !== null && aliasInput(dialog) !== null;
      }, deadline);
      phase = dialogOpened ? "complete" : "dialog";
      rememberOpenAdd(phase, "not-attempted", hadException);
      if (dialogOpened) pendingAdd = { name, path, alias };
    } catch (_) {
      hadException = true;
      phase = "error";
    } finally {
      const invokeAvailable = typeof window.__TAURI_INTERNALS__?.invoke === "function";
      rememberOpenAdd(phase, invokeAvailable ? "pending" : "unavailable", hadException);
      const sendState = await send("childAliasOpenAdd", { menuDispatched, dialogOpened }, probeId);
      rememberOpenAdd(phase, sendState, hadException);
    }
  }

  async function openAddDiagnosticRead(probeId) {
    const captured = openAddDiagnostic || {
      phase: "not-started",
      sendState: "not-attempted",
      hadException: false,
    };
    const evidence = openAddDiagnosticFacts(captured.phase, captured.sendState, captured.hadException);
    await send("childAliasOpenAddDiagnostic", evidence, probeId);
  }

  async function addSave(probeId, alias) {
    let saveDispatched = false;
    let saveCompleted = false;
    const target = pendingAdd;
    const dialog = target && target.alias === alias && routePath() === "/shortcuts" && activeAliasTab()
      ? aliasDialog("create", target.name, target.path)
      : null;
    const input = aliasInput(dialog);
    if (input && setInputValue(input, alias) && input.value === alias) {
      const saveReady = await waitFor(() => {
        const currentDialog = aliasDialog("create", target.name, target.path);
        return aliasInput(currentDialog)?.value === alias && saveButton(currentDialog) !== null;
      });
      const currentDialog = saveReady ? aliasDialog("create", target.name, target.path) : null;
      saveDispatched = click(saveButton(currentDialog));
      if (saveDispatched) {
        saveCompleted = await waitFor(() => aliasDialog("create", target.name, target.path) === null &&
          matchingAliasRows(alias, target.name, target.path).length === 1);
        if (saveCompleted) {
          selectedTarget = { name: target.name, path: target.path };
          pendingAdd = null;
        }
      }
    }
    await send("childAliasAddSave", { saveDispatched, saveCompleted }, probeId);
  }

  async function editSave(probeId, fromAlias, toAlias) {
    let saveDispatched = false;
    let saveCompleted = false;
    if (typeof fromAlias === "string" && fromAlias.length > 0 &&
        typeof toAlias === "string" && toAlias.length > 0 && fromAlias !== toAlias &&
        await openAliasTab() && await waitFor(() => aliasRows(fromAlias).length === 1)) {
      const oldRows = aliasRows(fromAlias);
      const row = oldRows.length === 1 ? oldRows[0] : null;
      const target = targetFromRow(row);
      const editButton = row?.querySelector('button.edit-btn[title="编辑"]');
      if (target && editButton && click(editButton)) {
        const dialogReady = await waitFor(() => {
          const dialog = aliasDialog("edit", target.name, target.path);
          return dialog !== null && aliasInput(dialog)?.value === fromAlias;
        });
        const dialog = dialogReady ? aliasDialog("edit", target.name, target.path) : null;
        const input = aliasInput(dialog);
        if (input && setInputValue(input, toAlias) && input.value === toAlias) {
          const saveReady = await waitFor(() => {
            const currentDialog = aliasDialog("edit", target.name, target.path);
            return aliasInput(currentDialog)?.value === toAlias && saveButton(currentDialog) !== null;
          });
          const currentDialog = saveReady ? aliasDialog("edit", target.name, target.path) : null;
          saveDispatched = click(saveButton(currentDialog));
          if (saveDispatched) {
            saveCompleted = await waitFor(() => aliasDialog("edit", target.name, target.path) === null &&
              aliasRows(fromAlias).length === 0 && matchingAliasRows(toAlias, target.name, target.path).length === 1);
            if (saveCompleted) selectedTarget = target;
          }
        }
      }
    }
    await send("childAliasEditSave", { saveDispatched, saveCompleted }, probeId);
  }

  async function readBack(probeId, name, path, alias) {
    const routeValid = await openAliasTab();
    const aliasVisible = routeValid && await waitFor(() =>
      matchingAliasRows(alias, name, path).length === 1 &&
      document.querySelectorAll(".alias-dialog-container").length === 0);
    if (aliasVisible) selectedTarget = { name, path };
    await send("childAliasReadBack", { routeValid, aliasVisible }, probeId);
  }

  async function deleteAlias(probeId, alias) {
    let deleteDialogOpened = false;
    let deleteConfirmed = false;
    let rowRemoved = false;
    const target = selectedTarget;
    const shortcutsReady = target && await openAliasTab() &&
      await waitFor(() => matchingAliasRows(alias, target.name, target.path).length === 1);
    const rowSet = shortcutsReady
      ? matchingAliasRows(alias, target.name, target.path)
      : [];
    const row = rowSet.length === 1 ? rowSet[0] : null;
    const button = row?.querySelector('button.delete-btn[title="删除"]');
    if (button && click(button)) {
      deleteDialogOpened = await waitFor(() => {
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"]')).filter((dialog) =>
          exactText(dialog.querySelector(".dialog-title")) === "删除别名映射" &&
          exactText(dialog.querySelector(".dialog-message")) === `确定要删除别名“${alias}”吗？`);
        return dialogs.length === 1;
      });
      if (deleteDialogOpened) {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).filter((item) =>
          exactText(item.querySelector(".dialog-title")) === "删除别名映射" &&
          exactText(item.querySelector(".dialog-message")) === `确定要删除别名“${alias}”吗？`)[0];
        const confirmButtons = Array.from(dialog.querySelectorAll(".dialog-footer button.btn")).filter((item) =>
          exactText(item) === "删除");
        deleteConfirmed = confirmButtons.length === 1 && click(confirmButtons[0]);
        if (deleteConfirmed) {
          rowRemoved = await waitFor(() => matchingAliasRows(alias, target.name, target.path).length === 0);
          if (rowRemoved) selectedTarget = null;
        }
      }
    }
    await send("childAliasDelete", { deleteDialogOpened, deleteConfirmed, rowRemoved }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_COMMAND_ALIASES__ = Object.freeze({
    commandAliasesOpenAdd: openAdd,
    commandAliasesOpenAddDiagnostic: openAddDiagnosticRead,
    commandAliasesAddSave: addSave,
    commandAliasesEditSave: editSave,
    commandAliasesReadBack: readBack,
    commandAliasesDelete: deleteAlias,
  });
})();
