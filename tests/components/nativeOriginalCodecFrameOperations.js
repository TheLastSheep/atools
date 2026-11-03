// Fixed-input DOM operations for the unchanged original local Developer Codec Tools package.
(function () {
  var values = { unicode: "你好 ATools", url: "A B+中", json: '{"name":"ATools","items":[1,2]}' , invalid: "{bad json}" };
  function required(node, label) { if (!node) throw Error("Original Codec UI missing: " + label); return node; }
  function state() {
    var category = document.querySelector(".category-item.active");
    return { ready: !!document.querySelector("#inputText") && !!document.querySelector("#outputText")
        && !!document.querySelector("#operation") && document.querySelector("#operation").options.length > 0
        && !!document.querySelector("#runOperation"), category: category?.dataset?.category || "",
      input: document.querySelector("#inputText")?.value || "", output: document.querySelector("#outputText")?.value || "",
      operation: document.querySelector("#operation")?.value || "", status: document.querySelector("#statusLine")?.textContent?.trim() || "" };
  }
  function input(value) {
    var node = required(document.querySelector("#inputText"), "input editor");
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function selectOperation(value) {
    var node = required(document.querySelector("#operation"), "operation selector");
    if (!Array.from(node.options).some(function (option) { return option.value === value; })) {
      throw Error("Original operation is not present in the active category: " + value);
    }
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("change", { bubbles: true }));
  }
  function selectCategory(value) {
    required(document.querySelector('.category-item[data-category="' + value + '"]'), value + " category").click();
  }
  function perform(operation, data) {
    data = data || {};
    if (operation === "select-encoding") selectCategory("encoding");
    else if (operation === "base64-encode") { selectCategory("encoding"); input(values.unicode); selectOperation("base64-encode"); required(document.querySelector("#runOperation"), "run button").click(); }
    else if (operation === "base64-decode") { selectCategory("encoding"); input("5L2g5aW9IEFUb29scw=="); selectOperation("base64-decode"); required(document.querySelector("#runOperation"), "run button").click(); }
    else if (operation === "url-encode") { selectCategory("encoding"); input(values.url); selectOperation("url-encode"); required(document.querySelector("#runOperation"), "run button").click(); }
    else if (operation === "json-format") { selectCategory("text"); input(values.json); selectOperation("json-format"); required(document.querySelector("#runOperation"), "run button").click(); }
    else if (operation === "json-invalid") { selectCategory("text"); input(values.invalid); selectOperation("json-format"); required(document.querySelector("#runOperation"), "run button").click(); }
    else throw Error("Unknown original Codec operation: " + operation);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-developer-codec-tools", state: state, perform: perform };
})();
