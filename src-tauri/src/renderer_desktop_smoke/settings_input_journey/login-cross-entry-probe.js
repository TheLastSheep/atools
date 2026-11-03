(() => {
  "use strict";
  if (window.__ATOOLS_SETTINGS_INPUT_LOGIN_CROSS_ENTRY__) return;

  const token = window.__ATOOLS_SETTINGS_INPUT_TOKEN__;
  const unknownObservation = () => ({
    ready: null,
    controlUnique: null,
    enabled: null,
    disabled: null,
    indeterminate: null,
    overviewUnknown: null,
    hasConflictMessage: null,
    saveState: null,
  });

  async function waitForNative(method) {
    const deadline = performance.now() + 1000;
    while (performance.now() < deadline) {
      const native = window.__ATOOLS_FALLBACK_SETTINGS_NATIVE__;
      if (native && typeof native[method] === "function") return native;
      const remaining = Math.max(0, deadline - performance.now());
      if (remaining === 0) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(25, remaining)));
    }
    return null;
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

  async function action(operation, method, probeId, withPlaceholder = false) {
    const native = window.__ATOOLS_FALLBACK_SETTINGS_NATIVE__;
    let evidence;
    try {
      const ready = native && typeof native[method] === "function" ? native : await waitForNative(method);
      if (!ready) throw new Error("probe-missing");
      evidence = await ready[method]();
    } catch (_) {
      const unknown = unknownObservation();
      evidence = withPlaceholder
        ? { ok: false, dispatched: null, reason: "probe-failed", before: unknown, after: unknown, placeholderObserved: null }
        : { ok: false, dispatched: null, reason: "probe-failed", before: unknown, after: unknown };
    }
    return send(operation, evidence, probeId);
  }

  async function inspect(probeId) {
    const native = window.__ATOOLS_FALLBACK_SETTINGS_NATIVE__;
    let evidence = unknownObservation();
    try {
      const ready = native && typeof native.inspect === "function" ? native : await waitForNative("inspect");
      if (!ready) throw new Error("probe-missing");
      evidence = await ready.inspect();
    } catch (_) {}
    return send("fallbackLoginInspect", evidence, probeId);
  }

  const bridge = Object.freeze({
    fallbackLoginInspect: inspect,
    fallbackLoginDisable: probeId => action("fallbackLoginDisable", "disable", probeId),
    fallbackLoginSave: probeId => action("fallbackLoginSave", "editPlaceholder", probeId, true),
    fallbackLoginConflict: probeId => action("fallbackLoginConflict", "conflict", probeId),
    fallbackLoginReread: probeId => action("fallbackLoginReread", "reread", probeId),
  });
  Object.defineProperty(window, "__ATOOLS_SETTINGS_INPUT_LOGIN_CROSS_ENTRY__", {
    configurable: false,
    enumerable: false,
    writable: false,
    value: bridge,
  });
})();
