import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";
import { spawn } from "node:child_process";
import ts from "typescript";
import { findChromePath } from "../chrome-cdp-smoke-utils.mjs";
import { createFixtureEnvironment } from "./legacy-node-environment.mjs";
import { trackNativeDescendants } from "./native-smoke-descendants.mjs";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.allocUnsafe(payload.length + 12);
  chunk.writeUInt32BE(payload.length, 0);
  typeBytes.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, chunk.length - 4)), chunk.length - 4);
  return chunk;
}

/** Build a complete 1x1 RGBA PNG, padding with a valid ancillary tEXt chunk. */
export function makeValidPng(targetBytes) {
  assert(Number.isSafeInteger(targetBytes) && targetBytes >= 128, "PNG target must be a positive bounded size");
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const image = Buffer.from([0, 24, 96, 180, 255]); // filter byte + one RGBA pixel
  const prefix = Buffer.concat([signature, pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(image))]);
  const keyword = Buffer.from("Comment\0", "ascii");
  const fixed = prefix.length + 12 + keyword.length + 12; // tEXt chunk + IEND
  const fillBytes = targetBytes - fixed;
  assert(fillBytes >= 0, "PNG target is too small for the valid chunk structure");
  const text = Buffer.concat([keyword, Buffer.alloc(fillBytes, 0x41)]);
  const result = Buffer.concat([prefix, pngChunk("tEXt", text), pngChunk("IEND", Buffer.alloc(0))]);
  assert.equal(result.length, targetBytes, "Generated PNG must have the requested exact byte length");
  assert.equal(result.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(result.readUInt32BE(8), 13);
  assert.equal(result.subarray(12, 16).toString("ascii"), "IHDR");
  assert.equal(result.readUInt32BE(16), 1);
  assert.equal(result.readUInt32BE(20), 1);
  assert.equal(result.subarray(-8, -4).toString("ascii"), "IEND");
  return result;
}

/** Pre-seed currently missing transitive modules, then the shared loader rewrites its owned set. */
export async function installExtraHostModuleSources(root, scratch) {
  const folder = join(scratch, "host-modules");
  await mkdir(folder, { recursive: true });
  for (const name of ["nodeModulePayloadBudget", "browserBuffer", "pluginElectronWebFrame", "pluginNativeImage", "hostClipboardBridge"]) {
    const source = await readFile(join(root, "src/lib", `${name}.ts`), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022,
    } });
    await writeFile(join(folder, `${name}.mjs`), outputText.replace(/from "(\.\/[^".]+)"/g, 'from "$1.mjs"'));
  }
  return folder;
}

export async function loadHostClipboardFactory(scratch) {
  const modulePath = pathToFileURL(join(scratch, "host-modules/hostClipboardBridge.mjs"));
  return import(modulePath.href);
}

