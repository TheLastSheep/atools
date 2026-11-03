// Fixed original CodeMirror UI controls; editor writes use native browser editing commands only.
(function () {
  var alpha = "ATools plain alpha document line 1234567890\nAlpha fixed body\nSecond line.";
  var beta = "# ATools markdown beta document\n\n- first\n- second";
  var results = [], focusAttempt = null;
  function unique(selector) {
    var nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) throw Error("Original plain-text control missing or ambiguous: " + selector);
    var node = nodes[0];
    if (node.disabled || node.readOnly || node.closest("[hidden],[inert],[aria-hidden='true']")) throw Error("Original plain-text control unavailable");
    for (var current = node; current && current.nodeType === 1; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") throw Error("Original plain-text control hidden");
    }
    return node;
  }
  function editor() { return unique('.cm-content[contenteditable="true"]'); }
  function focusState(node) {
    var rect = node && node.getBoundingClientRect(), active = document.activeElement;
    var style = node ? getComputedStyle(node) : null, inertAncestors = [];
    for (var ancestor = node; ancestor && ancestor.nodeType === 1 && inertAncestors.length < 12; ancestor = ancestor.parentElement) {
      if (ancestor.inert === true) inertAncestors.push(ancestor.tagName.toLowerCase().slice(0, 24));
    }
    var activation = navigator.userActivation;
    return { documentHasFocus: typeof document.hasFocus === "function" && document.hasFocus() === true,
      visibilityState: document.visibilityState, documentHidden: document.hidden,
      editorActive: !!node && active === node, editorConnected: !!node && node.isConnected,
      activeElementKind: active === node ? "editor" : active === document.body ? "body" : active === document.documentElement ? "document" : "other",
      activeElementTag: active ? active.tagName.toLowerCase().slice(0, 32) : "",
      editorOwnerDocumentMatches: !!node && node.ownerDocument === document,
      editorRootIsDocument: !!node && node.getRootNode() === document,
      editorContentEditable: !!node && node.getAttribute("contenteditable") === "true",
      editorIsContentEditable: !!node && node.isContentEditable === true,
      computedStyle: style ? { webkitUserModify: String(style.webkitUserModify || "").slice(0, 32),
        userSelect: String(style.userSelect || "").slice(0, 32), pointerEvents: String(style.pointerEvents || "").slice(0, 32) } : null,
      inertAncestors: inertAncestors,
      userActivation: activation ? { isActive: activation.isActive === true, hasBeenActive: activation.hasBeenActive === true } : null,
      editorTabIndex: node ? node.tabIndex : null,
      editorWidth: rect && Number.isFinite(rect.width) ? Math.min(10000, Math.max(0, rect.width)) : 0,
      editorHeight: rect && Number.isFinite(rect.height) ? Math.min(10000, Math.max(0, rect.height)) : 0 };
  }
  function state() {
    var node = null; try { node = editor(); } catch (_) {}
    var lines = node ? Array.from(node.querySelectorAll(".cm-line")) : [];
    var drawer = document.querySelector(".editor-drawer");
    return { ready: !!node && !!document.querySelector('button[title="新建文稿"]'),
      text: node ? (lines.length ? lines.map(function (line) { return line.textContent || ""; }).join("\n") : node.textContent || "").slice(0, 4096) : "",
      mode: document.querySelector('button[title="切换纯文本"]') ? "markdown" : "text",
      previewHeading: (document.querySelector(".editor-md-preview h1") || {}).textContent || "",
      previewItems: Array.from(document.querySelectorAll(".editor-md-preview li")).map(function (item) { return (item.textContent || "").slice(0, 100); }),
      drawerOpen: !!drawer,
      drafts: Array.from(document.querySelectorAll(".editor-drawer-item")).slice(0, 5).map(function (row) {
        return { title: (row.querySelector(".editor-drawer-item-title") || {}).textContent || "", active: row.classList.contains("active") };
      }), focusDiagnostics: focusState(node), focusAttempt: focusAttempt, editCommandResults: results.slice(),
      nativeUiInputObservation: window.__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__
        ? window.__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__.snapshot() : undefined };
  }
  function approved(operation, data) {
    if (data === undefined) return true;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return Object.keys(data).length === keys.length && Object.keys(data).every(function (key) { return keys.includes(key); })
      && data.kind === "atools-published-probe" && data.caseId === "local-plain-text" && data.operation === operation
      && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 128
      && typeof data.id === "string" && data.id.length > 0 && data.id.length <= 128
      && typeof data.documentNonce === "string" && /^[a-f0-9]{32}$/.test(data.documentNonce)
      && Array.isArray(data.workerLeaseSessions) && data.workerLeaseSessions.length === 0;
  }
  function enter(value) {
    var node = editor(); results = []; focusAttempt = null;
    var before = focusState(node);
    if (before.visibilityState !== "visible" || before.documentHidden
      || before.editorWidth <= 0 || before.editorHeight <= 0) throw Error("Original plain-text requires positively visible focused native document");
    node.focus({ preventScroll: true });
    focusAttempt = { before: before, immediateAfter: focusState(node), focusCalls: 1, editCommandsBeforeSnapshot: results.length };
    if (document.activeElement !== node || !document.hasFocus()) throw Error("Original plain-text editor focus failed; no fallback input is permitted");
    results.push({ command: "selectAll", accepted: document.execCommand("selectAll") === true });
    if (!results[0].accepted) throw Error("Original plain-text browser selectAll failed");
    results.push({ command: "insertText", accepted: document.execCommand("insertText", false, value) === true });
    if (!results[1].accepted) throw Error("Original plain-text browser insertText failed");
  }
  function click(selector) { unique(selector).click(); }
  function selectDraft(title) {
    var rows = Array.from(document.querySelectorAll(".editor-drawer-item")).filter(function (row) {
      return (row.querySelector(".editor-drawer-item-title") || {}).textContent === title;
    });
    if (rows.length !== 1) throw Error("Original plain-text fixed draft missing or ambiguous");
    // Click the original row; never its nested delete control.
    rows[0].click();
  }
  function perform(operation, data) {
    var nativeUiOperation = ["native-ui-alpha", "native-ui-beta", "native-ui-stop"].includes(operation);
    if (!["enter-alpha", "enter-beta", "new-draft", "markdown", "open-list", "select-alpha", "select-beta",
      "native-ui-alpha", "native-ui-beta", "native-ui-stop"].includes(operation)
      || nativeUiOperation && (data === undefined || !approved(operation, data)) || !approved(operation, data))
      throw Error("Unapproved original plain-text operation");
    if (operation === "enter-alpha") enter(alpha);
    else if (operation === "enter-beta") enter(beta);
    else if (operation === "native-ui-alpha" || operation === "native-ui-beta" || operation === "native-ui-stop") {
      var observer = window.__ATOOLS_NATIVE_PLAIN_TEXT_UI_INPUT__;
      if (!observer) throw Error("Native plain-text OS input observer unavailable");
      if (operation === "native-ui-stop") observer.stop();
      else observer.begin(operation.slice("native-ui-".length));
    }
    else if (operation === "new-draft") click('button[title="新建文稿"]');
    else if (operation === "markdown") click('button[title="切换 Markdown"]');
    else if (operation === "open-list") click('button[title="文稿列表"]');
    else selectDraft(operation === "select-alpha" ? alpha.split("\n")[0].slice(0, 20) : beta.split("\n")[0].slice(0, 20));
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-plain-text", state: state, perform: perform };
})();
