// A bounded, isolated client for the original local package's genuine JSON Worker.
// The parent iframe injects this before frame operations; the original package remains unchanged.
(function () {
  var validText = '{"ok":true,"items":[1,2]}';
  var invalidText = '{"ok":}';
  var recoveryText = '{"ok":true,"items":[3]}';
  var uri = "inmemory://atools-worker-contract/model.json";
  var deadlineMs = 3800;
  var workerTimeoutMs = 700;

  function required(condition, message) {
    if (!condition) throw Error(message);
  }
  function elapsedSince(began) {
    return Math.max(0, Math.round(performance.now() - began));
  }
  function markerSummary(value) {
    required(Array.isArray(value), "validation reply was not a diagnostic array");
    var errors = value.filter(function (item) { return item && item.severity === 1; });
    var positions = errors.slice(0, 3).map(function (item) {
      var start = item && item.range && item.range.start;
      return { line: Number(start && start.line) + 1, column: Number(start && start.character) + 1 };
    }).filter(function (position) {
      return Number.isSafeInteger(position.line) && position.line > 0
        && Number.isSafeInteger(position.column) && position.column > 0;
    });
    var codes = value.slice(0, 4).map(function (item) {
      var code = item && item.code;
      return typeof code === "number" || typeof code === "string" && /^[0-9]{1,12}$/.test(code)
        ? String(code).slice(0, 12) : "";
    }).filter(Boolean);
    return { markerCount: value.length, errorCount: errors.length, codes: codes, positions: positions };
  }
  function run() {
    var began = performance.now();
    var environment = window.MonacoEnvironment || self.MonacoEnvironment;
    required(environment && typeof environment.getWorkerUrl === "function",
      "Original Monaco JSON worker URL resolver is unavailable");
    var workerUrl = environment.getWorkerUrl("workerMain.js", "json");
    required(typeof workerUrl === "string" && workerUrl.length > 0,
      "Original Monaco JSON worker URL resolver returned no URL");
    var worker;
    try {
      worker = new Worker(workerUrl, { name: "json-contract" });
    } catch (_) {
      throw Error("Original JSON worker-contract construction failed");
    }
    var listeners = [];
    var timer = 0;
    var pending = null;
    var nextSequence = 1;
    var stages = [];
    var lastFailureKind = "";

    function onMessage(event) {
      if (!event || event.isTrusted !== true) return;
      var message = event.data;
      if (!pending || !message || message.vsWorker !== 1 || message.type !== 1
        || String(message.seq) !== pending.sequence) return;
      var current = pending;
      pending = null;
      clearTimeout(timer);
      timer = 0;
      if (elapsedSince(began) > deadlineMs) {
        lastFailureKind = "timeout";
        current.reject(Error("overall deadline"));
        return;
      }
      if (message.err != null) {
        lastFailureKind = "rpc-error";
        current.reject(Error("Original JSON worker-contract RPC returned an error"));
        return;
      }
      current.resolve(message);
    }
    function onError() {
      if (!pending) return;
      var current = pending;
      pending = null;
      clearTimeout(timer);
      timer = 0;
      lastFailureKind = "worker-error";
      current.reject(Error("Original JSON worker-contract emitted an error"));
    }
    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    listeners.push(["message", onMessage], ["error", onError]);

    function rpc(method, args) {
      if (performance.now() - began >= deadlineMs) {
        lastFailureKind = "timeout";
        return Promise.reject(Error("overall deadline"));
      }
      var sequence = String(nextSequence++);
      return new Promise(function (resolve, reject) {
        pending = { sequence: sequence, resolve: resolve, reject: reject };
        var remaining = deadlineMs - (performance.now() - began);
        timer = setTimeout(function () {
          if (!pending || pending.sequence !== sequence) return;
          pending = null;
          timer = 0;
          lastFailureKind = "timeout";
          reject(Error("request deadline"));
        }, Math.max(1, Math.min(workerTimeoutMs, remaining)));
        try {
          worker.postMessage({ vsWorker: 1, type: 0, req: sequence, method: method, args: args });
        } catch (_) {
          clearTimeout(timer);
          timer = 0;
          pending = null;
          lastFailureKind = "dispatch-error";
          reject(Error("request dispatch failed"));
        }
      });
    }
    function assertAck(reply, sequence, label) {
      required(reply && reply.vsWorker === 1 && reply.type === 1 && String(reply.seq) === sequence
        && (reply.err == null), label + " acknowledgement was not paired to its request");
    }
    async function perform() {
      // The first message selects the original Monaco SimpleWorker protocol; it is consumed by bootstrap.
      worker.postMessage("vs/base/common/worker/simpleWorker");
      var init = await rpc("$initialize", [1, null,
        "vs/editor/common/services/editorSimpleWorker", []]);
      required(Array.isArray(init.res) && ["acceptNewModel", "acceptModelChanged", "loadForeignModule", "fmr"]
        .every(function (name) { return init.res.indexOf(name) >= 0; }),
      "Original JSON worker initialization did not expose the expected protocol methods");
      stages.push({ stage: "initialize", request: "1", response: "1" });

      var loaded = await rpc("loadForeignModule", ["vs/language/json/jsonWorker", {
        languageId: "json", languageSettings: { validate: true, allowComments: false, schemas: [] },
        enableSchemaRequest: false
      }, []]);
      required(Array.isArray(loaded.res) && loaded.res.includes("doValidation") && loaded.res.includes("format"),
        "Original JSON worker did not load its JSON language service");
      stages.push({ stage: "load-json-language-service", request: "2", response: "2" });

      var created = await rpc("acceptNewModel", [{ url: uri, lines: [validText], EOL: "\n", versionId: 1 }]);
      assertAck(created, "3", "valid model");
      var validReply = await rpc("fmr", ["doValidation", [uri]]);
      var valid = markerSummary(validReply.res);
      required(valid.markerCount === 0 && valid.errorCount === 0,
        "Original JSON worker rejected the fixed valid JSON input");
      stages.push({ stage: "valid", expectedVersion: 1, updateRequest: "3", updateAck: "3",
        validationRequest: "4", validationResponse: "4", ...valid });

      var changed = await rpc("acceptModelChanged", [uri, { eol: "\n", versionId: 2,
        changes: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1,
          endColumn: validText.length + 1 }, text: invalidText }] }]);
      assertAck(changed, "5", "malformed model");
      var invalidReply = await rpc("fmr", ["doValidation", [uri]]);
      var invalid = markerSummary(invalidReply.res);
      required(invalid.markerCount > 0 && invalid.errorCount > 0 && invalid.positions.length > 0,
        "Original JSON worker did not return a positioned error for malformed JSON");
      stages.push({ stage: "malformed", expectedVersion: 2, updateRequest: "5", updateAck: "5",
        validationRequest: "6", validationResponse: "6", ...invalid });

      var recovered = await rpc("acceptModelChanged", [uri, { eol: "\n", versionId: 3,
        changes: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1,
          endColumn: invalidText.length + 1 }, text: recoveryText }] }]);
      assertAck(recovered, "7", "recovery model");
      var recoveryReply = await rpc("fmr", ["doValidation", [uri]]);
      var recovery = markerSummary(recoveryReply.res);
      required(recovery.markerCount === 0 && recovery.errorCount === 0,
        "Original JSON worker did not clear diagnostics after valid recovery");
      stages.push({ stage: "recovery", expectedVersion: 3, updateRequest: "7", updateAck: "7",
        validationRequest: "8", validationResponse: "8", ...recovery });

      var removed = await rpc("acceptRemovedModel", [uri]);
      assertAck(removed, "9", "model removal");
      stages.push({ stage: "remove-model", request: "9", response: "9" });
      required(elapsedSince(began) <= deadlineMs, "overall deadline");
      return { completed: true, entryResolved: true, stages: stages,
        elapsedMs: elapsedSince(began) };
    }

    return perform().catch(function (error) {
      var phase = stages.length ? stages[stages.length - 1].stage : "worker-bootstrap";
      // Worker errors are deliberately reduced to stage and bounded failure type, never message payloads.
      return { completed: false, entryResolved: true, failedStage: phase,
        failureKind: lastFailureKind || "contract-assertion",
        elapsedMs: elapsedSince(began) };
    }).finally(function () {
      if (timer) clearTimeout(timer);
      timer = 0;
      pending = null;
      listeners.forEach(function (item) { worker.removeEventListener(item[0], item[1]); });
      try { worker.terminate(); } catch (_) {}
    });
  }

  window.__ATOOLS_JSON_WORKER_CONTRACT__ = Object.freeze({ run: run });
})();
