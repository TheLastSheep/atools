// Fixed values and original DOM controls only; never invokes a calculator or clipboard function.
(function () {
  function unique(selector) {
    var nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) throw Error("Original subnet control missing or ambiguous: " + selector);
    var node = nodes[0];
    if (node.disabled || node.readOnly || node.closest("[hidden],[inert]")) throw Error("Original subnet control unavailable");
    for (var current = node; current && current.nodeType === 1; current = current.parentElement) {
      var style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") throw Error("Original subnet control hidden");
    }
    return node;
  }
  function input(selector, value) {
    var node = unique(selector); node.focus(); node.value = value; node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function state() {
    return { ready: !!document.querySelector("#ipInput") && !!document.querySelector("#maskInput") && !!document.querySelector("#calcSection button"),
      ip: (document.querySelector("#ipInput") || {}).value || "", mask: (document.querySelector("#maskInput") || {}).value || "",
      hostCount: (document.querySelector("#hostCountInput") || {}).value || "", startIp: (document.querySelector("#startIpInput") || {}).value || "",
      reverse: !!document.querySelector("#reverseSection.active"),
      resultText: (document.querySelector("#resultArea") || {}).textContent || "",
      rows: Array.from(document.querySelectorAll("#resultArea .result-row")).slice(0, 16).map(function (row) {
        return { label: (row.querySelector(".result-label") || {}).textContent || "", value: (row.querySelector(".result-value") || {}).textContent || "" };
      }), visibilityState: document.visibilityState, documentHidden: document.hidden };
  }
  function approved(operation, data) {
    if (data === undefined) return true;
    if (!data || typeof data !== "object" || Array.isArray(data)) return false;
    var keys = ["kind", "token", "id", "caseId", "operation", "documentNonce", "workerLeaseSessions"];
    return Object.keys(data).length === keys.length && Object.keys(data).every(function (key) { return keys.includes(key); })
      && data.kind === "atools-published-probe" && data.caseId === "local-subnet-calculator" && data.operation === operation
      && typeof data.token === "string" && data.token.length > 0 && data.token.length <= 128
      && typeof data.id === "string" && data.id.length > 0 && data.id.length <= 128
      && typeof data.documentNonce === "string" && /^[a-f0-9]{32}$/.test(data.documentNonce)
      && Array.isArray(data.workerLeaseSessions) && data.workerLeaseSessions.length === 0;
  }
  function calc(ip, mask) { input("#ipInput", ip); input("#maskInput", mask); unique("#calcSection button").click(); }
  function reverse(count) { input("#hostCountInput", count); input("#startIpInput", "192.168.1.100"); unique("#reverseSection button").click(); }
  function perform(operation, data) {
    if (!["calculate-24", "calculate-31", "calculate-32", "invalid-mask", "reverse-tab", "reverse-30", "reverse-zero"].includes(operation)
      || !approved(operation, data)) throw Error("Unapproved original subnet operation");
    if (operation === "calculate-24") calc("192.168.1.100", "/24");
    else if (operation === "calculate-31") calc("10.0.0.1", "/31");
    else if (operation === "calculate-32") calc("10.0.0.1", "/32");
    else if (operation === "invalid-mask") calc("192.168.1.100", "255.0.255.0");
    else if (operation === "reverse-tab") {
      var tabs = document.querySelectorAll(".tabs .tab");
      if (tabs.length !== 2 || tabs[1].textContent.trim() !== "子网逆算") throw Error("Original subnet reverse tab missing or ambiguous");
      tabs[1].click();
    } else reverse(operation === "reverse-30" ? "30" : "0");
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-subnet-calculator", state: state, perform: perform };
})();
