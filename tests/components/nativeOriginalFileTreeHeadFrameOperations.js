// Fixture-only parent messaging for the exact original FileTree UI; never shipped in production.
(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_PANEL_TOKEN__";
  const MAX_RENDERED_TREE_CHARS = 4096;
  const documentId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 18)}`;
  let announcedReady = false;
  let disposed = false;
  function hasFileTreeRoot() {
    return document.readyState !== "loading" && Boolean(document.querySelector("#treeContainer")
      && document.querySelector("#selectFolder") && document.querySelector("#showHidden")
      && document.querySelector("#ignorePatterns"));
  }
  function announceReady() {
    if (disposed || announcedReady || !hasFileTreeRoot()) return;
    announcedReady = true;
    document.removeEventListener("DOMContentLoaded", announceReady);
    window.parent.postMessage({ kind: "atools-file-tree-head-ready", token, documentId }, "*");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announceReady, { once: true });
  else announceReady();
  function state() {
    const widget = document.querySelector(".CodeMirror");
    const editor = widget?.CodeMirror;
    const code = widget?.querySelector(".CodeMirror-code");
    let renderedTree = "";
    let renderedTreeOverflow = false;
    const lines = code?.querySelectorAll(".CodeMirror-line") ?? [];
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = typeof lines[index].innerText === "string" ? lines[index].innerText : "";
      const separator = index === 0 ? "" : "\n";
      const remaining = MAX_RENDERED_TREE_CHARS - renderedTree.length - separator.length;
      if (remaining < 0) {
        renderedTreeOverflow = true;
        break;
      }
      renderedTree += separator + lineText.slice(0, remaining);
      if (lineText.length > remaining || (index + 1 < lines.length && renderedTree.length === MAX_RENDERED_TREE_CHARS)) {
        renderedTreeOverflow = true;
        break;
      }
    }
    return {
      // CodeMirror's model remains separate from the rendered DOM evidence below.
      tree: typeof editor?.getValue === "function" ? editor.getValue() : "",
      renderedTree,
      renderedTreeChars: renderedTree.length,
      renderedTreeOverflow,
      renderedTreeAvailable: Boolean(code),
      hiddenChecked: document.querySelector("#showHidden")?.checked === true,
      ignoreValue: document.querySelector("#ignorePatterns")?.value ?? null,
      pageHasTauri: "__TAURI_INTERNALS__" in window,
      opaqueOrigin: location.origin === "null",
    };
  }
  function onMessage(event) {
    const message = event.data;
    if (disposed || event.source !== window.parent || message?.token !== token || message?.kind !== "atools-file-tree-head-probe") return;
    if (message.operation === "dispose") {
      if (message.documentId && message.documentId !== documentId) return;
      disposed = true;
      document.removeEventListener("DOMContentLoaded", announceReady);
      window.removeEventListener("message", onMessage);
      return;
    }
    let error = "";
    try {
      if (message.operation !== "ping" && message.documentId !== documentId) throw Error("FILE_TREE_FRAME_DOCUMENT_CHANGED");
      if (message.operation === "ping") {
        announceReady();
        window.parent.postMessage({ kind: "atools-file-tree-head-result", token, id: message.id, operation: "ping",
          documentId, ready: hasFileTreeRoot(), error: "" }, "*");
        return;
      } else if (message.operation === "state") {
        // Read-only model, CodeMirror widget DOM, and control-state snapshot.
      } else if (message.operation === "filter-enter") {
        const input = document.querySelector("#ignorePatterns");
        if (!(input instanceof HTMLInputElement)) throw Error("missing-ignore-input");
        input.value = String(message.value ?? "");
        input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
      } else if (message.operation === "hidden-toggle") {
        const checkbox = document.querySelector("#showHidden");
        if (!(checkbox instanceof HTMLInputElement)) throw Error("missing-hidden-toggle");
        checkbox.checked = message.checked === true;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      } else throw Error("unknown-operation");
    } catch (failure) { error = failure instanceof Error ? failure.message : "operation-failed"; }
    window.parent.postMessage({ kind: "atools-file-tree-head-result", token, id: message.id, operation: message.operation,
      documentId, error, state: state() }, "*");
  }
  window.addEventListener("message", onMessage);
})();
