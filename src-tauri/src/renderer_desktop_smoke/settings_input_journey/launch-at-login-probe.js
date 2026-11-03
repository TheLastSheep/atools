(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_LAUNCH_AT_LOGIN__) return;

  const LABEL = "开机自动启动";
  const ERROR_PREFIX = "更新开机启动设置失败:";
  const ERROR_MAP = Object.freeze({
    SETTINGS_LAUNCH_AT_LOGIN_CONFLICT: "conflict",
    SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED: "approval",
    SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION: "legacy",
    SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE: "unavailable",
    SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED: "unsupported",
    SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED: "recovery",
  });
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

  function controls() {
    const rows = Array.from(document.querySelectorAll(".setting-item")).filter(row =>
      row.querySelector(".setting-label > span")?.textContent?.trim() === LABEL);
    const inputs = rows.length === 1
      ? Array.from(rows[0].querySelectorAll('.setting-control .toggle input[type="checkbox"]'))
      : [];
    return { rowCount: rows.length, inputCount: inputs.length, input: inputs.length === 1 ? inputs[0] : null };
  }

  async function waitFor(predicate, timeoutMs = 2500) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      try { if (predicate()) return true; } catch (_) {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return false;
  }

  async function ensureGeneral() {
    if (!routeGeneral()) {
      const entries = Array.from(document.querySelectorAll(".settings-sidebar .menu-list .menu-item"))
        .filter(item => item.querySelector(".menu-label")?.textContent?.trim() === "通用设置");
      if (entries.length !== 1) return false;
      entries[0].click();
    }
    return waitFor(() => {
      const control = controls();
      return routeGeneral() && control.rowCount === 1 && control.inputCount === 1;
    }, 2500);
  }

  async function getter() {
    const read = window.ztools?.internal?.getLaunchAtLogin;
    if (typeof read !== "function") return null;
    try {
      const value = await read.call(window.ztools.internal);
      return typeof value === "boolean" ? value : null;
    } catch (_) {
      return null;
    }
  }

  async function boundedGetter() {
    let timer;
    try {
      return await Promise.race([
        getter(), new Promise(resolve => { timer = setTimeout(() => resolve(null), 3000); }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function inspect(probeId) {
    const evidence = { routeGeneral: false, controlUnique: false, uiEnabled: null, getterEnabled: null };
    try {
      evidence.routeGeneral = await ensureGeneral();
      evidence.getterEnabled = await boundedGetter();
      if (evidence.routeGeneral && typeof evidence.getterEnabled === "boolean") {
        await waitFor(() => {
          const control = controls();
          return control.rowCount === 1 && control.inputCount === 1
            && control.input.checked === evidence.getterEnabled;
        }, 1000);
      }
      const control = controls();
      evidence.controlUnique = control.rowCount === 1 && control.inputCount === 1;
      evidence.uiEnabled = control.input === null ? null : control.input.checked === true;
    } catch (_) {}
    await send("childLaunchAtLoginInspect", evidence, probeId);
  }

  function errorKind(error) {
    let code;
    try { code = error?.code; } catch (_) { return "other"; }
    if (typeof code !== "string") return "other";
    return Object.prototype.hasOwnProperty.call(ERROR_MAP, code) ? ERROR_MAP[code] : "other";
  }

  async function click(probeId, mode) {
    const evidence = {
      routeGeneral: false, controlUnique: false, clickDispatched: false,
      uiEnabled: null, getterEnabled: null, errorCode: null,
    };
    let originalError;
    let capturedError = null;
    let patchedConsole = false;
    try {
      evidence.routeGeneral = await ensureGeneral();
      const control = controls();
      evidence.controlUnique = control.rowCount === 1 && control.inputCount === 1;
      if (mode !== "enable" && mode !== "conflict") return send("childLaunchAtLoginClick", evidence, probeId);
      const expectedBefore = mode === "enable" ? false : true;
      const expectedAfter = !expectedBefore;
      if (!evidence.routeGeneral || !evidence.controlUnique || control.input.checked !== expectedBefore) {
        evidence.uiEnabled = control.input === null ? null : control.input.checked === true;
        return send("childLaunchAtLoginClick", evidence, probeId);
      }

      originalError = console.error;
      console.error = function (...args) {
        if (args[0] === ERROR_PREFIX) capturedError = errorKind(args[1]);
        if (typeof originalError === "function") return Reflect.apply(originalError, this, args);
      };
      patchedConsole = true;
      control.input.click();
      evidence.clickDispatched = true;
      if (mode === "enable") {
        evidence.getterEnabled = await boundedGetter();
        await waitFor(() => control.input.checked === expectedAfter && evidence.getterEnabled === expectedAfter, 1500);
      } else {
        await waitFor(() => capturedError === "conflict" && control.input.checked === true, 1500);
        evidence.errorCode = capturedError;
      }
      evidence.uiEnabled = control.input.checked === true;
    } catch (_) {
      evidence.errorCode = evidence.errorCode ?? "other";
    } finally {
      if (patchedConsole) {
        try { console.error = originalError; } catch (_) {}
      }
    }
    if (mode === "enable" && capturedError !== null) evidence.errorCode = capturedError;
    await send("childLaunchAtLoginClick", evidence, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_LAUNCH_AT_LOGIN__ = Object.freeze({
    launchAtLoginInspect: inspect,
    launchAtLoginClick: click,
  });
})();
