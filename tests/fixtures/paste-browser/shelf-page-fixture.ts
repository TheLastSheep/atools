import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CdpClient } from "../../../scripts/chrome-cdp-smoke-utils.mjs";
import { pasteBrowserPin } from "./original-assets";
import { createPasteShelfHistoryRelay, type PasteShelfHistoryRelayReport } from "./shelf-history-relay";

const origin = "https://pasteboard-pro.fixture.invalid";
const corsResponseHeaders = new Set([
  "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
  "access-control-allow-credentials", "access-control-allow-private-network", "access-control-expose-headers",
]);

export type PasteShelfEndpoints = Record<"node" | "data" | "history" | "write" | "contentWrite" | "secret", string>;
export type PasteShelfNetworkReport = {
  origin: string;
  allowed: Array<{ role: PasteShelfRole; route: string; method: string }>;
  denied: Array<{ role: PasteShelfRole; url: string; method: string; reason: string }>;
  failures: string[];
  pinsServed: Array<{ role: PasteShelfRole; path: string; bytes: number; sha256: string }>;
  documents: Array<{ role: PasteShelfRole; url: string }>;
  pluginDataCalls: Array<{ role: PasteShelfRole; method: string }>;
  historyMirrorCalls: Array<{ role: "primary"; method: "POST"; response: "controlled-empty-fixture" }>;
  faviconRequests: number;
  historyRelay: PasteShelfHistoryRelayReport;
  diagnostics: Array<Record<string, unknown>>;
};
export type PasteShelfRole = "primary" | "shelf";

type Options = {
  pluginRoot: string;
  injectedHtml: string;
  endpoints: PasteShelfEndpoints;
  report: PasteShelfNetworkReport;
  role: PasteShelfRole;
  primaryPage?: CdpClient;
};

type TrackedRequest = { role: PasteShelfRole; route: string; method: string; resourceType?: string };

export function pastePrimaryUrl() { return `${origin}/`; }
export function pasteShelfUrl() { return `${origin}/?shelf=1`; }

export function emptyPasteShelfNetworkReport(): PasteShelfNetworkReport {
  return {
    origin,
    allowed: [], denied: [], failures: [], pinsServed: [], documents: [], pluginDataCalls: [],
    historyMirrorCalls: [], faviconRequests: 0,
    historyRelay: {
      mode: "fixture-only relay: exact Shelf history-query is forwarded to primary preload API; result returns on original Shelf event",
      parentIpcTested: false,
      nonceValidation: "shape-only; no native identity authorization",
      primaryDataSource: "original-primary-preload-searchHistoryPage",
      primaryDataMechanism: "PluginData db.allDocs through original HistorySearchService",
      serialization: "original-native-JSON-semantics; CDP-string-boundary",
      hopCount: 0, requests: [], rejectedNativeCalls: [],
    },
    diagnostics: [],
  };
}

/**
 * Serves one pinned original Paste document. The shelf role relays only its exact
 * history-query to a peer primary document; database filtering remains in the
 * original primary preload and its real PluginData/allDocs route.
 */
