(() => {
  const token = __ATOOLS_MULTIWEBVIEW_TOKEN__;
  const operation = __ATOOLS_MULTIWEBVIEW_OPERATION__;
  const resourcePath = __ATOOLS_MULTIWEBVIEW_RESOURCE__;
  const invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

  function errorCode(error) {
    const message = typeof error === "string" ? error : String(error && error.message || error);
    if (/unknown command|command not found|not registered/i.test(message)) return "UNKNOWN_COMMAND";
    return "REJECTED";
  }

  async function attempt(command, args, includeBoolean) {
    if (typeof invoke !== "function") return { ok: false, code: "NATIVE_INVOKE_UNAVAILABLE" };
    try {
      const value = await invoke(command, args);
      const result = { ok: true };
      if (includeBoolean && typeof value === "boolean") result.value = value;
      return result;
    } catch (error) {
      return { ok: false, code: errorCode(error) };
    }
  }

  async function report(evidence) {
    if (typeof invoke !== "function") return;
    try {
      await invoke("multiwebview_probe", { token, operation, evidence });
    } catch (_) {
      // The native harness records missing reports by its bounded timeout.
    }
  }

  async function run() {
    const api = window.ztools;
    if (operation === "main-ipc") {
      const settings = await attempt("get_setting", { key: "settings-general" }, false);
      const visible = await attempt("plugin:window|is_visible", { label: "main" }, true);
      const resource = await attempt("plugin:fs|exists", { path: resourcePath }, true);
      await report({
        getGeneralSettings: settings,
        windowIsVisible: visible,
        resourceExists: resource,
      });
      return;
    }
    if (operation === "window-expand") {
      if (!api || typeof api.resizeWindow !== "function") {
        await report({ ok: false, code: "ZTOOLS_WINDOW_API_UNAVAILABLE" });
        return;
      }
      api.resizeWindow(420);
      setTimeout(() => void report({ ok: true }), 60);
      return;
    }
    if (operation === "window-reset") {
      if (!api || typeof api.resetWindow !== "function") {
        await report({ ok: false, code: "ZTOOLS_WINDOW_API_UNAVAILABLE" });
        return;
      }
      try {
        await api.resetWindow();
        await report({ ok: true });
      } catch (error) {
        await report({ ok: false, code: errorCode(error) });
      }
      return;
    }
    if (operation === "window-hide") {
      if (!api || typeof api.hideWindow !== "function") {
        await report({ ok: false, code: "ZTOOLS_WINDOW_API_UNAVAILABLE" });
        return;
      }
      api.hideWindow();
      setTimeout(() => void report({ ok: true }), 60);
      return;
    }
    if (operation === "main-alive") {
      await report({
        ok: document.readyState === "complete" || document.readyState === "interactive",
        path: window.location.pathname,
      });
      return;
    }
    if (operation === "main-focus") {
      await report({
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
        path: window.location.pathname,
      });
      return;
    }
    await report({ ok: false, code: "UNKNOWN_PROBE_OPERATION" });
  }

  void run();
})();
