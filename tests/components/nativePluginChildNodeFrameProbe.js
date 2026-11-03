// Installed only by the explicit child-node native fixture. No arbitrary script operation.
(() => {
  if (window === window.top) return;
  const token = "__ATOOLS_PANEL_TOKEN__", replies = new Map(), children = new Map();
  const sentinel = "ATools child-only Node fixed sentinel 31";
  const dictionary = [{ name: "atools-child-dictionary-word-31", trans: ["fixed fixture translation"] }];
  const metadata = { id: "atools-child-dictionary-31", name: "ATools child dictionary fixture 31", length: 1 };
  const errorClasses = ["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "UnknownError"];
  const errorCounts = Object.fromEntries(errorClasses.map(name => [name, 0]));
  const errorClass = failure => errorClasses.includes(failure?.name) ? failure.name : "UnknownError";
  let errorCount = 0;
  function recordError(failure) { if (errorCount < 32) { errorCount++; errorCounts[errorClass(failure)]++; } }
  window.addEventListener("error", event => recordError(event.error));
  window.addEventListener("unhandledrejection", event => recordError(event.reason));
  function jsonFixtureEqual(actual, expected, depth = 0) {
    if (depth > 32 || typeof actual !== typeof expected) return false;
    if (actual === null || expected === null) return actual === expected;
    if (typeof expected === "number") return Number.isFinite(actual) && actual === expected;
    if (typeof expected === "string" || typeof expected === "boolean") return actual === expected;
    if (typeof expected !== "object") return false;
    if (Array.isArray(actual) || Array.isArray(expected)) {
      return Array.isArray(actual) && Array.isArray(expected) && actual.length === expected.length
        && Object.keys(actual).length === actual.length && Object.keys(expected).length === expected.length
        && Array.from({ length: expected.length }, (_, index) => index).every(index =>
          Object.prototype.hasOwnProperty.call(actual, index) && Object.prototype.hasOwnProperty.call(expected, index)
          && jsonFixtureEqual(actual[index], expected[index], depth + 1));
    }
    const actualKeys = Object.keys(actual).sort(), expectedKeys = Object.keys(expected).sort();
    return actualKeys.length === expectedKeys.length && expectedKeys.every((key, index) =>
      actualKeys[index] === key && jsonFixtureEqual(actual[key], expected[key], depth + 1));
  }
  function inspectChildDocumentZoom() {
    const proof = { webFrameZoomAvailable: false, documentZoomFactorRoundTrip: false,
      computedDocumentZoomMatches: false, documentZoomRestored: false };
    const cssFactor = value => { const text = String(value || "").trim();
      return text.endsWith("%") ? Number.parseFloat(text) / 100 : Number.parseFloat(text); };
    const root = document.documentElement;
    let webFrame, original = NaN;
    try {
      webFrame = window.require("electron").webFrame;
      proof.webFrameZoomAvailable = typeof webFrame?.setZoomFactor === "function" && typeof webFrame?.getZoomFactor === "function";
      if (!proof.webFrameZoomAvailable || !root) return proof;
      original = webFrame.getZoomFactor();
      webFrame.setZoomFactor(1.25);
      proof.computedDocumentZoomMatches = cssFactor(getComputedStyle(root).getPropertyValue("zoom")) === 1.25;
      proof.documentZoomFactorRoundTrip = original === 1 && webFrame.getZoomFactor() === 1.25
        && cssFactor(root.style.getPropertyValue("zoom")) === 1.25 && proof.computedDocumentZoomMatches;
    } catch { proof.documentZoomFactorRoundTrip = false; }
    finally {
      if (proof.webFrameZoomAvailable && Number.isFinite(original) && original > 0) {
        try {
          webFrame.setZoomFactor(original);
          proof.documentZoomRestored = original === 1 && webFrame.getZoomFactor() === 1
            && cssFactor(root.style.getPropertyValue("zoom")) === 1 && cssFactor(getComputedStyle(root).getPropertyValue("zoom")) === 1;
        } catch { proof.documentZoomRestored = false; }
      }
    }
    return proof;
  }
  function state() {
    const stage = window.__AToolsChildMainStage;
    return { opaque: location.origin === "null", noTauri: !("__TAURI_INTERNALS__" in window),
      parentPreloadExecuted: window.__AToolsChildParentPreload?.executed === true,
      parentElectronIpc: window.__AToolsChildParentPreload?.electronIpc === true,
      mainReady: window.__AToolsChildMainReady === true,
      mainNodeEnvironment: typeof window.__atoolsNodeModuleRequire === "function",
      mainScriptEntered: stage?.entered === true, mainStorageApiAvailable: stage?.storageApiAvailable === true,
      mainDataAttempted: stage?.attempted === true, mainDataCompleted: stage?.completed === true,
      mainDataErrorClass: stage?.errorClass || "", mainDataErrorCode: stage?.errorCode || "",
      observedErrorCount: errorCount, observedErrorCounts: { ...errorCounts },
      children: [...children].map(([kind, item]) => ({ kind, ready: item.ready, rejected: item.rejected,
        readyCallbackCount: item.callbacks, destroyed: item.handle.isDestroyed() })) };
  }
  function open(kind) {
    if (children.has(kind)) throw Error("ChildAlreadyRequested");
    const item = { ready: false, rejected: false, callbacks: 0, handle: null };
    const handle = window.ztools.createBrowserWindow("child.html", {
      show: false, webPreferences: { preload: kind === "generated" ? "child-preload.js" : "preload-app.js" },
    }, () => item.callbacks++);
    item.handle = handle; children.set(kind, item);
    handle.ready.then(() => { item.ready = true; }, () => { item.rejected = true; });
    return { synchronousHandle: !!handle && typeof handle.then !== "function"
      && typeof handle.close === "function" && handle.isDestroyed() === false };
  }
  async function inspectGenerated() {
    const item = children.get("generated"); if (!item) throw Error("GeneratedChildMissing");
    await item.handle.ready;
    return item.handle.webContents.executeJavaScript(`(() => {
      const observation=window.__AToolsChildSentinel;
      return {opaque:location.origin==='null',noTauri:!('__TAURI_INTERNALS__' in window),
        actualNodeBridge:typeof window.__atoolsNodeModuleRequire==='function',
        sentinelMatches:observation?.value===${JSON.stringify(sentinel)},
        processId:Number.isSafeInteger(observation?.pid)&&observation.pid>0?observation.pid:null};
    })()`);
  }
  async function originalRoundTrip() {
    const item = children.get("original"); if (!item) throw Error("OriginalChildMissing");
    await item.handle.ready;
    const parentZoomBefore = document.documentElement.style.getPropertyValue("zoom");
    const parentComputedBefore = getComputedStyle(document.documentElement).getPropertyValue("zoom");
    const result = await item.handle.webContents.executeJavaScript(`(async () => {
      const expected=${JSON.stringify(dictionary)},metadata=${JSON.stringify(metadata)};
      const exactJson=${jsonFixtureEqual.toString()};
      const originalFunctionsReady=['newLocalDict','readLocalDict','readLocalDictConfig'].every(name=>typeof window[name]==='function');
      if(!originalFunctionsReady)throw Error('OriginalChildFunctionsMissing');
      const stored=window.newLocalDict('fixture-dictionary.json',metadata);
      const actual=await window.readLocalDict(metadata.id),config=window.readLocalDictConfig();
      const zoomProof=(${inspectChildDocumentZoom.toString()})();
      return {opaque:location.origin==='null',noTauri:!('__TAURI_INTERNALS__' in window),
        actualNodeBridge:typeof window.__atoolsNodeModuleRequire==='function',originalFunctionsReady,
        originalFsAttachmentStored:stored===true,
        dictionaryRoundTrip:exactJson(actual,expected),
        metadataRoundTrip:exactJson(config,[metadata]),
        zoomRateInitialized:window.ztools.dbStorage.getItem('zoom_rate')===1,...zoomProof};
    })()`);
    return { ...result, parentDocumentZoomUnchanged: document.documentElement.style.getPropertyValue("zoom") === parentZoomBefore
      && getComputedStyle(document.documentElement).getPropertyValue("zoom") === parentComputedBefore };
  }
  async function close(kind) {
    const item = children.get(kind); if (!item) throw Error("ChildMissing");
    const result = await item.handle.close();
    return { actualClose: result?.closed === true, destroyed: item.handle.isDestroyed(), readyCallbackCount: item.callbacks };
  }
  async function perform(operation) {
    switch (operation) {
      case "state": return state();
      case "open-generated": return open("generated");
      case "open-original": return open("original");
      case "inspect-generated": return inspectGenerated();
      case "original-roundtrip": return originalRoundTrip();
      case "close-generated": return close("generated");
      case "close-original": return close("original");
      default: throw Error("UnreviewedChildNodeOperation");
    }
  }
  window.addEventListener("message", async event => {
    const message = event.data;
    if (event.source !== parent || message?.kind !== "atools-child-node-probe" || message.token !== token
      || typeof message.id !== "string" || replies.has(message.id) || replies.size >= 512) return;
    replies.set(message.id, true); let result = null, error = "";
    try { result = await perform(message.operation); }
    catch (failure) { error = errorClass(failure); }
    parent.postMessage({ kind: "atools-child-node-result", token, id: message.id, result, error }, "*");
  });
})();
