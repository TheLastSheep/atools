((token, runId, pid, fixtureText, fixtureFileName) => {
  "use strict";
  const KEY = "__ATOOLS_CLIPBOARD_CONTEXT_PROBE__";
  if (window[KEY]) return;
  const COMMAND = "renderer_clipboard_context_probe";
  const FIXED_TEXT = fixtureText;
  const NORMAL_INPUT_TEXT = FIXED_TEXT.replace(/[\r\n]/g, "");
  const allowed = new Set([
    "textEmpty", "textSelection", "image", "file", "expiredSameCount", "empty", "denied", "dispose",
  ]);
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const invoke = typeof window.__TAURI__?.core?.invoke === "function"
    ? window.__TAURI__.core.invoke.bind(window.__TAURI__.core)
    : null;
  let inFlight = false;
  let disposed = false;
  let contextWrites = 0;
  let lastContextSummary = null;
  let fullTextContextSeen = false;
  let originalUpdate = null;
  let updateWrapper = null;
  let ztools = null;

  function summarizeLaunchContext(context) {
    if (!context || typeof context !== "object") return null;
    const files = context.pastedFiles;
    return {
      queryEmpty: context.searchQuery === "",
      queryIsFixture: context.searchQuery === FIXED_TEXT,
      queryIsSelectionMarker: context.searchQuery === "ATools R62 selection marker",
      pastedTextIsFixture: context.pastedText === FIXED_TEXT,
      pastedTextIsNull: context.pastedText === null,
      pastedImageIsDataUrl: typeof context.pastedImage === "string" &&
        context.pastedImage.startsWith("data:image/png;base64,"),
      pastedFilesEmpty: context.pastedFiles === null || Array.isArray(files) && files.length === 0,
      oneFixtureFile: Array.isArray(files) && files.length === 1 && files[0] &&
        files[0].name === fixtureFileName && typeof files[0].path === "string" &&
        files[0].path.length > 0 && files[0].isDirectory === false,
    };
  }

  function installLaunchContextObserver() {
    ztools = window.ztools;
    if (!ztools || typeof ztools.updateLaunchContext !== "function") return;
    originalUpdate = ztools.updateLaunchContext;
    updateWrapper = function (context) {
      const result = originalUpdate.apply(this, arguments);
      contextWrites += 1;
      lastContextSummary = summarizeLaunchContext(context);
      if (lastContextSummary?.pastedTextIsFixture) fullTextContextSeen = true;
      return result;
    };
    try {
      ztools.updateLaunchContext = updateWrapper;
      if (ztools.updateLaunchContext !== updateWrapper) {
        originalUpdate = null;
        updateWrapper = null;
      }
    } catch (_) {
      originalUpdate = null;
      updateWrapper = null;
    }
  }

  function restoreLaunchContextObserver() {
    if (originalUpdate && updateWrapper && ztools.updateLaunchContext === updateWrapper) {
      try { ztools.updateLaunchContext = originalUpdate; } catch (_) {}
    }
    originalUpdate = null;
    updateWrapper = null;
  }

  function input() {
    return document.querySelector("input.search-input");
  }

  function adapterOutstanding() {
    try {
      const value = window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.()?.outstandingNativeCalls;
      return Number.isSafeInteger(value) && value >= 0 && value <= 4096 ? value : null;
    } catch (_) {
      return null;
    }
  }

  function waitFor(predicate, limit = 2500) {
    const deadline = Date.now() + limit;
    return new Promise((resolve) => {
      const poll = () => {
        let matched = false;
        try { matched = predicate() === true; } catch (_) {}
        if (matched || Date.now() >= deadline) return resolve(matched);
        setTimeout(poll, 20);
      };
      poll();
    });
  }

  function baseEvidence(operation, probeId) {
    return {
      schemaVersion: 1,
      operation,
      probeId,
      documentRoot: document.documentElement !== null,
      documentVisibility: document.visibilityState === "visible"
        ? "visible"
        : document.visibilityState === "hidden" ? "hidden" : "",
      documentHasFocus: typeof document.hasFocus === "function" && document.hasFocus() === true,
      searchInputCount: document.querySelectorAll("input.search-input").length,
      clipboardGetterAvailable: typeof window.ztools?.getLastCopiedContent === "function",
      pasteCanceled: null,
      inputEmpty: null,
      inputValueMatches: null,
      selectionMatches: null,
      textChipMatches: null,
      imageChipMatches: null,
      fileChipMatches: null,
      fileNameMatches: null,
      launchContextObserved: null,
      launchContextUnchanged: null,
      uiUnchanged: null,
      getterReturnedNull: null,
      getterRejected: null,
      naturalWidth: null,
      naturalHeight: null,
      adapterOutstandingNativeCalls: adapterOutstanding(),
    };
  }

  function failureEvidence(operation, probeId) {
    const value = {};
    if (operation === "textEmpty") Object.assign(value, {
      pasteCanceled: false, inputEmpty: false, textChipMatches: false, launchContextObserved: false,
    });
    if (operation === "textSelection") Object.assign(value, {
      pasteCanceled: false, inputValueMatches: false, selectionMatches: false, launchContextObserved: false,
    });
    if (operation === "image") Object.assign(value, {
      pasteCanceled: false, imageChipMatches: false, naturalWidth: 0, naturalHeight: 0,
      launchContextObserved: false,
    });
    if (operation === "file") Object.assign(value, {
      pasteCanceled: false, fileChipMatches: false, fileNameMatches: false, launchContextObserved: false,
    });
    if (operation === "expiredSameCount") Object.assign(value, {
      getterReturnedNull: false, launchContextUnchanged: false,
    });
    if (operation === "empty") Object.assign(value, {
      getterReturnedNull: false, uiUnchanged: false, launchContextUnchanged: false,
    });
    if (operation === "denied") Object.assign(value, { getterRejected: false, uiUnchanged: false });
    return value;
  }

  function truncatedFixtureText() {
    if (FIXED_TEXT.length <= 30) return FIXED_TEXT;
    return `${FIXED_TEXT.substring(0, 15)}...${FIXED_TEXT.substring(FIXED_TEXT.length - 10)}`;
  }

  function contextHasFile() {
    return lastContextSummary?.oneFixtureFile === true;
  }

  function uiSnapshot() {
    const search = input();
    const text = document.querySelector(".pasted-text .text-content");
    const image = document.querySelector(".pasted-image-thumbnail img");
    const files = document.querySelectorAll(".pasted-files .file-name");
    return {
      inputCount: document.querySelectorAll("input.search-input").length,
      inputValue: search ? search.value : null,
      textChip: text ? text.textContent : null,
      imageSource: image ? image.getAttribute("src") : null,
      fileCount: files.length,
      fileName: files.length === 1 ? files[0].textContent : null,
    };
  }

  function sameSnapshot(left, right) {
    return left.inputCount === right.inputCount && left.inputValue === right.inputValue &&
      left.textChip === right.textChip && left.imageSource === right.imageSource &&
      left.fileCount === right.fileCount && left.fileName === right.fileName;
  }

  function dispatchPaste(target) {
    if (!target || typeof ClipboardEvent !== "function") return false;
    let event;
    try {
      const data = typeof DataTransfer === "function" ? new DataTransfer() : undefined;
      event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
    } catch (_) {
      try { event = new ClipboardEvent("paste", { bubbles: true, cancelable: true }); } catch (_) { return false; }
    }
    if (!(event instanceof ClipboardEvent) || !event.cancelable) return false;
    try {
      const dispatched = target.dispatchEvent(event);
      return dispatched === false && event.defaultPrevented === true;
    } catch (_) {
      return false;
    }
  }

  function setNativeInputValue(target, value) {
    if (!target || typeof InputEvent !== "function") return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (typeof setter !== "function") return false;
    try {
      setter.call(target, value);
      return target.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: value,
      }));
    } catch (_) {
      return false;
    }
  }

  async function textEmpty(value) {
    const beforeWrites = contextWrites;
    const target = input();
    value.pasteCanceled = dispatchPaste(target);
    await waitFor(() => Boolean(document.querySelector(".pasted-text .text-content")) &&
      lastContextSummary?.pastedTextIsFixture === true);
    const current = input();
    value.inputEmpty = current !== null && current.value === "";
    value.textChipMatches = document.querySelector(".pasted-text .text-content")?.textContent === truncatedFixtureText();
    value.launchContextObserved = contextWrites > beforeWrites && fullTextContextSeen &&
      lastContextSummary?.pastedTextIsFixture === true && lastContextSummary?.queryEmpty === true;
  }

  async function textSelection(value) {
    const chip = document.querySelector(".pasted-text");
    if (chip) chip.click();
    await waitFor(() => {
      const target = input();
      return target !== null && target.value === NORMAL_INPUT_TEXT &&
        !document.querySelector(".pasted-text") &&
        lastContextSummary?.queryIsFixture === true &&
        lastContextSummary?.pastedTextIsNull === true;
    });
    const target = input();
    const marker = "ATools R62 selection marker";
    const markerApplied = setNativeInputValue(target, marker);
    await waitFor(() => input()?.value === marker &&
      lastContextSummary?.queryIsSelectionMarker === true &&
      lastContextSummary?.pastedTextIsNull === true);
    const beforePasteWrites = contextWrites;
    if (markerApplied && target) {
      target.setSelectionRange(0, marker.length);
      value.pasteCanceled = dispatchPaste(target);
    } else {
      value.pasteCanceled = false;
    }
    await waitFor(() => {
      const current = input();
      return current !== null && current.value === NORMAL_INPUT_TEXT &&
        current.selectionStart === current.selectionEnd &&
        current.selectionEnd === current.value.length && contextWrites > beforePasteWrites &&
        lastContextSummary?.queryIsFixture === true &&
        lastContextSummary?.pastedTextIsNull === true;
    });
    const current = input();
    value.inputValueMatches = current !== null && current.value === NORMAL_INPUT_TEXT;
    value.selectionMatches = current !== null && current.selectionStart === current.selectionEnd &&
      current.selectionEnd === current.value.length;
    value.launchContextObserved = contextWrites > beforePasteWrites &&
      lastContextSummary?.queryIsFixture === true &&
      lastContextSummary?.pastedTextIsNull === true;
  }

  async function pasteImage(value) {
    const beforeWrites = contextWrites;
    value.pasteCanceled = dispatchPaste(input());
    await waitFor(() => {
      const image = document.querySelector(".pasted-image-thumbnail img");
      return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0 &&
        lastContextSummary?.pastedImageIsDataUrl === true;
    });
    const image = document.querySelector(".pasted-image-thumbnail img");
    value.imageChipMatches = image instanceof HTMLImageElement &&
      image.getAttribute("src")?.startsWith("data:image/png;base64,") === true;
    value.naturalWidth = image instanceof HTMLImageElement ? image.naturalWidth : 0;
    value.naturalHeight = image instanceof HTMLImageElement ? image.naturalHeight : 0;
    value.launchContextObserved = contextWrites > beforeWrites &&
      lastContextSummary?.pastedImageIsDataUrl === true;
  }

  async function pasteFile(value) {
    const beforeWrites = contextWrites;
    value.pasteCanceled = dispatchPaste(input());
    await waitFor(() => document.querySelector(".pasted-files .file-name")?.textContent === fixtureFileName &&
      contextHasFile());
    const rows = document.querySelectorAll(".pasted-files .file-name");
    value.fileChipMatches = document.querySelectorAll(".pasted-files").length === 1 && rows.length === 1;
    value.fileNameMatches = rows.length === 1 && rows[0].textContent === fixtureFileName;
    value.launchContextObserved = contextWrites > beforeWrites && contextHasFile();
  }

  async function readNull(value, timeLimit) {
    const beforeUi = uiSnapshot();
    const beforeWrites = contextWrites;
    const beforeContext = lastContextSummary;
    try {
      const result = timeLimit === undefined
        ? await window.ztools.getLastCopiedContent()
        : await window.ztools.getLastCopiedContent(timeLimit);
      value.getterReturnedNull = result === null;
    } catch (_) {
      value.getterReturnedNull = false;
    }
    value.uiUnchanged = sameSnapshot(beforeUi, uiSnapshot());
    value.launchContextUnchanged = contextWrites === beforeWrites &&
      lastContextSummary === beforeContext && lastContextSummary !== null;
  }

  async function denied(value) {
    const beforeUi = uiSnapshot();
    const beforeWrites = contextWrites;
    const beforeContext = lastContextSummary;
    let rejected = false;
    try {
      await window.ztools.getLastCopiedContent();
    } catch (_) {
      rejected = true;
    }
    value.getterRejected = rejected;
    value.uiUnchanged = sameSnapshot(beforeUi, uiSnapshot());
    value.launchContextUnchanged = contextWrites === beforeWrites &&
      lastContextSummary === beforeContext && lastContextSummary !== null;
  }

  async function send(evidence) {
    if (!invoke) return false;
    try {
      await invoke(COMMAND, { token, runId, pid, probeId: evidence.probeId, evidence });
      return true;
    } catch (_) {
      return false;
    }
  }

  async function run(operation, probeId) {
    if (disposed || inFlight || !Number.isSafeInteger(probeId) || probeId < 0 ||
        (operation === "ready" ? probeId !== 0 : (!allowed.has(operation) || probeId === 0))) return false;
    inFlight = true;
    const value = failureEvidence(operation, probeId);
    try {
      if (operation === "ready") {
        const ready = await waitFor(() => document.documentElement !== null && input() !== null &&
          typeof window.ztools?.getLastCopiedContent === "function" && adapterOutstanding() === 0);
        if (ready) installLaunchContextObserver();
      } else if (operation === "textEmpty") {
        await textEmpty(value);
      } else if (operation === "textSelection") {
        await textSelection(value);
      } else if (operation === "image") {
        await pasteImage(value);
      } else if (operation === "file") {
        await pasteFile(value);
      } else if (operation === "expiredSameCount") {
        await readNull(value, 1);
      } else if (operation === "empty") {
        await readNull(value);
      } else if (operation === "denied") {
        await denied(value);
      } else if (operation === "dispose") {
        restoreLaunchContextObserver();
        value.adapterOutstandingNativeCalls = adapterOutstanding();
      }
    } catch (_) {
      // The report contains only bounded booleans and counts, never exception text.
    }
    value.adapterOutstandingNativeCalls = adapterOutstanding();
    const evidence = { ...baseEvidence(operation, probeId), ...value };
    const accepted = await send(evidence);
    if (operation === "dispose") {
      disposed = true;
      try { delete window[KEY]; } catch (_) {}
    }
    inFlight = false;
    return accepted;
  }

  const api = Object.freeze({ run });
  Object.defineProperty(window, KEY, {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  void run("ready", 0);
})(
  "__ATOOLS_CLIPBOARD_TOKEN__",
  "__ATOOLS_CLIPBOARD_RUN_ID__",
  __ATOOLS_CLIPBOARD_PID__,
  "__ATOOLS_CLIPBOARD_FIXTURE_TEXT__",
  "__ATOOLS_CLIPBOARD_FIXTURE_FILE_NAME__",
);
