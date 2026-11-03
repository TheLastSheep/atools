// Fixed-input DOM operations for the unchanged original local Content Workbench package.
(function () {
  var inputText = "  A\t  B  \n\n\nRead **ZTools** at [site](https://z.tools). #效率 ";
  function required(node, label) { if (!node) throw Error("Original Content Workbench UI missing: " + label); return node; }
  function state() {
    return { ready: !!document.querySelector("#input") && !!document.querySelector("#output")
        && !!document.querySelector("#normalize") && !!document.querySelector("#social"),
      input: document.querySelector("#input")?.value || "", output: document.querySelector("#output")?.textContent || "" };
  }
  function perform(operation, data) {
    data = data || {};
    if (operation === "set-input") {
      if (data.value !== inputText) throw Error("Unapproved synthetic Content Workbench input");
      var input = required(document.querySelector("#input"), "content input");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, inputText);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else if (operation === "normalize" || operation === "plain" || operation === "links" || operation === "social") {
      var id = { normalize: "#normalize", plain: "#plain", links: "#links", social: "#social" }[operation];
      required(document.querySelector(id), operation + " button").click();
    } else throw Error("Unknown original Content Workbench operation: " + operation);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "local-content-workbench", state: state, perform: perform };
})();
