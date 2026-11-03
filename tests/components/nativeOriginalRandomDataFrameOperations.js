// Fixed original Random Data settings controls only; no generator API is called by this adapter.
(function () {
  var caseId = "local-random-data-head";
  var command = "ATools Random UUID Acceptance";
  var operations = ["state", "sample", "add-command"];
  function visible(element) {
    if (!element || element.closest("[hidden],[inert]")) return false;
    for (var current = element; current && current !== document; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function unique(selector, requireEnabled) {
    var nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length !== 1 || !visible(nodes[0])) throw Error("Original Random Data control is missing, hidden or ambiguous");
    if (requireEnabled && (nodes[0].disabled || nodes[0].readOnly)) throw Error("Original Random Data control is unavailable");
    return nodes[0];
  }
  function state() {
    var row = document.querySelector('[data-code="randomUuid"]');
    var input = row && row.querySelector('.chip-input[data-action="add-command"]');
    var preview = row && row.querySelector(".preview-box pre");
    var ready = !!row && !!input && !!document.querySelector("#saveButton");
    try { unique('[data-code="randomUuid"] [data-action="sample"]', true); unique("#saveButton"); }
    catch (_) { ready = false; }
    return { ready: ready, enabled: !!row && !!row.querySelector('[data-action="enabled"]:checked'),
      commands: row ? Array.from(row.querySelectorAll(".command-chip span")).map(node => (node.textContent || "").trim()).slice(0, 32) : [],
      input: input ? input.value.slice(0, 128) : "", preview: preview ? (preview.textContent || "").trim().slice(0, 128) : "",
      saveStatus: (document.querySelector("#saveButton")?.textContent || "").trim().slice(0, 32) };
  }
  function authorized(operation, envelope) {
    if (window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ !== caseId || !operations.includes(operation)) return false;
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return envelope && typeof envelope === "object" && !Array.isArray(envelope)
      && Object.keys(envelope).length === keys.length && Object.keys(envelope).every(function (key) { return keys.includes(key); })
      && envelope.kind === "atools-published-probe" && envelope.caseId === caseId && envelope.operation === operation
      && typeof envelope.token === "string" && envelope.token.length > 0 && envelope.token.length <= 128
      && typeof envelope.id === "string" && envelope.id.length > 0 && envelope.id.length <= 128
      && typeof envelope.documentNonce === "string" && /^[a-f0-9]{32}$/.test(envelope.documentNonce)
      && Array.isArray(envelope.workerLeaseSessions) && envelope.workerLeaseSessions.length === 0;
  }
  function perform(operation, envelope) {
    if (!authorized(operation, envelope)) throw Error("Unapproved original Random Data UI operation");
    var row = unique('[data-code="randomUuid"]');
    if (operation === "sample") unique('[data-code="randomUuid"] [data-action="sample"]', true).click();
    if (operation === "add-command") {
      var input = unique('[data-code="randomUuid"] .chip-input[data-action="add-command"]', true);
      input.focus(); input.value = command; input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    }
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = {
    get caseId() { return window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ === caseId ? caseId : null; }, state: state, perform: perform
  };
})();
