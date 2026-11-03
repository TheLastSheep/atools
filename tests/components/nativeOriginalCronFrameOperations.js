// Fixed-input DOM operations for the unchanged original local Cron package.
(function () {
  var expressions = ["0 10/5 * * * ?"];
  function required(node, label) { if (!node) throw Error("Original Cron UI missing: " + label); return node; }
  function approved(value, list) { if (typeof value !== "string" || list.indexOf(value) < 0) throw Error("Unapproved synthetic Cron input"); return value; }
  function setValue(node, value) {
    var proto = node.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
    node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    if (node.tagName !== "SELECT") node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function state() {
    var version = document.querySelector("#cronVersion"), result = document.querySelector("#cronResult");
    var mode = document.querySelector('input[name="minutes"]:checked');
    return { ready: !!version && !!result && !!mode && !!document.querySelector("#min_start_step"),
      version: version ? version.value : "", expression: result ? result.value : "",
      minuteMode: mode ? mode.value : "", minuteStart: document.querySelector("#min_start_val")?.value || "",
      minuteStep: document.querySelector("#min_start_step")?.value || "",
      versionInfo: document.querySelector("#versionInfo")?.textContent?.trim() || "" };
  }
  function perform(operation, data) {
    data = data || {};
    if (operation === "select-version") setValue(required(document.querySelector("#cronVersion"), "version selector"), approved(data.value, ["linux", "spring"]));
    else if (operation === "choose-minute-step") {
      required(document.querySelector("#min_start"), "minute start radio").click();
      setValue(required(document.querySelector("#min_start_val"), "minute start value"), approved(data.start, ["0", "10"]));
      setValue(required(document.querySelector("#min_start_step"), "minute step value"), approved(data.step, ["5"]));
    } else if (operation === "set-expression") {
      var result = required(document.querySelector("#cronResult"), "expression input");
      setValue(result, approved(data.value, expressions));
    } else throw Error("Unknown original Cron operation: " + operation);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-cron", state: state, perform: perform };
})();
