import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_NODE_REQUEST_BYTES = 1024 * 1024;
const MAX_DATA_BYTES = 512 * 1024;
const MAX_DIALOG_BYTES = 32 * 1024 + 128;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const LISTENER_TIMEOUT_MS = 2000;
const MAX_DIAGNOSTIC_PATHS = 8;
const MAX_NODE_PARAM_SAMPLES = 24;
const MAX_DIAGNOSTIC_STRING_LENGTH = 160;
const SENSITIVE_DIAGNOSTIC_KEY = /token|authorization|password|secret|credential|cookie|api[-_]?key|auth/i;
const SAFE_DIAGNOSTIC_TEXT_KEYS = new Set(["specifier", "property", "method", "module", "moduleName", "operation"]);

function failure(message, code = "ERR_ATOOLS_ORIGINAL_PLUGIN_HOST_PORT") {
  return Object.assign(new Error(message), { code });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function inside(root, candidate) {
  const segment = relative(root, candidate);
  return segment === "" || (segment !== ".." && !segment.startsWith(`..${sep}`) && !isAbsolute(segment));
}

function count(table, key) {
  Object.defineProperty(table, key, { value: (Object.hasOwn(table, key) ? table[key] : 0) + 1,
    writable: true, enumerable: true, configurable: true });
}

function limitedEntries(value, maximum) {
  const entries = [];
  for (const key in value) {
    if (!Object.hasOwn(value, key) || SENSITIVE_DIAGNOSTIC_KEY.test(key)) continue;
    entries.push([key.slice(0, 80), value[key]]);
    if (entries.length >= maximum) break;
  }
  return entries;
}

function summarizeArgumentShape(value, depth = 0) {
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "string", length: value.length };
  if (typeof value !== "object") return { type: typeof value };
  if (Array.isArray(value)) {
    return { type: "array", length: value.length,
      ...(depth < 3 ? { items: value.slice(0, 8).map(item => summarizeArgumentShape(item, depth + 1)) } : {}) };
  }
  const entries = limitedEntries(value, 8);
  return { type: "object", keys: entries.map(([key]) => key),
    ...(depth < 3 ? { fields: entries.map(([key, child]) => ({ name: key, shape: summarizeArgumentShape(child, depth + 1) })) } : {}) };
}

function summarizeNodeParams(params) {
  const fields = limitedEntries(params, 12).map(([key, value]) => {
    if (key === "handleId" && (typeof value === "string" || typeof value === "number")) {
      return { name: key, handleHash: createHash("sha256").update(String(value)).digest("hex").slice(0, 12) };
    }
    if (key === "args") return { name: key, shape: summarizeArgumentShape(value) };
    if (SAFE_DIAGNOSTIC_TEXT_KEYS.has(key) && typeof value === "string") {
      return { name: key, value: value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH) };
    }
    return { name: key, shape: summarizeArgumentShape(value) };
  });
  return { fields };
}

function recordNativeTextPath(stats, method, targetPath, scratchRoot, pluginDataRoot) {
  const histogram = stats.nativeTextPort.pathHistogram ??= { paths: [], omittedCalls: 0 };
  const rootName = inside(pluginDataRoot, targetPath) ? "pluginData" : "scratch";
  const root = rootName === "pluginData" ? pluginDataRoot : scratchRoot;
  const relativePath = relative(root, targetPath) || ".";
  const fullLabel = `${rootName}/${relativePath}`;
  const label = fullLabel.length <= MAX_DIAGNOSTIC_STRING_LENGTH ? fullLabel
    : `${fullLabel.slice(0, 140)}#${createHash("sha256").update(fullLabel).digest("hex").slice(0, 16)}`;
  let entry = histogram.paths.find(item => item.path === label);
  if (!entry && histogram.paths.length < MAX_DIAGNOSTIC_PATHS) {
    entry = { path: label, reads: 0, writes: 0 };
    histogram.paths.push(entry);
  }
  if (!entry) { histogram.omittedCalls++; return; }
  if (method === "readTextPath") entry.reads++;
  else entry.writes++;
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(failure(`${label} timed out`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

function readJsonBody(request, maximum) {
  return (async () => {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.byteLength;
      if (bytes > maximum) throw failure("Request exceeds fixture byte budget", "ERR_ATOOLS_FIXTURE_REQUEST_LIMIT");
      chunks.push(chunk);
    }
    if (bytes === 0) throw failure("Request body is empty", "ERR_ATOOLS_FIXTURE_REQUEST_INVALID");
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
    catch { throw failure("Request body is not valid JSON", "ERR_ATOOLS_FIXTURE_REQUEST_INVALID"); }
  })();
}

function jsonResponse(response, status, value, origin) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Connection: "close",
    ...(origin ? {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true",
      Vary: "Origin",
    } : {}),
  });
  response.end(JSON.stringify(value));
}