export function paintbrushChildHtml({ preloadTag, clipboardTag, electronTag, nodeEndpoint }) {
  const script = (source) => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  const bootstrap = `(() => {
    const listeners = new Map();
    const ipc = {
      on(channel, callback) { const bucket = listeners.get(channel) || new Set(); bucket.add(callback); listeners.set(channel, bucket); return this; },
      addListener(channel, callback) { return this.on(channel, callback); },
      once(channel, callback) { const once = (...args) => { this.removeListener(channel, once); callback(...args); }; return this.on(channel, once); },
      off(channel, callback) { listeners.get(channel)?.delete(callback); return this; },
      removeListener(channel, callback) { return this.off(channel, callback); },
      removeAllListeners(channel) { if (channel === undefined) listeners.clear(); else listeners.delete(channel); return this; },
    };
    const electronShim = { ipcRenderer: ipc };
    window.__paintbrushProbe = { listeners, pickerCalls: 0, notifications: [], hidden: 0, scenario: null, stage: "bootstrap",
      diagnostics: [], diagnosticBytes: 0, diagnosticDropped: 0 };
    const probe = window.__paintbrushProbe;
    const safeCode = value => {
      const code = typeof value === "string" ? value : (typeof value?.code === "string" ? value.code : value?.name);
      return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(code) ? code : "Error";
    };
    const safeMessage = value => String(value?.message || value || "").replace(/data:[^,\\s]+;base64,[A-Za-z0-9+/=]+/gi, "data:[redacted]")
      .replace(/\\/(host|node)\\/[a-f0-9]{64}/gi, "/$1/[redacted]").replace(/https?:\\/\\/[^\\s]+/gi, "[url]").slice(0, 160);
    const recordDiagnostic = (kind, error, line = 0) => {
      const event = { kind, code: safeCode(error), stage: probe.stage, line: Number.isSafeInteger(line) ? line : 0,
        message: safeMessage(error) }, size = new TextEncoder().encode(JSON.stringify(event)).byteLength;
      if (probe.diagnostics.length >= 12 || probe.diagnosticBytes + size > 2048) { probe.diagnosticDropped++; return; }
      probe.diagnostics.push(event); probe.diagnosticBytes += size;
      parent.postMessage({ type: "paintbrush-diagnostic", event }, "*");
    };
    window.__paintbrushSetStage = stage => { probe.stage = stage; };
    window.addEventListener("error", event => recordDiagnostic("windowerror", event.error || event.message || "Error", event.lineno || 0));
    window.addEventListener("unhandledrejection", event => recordDiagnostic("unhandledrejection", event.reason || "Error", 0));
    const resolveSaveFeature = () => {
      const exported = window.exports?.["save-clipboard"];
      if (typeof exported?.args?.enter === "function") return { owner: "exports", feature: exported };
      const service = window.services?.["save-clipboard"];
      if (typeof service?.args?.enter === "function") return { owner: "services", feature: service };
      return { owner: null, feature: null };
    };
    const diagnosticsSnapshot = () => ({ events: [...probe.diagnostics], bytes: probe.diagnosticBytes, dropped: probe.diagnosticDropped });
    window.utools = window.ztools = {
      clipboard: {}, getAppName: () => "ATools fixture", getAppVersion: () => "3.0 fixture",
      getPath: name => name === "downloads" ? probe.scenario?.downloads || "/tmp" : "",
      showSaveDialog(options) { probe.pickerCalls++; probe.lastPickerOptions = { title: options?.title, filters: options?.filters }; return probe.scenario?.cancel ? "" : probe.scenario?.savePath || ""; },
      showNotification(message) { probe.notifications.push(String(message).startsWith("已保存到 ") ? "saved" : String(message).startsWith("保存失败:") ? "save-failed" : String(message).includes("没有图片") ? "no-image" : "other"); },
      hideMainWindow() { probe.hidden++; }, outPlugin() {},
    };
    window.require = name => {
      const normalized = String(name).replace(/^node:/, "");
      if (normalized === "electron") return electronShim;
      throw new Error("Fixture local require unavailable: " + normalized);
    };
    window.__atoolsNativeDialog = { electron: {
      showSaveDialog: async () => ({ canceled: true, filePath: "" }),
      showSaveDialogSync: () => "", showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
      showOpenDialogSync: () => [],
    } };
    window.__paintbrushProbeReady = false;
    window.addEventListener("message", event => {
      if (event.source !== parent || !event.data || event.data.type !== "paintbrush-run") return;
      const request = event.data;
      probe.stage = "plugin-enter";
      probe.scenario = request.scenario;
      probe.pickerCalls = 0; probe.notifications = []; probe.hidden = 0; probe.lastPickerOptions = null; probe.chosenOwner = null;
      let errorCode = "";
      try {
        const selected = resolveSaveFeature();
        probe.chosenOwner = selected.owner;
        const enter = selected.feature?.args?.enter;
        if (typeof enter !== "function") throw new Error("Original save-clipboard enter handler was not installed");
        enter();
      } catch (error) { errorCode = safeCode(error); }
      setTimeout(() => parent.postMessage({ type: "paintbrush-result", id: request.id,
        pickerCalls: probe.pickerCalls, notifications: [...probe.notifications], hiddenCalls: probe.hidden,
        errorCode, chosenOwner: probe.chosenOwner || null, handlerInstalled: Boolean(resolveSaveFeature().feature),
        diagnostics: diagnosticsSnapshot() }, "*"), 90);
    });
  })();`;
  const node = `window.__atoolsNodeModuleRequire=${nodeEndpoint};
    window.require=window.__atoolsNodeModuleRequire;
    window.process=window.require("process");
    window.Buffer=window.require("buffer").Buffer;
    if(!window.setImmediate)window.setImmediate=fn=>setTimeout(fn,0);
    if(!window.clearImmediate)window.clearImmediate=clearTimeout;`;
  const run = `const exported=window.exports?.["save-clipboard"],service=window.services?.["save-clipboard"];
    window.__paintbrushSetStage?.("ready-check");
    const exportsHandler=typeof exported?.args?.enter==="function",servicesHandler=typeof service?.args?.enter==="function";
    window.__paintbrushProbeReady=exportsHandler||servicesHandler;
    parent.postMessage({type:"paintbrush-ready",ready:window.__paintbrushProbeReady,
      exportsHandler,servicesHandler,chosenOwner:exportsHandler?"exports":servicesHandler?"services":null,
      diagnostics:{events:[...window.__paintbrushProbe.diagnostics],bytes:window.__paintbrushProbe.diagnosticBytes,
        dropped:window.__paintbrushProbe.diagnosticDropped}},"*");`;
  const mark = (stage) => script(`window.__paintbrushSetStage?.(${JSON.stringify(stage)})`);
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>${script(bootstrap)}${mark("clipboard-bridge")}${clipboardTag}${mark("electron-adapter")}${electronTag}${mark("node-bridge")}${script(node)}${mark("plugin-preload")}${preloadTag}${script(run)}</body></html>`;
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function waitChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => { child.off("close", onClose); resolveWait(false); }, timeoutMs);
    function onClose() { clearTimeout(timer); resolveWait(true); }
    child.once("close", onClose);
  });
}

/** Start a fixture-only Chromium process with an owned handle and isolated profile/env. */
export async function launchManagedChrome(scratch, errorMessageSafe, errorCode, onSpawn = async () => {}) {
  const executable = await findChromePath();
  const profile = join(scratch, "chromium-profile");
  const isolation = await createFixtureEnvironment();
  const child = spawn(executable, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--disable-background-networking", "--disable-component-update", "--disable-default-apps", "--disable-extensions",
    "--disable-features=MediaRouter,Translate", "--disable-gpu", "--hide-scrollbars", "--mute-audio",
    "--no-default-browser-check", "--no-first-run", "about:blank"], {
    env: isolation.env, stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
  const stopDescendants = child.pid ? trackNativeDescendants(child, "") : null;
  let log = "", closing = null;
  let resolveReady, rejectReady;
  const ready = new Promise((resolveReadyValue, rejectReadyValue) => { resolveReady = resolveReadyValue; rejectReady = rejectReadyValue; });
  const onData = (chunk) => {
    log = (log + chunk.toString()).slice(-8000);
    const match = log.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) resolveReady(match[1]);
  };
  child.stdout.on("data", onData); child.stderr.on("data", onData);
  child.once("error", rejectReady);
  child.once("exit", (code, signal) => rejectReady(new Error(`Chromium exited before DevTools ready: ${code ?? signal}`)));
  const timer = setTimeout(() => rejectReady(new Error("Chromium DevTools ready timeout")), 10000);
  let webSocketUrl;
  try {
    await onSpawn({ pid: child.pid, executable });
    webSocketUrl = await ready;
  }
  catch (error) {
    clearTimeout(timer);
    try { if (stopDescendants) await stopDescendants(); } catch { /* Keep startup cleanup unknown. */ }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (!await waitChildClose(child, 2000) && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const stopped = await waitChildClose(child, 1000);
    const environment = await isolation.cleanup();
    throw Object.assign(new Error(errorMessageSafe(error)), { code: errorCode(error),
      chromeStartupCleanup: { processCloseObserved: stopped, isolatedEnvironmentRemoved: environment.isolatedEnvironmentRemoved } });
  }
  clearTimeout(timer);
  return {
    webSocketUrl, pid: child.pid, executable, isolation,
    environmentRoot: isolation.root,
    close() { return closing ||= (async () => {
      let trackedCleanup = false;
      try { if (stopDescendants) { await stopDescendants(); trackedCleanup = true; } }
      finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        if (!await waitChildClose(child, 3000) && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      const processCloseObserved = await waitChildClose(child, 1500);
      const environment = await isolation.cleanup();
      return { trackedDescendantCleanupAttempted: trackedCleanup, childExitCode: child.exitCode, childSignalCode: child.signalCode,
        processCloseObserved, isolatedEnvironmentRemoved: environment.isolatedEnvironmentRemoved,
        profileRelativePath: relative(scratch, profile) };
    })(); },
  };
}
