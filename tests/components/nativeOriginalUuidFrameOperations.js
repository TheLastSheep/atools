// Read-only observations from the unchanged UUID UI; host sub-input events drive all business operations.
(function () {
  function unique(selector) {
    var nodes = document.querySelectorAll(selector);
    return nodes.length === 1 ? nodes[0] : null;
  }
  function text(selector, limit) { return (unique(selector)?.textContent || "").trim().slice(0, limit); }
  function state() {
    var input = unique("input#input"), output = unique("#out");
    var rows = output ? Array.from(output.querySelectorAll(".row:not(.action)")).slice(0, 12).map(function (node) {
      return { label: (node.querySelector(".label")?.textContent || "").trim().slice(0, 128),
        value: (node.querySelector(".value")?.textContent || "").trim().slice(0, 256) };
    }) : [];
    return { ready: !!input && !!output && !!unique("#badge") && !!unique("#meta") && !!unique("#selftest-fail"),
      input: input ? input.value.slice(0, 256) : "", badge: text("#badge", 128), meta: text("#meta", 256),
      error: text("#out .error", 512), selftestError: text("#selftest-fail", 512), rows: rows,
      visibilityState: document.visibilityState, documentHidden: document.hidden };
  }
  function approvedEnvelope(operation, data) {
    if (data === undefined) return true;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return Object.keys(data).length === keys.length && Object.keys(data).every(function (key) { return keys.includes(key); })
      && data.kind === "atools-published-probe" && data.caseId === "local-uuid-kit" && data.operation === operation
      && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 128
      && typeof data.id === "string" && data.id.length > 0 && data.id.length <= 128
      && typeof data.documentNonce === "string" && /^[a-f0-9]{32}$/.test(data.documentNonce)
      && Array.isArray(data.workerLeaseSessions) && data.workerLeaseSessions.length === 0;
  }
  function perform(operation, data) {
    if (operation !== "inspect-result" || !approvedEnvelope(operation, data)) throw Error("Unapproved original UUID operation");
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-uuid-kit", state: state, perform: perform };
})();
