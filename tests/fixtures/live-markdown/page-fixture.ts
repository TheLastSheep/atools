import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CdpClient } from "../../../scripts/chrome-cdp-smoke-utils.mjs";
import { liveMarkdownPinnedFile } from "./original-package";
import type { LiveMarkdownNodeEndpoints } from "./document-fixture";

const corsHeaders = new Set([
  "access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers",
  "access-control-allow-credentials", "access-control-allow-private-network", "access-control-expose-headers",
]);
type TrackedRequest = { route: string; method: string; resourceType?: string };
export type LiveMarkdownNetworkReport = {
  allowed: Array<{ route: string; method: string }>;
  denied: Array<{ route: string; method: string }>;
  failures: string[];
  pinsServed: Array<{ path: string; bytes: number; sha256: string }>;
  editorDocuments: number;
  diagnostics: Array<Record<string, unknown>>;
  javascriptErrors: Array<Record<string, unknown>>;
  dialogs: Array<{ type: string; message: string }>;
  browserBuiltins: Array<{ path: string; status: number; reason: string }>;
  navigationFailure?: Record<string, unknown>;
};

export type OriginalBrowserAssetPin = { sha256: string; contentType: string };

const assetTypes: Record<string, string> = {
  "assets/index-CTaIDxc4.js": "text/javascript; charset=utf-8",
  "assets/index-C2N-317C.css": "text/css; charset=utf-8",
  "logo.svg": "image/svg+xml",
};

export function createLiveMarkdownNetworkReport(): LiveMarkdownNetworkReport {
  return { allowed: [], denied: [], failures: [], pinsServed: [], editorDocuments: 0,
    diagnostics: [], javascriptErrors: [], dialogs: [], browserBuiltins: [] };
}

