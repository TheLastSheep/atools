// Fixed text entry through original textarea input handlers; no render, storage or filesystem service calls.
(function () {
  var values = { "enter-level-text": "root\n=src\n==index.js", "enter-tree-text": "root\n└── docs\n    └── README.md" };
  function textarea(selector) {
    var nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) throw Error("Original ASCII textarea missing or ambiguous");
    var node = nodes[0];
    if (node.disabled || node.readOnly || node.closest("[hidden],[inert]")) throw Error("Original ASCII textarea is unavailable");
    for (var current = node; current && current !== document; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") throw Error("Original ASCII textarea is hidden");
    }
    return node;
  }
  function state() {
    var input, output, ready = true;
    try { input = textarea("textarea#text"); output = textarea("textarea#tree"); } catch (_) { ready = false; }
    return { ready: ready, input: input ? input.value.slice(0, 4096) : "", output: output ? output.value.slice(0, 4096) : "",
      visibilityState: document.visibilityState, documentHidden: document.hidden };
  }
  function approvedEnvelope(operation, data) {
    if (data === undefined) return true;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return Object.keys(data).length === keys.length && Object.keys(data).every(function (key) { return keys.includes(key); })
      && data.kind === "atools-published-probe" && data.caseId === "local-ascii-tree" && data.operation === operation
      && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 128
      && typeof data.id === "string" && data.id.length > 0 && data.id.length <= 128
      && typeof data.documentNonce === "string" && /^[a-f0-9]{32}$/.test(data.documentNonce)
      && Array.isArray(data.workerLeaseSessions) && data.workerLeaseSessions.length === 0;
  }
  function perform(operation, data) {
    if (!Object.prototype.hasOwnProperty.call(values, operation) || !approvedEnvelope(operation, data)) throw Error("Unapproved original ASCII operation");
    var node = textarea(operation === "enter-level-text" ? "textarea#text" : "textarea#tree");
    node.focus(); node.value = values[operation]; node.dispatchEvent(new Event("input", { bubbles: true }));
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-ascii-tree", state: state, perform: perform };
})();
