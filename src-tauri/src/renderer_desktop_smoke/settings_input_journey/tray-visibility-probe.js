(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_TRAY_VISIBILITY__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const LABEL = "显示托盘图标";
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

  function selectedControl() {
    const rows = Array.from(document.querySelectorAll(".setting-item")).filter((row) =>
      row.querySelector(".setting-label > span")?.textContent?.trim() === LABEL);
    const row = rows.length === 1 ? rows[0] : null;
    const controls = row === null
      ? []
      : Array.from(row.querySelectorAll(".setting-control input[type=checkbox]"));
    return { input: controls.length === 1 ? controls[0] : null, rowCount: rows.length, controlCount: controls.length };
  }

  async function storedEnabled() {
    const dbGet = window.ztools?.internal?.dbGet;
    if (typeof dbGet !== "function") return null;
    try {
      const stored = await dbGet("settings-general");
      if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
      const value = Object.prototype.hasOwnProperty.call(stored, "showTrayIcon")
        ? stored.showTrayIcon : true;
      return typeof value === "boolean" ? value : null;
    } catch (_) {
      return null;
    }
  }

  function uiFacts() {
    const selected = selectedControl();
    return {
      routeGeneral: routeGeneral(),
      controlUnique: selected.rowCount === 1 && selected.controlCount === 1,
      uiEnabled: selected.input === null ? null : selected.input.checked,
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : null,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
    };
  }

  async function inspect(probeId) {
    await send("childTrayVisibilityInspect", {
      ...uiFacts(),
      storedEnabled: await storedEnabled(),
    }, probeId);
  }

  async function setEnabled(probeId, expected) {
    const input = selectedControl().input;
    const validExpected = typeof expected === "boolean";
    const value = validExpected ? expected : null;
    let inputDispatched = false;
    let changeDispatched = false;
    if (input !== null && validExpected) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
      if (typeof setter === "function") {
        setter.call(input, value);
        inputDispatched = input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        changeDispatched = input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      }
    }
    let stored = null;
    if (!validExpected) {
      stored = await storedEnabled();
    } else {
      const deadline = Date.now() + 4500;
      while (Date.now() < deadline) {
        stored = await storedEnabled();
        if (input?.checked === value && stored === value) break;
        await delay(200);
      }
    }
    await send("childTrayVisibilitySet", {
      ...uiFacts(),
      storedEnabled: stored,
      inputDispatched,
      changeDispatched,
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_TRAY_VISIBILITY__ = {
    inspect,
    setEnabled,
    trayVisibilityInspect: inspect,
    trayVisibilitySet: setEnabled,
  };
})();
