// Frame diagnostics and authenticated test transport; per-package UI operations are injected separately.
(function () {
  if (window.__ATOOLS_PUBLISHED_DIAGNOSTICS__) return;
  window.__ATOOLS_PUBLISHED_DIAGNOSTICS__ = true;
  var token = "__ATOOLS_PUBLISHED_TOKEN__";
  var caseId = "__ATOOLS_PUBLISHED_CASE_ID__";
  Object.defineProperty(window, "__ATOOLS_PUBLISHED_ACTIVE_CASE__", {
    value: caseId, configurable: false, enumerable: false, writable: false
  });
  var random = new Uint32Array(4);
  window.crypto.getRandomValues(random);
  var documentNonce = Array.from(random).map(function (value) { return value.toString(16).padStart(8, "0"); }).join("");
  var consoleErrors = [];
  var consoleWarnings = [];
  try {
    var originalConsoleError = console.error.bind(console);
    console.error = function () {
      consoleErrors.push(Array.prototype.slice.call(arguments, 0, 3).map(function (value) {
        return typeof value === "string" ? value.slice(0, 280) : Object.prototype.toString.call(value);
      }));
      if (consoleErrors.length > 12) consoleErrors.shift();
      emit("console-error", { messages: consoleErrors[consoleErrors.length - 1] });
      return originalConsoleError.apply(console, arguments);
    };
    var originalConsoleWarn = console.warn.bind(console);
    console.warn = function () {
      consoleWarnings.push(Array.prototype.slice.call(arguments, 0, 3).map(function (value) {
        return typeof value === "string" ? value.slice(0, 280) : Object.prototype.toString.call(value);
      }));
      if (consoleWarnings.length > 12) consoleWarnings.shift();
      return originalConsoleWarn.apply(console, arguments);
    };
  } catch (_) {}
  function emit(kind, detail) {
    try {
      window.top.postMessage({ kind: "atools-published-diagnostic", token: token, frame: window === window.top ? "host" : "plugin",
        event: kind, detail: detail }, "*");
    } catch (_) {}
  }
  window.addEventListener("securitypolicyviolation", function (event) {
    var blocked = String(event.blockedURI || "");
    var safeBlocked = blocked === "inline" || blocked === "eval" ? blocked : blocked.split("/").slice(0, 3).join("/");
    emit("securitypolicyviolation", { directive: String(event.effectiveDirective || ""), blocked: safeBlocked,
      disposition: String(event.disposition || "") });
  }, true);
  window.addEventListener("error", function (event) {
    if (event.target && event.target !== window && event.target.tagName) {
      emit("resource-load-error", { tag: String(event.target.tagName) });
      return;
    }
    emit("uncaught-error", { message: String(event.message || "Script error"), sourceKind: event.filename ? "script" : "unknown" });
  }, true);
  window.addEventListener("unhandledrejection", function (event) {
    emit("unhandled-rejection", { reasonType: event.reason == null ? String(event.reason) : typeof event.reason });
  });
  var workerLeaseSessions = [];
  function state() {
    var parentDocumentAccessBlocked = false;
    try { void window.parent.document; } catch (_) { parentDocumentAccessBlocked = true; }
    var leaseSessions = new Set();
    function transportFor(src) {
      var lease = src.match(/^(?:atools-plugin:\/\/localhost|https?:\/\/atools-plugin\.localhost)\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/[^?#]+(?:[?#].*)?$/i);
      if (lease) leaseSessions.add(lease[1].toLowerCase());
      return !src ? "inline" : lease ? "lease"
        : /^(?:atools-plugin:|https?:\/\/atools-plugin\.localhost(?:[/:]|$))/i.test(src) ? "invalid-lease"
        : /^(?:asset:\/\/localhost\/|https?:\/\/asset\.localhost\/)/i.test(src) ? "asset" : "remote";
    }
    var scripts = Array.from(document.scripts).map(function (script) {
      var src = script.getAttribute("src") || "";
      var marker = script.getAttribute("data-atools-plugin-script-src") || "";
      var publicPath = script.getAttribute("data-atools-plugin-public-path-src") || "";
      var publicPathResource = publicPath ? { resourceTransport: transportFor(publicPath),
        sourceMatches: (script.textContent || "").includes("new URL(" + JSON.stringify(publicPath) + ", document.baseURI).href") } : undefined;
      var imports = [], validImports = true;
      try {
        var raw = script.getAttribute("data-atools-plugin-module-imports");
        var urls = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(urls) || urls.length > 128) throw Error("Invalid inline module resource metadata");
        imports = urls.map(function (url) {
          if (typeof url !== "string" || !url || url.length > 16384) throw Error("Invalid inline module resource URL");
          var literal = JSON.stringify(url).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
          return { resourceTransport: transportFor(url), sourceMatches: (script.textContent || "").includes(literal) };
        });
      } catch (_) { validImports = false; }
      return { type: (script.type || "classic").split(";", 1)[0].trim().toLowerCase(), external: !!src, defer: script.defer,
        inlineBytes: script.textContent ? script.textContent.length : 0,
        fixtureResource: !!marker, preparedSourceMatches: !!src && src === marker, resourceTransport: transportFor(src),
        inlineModuleImports: imports, inlineModuleImportsValid: validImports, publicPathResource: publicPathResource };
    });
    return {
      documentState: document.readyState, title: document.title || "", origin: location.origin,
      parentDocumentAccessBlocked: parentDocumentAccessBlocked,
      tauriInternalsType: typeof window.__TAURI_INTERNALS__, globalTauriType: typeof window.__TAURI__,
      bodyText: document.body && document.body.innerText.slice(0, 1600) || "",
      appMountChildren: document.querySelector("#app") && document.querySelector("#app").childElementCount || 0,
      scripts: scripts, preparedResourceLeaseCount: leaseSessions.size,
      consoleErrors: consoleErrors.slice(), consoleWarnings: consoleWarnings.slice(),
      workerEvidence: typeof window.__ATOOLS_NATIVE_WORKER_OBSERVATION__ === "function"
        ? window.__ATOOLS_NATIVE_WORKER_OBSERVATION__(workerLeaseSessions) : { supported: false, workers: [] },
      ztoolsType: typeof window.ztools,
      servicesType: window.services == null ? String(window.services) : typeof window.services
    };
  }
  async function perform(operation, data) {
    var adapter = window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
    if (!adapter || adapter.caseId !== "__ATOOLS_PUBLISHED_CASE_ID__") throw new Error("Unregistered package operation adapter");
    var result = operation === "state" ? adapter.state() : await adapter.perform(operation, data);
    return Object.assign(state(), result);
  }
  document.addEventListener("DOMContentLoaded", function () {
    // Registered after the production bridge so these snapshots see its synchronous teardown.
    ["atools-plugin-out", "pagehide", "atools-workers-disposed"].forEach(function (kind) {
      window.addEventListener(kind, function () {
        if (caseId !== "local-json-editor" || typeof window.__ATOOLS_NATIVE_WORKER_OBSERVATION__ !== "function") return;
        var evidence = window.__ATOOLS_NATIVE_WORKER_OBSERVATION__(workerLeaseSessions);
        emit("worker-lifecycle", { kind: kind, supported: evidence.supported, overflowed: evidence.overflowed,
          workers: evidence.workers.map(function (worker) {
            return { name: worker.name, entry: worker.entry, constructed: worker.constructed, terminated: worker.terminated };
          }) });
      });
    });
  }, { once: true });
  function ready() {
    var adapter = window.__ATOOLS_PUBLISHED_CASE_OPERATIONS__;
    return document.URL === "about:srcdoc" && document.readyState !== "loading" && adapter && adapter.caseId === caseId
      && typeof adapter.state === "function" && typeof adapter.perform === "function";
  }
  window.addEventListener("message", async function (event) {
    var message = event.data;
    if (event.source !== window.parent || !message || message.token !== token || message.caseId !== caseId
      || typeof message.id !== "string" || !message.id) return;
    if (message.kind === "atools-published-probe-ready" && message.operation === "ready") {
      // No adapter method or original plugin operation runs during readiness checks.
      if (ready()) window.parent.postMessage({ kind: "atools-published-probe-ready-result", token: token, id: message.id,
        caseId: caseId, operation: "ready", ready: true, documentNonce: documentNonce,
        documentUrl: document.URL, documentState: document.readyState }, "*");
      return;
    }
    if (message.kind !== "atools-published-probe" || message.documentNonce !== documentNonce || !ready()) return;
    workerLeaseSessions = Array.isArray(message.workerLeaseSessions) ? message.workerLeaseSessions.slice(0, 4) : [];
    try {
      window.parent.postMessage({ kind: "atools-published-probe-result", token: token,
        id: message.id, caseId: caseId, operation: message.operation, documentNonce: documentNonce,
        state: await perform(message.operation, message) }, "*");
    } catch (error) {
      window.parent.postMessage({ kind: "atools-published-probe-result", token: token,
        id: message.id, caseId: caseId, operation: message.operation, documentNonce: documentNonce,
        error: String(error && error.message || error) }, "*");
    }
  });
})();