export function attachPasteShelfPage(page: CdpClient, options: Options) {
  if (options.role === "shelf" && options.primaryPage === undefined) {
    throw new TypeError("Paste Shelf fixture requires its same-owner primary page");
  }
  if (options.role === "primary" && options.primaryPage !== undefined) {
    throw new TypeError("Primary Paste fixture cannot relay to another primary page");
  }

  const routes = createLoopbackRoutes(options.endpoints);
  const requests = new Map<string, TrackedRequest>();
  const pendingNetwork = new Set<Promise<void>>();
  let diagnosticSequence = 0;
  let enabled = false;
  let disposed = false;
  const run = (method: string, params: Record<string, unknown> = {}, timeoutMs = 12_000) =>
    page.send(method, params, { timeoutMs });
  const relay = options.role === "shelf"
    ? createPasteShelfHistoryRelay(page, options.primaryPage!, options.report.historyRelay, message => {
      options.report.failures.push(message);
    })
    : undefined;

  const recordDiagnostic = (entry: Record<string, unknown>) => {
    options.report.diagnostics.push({
      sequence: ++diagnosticSequence,
      role: options.role,
      ...(sanitizeDiagnostic(entry) as Record<string, unknown>),
    });
  };
  const scopeForUrl = (rawUrl: string): { kind: "asset" | "bridge"; route: string } | undefined => {
    try {
      const url = new URL(rawUrl);
      if (url.origin === origin) return { kind: "asset", route: `asset:${url.pathname}` };
      const route = routes.get(url.href);
      return route === undefined ? undefined : { kind: "bridge", route: `bridge:${route}` };
    } catch { return undefined; }
  };
  const safeUrl = (rawUrl: string) =>
    sanitizeDiagnostic(scopeForUrl(rawUrl)?.route ?? "<blocked-out-of-scope>") as string;

  page.on("Fetch.requestPaused", (event: any) => {
    const task = handlePaused(event).catch(async error => {
      const message = `Fetch ${event.request?.method ?? "?"} ${safeUrl(String(event.request?.url ?? ""))}: ${String(error)}`;
      options.report.failures.push(sanitizeDiagnostic(message) as string);
      await run("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }).finally(() => pendingNetwork.delete(task));
    pendingNetwork.add(task);
  });
  page.on("Network.requestWillBeSent", (event: any) => {
    const requestId = String(event.requestId ?? "");
    const request = event.request ?? {};
    const scope = typeof request.url === "string" ? scopeForUrl(request.url) : undefined;
    requests.delete(requestId);
    if (!requestId || !scope) return;
    const method = String(request.method ?? "GET").toUpperCase();
    requests.set(requestId, { role: options.role, route: scope.route, method, resourceType: event.type });
    recordDiagnostic({ event: "Network.requestWillBeSent", requestId, route: scope.route, method, resourceType: event.type });
  });
  page.on("Network.responseReceived", (event: any) => {
    const tracked = requests.get(String(event.requestId ?? ""));
    if (!tracked || tracked.route.startsWith("asset:") || tracked.method !== "OPTIONS") return;
    const response = event.response ?? {};
    const corsHeaders = Object.fromEntries(Object.entries(response.headers ?? {})
      .filter(([name]) => corsResponseHeaders.has(name.toLowerCase()))
      .map(([name, value]) => [name.toLowerCase(), sanitizeDiagnostic(value)]));
    recordDiagnostic({ event: "Network.responseReceived", requestId: event.requestId, route: tracked.route,
      method: tracked.method, status: response.status, statusText: sanitizeDiagnostic(response.statusText ?? ""), corsHeaders });
  });
  page.on("Network.loadingFailed", (event: any) => {
    const tracked = requests.get(String(event.requestId ?? ""));
    if (!tracked) return;
    recordDiagnostic({ event: "Network.loadingFailed", requestId: event.requestId, route: tracked.route,
      method: tracked.method, errorText: sanitizeDiagnostic(event.errorText ?? ""),
      blockedReason: sanitizeDiagnostic(event.blockedReason ?? null), corsErrorStatus: sanitizeDiagnostic(event.corsErrorStatus ?? null),
      canceled: event.canceled === true });
  });
  page.on("Runtime.exceptionThrown", (event: any) => {
    const detail = event.exceptionDetails ?? {};
    recordDiagnostic({ event: "Runtime.exceptionThrown", text: sanitizeDiagnostic(detail.text ?? ""),
      description: sanitizeDiagnostic(detail.exception?.description ?? "") });
  });
  page.on("Log.entryAdded", (event: any) => {
    const entry = event.entry ?? {};
    if (!( ["network", "security"] as unknown[]).includes(entry.source) || entry.level !== "error") return;
    const tracked = requests.get(String(entry.networkRequestId ?? ""));
    const scope = typeof entry.url === "string" ? scopeForUrl(entry.url) : undefined;
    if (!tracked && !scope) return;
    recordDiagnostic({ event: "Log.entryAdded", requestId: entry.networkRequestId ?? null,
      route: scope?.route ?? tracked?.route, source: entry.source, level: entry.level,
      text: sanitizeDiagnostic(entry.text ?? "") });
  });
  async function enableInterception() {
    if (enabled) return;
    await run("Page.enable");
    await run("Runtime.enable");
    await run("Network.enable");
    await relay?.enable();
    // All Fetch listeners and the optional bridge observer are ready before a request can pause.
    await run("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    enabled = true;
  }

  async function navigate() {
    await enableInterception();
    await run("Emulation.setDeviceMetricsOverride", { width: 1050, height: 780, deviceScaleFactor: 1, mobile: false });
    await run("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    await run("Page.bringToFront");
    const url = options.role === "primary" ? pastePrimaryUrl() : pasteShelfUrl();
    options.report.documents.push({ role: options.role, url });
    await run("Page.navigate", { url });
    const ready = options.role === "primary"
      ? "document.readyState==='complete' && typeof window.pasteboardPro?.searchHistoryPage==='function'"
      : "document.readyState==='complete' && document.querySelector('[data-pb-search]') && document.querySelector('[aria-label=\"剪贴板时间线\"]')";
    await waitFor(ready, `${options.role} original Paste document`, 20_000);
  }

  async function evaluate(expression: string, awaitPromise = false) {
    const response = await run("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: false });
    assert.ok(!response.exceptionDetails,
      response.exceptionDetails?.exception?.description || response.exceptionDetails?.text || `Paste ${options.role} evaluation failed`);
    return response.result?.value;
  }

  async function waitFor(expression: string, label: string, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      const failure = await evaluate(`(()=>{const e=document.querySelector('[data-startup-error],.startup-error');const t=e?.innerText||document.body?.innerText||'';return t.match(/Paste preload bridge is unavailable|加载失败，请关闭后重新打开 Paste[^\\n]*/)?.[0]||''})()`).catch(() => "");
      if (failure) throw new Error(`Original Paste ${options.role} startup error: ${sanitizeDiagnostic(failure)}`);
      try {
        // The callers use readiness predicates. Convert in-page so DOM nodes never cross CDP by value.
        last = await evaluate(`Boolean((${expression}))`);
        if (last === true) return true;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for ${label}; last value ${JSON.stringify(last)}`);
  }

  async function click(selector: string) {
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'center',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return !e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))?{x,y}:null})()`);
    assert.ok(point, `Original Paste ${options.role} control is not hit-testable: ${selector}`);
    await run("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
    await run("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  }

  async function key(keyValue: string, modifiers: string[] = []) {
    const map: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    const mask = modifiers.reduce((value, modifier) => value | (map[modifier] ?? 0), 0);
    const code = keyValue.length === 1 ? `Key${keyValue.toUpperCase()}` : keyValue;
    const virtualKey = virtualKeyCode(keyValue);
    const selectAll = keyValue.toLowerCase() === "a" && modifiers.length === 1 && modifiers[0] === "Meta"
      ? { commands: ["selectAll"] } : {};
    await run("Input.dispatchKeyEvent", { type: "keyDown", key: keyValue, code,
      ...(virtualKey === undefined ? {} : { windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey }), modifiers: mask,
      ...selectAll });
    await run("Input.dispatchKeyEvent", { type: "keyUp", key: keyValue, code,
      ...(virtualKey === undefined ? {} : { windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey }), modifiers: mask });
  }

  async function type(selector: string, text: string) {
    await click(selector);
    await waitFor(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, `focus ${selector}`);
    const input = `document.querySelector(${JSON.stringify(selector)})`;
    if (await evaluate(`typeof ${input}?.value==='string'&&${input}.value.length>0`)) {
      await key("a", ["Meta"]);
      await waitFor(`${input}.selectionStart===0&&${input}.selectionEnd===${input}.value.length`, `select all ${selector}`);
      await key("Backspace");
      await waitFor(`${input}.value===''`, `clear ${selector}`);
    }
    if (text) await run("Input.insertText", { text });
    await waitFor(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`, `typed ${selector}`);
  }

  async function screenshot(path: string) {
    const image = await run("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const bytes = Buffer.from(image.data, "base64");
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }

  async function settleRequests(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while ((pendingNetwork.size || (relay?.pendingCount ?? 0) > 0) && Date.now() < deadline) {
      if (pendingNetwork.size) {
        const remaining = deadline - Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const complete = await Promise.race([
          Promise.allSettled([...pendingNetwork]).then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), Math.max(0, remaining)); }),
        ]);
        if (timer) clearTimeout(timer);
        if (!complete && pendingNetwork.size > 0) {
          throw new Error(`Paste ${options.role} network cleanup timed out with ${pendingNetwork.size} request(s) still active`);
        }
      }
      if ((relay?.pendingCount ?? 0) > 0) await relay!.settle(Math.max(1, deadline - Date.now()));
    }
    if (pendingNetwork.size || (relay?.pendingCount ?? 0) > 0) {
      throw new Error(`Paste ${options.role} cleanup could not confirm all pending network/history work exited`);
    }
  }

  async function dispose() {
    if (disposed) return;
    await settleRequests();
    disposed = true;
    const failures: unknown[] = [];
    try { await relay?.dispose(); } catch (error) { failures.push(error); }
    try { await run("Fetch.disable"); }
    catch (error) { if (!isDestroyedCdpTarget(page, error)) failures.push(error); }
    if (failures.length) throw new AggregateError(failures, `Paste ${options.role} fixture dispose failed`);
  }

  async function handlePaused(event: any) {
    const request = event.request as { url: string; method: string; postData?: string };
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (url.origin === origin) {
      if (method === "GET" && url.pathname === "/favicon.ico") {
        options.report.faviconRequests++;
        return fulfill(event, 204, "text/plain; charset=utf-8", Buffer.alloc(0));
      }
      if (method !== "GET" || url.pathname !== "/" && url.pathname !== "/assets/index-4mPfCjok.js"
        && url.pathname !== "/assets/index-Cu7SjoI2.css" && url.pathname !== "/logo.png") {
        return deny(event, `${method} ${safeUrl(request.url)}`, "resource is outside pinned Paste document closure");
      }
      if (url.pathname === "/") {
        const expectedSearch = options.role === "primary" ? "" : "?shelf=1";
        if (url.search !== expectedSearch || url.hash) return deny(event, `${method} ${safeUrl(request.url)}`, "unexpected Paste document URL");
        return fulfill(event, 200, "text/html; charset=utf-8", Buffer.from(options.injectedHtml), false,
          "sandbox allow-scripts allow-same-origin allow-forms");
      }
      const relative = url.pathname.slice(1);
      const pin = pasteBrowserPin(relative);
      const bytes = await readFile(join(options.pluginRoot, relative));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(bytes.length, pin.bytes, `Original Paste asset size changed: ${relative}`);
      assert.equal(sha256, pin.sha256, `Original Paste asset hash changed: ${relative}`);
      options.report.pinsServed.push({ role: options.role, path: relative, bytes: bytes.length, sha256 });
      return fulfill(event, 200, pin.contentType, bytes);
    }

    const route = routes.get(url.href);
    if (!route || !["POST", "OPTIONS"].includes(method)) {
      return deny(event, `${method} ${safeUrl(request.url)}`, "unregistered bridge endpoint or method");
    }
    if (method === "OPTIONS") return fulfill(event, 200, "application/json; charset=utf-8", Buffer.from('{"ok":true,"result":null}'), true);
    if (method === "POST" && route === "history") {
      if (options.role !== "primary") {
        return deny(event, `${method} ${safeUrl(request.url)}`, "Shelf clipboard-history access is outside the Shelf search relay");
      }
      options.report.historyMirrorCalls.push({ role: "primary", method: "POST", response: "controlled-empty-fixture" });
      options.report.allowed.push({ role: "primary", route: "history", method: "POST" });
      return run("Fetch.continueRequest", { requestId: event.requestId });
    }
    if (method === "POST" && route === "data") await observePluginDataCall(event);
    options.report.allowed.push({ role: options.role, route, method });
    return run("Fetch.continueRequest", { requestId: event.requestId });
  }

  async function observePluginDataCall(event: any) {
    const request = event.request as { postData?: string };
    const body = request.postData ?? (await run("Fetch.getRequestPostData", { requestId: event.requestId })).postData;
    const method = JSON.parse(String(body ?? "")).method;
    if (typeof method !== "string" || method.length > 128) throw new TypeError("PluginData request method is invalid");
    options.report.pluginDataCalls.push({ role: options.role, method });
  }

  async function deny(event: any, url: string, reason: string) {
    options.report.denied.push({ role: options.role, url: sanitizeDiagnostic(url) as string,
      method: String(event.request?.method ?? "?"), reason });
    options.report.failures.push(sanitizeDiagnostic(`Blocked Paste ${options.role} request: ${reason} ${url}`) as string);
    return run("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
  }

  async function fulfill(event: any, status: number, contentType: string, bytes: Buffer, cors = false, csp?: string) {
    const responseHeaders = [
      { name: "Content-Type", value: contentType }, { name: "Cache-Control", value: "no-store" },
      ...(csp ? [{ name: "Content-Security-Policy", value: csp }] : []),
      ...(cors ? [
        { name: "Access-Control-Allow-Origin", value: origin },
        { name: "Access-Control-Allow-Methods", value: "POST, OPTIONS" },
        { name: "Access-Control-Allow-Headers", value: "content-type" },
        { name: "Access-Control-Allow-Private-Network", value: "true" },
      ] : []),
    ];
    return run("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: status, responseHeaders,
      body: bytes.toString("base64") });
  }

  return {
    role: options.role,
    report: options.report,
    enableInterception,
    navigate,
    evaluate,
    waitFor,
    click,
    type,
    key,
    screenshot,
    settleRequests,
    dispose,
  };
}

function sanitizeDiagnostic(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/(\/(?:node|data|host|secrets)\/)[a-f0-9]{64}(?=\/|[?#\s]|$)/giu, "$1<redacted>")
      .replace(/\b[a-f0-9]{64}\b/giu, "<redacted>");
  }
  if (Array.isArray(value)) return value.map(sanitizeDiagnostic);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeDiagnostic(item)]));
  }
  return value;
}

function virtualKeyCode(key: string): number | undefined {
  const keys: Record<string, number> = {
    Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Escape: 27,
    Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46,
  };
  if (keys[key] !== undefined) return keys[key];
  if (/^[a-z]$/iu.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^\d$/u.test(key)) return key.charCodeAt(0);
  return undefined;
}

function createLoopbackRoutes(endpoints: PasteShelfEndpoints) {
  const expectedPrefix: Record<keyof PasteShelfEndpoints, string> = {
    node: "/node/", data: "/data/", history: "/host/", write: "/host/",
    contentWrite: "/host/", secret: "/secrets/",
  };
  const routes = new Map<string, string>();
  const ports = new Set<string>();
  for (const [name, endpoint] of Object.entries(endpoints) as Array<[keyof PasteShelfEndpoints, string]>) {
    const url = new URL(endpoint);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password
      || url.search || url.hash || !new RegExp(`^${expectedPrefix[name]}[a-f0-9]{64}$`, "u").test(url.pathname)) {
      throw new TypeError(`Paste ${name} endpoint is outside the exact fixture loopback contract`);
    }
    ports.add(url.port);
    if (routes.has(url.href)) throw new TypeError("Paste fixture endpoints must have distinct bearer paths");
    routes.set(url.href, name);
  }
  if (ports.size !== 1) throw new TypeError("Paste fixture endpoints must share one owned loopback server");
  return routes;
}

function isDestroyedCdpTarget(page: CdpClient, error: unknown) {
  const client = page as unknown as { ws?: { socket?: { destroyed?: boolean } } };
  return client.ws?.socket?.destroyed === true || String(error).includes("Target closed");
}