function errorReply(response, error, origin, status = 200) {
  jsonResponse(response, status, { ok: false, error: { code: String(error?.code ?? "ERR_ATOOLS_FIXTURE_PORT"),
    message: String(error?.message ?? error).slice(0, 4096) } }, origin);
}

function validateTextPath(value, scratchRoot, pluginDataRoot) {
  if (typeof value !== "string" || !value || value.includes("\0") || !isAbsolute(value) || resolve(value) !== value
    || Buffer.byteLength(value, "utf8") > 8192
    || (!inside(scratchRoot, value) && !inside(pluginDataRoot, value))) {
    throw failure("native text fallback accepts only canonical fixture paths", "ERR_ATOOLS_NATIVE_FS_REQUEST");
  }
}

function validateNodeEnvelope(body) {
  if (!hasExactKeys(body, ["method", "params"]) || typeof body.method !== "string" || !body.method
    || body.method.length > 128 || !isRecord(body.params)) {
    throw failure("Invalid Node module bridge envelope", "ERR_ATOOLS_FIXTURE_NODE_REQUEST");
  }
}

function validateDataEnvelope(body) {
  if (!hasExactKeys(body, ["method", "args"]) || typeof body.method !== "string" || !body.method
    || body.method.length > 128 || !Array.isArray(body.args) || body.args.length > 256) {
    throw failure("Invalid PluginData envelope", "ERR_ATOOLS_FIXTURE_DATA_REQUEST");
  }
}

function validateDialogEnvelope(body, method) {
  if (!hasExactKeys(body, ["method", "options"]) || body.method !== method || !isRecord(body.options)) {
    throw failure(`Fixture dialog port accepts only ${method} with options`, "ERR_ATOOLS_FIXTURE_DIALOG_REQUEST");
  }
}

function openDialogMode(options) {
  const properties = options.properties;
  if (!Array.isArray(properties) || properties.length === 0 || properties.length > 2
    || properties.some(value => typeof value !== "string") || new Set(properties).size !== properties.length) {
    throw failure("showOpenDialog requires a supported properties list", "ERR_ATOOLS_FIXTURE_DIALOG_PROPERTIES");
  }
  const propertySet = new Set(properties);
  if (propertySet.has("openFile") && propertySet.has("openDirectory")) {
    throw failure("showOpenDialog cannot mix file and directory selection", "ERR_ATOOLS_FIXTURE_DIALOG_PROPERTIES");
  }
  if (propertySet.has("openFile") && properties.every(value => ["openFile", "multiSelections"].includes(value))) {
    return { kind: "file", multiSelections: propertySet.has("multiSelections") };
  }
  if (propertySet.has("openDirectory") && properties.every(value => ["openDirectory", "createDirectory"].includes(value))) {
    return { kind: "directory" };
  }
  throw failure("showOpenDialog properties are unsupported", "ERR_ATOOLS_FIXTURE_DIALOG_PROPERTIES");
}