export function attachLiveMarkdownPage(page: CdpClient, options: {
  origin: string;
  pluginRoot: string;
  injectedHtml: string;
  endpoints: LiveMarkdownNodeEndpoints;
  report: LiveMarkdownNetworkReport;
  assetPins?: Readonly<Record<string, OriginalBrowserAssetPin>>;
  navigationDiagnosticScreenshotPath?: string;
  cpuProfilePath?: string;
}) {
  const origin = new URL(options.origin).origin;
  const routes = new Map(Object.entries(options.endpoints).filter(([, endpoint]) => typeof endpoint === "string")
    .map(([name, endpoint]) => [new URL(endpoint as string).href, name] as const));
  const pending = new Set<Promise<void>>();
  const requestById = new Map<string, TrackedRequest>();
  let sequence = 0;
  let sourceClickProfileAttempted = false;
  const run = (method: string, params: Record<string, unknown> = {}) => page.send(method, params, { timeoutMs: 12_000 });
  const routeFor = (raw: string) => {
    try {
      const url = new URL(raw);
      if (url.origin === origin) return `editor:${url.pathname}`;
      const endpoint = routes.get(url.href);
      return endpoint ? `bridge:${endpoint}` : undefined;
    } catch { return undefined; }
  };
  const record = (entry: Record<string, unknown>) => {
    options.report.diagnostics.push({ sequence: ++sequence, ...redact(entry) as Record<string, unknown> });
  };

  page.on("Fetch.requestPaused", (event: any) => {
    const task = handlePaused(event).catch(async error => {
      options.report.failures.push(String(redact(`${event.request?.method ?? "?"} ${routeFor(String(event.request?.url ?? "")) ?? "<blocked-out-of-scope>"}: ${String(error)}`)));
      await run("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {});
    }).finally(() => pending.delete(task));
    pending.add(task);
  });
  page.on("Network.requestWillBeSent", (event: any) => {
    const url = String(event.request?.url ?? "");
    const route = routeFor(url);
    if (!route) return;
    const tracked = { route, method: String(event.request?.method ?? "GET").toUpperCase(), resourceType: event.type };
    requestById.set(String(event.requestId), tracked);
    record({ event: "Network.requestWillBeSent", requestId: event.requestId, ...tracked });
  });
  page.on("Network.responseReceived", (event: any) => {
    const tracked = requestById.get(String(event.requestId));
    if (!tracked || !tracked.route.startsWith("bridge:") || tracked.method !== "OPTIONS") return;
    const response = event.response ?? {};
    const allowed = Object.fromEntries(Object.entries(response.headers ?? {})
      .filter(([name]) => corsHeaders.has(name.toLowerCase())).map(([name, value]) => [name.toLowerCase(), value]));
    record({ event: "Network.responseReceived", requestId: event.requestId, ...tracked,
      status: response.status, headers: allowed });
  });
  page.on("Network.loadingFailed", (event: any) => {
    const tracked = requestById.get(String(event.requestId));
    if (!tracked) return;
    record({ event: "Network.loadingFailed", requestId: event.requestId, ...tracked,
      errorText: event.errorText, blockedReason: event.blockedReason, corsErrorStatus: event.corsErrorStatus ?? null,
      canceled: event.canceled === true });
  });
  page.on("Log.entryAdded", (event: any) => {
    const entry = event.entry ?? {};
    const tracked = requestById.get(String(entry.networkRequestId ?? ""));
    const route = typeof entry.url === "string" ? routeFor(entry.url) : tracked?.route;
    if (!route || !["security", "network"].includes(String(entry.source)) || entry.level !== "error") return;
    record({ event: "Log.entryAdded", route, source: entry.source, text: entry.text });
  });
  page.on("Runtime.exceptionThrown", (event: any) => {
    options.report.javascriptErrors.push(redact({ target: "editor", description: event.exceptionDetails?.exception?.description
      ?? event.exceptionDetails?.text ?? "unknown JavaScript exception" }) as Record<string, unknown>);
  });
  page.on("Runtime.consoleAPICalled", (event: any) => {
    if (event.type !== "error") return;
    const text = (event.args ?? []).map((arg: any) => arg.value ?? arg.description ?? "").join(" ");
    options.report.javascriptErrors.push(redact({ target: "editor", source: "console.error", text }) as Record<string, unknown>);
  });
  page.on("Page.javascriptDialogOpening", (event: any) => {
    options.report.dialogs.push({ type: String(event.type), message: String(redact(event.message)) });
    void run("Page.handleJavaScriptDialog", { accept: false }).catch(error => options.report.failures.push(String(redact(`dialog-dismiss:${String(error)}`))));
  });

  async function handlePaused(event: any) {
    const url = new URL(event.request.url);
    const method = String(event.request.method ?? "GET").toUpperCase();
    if (url.origin === origin) {
      const path = url.pathname.slice(1);
      if (method !== "GET") return deny(event, `editor:${url.pathname}`);
      if (url.pathname === "/" && url.search === "") {
        options.report.editorDocuments++;
        return fulfill(event, 200, "text/html; charset=utf-8", Buffer.from(options.injectedHtml), false,
          "sandbox allow-scripts allow-same-origin allow-forms");
      }
      if (url.pathname === "/favicon.ico" && url.search === "") {
        options.report.browserBuiltins.push({ path: "/favicon.ico", status: 204,
          reason: "Chrome automatic favicon request; the fixture page has no favicon resource" });
        return run("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 204,
          responseHeaders: [{ name: "Cache-Control", value: "no-store" }] });
      }
      const assetPin = options.assetPins
        ? (Object.hasOwn(options.assetPins, path) ? options.assetPins[path] : undefined)
        : (Object.hasOwn(assetTypes, path)
          ? { sha256: liveMarkdownPinnedFile(path), contentType: assetTypes[path] }
          : undefined);
      if (!assetPin) return deny(event, `editor:${url.pathname}`);
      const bytes = await readFile(join(options.pluginRoot, path));
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      assert.equal(sha256, assetPin.sha256, `Served original plugin asset hash changed: ${path}`);
      options.report.pinsServed.push({ path, bytes: bytes.length, sha256 });
      return fulfill(event, 200, assetPin.contentType, bytes);
    }
    const route = routes.get(url.href);
    if (!route || !["POST", "OPTIONS"].includes(method)) return deny(event, "<blocked-out-of-scope>");
    options.report.allowed.push({ route: `bridge:${route}`, method });
    return run("Fetch.continueRequest", { requestId: event.requestId });
  }

  async function deny(event: any, route: string) {
    options.report.denied.push({ route: String(redact(route)), method: String(event.request?.method ?? "?") });
    options.report.failures.push(String(redact(`Blocked unknown browser request: ${event.request?.method ?? "?"} ${route}`)));
    return run("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" });
  }

  async function fulfill(event: any, status: number, type: string, bytes: Buffer, cors = false, csp?: string) {
    const headers = [
      { name: "Content-Type", value: type }, { name: "Cache-Control", value: "no-store" },
      ...(csp ? [{ name: "Content-Security-Policy", value: csp }] : []),
      ...(cors ? [
        { name: "Access-Control-Allow-Origin", value: origin },
        { name: "Access-Control-Allow-Methods", value: "POST, OPTIONS" },
        { name: "Access-Control-Allow-Headers", value: "content-type" },
        { name: "Access-Control-Allow-Private-Network", value: "true" },
      ] : []),
    ];
    return run("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: status,
      responseHeaders: headers, body: bytes.toString("base64") });
  }

  async function settleRequests() {
    const deadline = Date.now() + 5000;
    while (pending.size && Date.now() < deadline) await Promise.allSettled([...pending]);
    assert.equal(pending.size, 0, "All intercepted Live Markdown requests must finish before fixture cleanup");
  }

  async function captureNavigationFailure(error: unknown) {
    const failure: Record<string, unknown> = { error: String(redact(error instanceof Error ? error.message : error)) };
    let responsive = false;
    try {
      const result = await run("Runtime.evaluate", {
        expression: `(()=>({readyState:document.readyState,location:location.href,bodyText:(document.body?.innerText||'').slice(0,6000),rootExists:!!document.querySelector('#root'),editorExists:!!document.querySelector('.typora-workbench'),writeExists:!!document.querySelector('#write')}))()`,
        returnByValue: true,
      });
      failure.page = redact(result.result?.value ?? result.exceptionDetails?.text ?? "DOM state unavailable");
      responsive = !result.exceptionDetails && result.result?.value != null;
    } catch (diagnosticError) {
      failure.pageDiagnosticError = String(redact(diagnosticError instanceof Error ? diagnosticError.message : diagnosticError));
    }
    if (responsive && options.navigationDiagnosticScreenshotPath) {
      try {
        const shot = await run("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const bytes = Buffer.from(shot.data, "base64");
        await writeFile(options.navigationDiagnosticScreenshotPath, bytes, { flag: "wx", mode: 0o600 });
        failure.screenshot = { path: options.navigationDiagnosticScreenshotPath, bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") };
      } catch (screenshotError) {
        failure.screenshotError = String(redact(screenshotError instanceof Error ? screenshotError.message : screenshotError));
      }
    } else failure.screenshot = { state: responsive ? "path_not_configured" : "skipped_target_not_responsive" };
    return failure;
  }

  return {
    report: options.report,
    async enableInterception() { await run("Fetch.enable", { patterns: [{ urlPattern: "*" }] }); },
    async navigate() {
      await run("Log.enable");
      await run("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await run("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
      await run("Page.bringToFront");
      await run("Page.navigate", { url: `${origin}/` });
      try {
        await this.wait("document.readyState==='complete'&&!!document.querySelector('#root')", "original Live Markdown document mount");
      } catch (error) {
        options.report.navigationFailure = await captureNavigationFailure(error);
        throw error;
      }
    },
    async evaluate(expression: string) {
      const result = await run("Runtime.evaluate", { expression, returnByValue: true, userGesture: false });
      assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text || "Original Live Markdown evaluation failed");
      return result.result?.value;
    },
    async wait(expression: string, label: string, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      let last: unknown;
      while (Date.now() < deadline) {
        const startupError = await this.evaluate(`(()=>{const e=document.querySelector('[data-startup-error],.startup-error');const text=e?.innerText||document.body?.innerText||'';return /preload bridge is unavailable|plugin runtime failed/i.test(text)?text.trim():null})()`).catch(() => null);
        if (startupError) throw new Error(`Original Live Markdown startup error: ${String(redact(startupError))}`);
        try { last = await this.evaluate(`Boolean((${expression}))`); if (last) return last; } catch {}
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error(`Timed out waiting for ${label}; last observation ${JSON.stringify(last)}`);
    },
    async click(selector: string) {
      const point = await this.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return !e.disabled&&r.width>0&&r.height>0&&(hit===e||e.contains(hit))?{x,y,disabled:e.disabled}:null})()`);
      assert.ok(point, `Original Live Markdown control is not hit-testable: ${selector}`);
      const dispatchClick = async () => {
        await run("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
        await run("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
      };
      if (selector !== "[data-testid=top-viewmode-cycle-btn]" || sourceClickProfileAttempted || !options.cpuProfilePath) {
        await dispatchClick();
        return;
      }
      sourceClickProfileAttempted = true;
      const profileReport: Record<string, unknown> = {
        state: "starting", purpose: "one-click diagnostic only; not a performance improvement claim",
        selector, path: options.cpuProfilePath,
      };
      (options.report as Record<string, unknown>).sourceClickCpuProfile = profileReport;
      let startAttempted = false;
      try {
        await page.send("Profiler.enable", {}, { timeoutMs: 3000 });
        startAttempted = true;
        await page.send("Profiler.start", {}, { timeoutMs: 3000 });
        profileReport.state = "recording";
      } catch (profileError) {
        profileReport.state = "unavailable";
        profileReport.startError = String(redact(profileError instanceof Error ? profileError.message : profileError));
      }
      try {
        await dispatchClick();
      } finally {
        if (startAttempted) {
          try {
            const stopped = await page.send("Profiler.stop", {}, { timeoutMs: 3000 });
            const profile = stopped.profile;
            if (!profile) throw new Error("CDP Profiler.stop returned no CPU profile");
            await writeFile(options.cpuProfilePath, JSON.stringify(profile), { flag: "wx", mode: 0o600 });
            profileReport.state = profileReport.startError ? "captured_after_start_error" : "captured";
            profileReport.nodes = profile.nodes?.length ?? 0;
            profileReport.samples = profile.samples?.length ?? 0;
            profileReport.durationMicroseconds = profile.endTime - profile.startTime;
          } catch (profileError) {
            profileReport.state = "stop_or_write_failed";
            profileReport.stopError = String(redact(profileError instanceof Error ? profileError.message : profileError));
          }
        }
      }
    },
    async clickText(selector: string, text: string) {
      const matches = await this.evaluate(`(()=>[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.innerText.trim()===${JSON.stringify(text)}).length)()`);
      assert.ok(matches > 0, `Original Live Markdown text control is missing: ${text}`);
      const index = 0;
      const all = await this.evaluate(`(()=>[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.innerText.trim()===${JSON.stringify(text)}).map(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:e.disabled}}))()`);
      const point = all[index];
      assert.ok(point && !point.disabled, `Original Live Markdown text control is disabled: ${text}`);
      await run("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await run("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    },
    async clickTextContaining(selector: string, text: string) {
      const all = await this.evaluate(`(()=>[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>e.innerText.includes(${JSON.stringify(text)})).map(e=>{const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,disabled:e.disabled}}))()`);
      const point = all[0];
      assert.ok(point && !point.disabled, `Original Live Markdown text control is missing or disabled: ${text}`);
      await run("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
      await run("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
    },
    async replaceContentEditable(selector: string, value: string) {
      await this.click(selector);
      await this.wait(`document.activeElement===document.querySelector(${JSON.stringify(selector)})`, `DOM focus ${selector}`);
      await run("Input.dispatchKeyEvent", { type: "keyDown", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 55 });
      await run("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0, modifiers: 4 });
      await run("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 0, modifiers: 4 });
      await run("Input.dispatchKeyEvent", { type: "keyUp", key: "Meta", code: "MetaLeft", windowsVirtualKeyCode: 91, nativeVirtualKeyCode: 55 });
      await run("Input.insertText", { text: value });
      const visibleAnchor = value.split(/\r?\n/u).map(line => line.replace(/^#{1,6}\s+/u, "").trim()).find(Boolean) ?? value;
      await this.wait(`document.querySelector(${JSON.stringify(selector)}).innerText.includes(${JSON.stringify(visibleAnchor)})`, `typed text in ${selector}`);
    },
    async screenshot(path: string) {
      const shot = await run("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const bytes = Buffer.from(shot.data, "base64");
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      return { path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    },
    settleRequests,
  };
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(\/(?:node|data|host|secrets|dialog)\/)[a-f0-9]{64}(?=\/|[?#\s]|$)/giu, "$1<redacted>")
    .replace(/\b[a-f0-9]{64}\b/giu, "<redacted>");
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  return value;
}
