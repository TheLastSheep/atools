(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_WINDOW_OPACITY__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const LABEL = "窗口不透明度";
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
      : Array.from(row.querySelectorAll(".setting-control.opacity-control input[type=range].slider"));
    return { row, input: controls.length === 1 ? controls[0] : null, rowCount: rows.length, controlCount: controls.length };
  }

  async function storedOpacity() {
    const dbGet = window.ztools?.internal?.dbGet;
    if (typeof dbGet !== "function") return null;
    try {
      const stored = await dbGet("settings-general");
      const value = stored?.opacity;
      return stored !== null && typeof stored === "object" && !Array.isArray(stored)
        && typeof value === "number" && Number.isFinite(value) && value >= 0.3 && value <= 1
        ? value : null;
    } catch (_) {
      return null;
    }
  }

  function opacityFacts() {
    const selected = selectedControl();
    const input = selected.input;
    const uiOpacity = input === null ? null : Number(input.value);
    const minimum = input === null ? null : Number(input.min);
    const maximum = input === null ? null : Number(input.max);
    const step = input === null ? null : Number(input.step);
    return {
      routeGeneral: routeGeneral(),
      controlUnique: selected.rowCount === 1 && selected.controlCount === 1,
      rangeValid: input !== null && minimum === 0.3 && maximum === 1 && step === 0.01,
      uiOpacity: input !== null && Number.isFinite(uiOpacity) && uiOpacity >= 0.3 && uiOpacity <= 1
        ? uiOpacity : null,
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : null,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
    };
  }

  async function inspect(probeId) {
    const facts = opacityFacts();
    const storedOpacityValue = await storedOpacity();
    await send("childWindowOpacityInspect", {
      ...facts,
      storedOpacity: storedOpacityValue,
    }, probeId);
  }

  async function setOpacity(probeId, expectedValue) {
    const selected = selectedControl();
    const value = Number(expectedValue);
    const input = selected.input;
    let inputDispatched = false;
    let changeDispatched = false;
    if (input !== null && (value === 0.65 || value === 1)) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (typeof setter === "function") {
        setter.call(input, String(value));
        inputDispatched = input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
        changeDispatched = input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      }
    }

    let storedOpacityValue = null;
    const deadline = Date.now() + 4500;
    while (Date.now() < deadline) {
      const uiOpacity = opacityFacts().uiOpacity;
      storedOpacityValue = await storedOpacity();
      if (uiOpacity !== null && Math.abs(uiOpacity - value) <= 0.001
          && storedOpacityValue !== null && Math.abs(storedOpacityValue - value) <= 0.001) break;
      await delay(200);
    }
    await send("childWindowOpacitySet", {
      ...opacityFacts(),
      storedOpacity: storedOpacityValue,
      inputDispatched,
      changeDispatched,
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_WINDOW_OPACITY__ = {
    inspect,
    setOpacity,
    windowOpacityInspect: inspect,
    windowOpacitySet: setOpacity,
  };
})();
