// Read-only observer/control for the exact HEAD Developer Codec Tools page.
(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_PANEL_TOKEN__";
  let disposed = false;
  const control = selector => document.querySelector(selector);

  function snapshot() {
    const operation = control("#operation");
    const input = control("#inputText");
    const output = control("#outputText");
    const run = control("#runOperation");
    const appInitialized = operation instanceof HTMLSelectElement
      && Array.from(operation.options).some(option => option.value === "base64-encode")
      && Array.from(operation.options).some(option => option.value === "base64-decode");
    return {
      ready: document.readyState !== "loading" && appInitialized
        && input instanceof HTMLTextAreaElement && output instanceof HTMLTextAreaElement && run instanceof HTMLButtonElement,
      appInitialized,
      opaqueOrigin: location.origin === "null",
      pageHasTauri: "__TAURI_INTERNALS__" in window,
      appControlsPresent: operation instanceof HTMLSelectElement && input instanceof HTMLTextAreaElement
        && output instanceof HTMLTextAreaElement && run instanceof HTMLButtonElement,
    };
  }

  function runObservation() {
    const operation = control("#operation");
    const run = control("#runOperation");
    const status = control("#statusLine");
    const appInitialized = operation instanceof HTMLSelectElement
      && Array.from(operation.options).some(option => option.value === "base64-encode")
      && Array.from(operation.options).some(option => option.value === "base64-decode");
    const text = status instanceof HTMLElement ? (status.textContent || "").trim() : "";
    const phase = text === "处理中" ? "processing" : text === "完成" ? "complete"
      : status instanceof HTMLElement && status.classList.contains("error") ? "error" : text ? "other" : "empty";
    return { appInitialized, handlerStarted: phase === "processing" || phase === "complete" || phase === "error", completionObserved: phase === "complete",
      runDisabled: run instanceof HTMLButtonElement && run.disabled, statusPhase: phase };
  }

  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const tick = () => {
        if (disposed) return reject(Error("DEVELOPER_CODEC_PROBE_DISPOSED"));
        if (predicate()) return resolve(true);
        if (Date.now() >= deadline) return reject(Error("DEVELOPER_CODEC_OPERATION_TIMEOUT"));
        window.setTimeout(tick, 20);
      };
      tick();
    });
  }

  async function runOriginal(operationId, inputValue, expected) {
    const operation = control("#operation");
    const input = control("#inputText");
    const output = control("#outputText");
    const run = control("#runOperation");
    const status = control("#statusLine");
    if (!(operation instanceof HTMLSelectElement) || !(input instanceof HTMLTextAreaElement)
      || !(output instanceof HTMLTextAreaElement) || !(run instanceof HTMLButtonElement)
      || !(status instanceof HTMLElement) || inputValue.length > 128 || expected.length > 256) {
      throw Error("DEVELOPER_CODEC_CONTROL_UNAVAILABLE");
    }
    operation.value = operationId;
    operation.dispatchEvent(new Event("change", { bubbles: true }));
    input.value = inputValue;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    run.click();
    if (operationId === "base64-decode" && inputValue === "%%%bad") {
      await waitFor(() => status.classList.contains("error") && output.value === "");
      return { operationSelected: operation.value === operationId, errorVisible: true,
        outputCleared: output.value === "", expectedErrorShown: status.textContent === "Base64 输入格式无效" };
    }
    await waitFor(() => status.textContent === "完成");
    return { operationSelected: operation.value === operationId, completed: status.textContent === "完成",
      outputMatchesExpected: output.value === expected };
  }

  async function handle(event) {
    const message = event.data;
    if (disposed || event.source !== window.parent || message?.kind !== "atools-developer-codec-head-probe"
      || message?.token !== token || !Number.isSafeInteger(message?.id)) return;
    if (message.operation === "dispose") {
      disposed = true;
      window.removeEventListener("message", handle);
      return;
    }
    let result;
    try {
      if (message.operation === "state") result = snapshot();
      else if (message.operation === "encode") result = await runOriginal("base64-encode", message.input, message.expected);
      else if (message.operation === "decode") result = await runOriginal("base64-decode", message.input, message.expected);
      else if (message.operation === "malformed") result = await runOriginal("base64-decode", "%%%bad", "");
      else throw Error("DEVELOPER_CODEC_OPERATION_UNKNOWN");
      window.parent.postMessage({ kind: "atools-developer-codec-head-result", token,
        id: message.id, result, errorCode: null }, "*");
    } catch (error) {
      const code = error instanceof Error && /^DEVELOPER_CODEC_[A-Z_]+$/.test(error.message)
        ? error.message : "DEVELOPER_CODEC_OPERATION_FAILED";
      window.parent.postMessage({ kind: "atools-developer-codec-head-result", token,
        id: message.id, result: null, errorCode: code, observation: runObservation() }, "*");
    }
  }
  window.addEventListener("message", handle);
})();
