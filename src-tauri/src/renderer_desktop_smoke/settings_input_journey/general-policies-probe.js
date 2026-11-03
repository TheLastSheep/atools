(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_GENERAL_POLICIES__) return;

  const STRATEGY_LABELS = Object.freeze({
    remember: "记住上次位置",
    cursor: "鼠标屏居中",
    primary: "主屏居中",
    lastActive: "上次活动屏居中",
  });
  const STRATEGY_VALUES = Object.freeze(Object.fromEntries(
    Object.entries(STRATEGY_LABELS).map(([value, label]) => [label, value]),
  ));
  const STRATEGY_TITLE = "窗口呼出位置";
  const RETENTION_TITLE = "剪贴板历史保存天数";
  const AUTO_BACK_TITLE = "自动返回到搜索";
  const AUTO_BACK_LABELS = Object.freeze({
    immediately: "立即",
    "30s": "30秒",
    "1m": "1分钟",
    "3m": "3分钟",
    "5m": "5分钟",
    "10m": "10分钟",
    never: "从不",
  });
  const AUTO_BACK_VALUES = Object.freeze(Object.fromEntries(
    Object.entries(AUTO_BACK_LABELS).map(([value, label]) => [label, value]),
  ));
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;

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

  function settingRow(title) {
    const rows = Array.from(document.querySelectorAll(".setting-item")).filter(row =>
      row.querySelector(".setting-label > span")?.textContent?.trim() === title);
    return { row: rows.length === 1 ? rows[0] : null, rowCount: rows.length };
  }

  function strategyControl() {
    const found = settingRow(STRATEGY_TITLE);
    const controls = found.row === null ? [] : Array.from(found.row.querySelectorAll(".setting-control .dropdown-trigger"));
    return { row: found.row, rowCount: found.rowCount, trigger: controls.length === 1 ? controls[0] : null, controlCount: controls.length };
  }

  function retentionControl() {
    const found = settingRow(RETENTION_TITLE);
    const inputs = found.row === null ? [] : Array.from(found.row.querySelectorAll('.setting-control input[type="number"]'));
    const buttons = found.row === null ? [] : Array.from(found.row.querySelectorAll('.setting-control button[title="重置"]'));
    return {
      row: found.row,
      rowCount: found.rowCount,
      input: inputs.length === 1 ? inputs[0] : null,
      inputCount: inputs.length,
      reset: buttons.length === 1 ? buttons[0] : null,
      resetCount: buttons.length,
    };
  }

  function autoBackControl() {
    const found = settingRow(AUTO_BACK_TITLE);
    const controls = found.row === null
      ? []
      : Array.from(found.row.querySelectorAll(".setting-control .dropdown-trigger"));
    return {
      row: found.row,
      trigger: controls.length === 1 ? controls[0] : null,
      rowCount: found.rowCount,
      controlCount: controls.length,
    };
  }

  function autoBackFromUi() {
    const control = autoBackControl();
    const label = control.trigger?.querySelector(".dropdown-value")?.textContent?.trim();
    return label && Object.hasOwn(AUTO_BACK_VALUES, label) ? AUTO_BACK_VALUES[label] : null;
  }

  function validAutoBack(value) {
    return typeof value === "string" && Object.hasOwn(AUTO_BACK_LABELS, value);
  }

  function strategyFromUi() {
    const control = strategyControl();
    const label = control.trigger?.querySelector(".dropdown-value")?.textContent?.trim();
    return label && Object.hasOwn(STRATEGY_VALUES, label) ? STRATEGY_VALUES[label] : null;
  }

  function uiDays() {
    const control = retentionControl();
    if (control.input === null) return null;
    const number = Number(control.input.value);
    return Number.isSafeInteger(number) && number >= 1 && number <= 3650 ? number : null;
  }

  async function readStored() {
    const dbGet = window.ztools?.internal?.dbGet;
    if (typeof dbGet !== "function") return null;
    try {
      const value = await dbGet.call(window.ztools.internal, "settings-general");
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function validStrategy(value) {
    return value === "remember" || value === "cursor" || value === "primary" || value === "lastActive";
  }

  function validDays(value, allowMissing) {
    return allowMissing && value === undefined || Number.isSafeInteger(value) && value >= 1 && value <= 3650;
  }

  async function facts(extra = {}) {
    const stored = await readStored();
    const strategy = strategyControl();
    const retention = retentionControl();
    const storedStrategy = stored !== null && validStrategy(stored.windowPositionStrategy)
      ? stored.windowPositionStrategy : null;
    const storedDays = stored !== null && validDays(stored.clipboardRetentionDays, false)
      ? stored.clipboardRetentionDays : null;
    return {
      routeGeneral: routeGeneral(),
      strategyControlUnique: strategy.rowCount === 1 && strategy.controlCount === 1,
      uiStrategy: strategyFromUi(),
      storedStrategy,
      retentionControlUnique: retention.rowCount === 1 && retention.inputCount === 1,
      uiDays: uiDays(),
      storedDays,
      resetButtonUnique: retention.rowCount === 1 && retention.resetCount === 1,
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : null,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
      ...extra,
    };
  }

  async function waitFor(predicate) {
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const current = await facts();
      if (predicate(current)) return current;
      await delay(100);
    }
    return facts();
  }

  async function inspect(probeId) {
    await send("childGeneralPoliciesInspect", await facts(), probeId);
  }

  async function selectStrategy(probeId, expected) {
    const control = strategyControl();
    let selectionDispatched = false;
    const expectedLabel = STRATEGY_LABELS[expected];
    if (control.trigger !== null && expectedLabel) {
      control.trigger.click();
      await delay(25);
      const dropdown = control.trigger.closest(".dropdown");
      const items = dropdown === null ? [] : Array.from(dropdown.querySelectorAll(".dropdown-menu .dropdown-item"));
      const matches = items.filter(item => item.querySelector(".dropdown-item-label")?.textContent?.trim() === expectedLabel);
      if (matches.length === 1) {
        matches[0].click();
        selectionDispatched = true;
      }
    }
    const final = await waitFor(value => value.uiStrategy === expected && value.storedStrategy === expected);
    await send("childGeneralPoliciesSelectStrategy", { ...final, selectionDispatched }, probeId);
  }

  async function setRetention(probeId, expected) {
    const control = retentionControl();
    const days = Number(expected);
    let inputDispatched = false;
    let changeDispatched = false;
    let blurDispatched = false;
    if (control.input !== null && Number.isSafeInteger(days) && days >= 1 && days <= 3650) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (typeof setter === "function") {
        setter.call(control.input, String(days));
        inputDispatched = control.input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        changeDispatched = control.input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
        blurDispatched = control.input.dispatchEvent(new Event("blur"));
      }
    }
    const final = await waitFor(value => value.uiDays === days && value.storedDays === days);
    await send("childGeneralPoliciesSetRetention", {
      ...final,
      inputDispatched,
      changeDispatched,
      blurDispatched,
    }, probeId);
  }

  async function resetRetention(probeId) {
    const control = retentionControl();
    let resetDispatched = false;
    if (control.reset !== null) {
      control.reset.click();
      resetDispatched = true;
    }
    const final = await waitFor(value => value.uiDays === 180 && value.storedDays === 180);
    await send("childGeneralPoliciesResetRetention", { ...final, resetDispatched }, probeId);
  }

  async function autoBackFacts(extra = {}) {
    const stored = await readStored();
    const control = autoBackControl();
    return {
      routeGeneral: routeGeneral(),
      controlUnique: control.rowCount === 1 && control.controlCount === 1,
      uiValue: autoBackFromUi(),
      dbValue: stored !== null && validAutoBack(stored.autoBackToSearch)
        ? stored.autoBackToSearch : null,
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : null,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
      ...extra,
    };
  }

  async function waitForAutoBack(predicate) {
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const current = await autoBackFacts();
      if (predicate(current)) return current;
      await delay(100);
    }
    return autoBackFacts();
  }

  async function inspectAutoBack(probeId) {
    const final = await waitForAutoBack(value =>
      value.controlUnique && validAutoBack(value.uiValue) && value.dbValue === value.uiValue);
    await send("childGeneralPoliciesAutoBackInspect", final, probeId);
  }

  async function selectAutoBack(probeId, expected) {
    const control = autoBackControl();
    const expectedLabel = AUTO_BACK_LABELS[expected];
    let selectionDispatched = false;
    let optionSetValid = false;
    if (control.trigger !== null && expectedLabel) {
      control.trigger.click();
      await delay(25);
      const dropdown = control.trigger.closest(".dropdown");
      const items = dropdown === null
        ? []
        : Array.from(dropdown.querySelectorAll(".dropdown-menu .dropdown-item"));
      const labels = items.map(item =>
        item.querySelector(".dropdown-item-label")?.textContent?.trim()).filter(Boolean);
      const expectedLabels = Object.values(AUTO_BACK_LABELS);
      optionSetValid = labels.length === expectedLabels.length
        && new Set(labels).size === expectedLabels.length
        && expectedLabels.every(label => labels.includes(label));
      const matches = items.filter(item =>
        item.querySelector(".dropdown-item-label")?.textContent?.trim() === expectedLabel);
      if (optionSetValid && matches.length === 1) {
        matches[0].click();
        selectionDispatched = true;
      }
    }
    const final = await waitForAutoBack(value => value.uiValue === expected && value.dbValue === expected);
    await send("childGeneralPoliciesAutoBackSelect", {
      ...final,
      selectionDispatched,
      optionSetValid,
    }, probeId);
  }

  async function inspectAutoBackMain(probeId) {
    const input = document.querySelector("input.search-input");
    const pluginDomPresent = document.querySelector(".app-container__plugin") !== null;
    const searchDomPresent = document.querySelector(
      ".app-container:not(.app-container__plugin) .scrollable-content",
    ) !== null && document.querySelector(".plugin-placeholder") === null;
    await send("mainGeneralPoliciesAutoBackInspect", {
      inputFound: input instanceof HTMLInputElement,
      queryEmpty: input instanceof HTMLInputElement && input.value.length === 0,
      pluginDomPresent,
      searchDomPresent,
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : null,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_GENERAL_POLICIES__ = {
    generalPoliciesInspect: inspect,
    generalPoliciesSelectStrategy: selectStrategy,
    generalPoliciesSetRetention: setRetention,
    generalPoliciesResetRetention: resetRetention,
    generalPoliciesAutoBackInspect: inspectAutoBack,
    generalPoliciesAutoBackSelect: selectAutoBack,
    generalPoliciesAutoBackMainInspect: inspectAutoBackMain,
  };
})();
