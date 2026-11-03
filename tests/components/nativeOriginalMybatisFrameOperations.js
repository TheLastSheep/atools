// Fixed original MyBatis SQL formatter controls only; no service/API is invoked by this adapter.
(function () {
  var caseId = "local-mybatis-sql-formatter-head";
  var operations = ["valid-input", "edge-input", "invalid-input", "format", "clear"];
  function visible(element) {
    if (!element || element.disabled || element.closest("[hidden],[inert]")) return false;
    for (var current = element; current && current !== document; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }
  function unique(selector) {
    var nodes = Array.from(document.querySelectorAll(selector));
    if (nodes.length !== 1 || !visible(nodes[0])) throw Error("Original MyBatis control is missing, hidden or ambiguous");
    return nodes[0];
  }
  function state() {
    var input = document.querySelector("#input"), output = document.querySelector("#output");
    var error = document.querySelector("#errorMsg"), info = document.querySelector("#infoBar");
    var ready = !!input && !!output && !!error && !!info;
    try { unique(".header-actions button.btn-ghost"); unique(".header-actions button.btn-primary"); } catch (_) { ready = false; }
    return { ready: ready, input: (input && input.value || "").slice(0, 512),
      output: (output && output.value || "").slice(0, 512), info: (info && info.textContent || "").trim().slice(0, 64),
      errorVisible: !!error && getComputedStyle(error).display !== "none",
      errorText: (error && error.textContent || "").trim().slice(0, 256) };
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
    if (!authorized(operation, envelope)) throw Error("Unapproved original MyBatis UI operation");
    if (operation === "valid-input" || operation === "edge-input" || operation === "invalid-input") {
      var input = unique("#input");
      input.value = operation === "valid-input"
        ? "[DEBUG] - ==>  Preparing: SELECT * FROM user WHERE id = ? AND name = ?\n[DEBUG] - ==> Parameters: 1(Integer), Tom(String)"
        : operation === "edge-input"
          ? "[DEBUG] - ==>  Preparing: SELECT * FROM user WHERE name = ? AND note = ? AND id = ?\n[DEBUG] - ==> Parameters: O'Neil(String), null, 7(Integer)"
          : "[DEBUG] - ==> Parameters: invalid(Integer)";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (operation === "format") unique(".header-actions button.btn-primary").click();
    else unique(".header-actions button.btn-ghost").click();
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = {
    get caseId() { return window.__ATOOLS_PUBLISHED_ACTIVE_CASE__ === caseId ? caseId : null; }, state: state, perform: perform
  };
})();
