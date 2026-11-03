(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const LABEL = "呼出快捷键";
  const HOTKEYS = new Set([
    "Command+Ctrl+Option+Shift+F10",
    "Command+Ctrl+Option+Shift+F11",
    "Command+Ctrl+Option+Shift+F12",
  ]);
  const CODES = new Set(["F10", "F11", "F12"]);
  const RAW_MUTATION_COMMAND = "plugin:global-shortcut|unregister_all";
  const REJECTION_TOAST = "快捷键设置失败: 快捷键设置失败，请尝试其他组合。";
  const ACL_DENIALS = new Set([
    "Command plugin:global-shortcut|unregister_all not allowed by ACL",
    "global-shortcut.unregister_all not allowed on origin [local]. Please create a capability that has this origin on the context field.\n\nFound matches for: \n\nPermissions associated with this command: global-shortcut:allow-unregister-all",
    "global-shortcut.unregister_all not allowed. Permissions associated with this command: global-shortcut:allow-unregister-all",
  ]);
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

  function selectedControl() {
    const rows = Array.from(document.querySelectorAll(".setting-item")).filter(row =>
      row.querySelector(".setting-label > span")?.textContent?.trim() === LABEL);
    const row = rows.length === 1 ? rows[0] : null;
    const controls = row === null ? [] : Array.from(row.querySelectorAll(".setting-control .hotkey-input"));
    return { input: controls.length === 1 ? controls[0] : null, rowCount: rows.length, controlCount: controls.length };
  }

  function acceptedHotkey(value) {
    return typeof value === "string" && HOTKEYS.has(value) ? value : null;
  }

  async function storedHotkey() {
    const dbGet = window.ztools?.internal?.dbGet;
    if (typeof dbGet !== "function") return null;
    try {
      const stored = await dbGet("settings-general");
      if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return null;
      return acceptedHotkey(stored.hotkey);
    } catch (_) {
      return null;
    }
  }

  function uiFacts() {
    const selected = selectedControl();
    return {
      routeGeneral: routeGeneral(),
      controlUnique: selected.rowCount === 1 && selected.controlCount === 1,
      displayValue: selected.input === null ? null : acceptedHotkey(selected.input.textContent?.trim()),
      documentHidden: typeof document.hidden === "boolean" ? document.hidden : null,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
    };
  }

  function hasRejectionToast() {
    return Array.from(document.querySelectorAll(".toast.toast-error")).some(node =>
      node.textContent?.trim() === REJECTION_TOAST);
  }

  async function inspect(probeId) {
    await send("childMainHotkeyInspect", { ...uiFacts(), storedValue: await storedHotkey() }, probeId);
  }

  function isAclDenied(error) {
    const message = typeof error === "string"
      ? error
      : error !== null && typeof error === "object" && typeof error.message === "string"
        ? error.message
        : null;
    return message !== null && ACL_DENIALS.has(message);
  }

  async function rawMutation(probeId, operation) {
    let aclDenied = false;
    const valid = operation === "mainRawHotkeyMutation" || operation === "childRawHotkeyMutation";
    const invoke = window.__TAURI_INTERNALS__?.invoke;
    if (valid && typeof invoke === "function") {
      try {
        await invoke(RAW_MUTATION_COMMAND, {});
      } catch (error) {
        aclDenied = isAclDenied(error);
      }
    }
    await send(operation, { aclDenied }, probeId);
  }

  function dispatchKeyboard(type, code, key, modifiers = {}) {
    document.dispatchEvent(new KeyboardEvent(type, {
      code,
      key,
      bubbles: true,
      cancelable: true,
      ...modifiers,
    }));
  }

  function dispatchChord(code) {
    const states = [
      { code: "MetaLeft", key: "Meta", metaKey: true },
      { code: "ControlLeft", key: "Control", metaKey: true, ctrlKey: true },
      { code: "AltLeft", key: "Alt", metaKey: true, ctrlKey: true, altKey: true },
      { code: "ShiftLeft", key: "Shift", metaKey: true, ctrlKey: true, altKey: true, shiftKey: true },
    ];
    for (const state of states) dispatchKeyboard("keydown", state.code, state.key, state);
    const modifiers = { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true };
    dispatchKeyboard("keydown", code, code, modifiers);
    dispatchKeyboard("keyup", code, code, modifiers);
  }

  async function record(probeId, code, expectedDisplay, expectedStored) {
    let clickDispatched = false;
    let keyDownDispatched = false;
    let keyUpDispatched = false;
    let rejectionObserved = false;
    const accepted = typeof code === "string" && CODES.has(code)
      && acceptedHotkey(expectedDisplay) !== null && acceptedHotkey(expectedStored) !== null;
    const selected = selectedControl();
    const staleRejection = code === "F12" && hasRejectionToast();
    if (accepted && routeGeneral() && selected.input !== null && !staleRejection) {
      try {
        selected.input.click();
        clickDispatched = true;
        await delay(30);
        dispatchChord(code);
        keyDownDispatched = true;
        keyUpDispatched = true;

        const deadline = Date.now() + 4500;
        while (Date.now() < deadline) {
          const [facts, storedValue] = await Promise.all([Promise.resolve(uiFacts()), storedHotkey()]);
          if (code === "F12") rejectionObserved = rejectionObserved || hasRejectionToast();
          const valuesMatch = facts.displayValue === expectedDisplay && storedValue === expectedStored;
          if (valuesMatch && (code !== "F12" || rejectionObserved)) break;
          await delay(100);
        }
      } catch (_) {
        // The owner-bound callback below preserves the failed dispatch facts.
      }
    }
    await send("childMainHotkeyRecord", {
      ...uiFacts(),
      storedValue: await storedHotkey(),
      clickDispatched,
      keyDownDispatched,
      keyUpDispatched,
      rejectionObserved,
    }, probeId);
  }

  window.__ATOOLS_SETTINGS_INPUT_MAIN_HOTKEY__ = {
    inspect,
    record,
    mainHotkeyRawMutation: rawMutation,
    mainHotkeyInspect: inspect,
    mainHotkeyRecord: record,
  };
})();
