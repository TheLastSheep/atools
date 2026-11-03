(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_HOTKEY_STARTUP__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const HOTKEY_LABEL = "呼出快捷键";
  const PLACEHOLDER_LABEL = "搜索框提示文字";
  const EMPTY_HOTKEY_PLACEHOLDER = "点击录制快捷键";
  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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

  function selectedControl(label) {
    const rows = Array.from(document.querySelectorAll(".setting-item")).filter(row =>
      row.querySelector(".setting-label > span")?.textContent?.trim() === label);
    const row = rows.length === 1 ? rows[0] : null;
    const selector = label === HOTKEY_LABEL
      ? ".setting-control .hotkey-input"
      : ".setting-control input";
    const controls = row === null ? [] : Array.from(row.querySelectorAll(selector));
    return { rowCount: rows.length, controlCount: controls.length, control: controls.length === 1 ? controls[0] : null };
  }

  async function settings() {
    const dbGet = window.ztools?.internal?.dbGet;
    if (typeof dbGet !== "function") return null;
    try {
      const value = await dbGet("settings-general");
      return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  async function currentShortcut() {
    const getCurrentShortcut = window.ztools?.internal?.getCurrentShortcut;
    if (typeof getCurrentShortcut !== "function") return null;
    try {
      const value = await getCurrentShortcut();
      return typeof value === "string" ? value : null;
    } catch (_) {
      return null;
    }
  }

  async function inspect(probeId) {
    const control = selectedControl(HOTKEY_LABEL);
    const [state, shortcut] = await Promise.all([settings(), currentShortcut()]);
    const value = {
      routeGeneral: routeGeneral(),
      hotkeyControlUnique: control.rowCount === 1 && control.controlCount === 1,
      hotkeyControlEmpty: control.control !== null
        && control.control.textContent?.trim() === EMPTY_HOTKEY_PLACEHOLDER,
      projectedHotkeyEmpty: state?.hotkey === "",
      currentShortcutEmpty: shortcut === "",
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : false,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : true,
    };
    await send("childHotkeyStartupInspect", value, probeId);
  }

  async function editPlaceholder(probeId, expectedBefore, nextValue) {
    const hotkey = selectedControl(HOTKEY_LABEL);
    const placeholder = selectedControl(PLACEHOLDER_LABEL);
    const [before, shortcut] = await Promise.all([settings(), currentShortcut()]);
    let placeholderClickDispatched = false;
    let inputDispatched = false;
    let changeDispatched = false;
    let placeholderStored = false;
    let projectedHotkeyEmpty = false;
    let currentShortcutEmpty = false;
    if (routeGeneral() && hotkey.control !== null && placeholder.control !== null
        && typeof expectedBefore === "string" && typeof nextValue === "string"
        && before?.placeholder === expectedBefore && before?.hotkey === ""
        && shortcut === "" && hotkey.control.textContent?.trim() === EMPTY_HOTKEY_PLACEHOLDER
        && placeholder.control.value === expectedBefore) {
      try {
        placeholder.control.click();
        placeholderClickDispatched = true;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        if (typeof setter === "function") {
          setter.call(placeholder.control, nextValue);
          placeholder.control.dispatchEvent(new Event("input", { bubbles: true }));
          inputDispatched = true;
          placeholder.control.dispatchEvent(new Event("change", { bubbles: true }));
          changeDispatched = true;
          placeholder.control.dispatchEvent(new Event("blur"));
          const deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            const [saved, current] = await Promise.all([settings(), currentShortcut()]);
            placeholderStored = saved?.placeholder === nextValue;
            projectedHotkeyEmpty = saved?.hotkey === "";
            currentShortcutEmpty = current === "";
            if (placeholderStored && projectedHotkeyEmpty && currentShortcutEmpty) break;
            await delay(100);
          }
        }
      } catch (_) {
        // Owner-bound evidence below records the unsuccessful control action.
      }
    }
    await send("childHotkeyStartupPlaceholder", {
      routeGeneral: routeGeneral(),
      hotkeyControlUnique: hotkey.rowCount === 1 && hotkey.controlCount === 1,
      placeholderControlUnique: placeholder.rowCount === 1 && placeholder.controlCount === 1,
      placeholderClickDispatched,
      inputDispatched,
      changeDispatched,
      placeholderStored,
      projectedHotkeyEmpty,
      currentShortcutEmpty,
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : false,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : true,
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_HOTKEY_STARTUP__ = {
    hotkeyStartupInspect: inspect,
    hotkeyStartupEditPlaceholder: editPlaceholder,
  };
})();
