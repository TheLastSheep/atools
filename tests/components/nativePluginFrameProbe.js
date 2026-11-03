// Installed by the opt-in native fixture in all frames; never shipped in the app.
(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_PANEL_TOKEN__";
  const errors = [];
  window.addEventListener("error", event => errors.push(String(event.message)));
  window.addEventListener("unhandledrejection", event => errors.push(String(event.reason?.message || event.reason)));
  function state() {
    return {
      title: document.title,
      text: document.body?.innerText || "",
      inputs: [...document.querySelectorAll("input,textarea")].map(node => ({ selector: node.id || node.className, placeholder: node.placeholder, value: node.value })),
      results: [...document.querySelectorAll(".result-item")].map(node => ({ label: node.querySelector(".result-item__label")?.textContent, value: node.querySelector(".result-item__value")?.textContent })),
      tree: document.querySelector(".CodeMirror")?.CodeMirror?.getValue() || "",
      errors: [...errors],
      noTauri: !("__TAURI_INTERNALS__" in window),
      sourceOpaque: location.origin === "null",
      moduleEntry: [...document.scripts].some(script => script.type.trim().toLowerCase() === "module" && !!script.src),
      styles: [...document.styleSheets].length,
      bodyWidth: document.body?.scrollWidth || 0,
      viewportWidth: innerWidth,
      documentHasFocus: document.hasFocus(),
      visibilityState: document.visibilityState,
      activeElementTag: document.activeElement?.tagName || "",
    };
  }
  window.addEventListener("message", async event => {
    const message = event.data;
    if (event.source !== window.parent || message?.token !== token || message?.kind !== "atools-panel-probe") return;
    const traceEscape = (phase, extra = {}) => {
      const frameMonotonicMs = performance.now();
      window.parent.postMessage({ kind: "atools-panel-escape-trace", token, id: message.id, measurementId: message.measurementId,
        trace: { phase, frameMonotonicMs, frameTimeOriginMs: performance.timeOrigin, epochMs: performance.timeOrigin + frameMonotonicMs,
          visibilityState: document.visibilityState, documentHasFocus: document.hasFocus(), ...extra } }, "*");
    };
    if (message.operation === "escape") traceEscape("frame-received");
    let error = "";
    try {
      const target = message.selector ? document.querySelector(message.selector) : null;
      if (message.operation === "input") {
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) throw Error("Missing original input " + message.selector);
        target.focus(); target.value = message.value;
        target.dispatchEvent(new Event("input", { bubbles: true }));
        target.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (message.operation === "click") {
        if (!(target instanceof HTMLElement)) throw Error("Missing original button " + message.selector);
        target.click();
      } else if (message.operation === "focus") {
        if (!(target instanceof HTMLElement)) throw Error("Missing original focus target " + message.selector);
        target.focus();
      } else if (message.operation === "files-enter") {
        window.dispatchEvent(new CustomEvent("atools-plugin-enter", { detail: { code: "file-tree", type: "files", payload: [{ path: message.path, isDirectory: true }] } }));
      } else if (message.operation === "escape") {
        // The actual host will destroy this frame on Escape; acknowledge before
        // dispatching so successful navigation cannot look like a probe timeout.
        window.parent.postMessage({ kind:"atools-panel-probe-result",token,id:message.id,error:"",state:state() },"*");
        const key = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
        traceEscape("before-keydown");
        (document.activeElement || document.body).dispatchEvent(key);
        traceEscape("after-keydown", { defaultPrevented: key.defaultPrevented });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    } catch (failure) { error = String(failure?.message || failure); }
    window.parent.postMessage({ kind: "atools-panel-probe-result", token, id: message.id, error, state: state() }, "*");
  });
})();
