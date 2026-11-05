// @vitest-environment node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as nodeFs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { JSDOM } from "jsdom";
import { expect, it } from "vitest";
import { createPluginBridgeDocument } from "../../src/lib/pluginPanelBridgeCompiler";
import { preparePluginPreload } from "../../src/lib/pluginPreload";

const configuredPluginsRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins";
const sourcePackage = resolve(configuredPluginsRoot, "snipaste");
const storageRelativePath = "preload/storage-clipboard.cjs";
const pinnedStorageSha256 = "c820c9faa33582c47c8d4c7261f3bc03ecb7518c988bad91abfa61721db6ea29";
const copiedPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/VscvDQAAAABJRU5ErkJggg==";
const copiedText = "Snipaste clipboard contract 01";
const instanceId = "harris-snipaste-copy-result-fixture";
const endpoint = "http://127.0.0.1:43123/host/" + "a".repeat(64);

type PublicCall = { method: "copyImage" | "copyText"; args: unknown[]; immediate: unknown; settled: Promise<{ status: "fulfilled"; value: unknown } | { status: "rejected"; error: string }> };

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scriptBody(script: string): string {
  return script.replace(/^<script[^>]*>\n?/, "").replace(/\n?<\/script>$/, "");
}

function createScratchRequire(pluginRoot: string, calls: string[], electronAdapter: unknown) {
  const nodeRequire = createRequire(import.meta.url);
  const allowedFs = new Set(["existsSync", "mkdirSync", "readFileSync", "writeFileSync", "renameSync", "readdirSync", "statSync", "unlinkSync"]);
  const fence = (value: unknown) => {
    if (typeof value !== "string") throw new Error("fixture fs requires string paths");
    const actual = resolve(value);
    if (actual !== pluginRoot && !actual.startsWith(`${pluginRoot}${sep}`)) {
      throw new Error(`Snipaste copy-result fixture escaped scratch: ${actual}`);
    }
    return actual;
  };
  const fs = new Proxy(nodeFs, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "promises") throw new Error("unexpected asynchronous fs in copy-result fixture");
      if (typeof value !== "function") return value;
      const method = typeof property === "string" ? property : String(property);
      return (...args: unknown[]) => {
        if (!allowedFs.has(method)) throw new Error(`blocked fs.${method} in copy-result fixture`);
        fence(args[0]);
        if (method === "renameSync") fence(args[1]);
        calls.push(`fs.${method}`);
        return Reflect.apply(value, target, args);
      };
    },
  });
  const childProcess = Object.freeze({
    execFileSync() { throw new Error("desktop capture is outside copy-result fixture scope"); },
  });
  return (specifier: string): unknown => {
    if (specifier === "node:fs" || specifier === "fs") return fs;
    if (specifier === "node:path" || specifier === "path") return nodeRequire(specifier);
    if (specifier === "node:child_process") return childProcess;
    if (specifier === "electron") return electronAdapter;
    throw new Error(`blocked module in copy-result fixture: ${specifier}`);
  };
}

