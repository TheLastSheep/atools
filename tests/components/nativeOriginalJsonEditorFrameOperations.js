// Fixed-input UI operations for the unchanged original local JSON Editor 1.7.2.
(function () {
  var validJson = '{"name":"ATools","nested":{"active":true,"items":[1,2]}}';
  var invalidJson = '{"name":"ATools","nested":[1,]}';
  var lastEditCommandResults = [];
  var focusObservation = { started: false, eventCount: 0, overflow: false, events: [], before: null, afterFrame: null };
  var focusObservationInput = null;
  var focusObservationListeners = null;
  var pendingFocusFrame = null;
  var MAX_FOCUS_EVENTS = 32;
  var capturedHTMLElementFocus = window.HTMLElement && window.HTMLElement.prototype.focus;
  function required(node, label) {
    if (!node) throw Error("Original JSON Editor UI missing: " + label);
    return node;
  }
  function editorInput() {
    return document.querySelector("#inputEditor textarea.inputarea");
  }
  function editorText() {
    var view = document.querySelector("#inputEditor .view-lines");
    if (!view) return "";
    var lines = Array.from(view.querySelectorAll(".view-line")).map(function (line) {
      return (line.innerText || line.textContent || "").replace(/\u00a0/g, " ");
    });
    var rendered = lines.length ? lines.join("\n") : (view.innerText || view.textContent || "");
    return rendered.replace(/\u00a0/g, " ").trim();
  }
  function safeVisibilityState() {
    var value = document.visibilityState;
    return value === "visible" || value === "hidden" || value === "prerender" ? value : "other";
  }
  function focusDiagnostics(textarea) {
    var active = document.activeElement;
    var rect = textarea && textarea.getBoundingClientRect ? textarea.getBoundingClientRect() : { width: 0, height: 0 };
    var activeClass = active && typeof active.className === "string" ? active.className : "";
    var ancestors = [];
    for (var node = textarea; node && node.nodeType === 1 && ancestors.length < 8; node = node.parentElement) {
      var style = null;
      try { style = window.getComputedStyle(node); } catch (_) {}
      var className = typeof node.className === "string" ? node.className : "";
      ancestors.push({
        tag: typeof node.tagName === "string" ? node.tagName.slice(0, 32).toLowerCase() : "",
        className: className.slice(0, 80),
        display: style && typeof style.display === "string" ? style.display.slice(0, 16) : "",
        visibility: style && typeof style.visibility === "string" ? style.visibility.slice(0, 16) : "",
        hidden: !!node.hidden,
        inert: !!node.inert,
        ariaHidden: node.getAttribute("aria-hidden") === "true"
      });
    }
    return {
      documentHasFocus: typeof document.hasFocus === "function" && document.hasFocus(),
      visibilityState: safeVisibilityState(),
      documentHidden: !!document.hidden,
      focusObservationFramePending: !!pendingFocusFrame,
      focusObservationAfterFrame: focusObservation.afterFrame ? Object.assign({}, focusObservation.afterFrame) : null,
      activeElementTag: active && typeof active.tagName === "string" ? active.tagName.slice(0, 32).toLowerCase() : "",
      activeElementClass: activeClass.slice(0, 80),
      textareaDisabled: !!(textarea && textarea.disabled),
      textareaReadOnly: !!(textarea && textarea.readOnly),
      textareaTabIndex: textarea && Number.isFinite(textarea.tabIndex) ? textarea.tabIndex : null,
      textareaConnected: !!(textarea && textarea.isConnected),
      textareaWidth: Number.isFinite(rect.width) ? Math.max(0, Math.min(10000, rect.width)) : 0,
      textareaHeight: Number.isFinite(rect.height) ? Math.max(0, Math.min(10000, rect.height)) : 0,
      textareaActive: !!textarea && active === textarea,
      ancestors: ancestors
    };
  }
  function focusPoint(textarea) {
    return {
      editorInputConnected: !!(textarea && textarea.isConnected),
      editorInputActive: !!textarea && document.activeElement === textarea
    };
  }
  function scheduleFocusAfterFrame() {
    if (pendingFocusFrame || typeof requestAnimationFrame !== "function") return;
    var token = {};
    pendingFocusFrame = token;
    token.id = requestAnimationFrame(function () {
      if (pendingFocusFrame !== token) return;
      pendingFocusFrame = null;
      var current = editorInput();
      var point = focusPoint(current);
      focusObservation.afterFrame = {
        sameEditorInput: current === focusObservationInput,
        editorInputConnected: point.editorInputConnected,
        editorInputActive: point.editorInputActive
      };
    });
  }
  function recordFocusEvent(event) {
    if (!focusObservation.started) return;
    var target = event && event.target;
    var node = target && target.nodeType === 1 ? target : null;
    var editor = document.querySelector("#inputEditor");
    var textarea = editorInput();
    var point = focusPoint(textarea);
    var record = {
      type: typeof event.type === "string" ? event.type.slice(0, 16) : "",
      isTrusted: event.isTrusted === true,
      targetTag: node && typeof node.tagName === "string" ? node.tagName.slice(0, 80).toLowerCase() : "",
      targetClass: node && typeof node.getAttribute === "function" ? String(node.getAttribute("class") || "").slice(0, 80) : "",
      inEditor: !!editor && !!target && typeof editor.contains === "function" && editor.contains(target),
      isEditorInput: !!textarea && target === textarea,
      editorInputActive: point.editorInputActive,
      editorInputConnected: point.editorInputConnected
    };
    focusObservation.eventCount = Math.min(MAX_FOCUS_EVENTS + 1, focusObservation.eventCount + 1);
    if (focusObservation.events.length < MAX_FOCUS_EVENTS) focusObservation.events.push(record);
    else focusObservation.overflow = true;
    scheduleFocusAfterFrame();
  }
  function beginFocusObservation() {
    if (focusObservation.started) return;
    focusObservation.started = true;
    focusObservationInput = editorInput();
    focusObservation.before = focusPoint(focusObservationInput);
    focusObservationListeners = ["focus", "focusin", "blur", "pointerdown"].map(function (type) {
      var listener = function (event) { recordFocusEvent(event); };
      document.addEventListener(type, listener, true);
      return { type: type, listener: listener };
    });
  }
  function stopFocusObservation() {
    if (focusObservationListeners) {
      focusObservationListeners.forEach(function (entry) {
        document.removeEventListener(entry.type, entry.listener, true);
      });
      focusObservationListeners = null;
    }
    if (pendingFocusFrame) {
      if (typeof cancelAnimationFrame === "function" && pendingFocusFrame.id !== undefined) {
        cancelAnimationFrame(pendingFocusFrame.id);
      }
      pendingFocusFrame = null;
    }
  }
  function focusObservationSnapshot() {
    return {
      started: focusObservation.started,
      eventCount: focusObservation.eventCount,
      overflow: focusObservation.overflow,
      events: focusObservation.events.map(function (event) { return Object.assign({}, event); }),
      before: focusObservation.before ? Object.assign({}, focusObservation.before) : null,
      afterFrame: focusObservation.afterFrame ? Object.assign({}, focusObservation.afterFrame) : null,
      framePending: !!pendingFocusFrame,
      listenerCount: focusObservationListeners ? focusObservationListeners.length : 0
    };
  }
  function state() {
    var textarea = editorInput();
    var formatButton = document.querySelector(".handle button");
    return {
      ready: !!document.querySelector("#inputEditor .monaco-editor") && !!textarea && !!formatButton,
      inputText: editorText(),
      inputReady: !!textarea,
      formatActionReady: !!formatButton,
      malformedMarkerCount: document.querySelectorAll("#inputEditor .squiggly-error").length,
      focusDiagnostics: focusDiagnostics(textarea),
      focusObservation: focusObservationSnapshot(),
      nativeUiInputObservation: window.__ATOOLS_NATIVE_JSON_UI_INPUT__?.snapshot(),
      editCommandResults: lastEditCommandResults.slice()
    };
  }
  function focusInput() {
    var textarea = required(editorInput(), "Monaco input textarea");
    try { textarea.focus({ preventScroll: true }); } catch (_) {}
    var current = state();
    current.focusInputSucceeded = textarea.isConnected && document.activeElement === textarea;
    return current;
  }
  function focusWithCapturedNative(element) {
    if (typeof capturedHTMLElementFocus !== "function") return false;
    try { capturedHTMLElementFocus.call(element, { preventScroll: true }); } catch (_) {}
    return !!element.isConnected && document.activeElement === element;
  }
  function diagnoseFocusControls() {
    var originalTextarea = required(editorInput(), "Monaco input textarea");
    var previousActive = document.activeElement;
    var container = document.createElement("div");
    var temporaryInput = document.createElement("input");
    var temporaryTextarea = document.createElement("textarea");
    container.setAttribute("data-atools-focus-diagnostic", "");
    container.style.cssText = "position:fixed;left:8px;top:8px;z-index:2147483647;padding:8px;background:#fff;color:#111;border:1px solid #555";
    temporaryInput.type = "text";
    temporaryInput.tabIndex = 0;
    temporaryInput.setAttribute("aria-label", "Temporary focus diagnostic input");
    temporaryTextarea.tabIndex = 0;
    temporaryTextarea.setAttribute("aria-label", "Temporary focus diagnostic textarea");
    container.appendChild(temporaryInput);
    container.appendChild(temporaryTextarea);
    var diagnostic = {
      originalTextareaNativeFocusActive: false,
      temporaryInputNativeFocusActive: false,
      temporaryTextareaNativeFocusActive: false,
      documentHasFocus: false,
      originalFocusIsCapturedNative: originalTextarea.focus === capturedHTMLElementFocus,
      originalHasOwnFocus: Object.prototype.hasOwnProperty.call(originalTextarea, "focus")
    };
    try {
      document.body.appendChild(container);
      diagnostic.originalTextareaNativeFocusActive = focusWithCapturedNative(originalTextarea);
      diagnostic.temporaryInputNativeFocusActive = focusWithCapturedNative(temporaryInput);
      diagnostic.temporaryTextareaNativeFocusActive = focusWithCapturedNative(temporaryTextarea);
      try { diagnostic.documentHasFocus = typeof document.hasFocus === "function" && document.hasFocus() === true; } catch (_) {}
    } finally {
      if (container.parentNode) container.parentNode.removeChild(container);
      if (previousActive && previousActive.isConnected && previousActive !== document.body) focusWithCapturedNative(previousActive);
    }
    return Object.assign(state(), { focusControlDiagnostics: diagnostic });
  }
  function nextFrame() {
    return new Promise(function (resolve) {
      var settled = false;
      var timeout = setTimeout(finish, 40);
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      }
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
    });
  }
  async function enter(value) {
    var textarea = required(editorInput(), "Monaco input textarea");
    lastEditCommandResults = [];
    if (document.activeElement !== textarea) textarea.focus();
    var attempts = 0;
    while (document.activeElement !== textarea && attempts < 3) {
      await nextFrame();
      attempts += 1;
    }
    if (document.activeElement !== textarea) {
      lastEditCommandResults.push({ command: "focus", accepted: false });
      return state();
    }
    lastEditCommandResults.push({ command: "selectAll", accepted: document.execCommand("selectAll") === true });
    lastEditCommandResults.push({ command: "insertText", accepted: document.execCommand("insertText", false, value) === true });
    return state();
  }
  function format() {
    // The first original toolbar button is the package's reformat action (Alt+F).
    required(document.querySelector(".handle button"), "original reformat button").click();
  }
  async function perform(operation) {
    if (["native-ui-valid", "native-ui-format", "native-ui-malformed", "native-ui-recovery", "native-ui-stop"].includes(operation)) {
      var observer = window.__ATOOLS_NATIVE_JSON_UI_INPUT__;
      if (!observer) throw Error("NativeJsonUiInputObserverUnavailable");
      if (operation === "native-ui-stop") observer.stop();
      else observer.begin(operation.slice("native-ui-".length));
      return state();
    }
    if (operation === "focus-input") return focusInput();
    if (operation === "diagnose-focus-controls") return diagnoseFocusControls();
    if (operation === "begin-focus-observation") {
      beginFocusObservation();
      return state();
    }
    if (operation === "read-focus-observation") return state();
    if (operation === "stop-focus-observation") {
      stopFocusObservation();
      return state();
    }
    if (operation === "worker-contract") {
      var contract = window.__ATOOLS_JSON_WORKER_CONTRACT__;
      if (!contract || typeof contract.run !== "function") throw Error("Original JSON worker-contract client is unavailable");
      return Object.assign(state(), { workerContract: await contract.run() });
    }
    if (operation === "enter-valid-json") await enter(validJson);
    else if (operation === "enter-malformed-json") await enter(invalidJson);
    else if (operation === "reformat") format();
    else throw Error("Unknown original JSON Editor operation: " + operation);
    return state();
  }
  window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__ = {
    caseId: "local-json-editor", state: state, perform: perform
  };
})();
