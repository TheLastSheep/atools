import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";

const dependencyRequire = createRequire(createRequire(import.meta.url).resolve("vite"));
const { build } = dependencyRequire("esbuild");
const scriptTag = source => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
// Parser-blocking data scripts preserve global lexical bindings and the exact
// original classic source, without HTML-parser escapes corrupting bundle strings.
const originalScriptTag = source => `<script src="data:text/javascript;base64,${Buffer.from(source).toString("base64")}"></script>`;
const beforeClosingBody = (html, content) => {
  // Released bundles can contain literal "</body>" in strings; use the final tag.
  const matches = [...html.matchAll(/<\/body\s*>/gi)], match = matches[matches.length - 1];
  return match ? html.slice(0, match.index) + content + html.slice(match.index) : html + content;
};
function documentShell(html) {
  if (!/<html\b/i.test(html)) return `<!doctype html><html><head></head><body>${html}</body></html>`;
  if (!/<head\b/i.test(html)) html = html.replace(/<html\b[^>]*>/i, "$&<head></head>");
  if (!/<body\b/i.test(html)) html = html.replace(/<\/html\s*>/i, "<body></body></html>");
  if (!/<body\b/i.test(html)) html += "<body></body>";
  return html;
}

/** Inline only existing released scripts; no install, output files or plugin build. */
export async function inlineOriginalPage(html, entry, pluginDir, readTracked) {
  html = documentShell(html);
  const scripts = [], omittedAssets = [], warnings = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(pattern)) {
    const attributes = match[1], sourceMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attributes);
    const type = /\btype\s*=\s*["']([^"']+)["']/i.exec(attributes)?.[1];
    if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue;
    let source = match[2], filename = entry;
    if (sourceMatch) {
      const address = sourceMatch[1];
      if (/^(?:https?:|\/\/)/i.test(address)) { omittedAssets.push(address); continue; }
      filename = address.startsWith("/") ? resolve(pluginDir, address.slice(1)) : resolve(dirname(entry), address);
      if (/\.(?:tsx?|jsx)$/.test(filename) || /(?:^|\/)src\/main\./.test(filename)) {
        throw new Error("ENTRY_REQUIRES_BUILD: source entry is not a released JavaScript asset");
      }
      source = await readTracked(filename);
    }
    if (type === "module") {
      const result = await build({
        stdin: { contents: source, resolveDir: dirname(filename), sourcefile: filename, loader: "js" },
        bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
        logLevel: "silent", metafile: true,
      });
      for (const input of Object.keys(result.metafile.inputs)) {
        if (input !== filename && !input.endsWith("<stdin>")) {
          await readTracked(isAbsolute(input) ? input : resolve(input));
        }
      }
      warnings.push(...result.warnings.map(warning => warning.text));
      source = result.outputFiles[0].text;
    }
    scripts.push(originalScriptTag(source));
  }
  const body = html.replace(pattern, "").replace(/<link\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/gi, "");
  return { html: beforeClosingBody(body, scripts.join("\n")), omittedAssets, warnings };
}