function createCompiledFrame(hostTransport: "denied" | "failure" | "success" = "success") {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { runScripts: "outside-only", url: "https://snipaste-copy-fixture.invalid/" });
  const window = dom.window as JSDOM["window"] & { __atoolsHostClipboard?: any; services?: any; ztools?: any };
  const hostMessages: any[] = [];
  const clipboardRequests: Array<{ method: string; endpoint: string; async: boolean; body: unknown; status: number }> = [];
  const listeners = new Map<string, Set<(event: any) => void>>();
  Object.defineProperty(window, "postMessage", {
    configurable: true,
    value: (data: unknown) => { hostMessages.push(data); },
  });
  Object.defineProperty(window, "addEventListener", {
    configurable: true,
    value: (type: string, callback: (event: any) => void) => {
      const entries = listeners.get(type) ?? new Set();
      entries.add(callback);
      listeners.set(type, entries);
    },
  });
  Object.defineProperty(window, "removeEventListener", {
    configurable: true,
    value: (type: string, callback: (event: any) => void) => listeners.get(type)?.delete(callback),
  });
  Object.assign(window, { TextEncoder, TextDecoder, Buffer });
  Object.defineProperty(window, "XMLHttpRequest", {
    configurable: true,
    value: class FixtureXmlHttpRequest {
      status = 200;
      responseText = "";
      private method = "";
      private target = "";
      private async = true;
      open(method: string, target: string, async = true) { this.method = method; this.target = target; this.async = async; }
      setRequestHeader() {}
      send(body: string) {
        const parsed = JSON.parse(body);
        this.status = hostTransport === "success" ? 200 : hostTransport === "denied" ? 403 : 500;
        clipboardRequests.push({ method: this.method, endpoint: this.target, async: this.async, body: parsed, status: this.status });
        this.responseText = JSON.stringify(hostTransport === "success"
          ? { ok: true, result: null }
          : { ok: false, error: { message: hostTransport === "denied" ? "host clipboard permission denied" : "controlled clipboard write failure" } });
      }
    },
  });

  const html = createPluginBridgeDocument({
    action: {
      plugin_id: "harris-snipaste",
      plugin_name: "Snipaste Pro",
      feature_code: "snipaste-paste",
      main_url: "dist/index.html",
      plugin_path: "/fixture/snipaste",
      expand_height: 0,
      plugin_permissions: ["clipboard.write"],
      payload: null,
    },
    windowType: "main",
    browserWindowId: "",
    geometrySnapshot: null,
    workerScope: "harris-snipaste-copy-result",
    mainPushConfig: null,
    webContentsId: 901,
    subInputEpoch: 0,
    appName: "ATools copy-result fixture",
    appVersion: "3.0.0-fixture",
    clipboard: { instanceId, endpoints: { write: endpoint, image_write: endpoint } },
  });
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  for (const script of Array.from(parsed.querySelectorAll("script"))) window.eval(script.textContent ?? "");

  function dispatchHostMessage(data: unknown) {
    const source = window.parent;
    for (const listener of [...(listeners.get("message") ?? [])]) listener({ source, data });
  }
  function trackPublicMethods(): PublicCall[] {
    const calls: PublicCall[] = [];
    for (const method of ["copyImage", "copyText"] as const) {
      const original = window.ztools[method];
      window.ztools[method] = function(this: unknown, ...args: unknown[]) {
        const immediate = Reflect.apply(original, this, args);
        const settled = Promise.resolve(immediate).then(
          value => ({ status: "fulfilled" as const, value }),
          error => ({ status: "rejected" as const, error: String(error) }),
        );
        calls.push({ method, args, immediate, settled });
        return immediate;
      };
    }
    return calls;
  }
  return { dom, window, hostMessages, clipboardRequests, dispatchHostMessage, trackPublicMethods };
}

async function prepareOriginalService(scratchRoot: string, graphReads: Set<string>) {
  const sourceFiles = ["preload/services.cjs", storageRelativePath, "preload/os-capture.cjs"];
  const pluginRoot = join(scratchRoot, "plugin");
  for (const relative of sourceFiles) {
    const original = join(sourcePackage, relative);
    const bytes = await readFile(original);
    const copy = join(pluginRoot, relative);
    await mkdir(dirname(copy), { recursive: true });
    await writeFile(copy, bytes);
    expect(sha256(await readFile(copy)), `scratch clone of ${relative}`).toBe(sha256(bytes));
  }
  const storageBytes = await readFile(join(sourcePackage, storageRelativePath));
  expect(sha256(storageBytes), "pinned Harris Snipaste 2.0.1 storage-clipboard.cjs").toBe(pinnedStorageSha256);
  const preloadPath = join(pluginRoot, "preload/services.cjs");
  const source = await preparePluginPreload({
    pluginDir: pluginRoot,
    preloadPath,
    readTextFile: async path => {
      const actual = resolve(path);
      if (actual !== scratchRoot && !actual.startsWith(`${scratchRoot}${sep}`)) throw new Error(`preload graph escaped scratch: ${actual}`);
      graphReads.add(actual);
      return readFile(actual, "utf8");
    },
  });
  return { pluginRoot, preloadSource: scriptBody(source) };
}

