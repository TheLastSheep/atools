(function installMainPanelReadProbe(token, runId, pid) {
  "use strict";

  const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const inputElement = () => document.querySelector("input.search-input");
  const invoke = window.__TAURI__?.core?.invoke;

  async function inspect(stage, probeId) {
    const deadline = Date.now() + 1800;
    let input = inputElement();
    while (Date.now() < deadline) {
      input = inputElement();
      const documentReady = stage === "shown" || stage === "reshown"
        ? document.visibilityState === "visible" && document.hasFocus() &&
          input !== null && document.activeElement === input
        : stage === "hidden"
          ? input !== null && !document.hasFocus()
          : input !== null;
      if (documentReady) break;
      await delay(30);
    }

    input = inputElement();
    const evidence = {
      schemaVersion: 1,
      stage,
      documentVisibility: document.visibilityState,
      documentHasFocus: typeof document.hasFocus === "function" ? document.hasFocus() : null,
      inputFound: input !== null,
      inputFocused: input !== null && document.activeElement === input,
    };
    if (typeof invoke !== "function") return;
    try {
      await invoke("main_panel_probe", { token, runId, pid, probeId, evidence });
    } catch (_) {
      // Rust owns protocol errors and the bounded native report.
    }
  }

  const probe = Object.freeze({
    capture(stage, probeId) {
      if (!new Set(["baseline", "shown", "hidden", "reshown"]).has(stage)) return;
      if (!Number.isSafeInteger(probeId) || probeId < 1) return;
      return inspect(stage, probeId);
    },
  });

  Object.defineProperty(window, "__ATOOLS_MAIN_PANEL_PROBE__", {
    value: probe,
    configurable: false,
    enumerable: false,
    writable: false,
  });

  if (typeof invoke === "function") void inspect("ready", 0);
})("__ATOOLS_MAIN_PANEL_TOKEN__", "__ATOOLS_MAIN_PANEL_RUN_ID__", __ATOOLS_MAIN_PANEL_PID__);