function installInstrumentation(config, createElectronAdapter) {
  const state = window.__matrix = { phase: "preload", loadErrors: [], hostFailures: [], unsupportedHostReads: [], requests: [], callbacks: {}, tools: {} };
  const describe = error => `${error?.name || "Error"}: ${error?.message || String(error)}\n${error?.stack || ""}`
    .replace(/data:text\/javascript;base64,[a-zA-Z0-9+/=]+/g, "[original-script]").slice(0, 8000);
  addEventListener("error", event => state.loadErrors.push({ phase: state.phase, error: describe(event.error || event.message) }));
  addEventListener("unhandledrejection", event => state.loadErrors.push({ phase: state.phase, error: describe(event.reason) }));
  state.recordPreloadError = error => state.loadErrors.push({ phase: "preload", error: describe(error) });
  const host = {};
  for (const name of ["onPluginEnter", "onPluginOut", "onPluginReady", "onMainPush", "onPluginAttach", "onPluginDetach"]) {
    host[name] = (...callbacks) => { (state.callbacks[name] ??= []).push(...callbacks); };
  }
  host.registerTool = (name, handler) => { state.tools[name] = handler; };
  // These are actual immutable project/OS values, not invented version gates.
  const ipcListeners = new Map();
  const broker = {
    on(channel, callback) { if (typeof channel !== "string" || typeof callback !== "function") throw new TypeError("Invalid IPC listener"); const set = ipcListeners.get(channel) || new Set(); set.add(callback); ipcListeners.set(channel, set); },
    once(channel, callback) { const once = (...args) => { broker.off(channel, once); callback(...args); }; broker.on(channel, once); },
    off(channel, callback) { ipcListeners.get(channel)?.delete(callback); },
    removeAllListeners(channel) { if (channel === undefined) ipcListeners.clear(); else ipcListeners.delete(channel); },
  };
  broker.addListener = broker.on; broker.removeListener = broker.off;
  state.emitIpc = (channel, ...args) => { for (const callback of [...(ipcListeners.get(channel) || [])]) callback({ sender: null }, ...args); };
  const electron = createElectronAdapter({ application: config.hostMetadata, ipcRenderer: broker });
  host.getAppVersion = electron.app.getVersion;
  host.getAppName = electron.app.getName;
  host.isMacOS = host.isMacOs = () => config.hostMetadata.platform === "darwin";
  host.isWindows = () => config.hostMetadata.platform === "win32";
  host.isLinux = () => config.hostMetadata.platform === "linux";
  // Optional APIs are genuinely absent. Calls to missing functions fail normally;
  // reads are recorded rather than replaced with blanket successful no-ops.
  const api = new Proxy(host, { get(target, property) {
    if (typeof property === "string" && !(property in target) && !state.unsupportedHostReads.includes(property)) state.unsupportedHostReads.push(property);
    return target[property];
  } });
  window.ztools = window.utools = api;
  window.require = specifier => {
    if (specifier === "electron") return electron;
    const error = new Error(`HOST_API_UNAVAILABLE: local require(${specifier}) is unavailable in the fixture`);
    state.hostFailures.push({ specifier, error: error.message }); throw error;
  };
  function record(body, asynchronous) {
    try { const request = JSON.parse(body); state.requests.push({ method: request.method, asynchronous }); } catch {}
  }
  const open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, asynchronous = true) { this.__asynchronous = asynchronous; return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(body) { record(body, this.__asynchronous); return send.apply(this, arguments); };
  const fetch = window.fetch;
  window.fetch = function(url, options) { record(options?.body, true); return fetch.apply(this, arguments); };
  state.config = config;
  state.baselineGlobals = Object.keys(window);
}

