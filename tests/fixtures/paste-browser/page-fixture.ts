import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CdpClient } from "../../../scripts/chrome-cdp-smoke-utils.mjs";
import { pasteBrowserPin } from "./original-assets";

const origin = "https://pasteboard-pro.fixture.invalid";
const editorUrl = `${origin}/?panel=editor&mode=create`;
const titleText = "ATools editor fixture";
const bodyText = "Invoice #1042\n固定文本验收 — keep exact bytes.";
const corsResponseHeaders = new Set([
  "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
  "access-control-allow-credentials", "access-control-allow-private-network", "access-control-expose-headers",
]);

type EndpointMap = Record<"node" | "data" | "history" | "write" | "contentWrite" | "secret", string>;
type FixtureScope = { kind: "editor" | "bridge"; route: string };
type TrackedRequest = { method: string; scope: FixtureScope; resourceType?: string };
type PutDocument = {
  _id?: string;
  type?: string;
  record?: { origin?: { host?: string }; item?: { id?: string; kind?: string; title?: string; contentFingerprint?: string; payload?: { text?: string } } };
};
export type EditorWriteAttempt = { id: string; itemId?: string; outcome: "pending" | "injected_failure" | "continued"; title: string; text: string };
export type PasteEditorNetworkReport = {
  allowed: Array<{ route: string; method: string }>;
  denied: Array<{ url: string; method: string }>;
  failures: string[];
  pinsServed: Array<{ path: string; bytes: number; sha256: string }>;
  editorDocuments: number;
  recordWrites: EditorWriteAttempt[];
  dialogs: Array<{ type: string; message: string }>;
  diagnostics?: Array<Record<string, unknown>>;
};

export function pasteEditorUrl() { return editorUrl; }
export function pasteEditorFixedInput() { return { title: titleText, text: bodyText }; }