/** Owner-scoped loopback fixture ports with fixed, private dialog results. */
export function createOriginalPluginHostPorts({ pluginId, origin, saveAsPath, openFilePath, openDirectoryPath,
  inputSelections, scratchRoot, pluginDataRoot, pluginData, forwardNode, stats }) {
  const openDialogEnabled = openFilePath !== undefined || openDirectoryPath !== undefined || inputSelections !== undefined;
  const names = ["node", "data", "saveDialog", ...(openDialogEnabled ? ["openDialog"] : [])];
  const tokens = Object.fromEntries(names.map(name => [name, randomBytes(32).toString("hex")]));
  const routes = new Map([
    [`/node/${tokens.node}`, "node"], [`/data/${tokens.data}`, "data"], [`/dialog/${tokens.saveDialog}`, "saveDialog"],
  ]);
  if (openDialogEnabled) routes.set(`/dialog/${tokens.openDialog}`, "openDialog");
  const selections = inputSelections?.map(group => [...group]);
  let nextInputSelection = 0;
  const sockets = new Set();
  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(error => errorReply(response, error, origin));
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  let bindState = "idle";
  let bindOutcome;
  let resolveBindOutcome;
  let bindOutcomeSettled = false;
  let closeRequested = false;
  let lateListenerCloseError;
  let listenerClose;
  let listening;
  let closing;
  let host;

  function settleBindOutcome(outcome) {
    if (bindOutcomeSettled) return;
    bindOutcomeSettled = true;
    resolveBindOutcome(outcome);
  }

  function closeBoundListener() {
    if (listenerClose) return listenerClose;
    listenerClose = (async () => {
      const socketClosed = [...sockets].map(socket => new Promise(resolveSocket => socket.once("close", resolveSocket)));
      try {
        for (const socket of sockets) socket.destroy();
        if (server.listening) {
          await bounded(new Promise((resolveClose, rejectClose) => {
            server.close(error => error ? rejectClose(error) : resolveClose());
            server.closeAllConnections?.();
          }), LISTENER_TIMEOUT_MS, `${pluginId} fixture listener close`);
        }
        await bounded(Promise.all(socketClosed), LISTENER_TIMEOUT_MS, `${pluginId} fixture sockets close`);
      } catch (error) {
        throw failure(`Listener cleanup was not confirmed: ${String(error?.message ?? error)}`,
          "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
      }
      if (server.listening || sockets.size) {
        throw failure("Original plugin fixture listener or sockets remained open", "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
      }
      if (lateListenerCloseError) {
        throw failure(`Late listener cleanup failed: ${String(lateListenerCloseError.message ?? lateListenerCloseError)}`,
          "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
      }
      return { listenerClosed: true };
    })();
    return listenerClose;
  }

  async function startListening() {
    if (listening) return listening;
    if (closeRequested) throw failure("Original plugin fixture listener is already closing", "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
    bindState = "pending";
    bindOutcome = new Promise(resolveOutcome => { resolveBindOutcome = resolveOutcome; });
    server.once("listening", () => {
      bindState = "listening";
      settleBindOutcome({ kind: "listening" });
      if (closeRequested) closeBoundListener().catch(error => { lateListenerCloseError = error; });
    });
    server.on("error", error => {
      if (bindState === "pending") {
        bindState = "failed";
        settleBindOutcome({ kind: "error", error });
      } else lateListenerCloseError = error;
    });
    try { server.listen(0, "127.0.0.1"); }
    catch (error) {
      bindState = "failed";
      settleBindOutcome({ kind: "error", error });
    }
    listening = (async () => {
      let outcome;
      try { outcome = await bounded(bindOutcome, LISTENER_TIMEOUT_MS, `${pluginId} fixture listener startup`); }
      catch {
        closeRequested = true;
        void close().catch(error => { lateListenerCloseError = error; });
        throw failure("Original plugin fixture listener bind was not confirmed", "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
      }
      if (outcome.kind === "error") throw outcome.error;
      if (closeRequested || !server.listening) {
        throw failure("Original plugin fixture listener closed before readiness", "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
      }
      const address = server.address();
      if (!address || typeof address !== "object" || address.address !== "127.0.0.1") {
        throw failure("Fixture listener did not bind to loopback", "ERR_ATOOLS_FIXTURE_LISTENER_BIND");
      }
      host = `127.0.0.1:${address.port}`;
      return endpointBundle();
    })();
    return listening;
  }

  function endpointBundle() {
    return {
      node: `http://${host}/node/${tokens.node}`,
      data: `http://${host}/data/${tokens.data}`,
      saveDialog: `http://${host}/dialog/${tokens.saveDialog}`,
      ...(openDialogEnabled ? { openDialog: `http://${host}/dialog/${tokens.openDialog}` } : {}),
    };
  }

  async function nodePort(body) {
    validateNodeEnvelope(body);
    count(stats.methods, `node.${body.method}`);
    if (body.method === "require" && typeof body.params.specifier === "string") stats.nodeModules.add(body.params.specifier);
    if (body.method === "readTextPath" || body.method === "writeTextPath") {
      const keys = body.method === "readTextPath" ? ["path"] : ["path", "text"];
      if (!hasExactKeys(body.params, keys)) throw failure(`${body.method} request shape is invalid`, "ERR_ATOOLS_NATIVE_FS_REQUEST");
      validateTextPath(body.params.path, scratchRoot, pluginDataRoot);
      recordNativeTextPath(stats, body.method, body.params.path, scratchRoot, pluginDataRoot);
      if (body.method === "readTextPath") stats.nativeTextPort.readRequests++;
      else {
        if (typeof body.params.text !== "string" || Buffer.byteLength(body.params.text, "utf8") > 512 * 1024) {
          throw failure("writeTextPath body exceeds fixture limit", "ERR_ATOOLS_NATIVE_FS_REQUEST");
        }
        stats.nativeTextPort.writeRequests++;
      }
      stats.denials.nativeTextFallback++;
      return { handled: false };
    }
    if (body.method === "get" || body.method === "call") {
      stats.nodeCallParamTail.push({ method: body.method, params: summarizeNodeParams(body.params) });
      if (stats.nodeCallParamTail.length > MAX_NODE_PARAM_SAMPLES) stats.nodeCallParamTail.shift();
    }
    return forwardNode(body.method, body.params);
  }

  async function dataPort(body) {
    validateDataEnvelope(body);
    count(stats.methods, `data.${body.method}`);
    return pluginData.dispatch(body.method, body.args) ?? null;
  }

  async function recordDialog(body, resultPaths) {
    const method = body.method;
    validateDialogEnvelope(body, method);
    if (Buffer.byteLength(JSON.stringify(body.options), "utf8") > MAX_DIALOG_BYTES) {
      throw failure("Dialog options exceed fixture limit", "ERR_ATOOLS_FIXTURE_DIALOG_LIMIT");
    }
    count(stats.methods, `dialog.${body.method}`);
    stats.dialogs.push({ method, options: structuredClone(body.options),
      resultPath: resultPaths.length === 1 ? resultPaths[0] : null, resultPaths: [...resultPaths] });
    return { canceled: false, paths: [...resultPaths] };
  }

  const saveDialogPort = body => {
    validateDialogEnvelope(body, "showSaveDialog");
    return recordDialog(body, [saveAsPath]);
  };

  async function openDialogPort(body) {
    validateDialogEnvelope(body, "showOpenDialog");
    if (Buffer.byteLength(JSON.stringify(body.options), "utf8") > MAX_DIALOG_BYTES) {
      throw failure("Dialog options exceed fixture limit", "ERR_ATOOLS_FIXTURE_DIALOG_LIMIT");
    }
    const mode = openDialogMode(body.options);
    let resultPaths;
    if (mode.kind === "file") {
      if (selections) {
        if (nextInputSelection >= selections.length) {
          throw failure("No fixed input selection remains", "ERR_ATOOLS_FIXTURE_DIALOG_SELECTIONS_EXHAUSTED");
        }
        const configuredPaths = selections[nextInputSelection];
        if (!mode.multiSelections && configuredPaths.length !== 1) {
          throw failure("Multiple fixed files require multiSelections", "ERR_ATOOLS_FIXTURE_DIALOG_PROPERTIES");
        }
        resultPaths = configuredPaths;
        nextInputSelection++;
      } else if (openFilePath !== undefined) resultPaths = [openFilePath];
      else throw failure("No fixed file selection is configured", "ERR_ATOOLS_FIXTURE_DIALOG_UNCONFIGURED");
    } else {
      if (openDirectoryPath === undefined) {
        throw failure("No fixed directory selection is configured", "ERR_ATOOLS_FIXTURE_DIALOG_UNCONFIGURED");
      }
      resultPaths = [openDirectoryPath];
    }
    count(stats.methods, "dialog.showOpenDialog");
    stats.dialogs.push({ method: body.method, options: structuredClone(body.options),
      resultPath: resultPaths.length === 1 ? resultPaths[0] : null, resultPaths: [...resultPaths] });
    return { canceled: false, paths: [...resultPaths] };
  }

  async function handleRequest(request, response) {
    const route = routes.get(request.url);
    if (!host || !route || request.headers.host !== host || request.headers.origin !== origin) {
      count(stats.denials, "route");
      jsonResponse(response, 403, { ok: false, error: { code: "ERR_ATOOLS_FIXTURE_ROUTE", message: "Fixture route rejected" } });
      return;
    }
    if (request.method === "OPTIONS") {
      if (request.headers["access-control-request-method"] !== "POST") {
        count(stats.denials, "route");
        jsonResponse(response, 403, { ok: false, error: { code: "ERR_ATOOLS_FIXTURE_ROUTE", message: "Preflight rejected" } });
        return;
      }
      count(stats.methods, `${route}.options`);
      jsonResponse(response, 204, null, origin);
      return;
    }
    if (request.method !== "POST") {
      jsonResponse(response, 405, { ok: false, error: { code: "ERR_ATOOLS_FIXTURE_METHOD", message: "POST required" } }, origin);
      return;
    }
    const contentType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
    const isDialog = route === "saveDialog" || route === "openDialog";
    const expectedTypes = isDialog ? ["text/plain", "application/json"] : ["application/json"];
    if (!expectedTypes.includes(contentType)) {
      jsonResponse(response, 415, { ok: false, error: { code: "ERR_ATOOLS_FIXTURE_CONTENT_TYPE", message: "Unsupported content type" } }, origin);
      return;
    }
    const maximum = route === "data" ? MAX_DATA_BYTES : isDialog ? MAX_DIALOG_BYTES : MAX_NODE_REQUEST_BYTES;
    try {
      const body = await readJsonBody(request, maximum);
      stats.requests++;
      const result = route === "node" ? await nodePort(body)
        : route === "data" ? await dataPort(body)
          : route === "saveDialog" ? await saveDialogPort(body) : await openDialogPort(body);
      const envelope = { ok: true, result };
      const limit = route === "data" ? MAX_DATA_BYTES : MAX_RESPONSE_BYTES;
      if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > limit) {
        throw failure("Fixture response exceeds byte budget", "ERR_ATOOLS_FIXTURE_RESPONSE_LIMIT");
      }
      jsonResponse(response, 200, envelope, origin);
    } catch (error) {
      if (error?.code === "ERR_ATOOLS_FIXTURE_REQUEST_LIMIT") count(stats.denials, "requestLimit");
      errorReply(response, error, origin);
    }
  }

  async function close() {
    if (closing) return closing;
    closeRequested = true;
    closing = (async () => {
      if (bindState === "pending") {
      try { await bounded(bindOutcome, LISTENER_TIMEOUT_MS, `${pluginId} fixture listener bind before close`); }
        catch {
          throw failure("Listener bind outcome is unconfirmed during cleanup", "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
        }
      }
      if (bindState === "pending") throw failure("Listener bind remained pending during cleanup", "ERR_ATOOLS_FIXTURE_LISTENER_OPEN");
      return closeBoundListener();
    })();
    return closing;
  }

  return { listen: startListening, close, activeSocketCount: () => sockets.size };
}
