// Test-only passive observation. No request arguments, diagnostic text or resource URL is emitted.
(function () {
  if (window.__ATOOLS_NATIVE_WORKER_OBSERVATION__) return;
  var NativeWorker = window.Worker;
  var records = [], blobs = new Map(), overflowed = false;
  var MAX_WORKERS = 8, MAX_PENDING = 64, MAX_REPLIES = 16, MAX_FIELDS = 16;
  var MAX_EVENTS = 1000000;
  // Rust replaces this entire JSON string literal with the owned installed root.
  var expectedAssetRoot = "__ATOOLS_EXPECTED_WORKER_ASSET_ROOT__";
  var supported = typeof NativeWorker === "function";
  function assetPath(url) {
    var path = decodeURIComponent(url.pathname);
    if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
    var parts = path.split("/");
    if (parts.some(function (part) { return part === "." || part === ".."; })) return null;
    return "/" + parts.filter(Boolean).join("/");
  }
  function leaf(source, allowedLeaseSessions) {
    try {
      if (typeof source !== "string" || source.length > 2048) return "unknown";
      var url = new URL(source, document.baseURI);
      if (url.username || url.password || url.port) return "unknown";
      var name;
      if (url.protocol === "atools-plugin:" && url.hostname === "localhost"
        || /^https?:$/.test(url.protocol) && url.hostname === "atools-plugin.localhost") {
        var parts = url.pathname.split("/");
        if (!Array.isArray(allowedLeaseSessions) || allowedLeaseSessions.length > 4
          || !allowedLeaseSessions.every(function (id) {
            return typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id);
          })
          || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(parts[1])
          || !allowedLeaseSessions.some(function (id) { return typeof id === "string" && id === parts[1]; })) return "unknown";
        var path = assetPath(url);
        if (!path) return "unknown";
        name = path.split("/").pop();
        return name === "json.worker.js" || name === "editor.worker.js" ? name : "unknown";
      }
      var root = new URL(expectedAssetRoot);
      if (!(root.protocol === "asset:" && root.hostname === "localhost"
        || /^https?:$/.test(root.protocol) && root.hostname === "asset.localhost")
        || root.username || root.password || root.port || root.search || root.hash
        || url.protocol !== root.protocol || url.host !== root.host || url.username || url.password) return "unknown";
      var directory = assetPath(root), path = assetPath(url);
      if (!directory || !path || path.indexOf(directory.replace(/\/$/, "") + "/") !== 0) return "unknown";
      name = path.split("/").pop();
      return name === "json.worker.js" || name === "editor.worker.js" ? name : "unknown";
    } catch (_) { return "unknown"; }
  }
  function increment(record, field) {
    if (record[field] >= MAX_EVENTS) { overflowed = true; return 0; }
    return ++record[field];
  }
  function requestKey(message, field) {
    if (!message || !Number.isSafeInteger(message.vsWorker)) return null;
    var id = message[field];
    return typeof id === "string" && /^[0-9]{1,16}$/.test(id) ? message.vsWorker + ":" + id : null;
  }
  function validationTransport(message) {
    var args = message.args;
    if (message.method === "fmr") {
      if (!Array.isArray(args) || args.length !== 2 || args[0] !== "doValidation") return null;
      args = args[1];
    } else if (message.method !== "doValidation") return null;
    return Array.isArray(args) && args.length === 1 && typeof args[0] === "string"
      && args[0].length > 0 && args[0].length <= 2048 ? message.method === "fmr" ? "fmr" : "direct" : null;
  }
  function summary(markers) {
    var codes = [], positions = [], errorCount = 0;
    for (var index = 0; index < markers.length; index++) {
      var marker = markers[index];
      if (!marker || typeof marker !== "object") continue;
      if (marker.severity === 1) errorCount++;
      if (codes.length < MAX_FIELDS && typeof marker.code === "number" && Number.isSafeInteger(marker.code))
        codes.push(String(marker.code));
      var start = marker.range && marker.range.start;
      if (positions.length < MAX_FIELDS && start && Number.isSafeInteger(start.line) && start.line >= 0
        && start.line < 1000000 && Number.isSafeInteger(start.character) && start.character >= 0
        && start.character < 1000000) positions.push({ line: start.line + 1, column: start.character + 1 });
    }
    return { markerCount: markers.length, errorCount: errorCount, codes: codes, positions: positions };
  }
  function snapshot(allowedLeaseSessions) {
    return { supported: supported, overflowed: overflowed, workers: records.map(function (record) {
      return { name: record.name, entry: leaf(record.entrySource, allowedLeaseSessions), constructed: true, requests: record.requests,
        responses: record.responses, validationRequests: record.validationRequests,
        validationResponses: record.validationResponses, errors: record.errors, terminated: record.terminated,
        validationReplies: record.validationReplies.map(function (reply) {
          return { requestOrdinal: reply.requestOrdinal, validationTransport: reply.validationTransport,
            markerCount: reply.markerCount, errorCount: reply.errorCount, codes: reply.codes.slice(),
            positions: reply.positions.map(function (position) { return { line: position.line, column: position.column }; }) };
        }) };
    }) };
  }
  Object.defineProperty(window, "__ATOOLS_NATIVE_WORKER_OBSERVATION__", { value: snapshot });
  if (!supported) return;
  var observedWorkers = new WeakMap();
  var nativePostMessage = NativeWorker.prototype.postMessage, nativeTerminate = NativeWorker.prototype.terminate;
  // Observe the real send point without replacing a subclass's custom postMessage.
  NativeWorker.prototype.postMessage = function (message) {
    var result = nativePostMessage.apply(this, arguments);
    try {
      var observation = observedWorkers.get(this);
      var key = observation && message && message.type === 0 ? requestKey(message, "req") : null;
      if (key) {
        increment(observation.record, "requests");
        var transport = validationTransport(message);
        var ordinal = transport ? increment(observation.record, "validationRequests") : 0;
        if (observation.pending.size < MAX_PENDING && !observation.pending.has(key))
          observation.pending.set(key, ordinal ? { requestOrdinal: ordinal, validationTransport: transport } : null);
        else overflowed = true;
      }
    } catch (_) {}
    return result;
  };
  var createObjectURL = URL.createObjectURL.bind(URL), revokeObjectURL = URL.revokeObjectURL.bind(URL);
  var readBlobText = Blob.prototype.text;
  URL.createObjectURL = function (blob) {
    var url = createObjectURL(blob);
    try {
      if (blob instanceof Blob && blob.size <= 2048) {
        if (blobs.size < 16) blobs.set(url, blob);
        else overflowed = true;
      }
    } catch (_) {}
    return url;
  };
  URL.revokeObjectURL = function (url) {
    blobs.delete(url);
    return revokeObjectURL(url);
  };
  function identify(record, source) {
    if (typeof source !== "string" || source.length > 2048) return;
    record.entrySource = source;
    var blob = blobs.get(source);
    if (!blob) return;
    // Only the production bridge's exact, small importScripts bootstrap is recognized.
    readBlobText.call(blob).then(function (text) {
      if (typeof text !== "string" || text.length > 2048) return;
      var match = /^importScripts\(("(?:[^"\\]|\\.)*")\);$/.exec(text);
      if (match) {
        var entry = JSON.parse(match[1]);
        if (typeof entry === "string" && entry.length <= 2048) record.entrySource = entry;
      }
    }).catch(function () {});
  }
  function ObservedWorker(source, options) {
    if (!new.target) return NativeWorker.apply(this, arguments);
    var worker = Reflect.construct(NativeWorker, arguments, new.target === ObservedWorker ? NativeWorker : new.target);
    if (records.length >= MAX_WORKERS) { overflowed = true; return worker; }
    var rawName;
    try { rawName = options && options.name; } catch (_) {}
    var record = { name: rawName === "json" || rawName === "json-contract" || rawName === "editorWorkerService" ? rawName : "other",
      entrySource: "", requests: 0, responses: 0, validationRequests: 0, validationResponses: 0,
      validationReplies: [], errors: 0, terminated: false };
    records.push(record);
    try { identify(record, source); } catch (_) {}
    var pending = new Map();
    observedWorkers.set(worker, { record: record, pending: pending });
    worker.addEventListener("message", function (event) {
      // Script-dispatched MessageEvents cannot count as native Worker replies.
      if (event.isTrusted !== true) return;
      var message = event.data, key = message && message.type === 1 ? requestKey(message, "seq") : null;
      if (!key || !pending.has(key)) return;
      var validation = pending.get(key); pending.delete(key); increment(record, "responses");
      if (!validation || message.err != null || !Array.isArray(message.res)) return;
      if (message.res.length > 256) { overflowed = true; return; }
      increment(record, "validationResponses");
      var reply = summary(message.res); reply.requestOrdinal = validation.requestOrdinal;
      reply.validationTransport = validation.validationTransport;
      record.validationReplies.push(reply);
      if (record.validationReplies.length > MAX_REPLIES) record.validationReplies.shift();
    });
    worker.addEventListener("error", function (event) { if (event.isTrusted === true) increment(record, "errors"); });
    worker.terminate = function () {
      var result = nativeTerminate.call(worker); record.terminated = true; pending.clear(); return result;
    };
    return worker;
  }
  ObservedWorker.prototype = NativeWorker.prototype;
  Object.setPrototypeOf(ObservedWorker, NativeWorker);
  window.Worker = ObservedWorker;
})();
