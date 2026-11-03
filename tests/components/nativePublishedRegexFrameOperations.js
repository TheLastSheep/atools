// Reviewed regex-editor DOM operations. This test adapter drives the original UI.
(function () {
  var writeAttempted = false;
  function state() {
    var pattern = document.querySelector(".pattern-input");
    var text = document.querySelector(".test-textarea");
    return {
      hasPattern: !!pattern, pattern: pattern && pattern.value || "",
      hasText: !!text, text: text && text.value || "",
      flags: Array.from(document.querySelectorAll(".flag-btn")).map(function (button) {
        return { label: String(button.textContent || "").trim(), title: String(button.title || ""), active: button.classList.contains("active") };
      }),
      error: document.querySelector(".error-msg") && document.querySelector(".error-msg").textContent.trim() || "",
      matchBadge: document.querySelector(".match-badge") && document.querySelector(".match-badge").textContent.trim() || "",
      captures: Array.from(document.querySelectorAll(".capture-item code")).map(function (node) { return node.textContent || ""; }),
      matched: Array.from(document.querySelectorAll(".matched")).map(function (node) { return node.textContent || ""; }),
      aiHint: document.querySelector(".ai-hint") && document.querySelector(".ai-hint").textContent.trim() || "",
      explanation: document.querySelector(".explanation-summary") && document.querySelector(".explanation-summary").textContent.trim() || "",
      canvasCount: document.querySelectorAll(".visual-regex-canvas").length,
      exampleNames: Array.from(document.querySelectorAll(".example-item")).map(function (node) { return node.textContent || ""; }),
      allAiModelsType: window.ztools && typeof window.ztools.allAiModels || "unavailable"
    };
  }
  function setInput(selector, value) {
    if (selector !== ".pattern-input" && selector !== ".test-textarea") throw new Error("Unapproved fixture selector");
    var node = document.querySelector(selector);
    if (!node) throw new Error("Published UI input missing: " + selector);
    var prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function paths() {
    var ztools = window.ztools, utools = window.utools;
    var electron = typeof window.require === "function" ? window.require("electron") : null;
    if (!ztools || typeof ztools.getPath !== "function" || !utools || typeof utools.getPath !== "function"
      || !electron || !electron.app || typeof electron.app.getPath !== "function") throw Error("Original path contract APIs missing");
    var expected = ztools.getPath("downloads"), agree = true, synchronous = typeof expected === "string";
    for (var i = 0; i < 120; i++) {
      var a = ztools.getPath("downloads"), b = utools.getPath("downloads"), c = electron.app.getPath("downloads");
      agree = agree && a === expected && b === expected && c === expected;
      synchronous = synchronous && typeof a === "string" && typeof b === "string" && typeof c === "string";
    }
    return { downloadsType: typeof expected, downloadsNonEmpty: typeof expected === "string" && expected.length > 0,
      allAliasesAgree: agree, allReadsSynchronous: synchronous, repeatedReadsPerAlias: 120,
      unknownZtoolsEmpty: ztools.getPath("ATOOLS_UNKNOWN_PATH") === "", unknownUtoolsEmpty: utools.getPath("ATOOLS_UNKNOWN_PATH") === "",
      unknownElectronEmpty: electron.app.getPath("ATOOLS_UNKNOWN_PATH") === "", actualPathValuesRecorded: false };
  }
  function perform(operation, data) {
    if (operation === "state") return state();
    if (operation === "set-pattern") { setInput(".pattern-input", data.value); return state(); }
    if (operation === "set-text") { setInput(".test-textarea", data.value); return state(); }
    if (operation === "toggle-global") {
      var button = Array.from(document.querySelectorAll(".flag-btn")).find(function (item) {
        return String(item.textContent || "").trim() === "g";
      });
      if (!button) throw new Error("Published g flag button missing");
      button.click(); return state();
    }
    if (operation === "load-chinese-example") {
      var item = Array.from(document.querySelectorAll(".example-item")).find(function (node) {
        return String(node.textContent || "").includes("中文字符");
      });
      if (!item) throw new Error("Reviewed 中文字符 example missing");
      item.click(); return state();
    }
    if (operation === "path-contract") return { pathContract: paths() };
    if (operation === "preload-write-synthetic-text") {
      if (writeAttempted) throw Error("Fixed synthetic export was already attempted");
      if (data && ["value", "text", "path", "extension"].some(function (key) { return Object.prototype.hasOwnProperty.call(data, key); })) {
        throw Error("Synthetic export does not accept caller-controlled text or paths");
      }
      if (!window.services || typeof window.services.writeTextFile !== "function") throw Error("Original writeTextFile service missing");
      writeAttempted = true;
      var result = window.services.writeTextFile("ATOOLS_PATH_SNAPSHOT_SYNTHETIC\n", ".txt");
      return { originalPreloadService: true, exportUiClicked: false, returnedString: typeof result === "string" && result.length > 0,
        returnedPathRecorded: false, fixedTextBytes: new TextEncoder().encode("ATOOLS_PATH_SNAPSHOT_SYNTHETIC\n").length };
    }
    throw new Error("Unknown native fixture operation");
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = { caseId: "regex-editor", state: state, perform: perform };
})();
