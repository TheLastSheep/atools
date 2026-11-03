// Fixed operations over the unchanged Calculation Paper DOM; the original React input handler performs all arithmetic.
(function () {
  var expressions = ["6*7", "8*9"];
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
  function setInput(node, value) {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function perform(operation, data) {
    var fields = rows();
    if (operation === "clear-tail-expression") {
      if (data && data.value !== undefined) throw Error("Clear Calculation Paper operation takes no expression payload");
      var current = fields.slice().reverse().find(function (field) { return field.value !== ""; });
      required(current, "current formula to clear");
      setInput(current, "");
      return state();
    }
    if (operation !== "set-tail-expression") throw Error("Unknown original Calculation Paper operation");
    var tail = fields.length && fields[fields.length - 1].value === "" ? fields[fields.length - 1] : null;
    required(tail, "automatically appended blank formula row");
    var value = data && data.value;
    if (typeof value !== "string" || expressions.indexOf(value) < 0) throw Error("Unapproved Calculation Paper expression");
    setInput(tail, value);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = {
    caseId: "local-calculation-paper-head", state: state, perform: perform,
  };
})();
