// Fixed-input DOM operations for the unchanged original local Calculation Paper React package.
(function () {
  var expressions = ["0.1+0.2", "1000+24", "1+", "6*7"];
  function required(node, label) { if (!node) throw Error("Original Calculation Paper UI missing: " + label); return node; }
  function rows() { return Array.from(document.querySelectorAll('.calc textarea[placeholder="计算公式"]')); }
  function state() {
    var fields = rows();
    return { ready: fields.length > 0 && !!document.querySelector("#root"),
      rows: fields.map(function (field) {
        var row = field.closest(".calc");
        return { expression: field.value, result: row?.querySelector(".result")?.textContent?.trim() || "" };
      }), trailingBlank: fields.length > 0 && fields[fields.length - 1].value === "" };
  }
  function perform(operation, data) {
    if (operation !== "set-tail-expression") throw Error("Unknown original Calculation Paper operation: " + operation);
    var value = data && data.value;
    if (typeof value !== "string" || expressions.indexOf(value) < 0) throw Error("Unapproved synthetic Calculation Paper expression");
    var fields = rows(), tail = fields.length && fields[fields.length - 1].value === "" ? fields[fields.length - 1] : null;
    required(tail, "automatically appended blank formula row");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(tail, value);
    tail.dispatchEvent(new Event("input", { bubbles: true }));
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-calculation-paper", state: state, perform: perform };
})();
