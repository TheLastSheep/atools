// Fixed button operations on the unchanged original calculator. No private React state or service calls.
(function () {
  var allowed = { "clear": "AC", "one": "1", "plus": "+", "two": "2", "equals": "=", "nine": "9", "divide": "÷", "three": "3" };
  var supportedCases = ["local-my-calculator-zpx", "converted-my-calculator-source"];
  function activeCaseId() {
    var caseId = window.__ATOOLS_PUBLISHED_ACTIVE_CASE__;
    return supportedCases.indexOf(caseId) >= 0 ? caseId : null;
  }
  function button(label) {
    var matches = Array.from(document.querySelectorAll(".calculator-buttons button")).filter(function (node) { return node.textContent.trim() === label; });
    if (matches.length !== 1) throw Error("Original calculator button missing or ambiguous: " + label);
    var node = matches[0];
    if (node.disabled || node.closest("[hidden],[inert]")) throw Error("Original calculator button is unavailable");
    for (var current = node; current && current !== document; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") throw Error("Original calculator control is hidden");
    }
    return node;
  }
  function text(selector) { return (document.querySelector(selector)?.textContent || "").trim().slice(0, 128); }
  function state() {
    var labels = Object.values(allowed);
    var ready = !!document.querySelector(".calculator") && !!document.querySelector(".display-expression") && !!document.querySelector(".display-result");
    try { labels.forEach(button); } catch (_) { ready = false; }
    return { ready: ready, expression: text(".display-expression"), result: text(".display-result"),
      visibilityState: document.visibilityState, documentHidden: document.hidden };
  }
  function approvedEnvelope(operation, data) {
    var caseId = activeCaseId();
    if (!caseId) return false;
    if (data === undefined) return true;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return Object.keys(data).length === keys.length && Object.keys(data).every(function (key) { return keys.includes(key); })
      && data.kind === "atools-published-probe" && data.caseId === caseId && data.operation === operation
      && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 128
      && typeof data.id === "string" && data.id.length > 0 && data.id.length <= 128
      && typeof data.documentNonce === "string" && /^[a-f0-9]{32}$/.test(data.documentNonce)
      && Array.isArray(data.workerLeaseSessions) && data.workerLeaseSessions.length === 0;
  }
  function perform(operation, data) {
    if (!Object.prototype.hasOwnProperty.call(allowed, operation) || !approvedEnvelope(operation, data)) throw Error("Unapproved original calculator operation");
    button(allowed[operation]).click();
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { get caseId() { return activeCaseId(); }, state: state, perform: perform };
})();