async function executeProbe(probe) {
  const state = window.__matrix;
  const result = { clientOrigin: location.origin, cases: [], loadErrors: state.loadErrors,
    hostFailures: state.hostFailures,
    unsupportedHostReads: state.unsupportedHostReads, registeredTools: Object.keys(state.tools),
    preloadLoaded: state.preloadLoaded, uiIncluded: state.config.ui };
  try { void parent.document.body; result.parentDocumentBlocked = false; }
  catch { result.parentDocumentBlocked = true; }
  function check(value, message) { if (!value) throw new Error(`ASSERTION_FAILED: ${message}`); }
  const describe = error => `${error?.name || "Error"}: ${error?.message || String(error)}\n${error?.stack || ""}`
    .replace(/data:text\/javascript;base64,[a-zA-Z0-9+/=]+/g, "[original-script]").slice(0, 8000);
  function classify(error) {
    if (/MATRIX_SCOPE_BLOCKED/.test(error)) return "scope_blocked";
    if (/Cannot find module|MODULE_NOT_FOUND/.test(error)) return "missing_dependencies";
    if (/HOST_|ERR_ATOOLS_NODE_PROPERTY|ERR_ATOOLS_HOST_API|upgrade|not a function|undefined.*object|undefined.*propert/i.test(error)) return "api_service_blocked";
    if (/import|module script|HAR_ANALYSIS_FAILED|CONTRACT_COMPARISON_FAILED/i.test(error)) return "runtime_module_blocked";
    if (/ERR_ATOOLS_NODE_BUFFER_ENCODING/.test(error)) return "runtime_value_blocked";
    return "business_failed";
  }
  const ctx = {
    config: state.config, check,
    async enter(code, payload = "", type = "text") { for (const callback of state.callbacks.onPluginEnter || []) await callback({ code, payload, type }); },
    block(reason) { throw Object.assign(new Error(`MATRIX_SCOPE_BLOCKED: ${reason}`), { code: "MATRIX_SCOPE_BLOCKED" }); },
    recordSurface(value) { result.surface = value; },
    async waitFor(predicate) {
      const deadline = performance.now() + 2000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error("ASSERTION_FAILED: expected original UI behavior did not occur");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    async test(name, fn, options = {}) {
      const started = performance.now(), before = state.requests.length;
      try { result.cases.push({ name, status: options.kind === "validation" ? "validation_passed" : "business_passed", value: await fn(), durationMs: performance.now() - started, requests: state.requests.length - before }); }
      catch (error) {
        const message = `${describe(error)}\ncode=${error?.code || ""}`;
        result.cases.push({ name, status: classify(message), error: message, code: error?.code,
          durationMs: performance.now() - started, requests: state.requests.length - before });
      }
    },
  };
  try { await probe(ctx); }
  catch (error) { result.harnessError = String(error?.stack || error); }
  window.__atoolsImportModule?.close();
  window.__atoolsNodeModuleRequire?.close();
  for (const callback of state.callbacks.onPluginOut || []) {
    try { await callback(); } catch (error) { result.cleanupCallbackError = String(error); }
  }
  await new Promise(resolve => setTimeout(resolve, 60));
  result.totalRequests = state.requests.length;
  result.methods = Object.fromEntries([...new Set(state.requests.map(request => request.method))]
    .map(method => [method, state.requests.filter(request => request.method === method).length]));
  result.passed = !result.harnessError && result.parentDocumentBlocked && result.clientOrigin === "null";
  parent.postMessage({ type: "business-result", result }, "*");
}

export function matrixFrameHtml({ page, preload, bridge, config, probe, electronFactory }) {
  const setup = scriptTag(`(${installInstrumentation.toString()})(${JSON.stringify(config)},(${electronFactory.toString()}))`);
  const node = bridge ? scriptTag(`window.__atoolsNodeModuleRequire=${bridge};
window.require=window.__atoolsNodeModuleRequire; window.process=window.require('process');
window.Buffer=window.require('buffer').Buffer;
window.setImmediate=(fn)=>setTimeout(fn,0); window.clearImmediate=clearTimeout;`) : "";
  const phase = scriptTag("window.__matrix.preloadLoaded=!window.__matrix.loadErrors.length; window.__matrix.phase='ui';");
  const functionSource = probe.toString().replace(/^async\s+probe\s*\(/, "async function(");
  const run = scriptTag(`addEventListener('DOMContentLoaded',()=>setTimeout(()=>(${executeProbe.toString()})(${functionSource}),60),{once:true});`);
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline'; connect-src http://127.0.0.1:*; img-src data: blob:;">`;
  const guardedPreload = preload.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script\s*>)/gi,
    (_, open, source, close) => `${open}try{\n${source}\n}catch(error){window.__matrix.recordPreloadError(error);throw error;}\n${close}`);
  const before = csp + setup + node + guardedPreload + phase;
  return beforeClosingBody(documentShell(page).replace(/<head[^>]*>/i, "$&" + before), run);
}