async function runCopy(kind: "image" | "text", hostResponse: "denied" | "failure" | "success") {
  const scratchRoot = await mkdtemp(join(tmpdir(), "atools-snipaste-copy-result-"));
  const graphReads = new Set<string>(), fsCalls: string[] = [];
  const frame = createCompiledFrame(hostResponse);
  try {
    const prepared = await prepareOriginalService(scratchRoot, graphReads);
    const electronAdapter = frame.window.require("electron") as { nativeImage?: Record<string, unknown> } & Record<string, unknown>;
    frame.window.require = createScratchRequire(prepared.pluginRoot, fsCalls, {
      ...electronAdapter,
      nativeImage: { ...electronAdapter.nativeImage, createFromBuffer: undefined },
    }) as any;
    frame.window.Buffer = Buffer as any;
    frame.dom.getInternalVMContext();
    const preloadNodeSource = `window.__filename=${JSON.stringify(join(prepared.pluginRoot, "preload/services.cjs"))};\n${prepared.preloadSource}`;
    frame.window.eval(preloadNodeSource);
    expect(frame.window.services).toBeDefined();
    expect([...graphReads].some(path => path.endsWith("/preload/storage-clipboard.cjs"))).toBe(true);
    const calls = frame.trackPublicMethods();
    const result = kind === "image"
      ? frame.window.services.writeDualModeClipboard(copiedPng, { timestamp: 1_729_700_001 })
      : frame.window.services.writeDualModeClipboard({ text: copiedText, timestamp: 1_729_700_002 });
    const call = calls.at(-1);
    expect(call?.method).toBe(kind === "image" ? "copyImage" : "copyText");
    expect(call?.args[0]).toBe(kind === "image" ? copiedPng : copiedText);
    if (kind === "image") expect(fsCalls).toContain("fs.writeFileSync");

    const asyncMessage = frame.hostMessages.findLast(value => kind === "image"
      ? value?.__atools_native_call__ === true && value.method === "copyImage"
      : value?.__ipc_call__ === true && value.cmd === "copy_text");
    if (asyncMessage) {
      const error = hostResponse === "success" ? undefined
        : hostResponse === "denied" ? "ERR_ATOOLS_CLIPBOARD_PERMISSION_DENIED: host rejected clipboard write"
          : "ERR_ATOOLS_CLIPBOARD_WRITE_FAILED: controlled host write failure";
      frame.dispatchHostMessage(kind === "image"
        ? { __atools_native_response__: true, reqId: asyncMessage.reqId, ...(error ? { error } : { result: true }) }
        : { __ipc_response__: true, reqId: asyncMessage.reqId, ...(error ? { error } : { result: true }) });
    }
    const observed = await call!.settled;
    return { result, observed, publicReturn: call!.immediate, asyncMessage, frame, scratchRoot, graphReads, fsCalls };
  } catch (error) {
    frame.dom.window.close();
    await rm(scratchRoot, { recursive: true, force: true });
    throw error;
  }
}

it.each([
  ["image", "denied"],
  ["text", "denied"],
  ["image", "failure"],
  ["text", "failure"],
] as const)("original Snipaste service reports clipboard %s copy as false when the host is %s", async (kind, response) => {
  const run = await runCopy(kind, response);
  try {
    expect({
      asyncMessage: run.asyncMessage,
      syncRequests: run.frame.clipboardRequests.filter(request => request.async === false).length,
      promiseOutcome: run.observed,
      copiedToSystemClipboard: run.result.copiedToSystemClipboard,
    }).toMatchObject({ asyncMessage: undefined, syncRequests: 1, copiedToSystemClipboard: false });
  } finally {
    run.frame.dom.window.close();
    await rm(run.scratchRoot, { recursive: true, force: true });
  }
});

it.each([["image", copiedPng], ["text", copiedText]] as const)(
  "compiled public copy%s returns an immediate boolean only after synchronous host success",
  async (kind, value) => {
    const run = await runCopy(kind, "success");
    try {
      expect(run.asyncMessage).toBeUndefined();
      expect(run.frame.clipboardRequests.filter(request => request.async === false)).toHaveLength(1);
      expect(run.observed).toEqual({ status: "fulfilled", value: true });
      expect(typeof run.publicReturn).toBe("boolean");
      expect(run.publicReturn).toBe(true);
      expect(run.result.copiedToSystemClipboard).toBe(true);
      expect(value.length).toBeGreaterThan(0);
    } finally {
      run.frame.dom.window.close();
      await rm(run.scratchRoot, { recursive: true, force: true });
    }
  },
);

it("compiled HostClipboard script performs its granted image and text writes through synchronous host transport", () => {
  const frame = createCompiledFrame();
  try {
    frame.window.__atoolsHostClipboard!.writeImage({ dataUrl: copiedPng, width: 1, height: 1 });
    frame.window.__atoolsHostClipboard!.writeText(copiedText);
    expect(frame.clipboardRequests).toEqual([
      { method: "POST", endpoint, async: false, body: { image: expect.objectContaining({ dataUrl: copiedPng, width: 1, height: 1 }) }, status: 200 },
      { method: "POST", endpoint, async: false, body: { text: copiedText }, status: 200 },
    ]);
  } finally {
    frame.dom.window.close();
  }
});