export function attachPasteEditorPage(page: CdpClient, options: {
  pluginRoot: string;
  injectedHtml: string;
  endpoints: EndpointMap;
  report: PasteEditorNetworkReport;
  failOneNewRecordPut: { pending: boolean };
  beforeSuccessfulRecordContinue?: (document: PutDocument) => Promise<void>;
}) {
  const routes = new Map(Object.entries(options.endpoints).map(([name, endpoint]) => [new URL(endpoint).href, name]));
  const diagnostics = options.report.diagnostics ??= [];
  const requests = new Map<string, TrackedRequest>();
  let diagnosticSequence = 0;
  const pending = new Set<Promise<void>>();
  const pendingFailedRequests: string[] = [];
  const run = (method: string, params: Record<string, unknown> = {}) => page.send(method, params, { timeoutMs: 12_000 });
  const scopeForUrl = (rawUrl: string): FixtureScope | undefined => {
    try {
      const url = new URL(rawUrl);
      if (url.origin === origin) return { kind: "editor", route: sanitizeDiagnostic(`editor:${url.pathname}`) as string };
      const route = routes.get(url.href);
      return route ? { kind: "bridge", route: `bridge:${route}` } : undefined;
    } catch { return undefined; }
  };
  const safeUrl = (rawUrl: string) => sanitizeDiagnostic(scopeForUrl(rawUrl)?.route ?? "<blocked-out-of-scope>") as string;
  const recordDiagnostic = (entry: Record<string, unknown>) => {
    diagnostics.push({ sequence: ++diagnosticSequence, ...(sanitizeDiagnostic(entry) as Record<string, unknown>) });
  };
  page.on("Fetch.requestPaused", event => {
    const task = handlePaused(event).catch(async error => {
      options.report.failures.push(sanitizeDiagnostic(`Fetch ${event.request?.method} ${safeUrl(String(event.request?.url ?? ""))}: ${String(error)}`) as string);
      await run("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }).finally(() => pending.delete(task));
    pending.add(task);
  });
  page.on("Network.requestWillBeSent", event => {
    const requestId = String(event.requestId ?? "");
    const request = event.request ?? {};
    const scope = typeof request.url === "string" ? scopeForUrl(request.url) : undefined;
    requests.delete(requestId);
    if (!requestId || !scope) return;
    const tracked = { method: String(request.method ?? "GET").toUpperCase(), scope, resourceType: event.type };
    requests.set(requestId, tracked);
    recordDiagnostic({ event: "Network.requestWillBeSent", requestId, ...tracked });
  });
  page.on("Network.responseReceived", event => {
    const tracked = requests.get(String(event.requestId ?? ""));
    if (!tracked || tracked.scope.kind !== "bridge" || tracked.method !== "OPTIONS") return;
    const response = event.response ?? {};
    const corsHeaders = Object.fromEntries(Object.entries(response.headers ?? {})
      .filter(([name]) => isCorsResponseHeader(name))
      .map(([name, value]) => [name.toLowerCase(), sanitizeDiagnostic(value)]));
    recordDiagnostic({ event: "Network.responseReceived", requestId: event.requestId, ...tracked,
      status: response.status, statusText: sanitizeDiagnostic(response.statusText ?? ""), corsHeaders });
  });
  page.on("Network.loadingFailed", event => {
    const tracked = requests.get(String(event.requestId ?? ""));
    if (!tracked) return;
    recordDiagnostic({ event: "Network.loadingFailed", requestId: event.requestId, ...tracked,
      errorText: sanitizeDiagnostic(event.errorText ?? ""), blockedReason: sanitizeDiagnostic(event.blockedReason ?? null),
      corsErrorStatus: sanitizeDiagnostic(event.corsErrorStatus ?? null), canceled: event.canceled === true });
  });
  page.on("Log.entryAdded", event => {
    const entry = event.entry ?? {};
    if (!(["network", "security"] as unknown[]).includes(entry.source) || entry.level !== "error") return;
    const tracked = requests.get(String(entry.networkRequestId ?? ""));
    const scope = typeof entry.url === "string" ? scopeForUrl(entry.url) : tracked?.scope;
    if (!scope) return;
    recordDiagnostic({ event: "Log.entryAdded", requestId: entry.networkRequestId ?? null, scope,
      source: entry.source, level: entry.level, text: sanitizeDiagnostic(entry.text ?? ""),
      url: typeof entry.url === "string" ? safeUrl(entry.url) : tracked?.scope.route ?? null });
  });
  page.on("Page.javascriptDialogOpening", event => {
    options.report.dialogs.push({ type: event.type, message: sanitizeDiagnostic(event.message) as string });
    void run("Page.handleJavaScriptDialog", { accept: false }).catch(error => options.report.failures.push(sanitizeDiagnostic(`dialog dismissal failed: ${String(error)}`) as string));
  });

  async function handlePaused(event: any) {
    const request = event.request as { url: string; method: string; postData?: string };
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    if (url.origin === origin) {
      if (method !== "GET" || url.pathname !== "/" && url.pathname !== "/assets/index-4mPfCjok.js"
        && url.pathname !== "/assets/index-Cu7SjoI2.css" && url.pathname !== "/logo.png") {
        return deny(event, `${method} ${safeUrl(request.url)}`);
      }
      if (url.pathname === "/") {
        if (url.search !== "?panel=editor&mode=create") return deny(event, `unexpected editor URL ${safeUrl(request.url)}`);
        options.report.editorDocuments++;
        return fulfill(
          event, 200, "text/html; charset=utf-8", Buffer.from(options.injectedHtml), false,
          "sandbox allow-scripts allow-same-origin allow-forms",
        );
      }
      const relative = url.pathname.slice(1);
      const pin = pasteBrowserPin(relative);
      const bytes = await readFile(join(options.pluginRoot, relative));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(bytes.length, pin.bytes, `Served original asset byte length changed: ${relative}`);
      assert.equal(sha256, pin.sha256, `Served original asset hash changed: ${relative}`);
      options.report.pinsServed.push({ path: relative, bytes: bytes.length, sha256 });
      return fulfill(event, 200, pin.contentType, bytes);
    }
    const route = routes.get(url.href);
    if (!route || !["POST", "OPTIONS"].includes(method)) return deny(event, `${method} ${safeUrl(request.url)}`);
    if (route === "data" && method === "POST") {
      const payloadText = request.postData ?? (await run("Fetch.getRequestPostData", { requestId: event.requestId })).postData;
      const payload = JSON.parse(String(payloadText ?? "")) as { method?: string; args?: unknown[] };
      if (payload.method === "db.put") {
        const document = payload.args?.[0] as PutDocument | undefined;
        if (isRequestedRecord(document)) {
          const attempt: EditorWriteAttempt = {
            id: String(document?._id), itemId: document?.record?.item?.id,
            outcome: "pending", title: String(document?.record?.item?.title), text: String(document?.record?.item?.payload?.text),
          };
          options.report.recordWrites.push(attempt);
          if (options.failOneNewRecordPut.pending) {
            options.failOneNewRecordPut.pending = false;
            attempt.outcome = "injected_failure";
            pendingFailedRequests.push(attempt.id);
            return fulfill(event, 200, "application/json; charset=utf-8", Buffer.from(JSON.stringify({
              ok: false, error: { message: "fixture explicit db.put failure" },
            })), true);
          }
          attempt.outcome = "continued";
          await options.beforeSuccessfulRecordContinue?.(document!);
        }
      }
    }
    options.report.allowed.push({ route, method });
    return run("Fetch.continueRequest", { requestId: event.requestId });
  }

  async function deny(event: any, url: string) {
    const safe = sanitizeDiagnostic(url) as string;
    options.report.denied.push({ url: safe, method: String(event.request?.method ?? "?") });
    options.report.failures.push(sanitizeDiagnostic(`Blocked unknown browser request: ${event.request?.method ?? "?"} ${safe}`) as string);
    return run("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
  }

  async function fulfill(event: any, status: number, contentType: string, bytes: Buffer, cors = false, contentSecurityPolicy?: string) {
    const headers = [
      { name: "Content-Type", value: contentType },
      { name: "Cache-Control", value: "no-store" },
      ...(contentSecurityPolicy ? [{ name: "Content-Security-Policy", value: contentSecurityPolicy }] : []),
      ...(cors ? [
        { name: "Access-Control-Allow-Origin", value: origin },
        { name: "Access-Control-Allow-Methods", value: "POST, OPTIONS" },
        { name: "Access-Control-Allow-Headers", value: "content-type" },
        { name: "Access-Control-Allow-Private-Network", value: "true" },
      ] : []),
    ];
    return run("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: status, responseHeaders: headers, body: bytes.toString("base64") });
  }

  async function settleRequests() {
    const deadline = Date.now() + 5000;
    while (pending.size && Date.now() < deadline) await Promise.allSettled([...pending]);
    assert.equal(pending.size, 0, "All intercepted browser requests must be settled before cleanup");
  }

  return {
    report: options.report,
    pendingFailedRequests,
    async enableInterception() {
      // The Fetch listener above is registered before this call can pause requests.
      await run("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    },
    async navigate() {
      await run("Log.enable", {});
      await run("Emulation.setDeviceMetricsOverride", { width: 1050, height: 780, deviceScaleFactor: 1, mobile: false });
      await run("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await run("Page.bringToFront");
      await run("Page.navigate", { url: editorUrl });
      await this.wait("document.readyState==='complete'&&document.querySelector('section.editor')", "original editor mount");
    },
    async evaluate(expression: string, awaitPromise = false) {
      const result = await run("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: false });
      assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || "Original editor evaluation failed");
      return result.result?.value;
    },
    async wait(expression: string, label: string, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs;
      let last: unknown;
      while (Date.now() < deadline) {
        const startupError = await this.evaluate(`(()=>{const explicit=window.startupError||window.__startupError||window.__pasteStartupError;const explicitText=explicit&&typeof explicit==='object'&&'message' in explicit?explicit.message:explicit;const node=document.querySelector('[role="alert"],[data-startup-error],.startup-error');const nodeText=node?.innerText?.trim()||node?.getAttribute('data-startup-error')||'';const bodyText=document.body?.innerText||'';const known=bodyText.match(/Paste preload bridge is unavailable[^\\n]*/i);return String(explicitText||nodeText||known?.[0]||'').trim()||null})()`).catch(() => null);
        if (typeof startupError === "string" && startupError) throw new Error(`Original Paste startup error: ${sanitizeDiagnostic(startupError)}`);
        try { last = await this.evaluate(expression); if (last) return last; } catch {}
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`Timed out waiting for ${label}; last value ${JSON.stringify(last)}`);
    },
    async click(selector: string) {
      const point = await this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;const hit=document.elementFromPoint(x,y);return !e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))?{x,y,tag:e.tagName,disabled:e.disabled}:null})()`);
      assert.ok(point, `Original editor control is not hit-testable: ${selector}`);
      await run("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await run("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    },
    async type(selector: string, text: string) {
      await this.click(selector);
      await this.wait(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, `focus ${selector}`);
      await run("Input.insertText", { text });
      await this.wait(`document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(text)}`, `typed ${selector}`);
    },
    async screenshot(path: string) {
      const image = await run("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const bytes = Buffer.from(image.data, "base64");
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
    settleRequests,
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

function isCorsResponseHeader(name: string) {
  return new Set([
    "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
    "access-control-allow-credentials", "access-control-allow-private-network", "access-control-expose-headers",
  ]).has(name.toLowerCase());
}

function isRequestedRecord(document: PutDocument | undefined): document is PutDocument {
  const item = document?.record?.item;
  return document?.type === "pasteboard-pro-record" && document.record?.origin?.host === "sync"
    && item?.kind === "text" && item.title === titleText && item.payload?.text === bodyText
    && typeof item.id === "string" && item.id.startsWith("ztools-created:")
    && typeof item.contentFingerprint === "string" && document._id === `pasteboard-pro:record:${item.contentFingerprint}`;
}
