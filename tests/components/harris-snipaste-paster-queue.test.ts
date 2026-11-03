// @vitest-environment node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as nodeFs from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
import { preparePluginPreload } from "../../src/lib/pluginPreload";

const sourceRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const sourcePackage = sourceRoot ? resolve(sourceRoot, "snipaste") : "";
const releaseFiles = [
  "plugin.json",
  "preload/services.cjs",
  "preload/storage-clipboard.cjs",
  "preload/os-capture.cjs",
  "dist/paster.html",
] as const;

// This runs the unmodified published preload graph with real Node fs fenced to
// a scratch copy. createBrowserWindow, captures, IPC, and native OS windows are
// not exercised; passing proves only the payload/query contract in this seam.

type CapturedWindow = { url: string; options: Record<string, any> };
type PreloadFrame = { services: any; close: () => void };

function digest(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createScratchFs(scratchRoot: string, fsCalls: string[], blockedCalls: string[]) {
  const allowedSyncMethods = new Set(["existsSync", "mkdirSync", "readFileSync", "writeFileSync"]);
  const fence = (path: unknown) => {
    if (typeof path !== "string" && !(path instanceof URL)) throw new Error(`Unexpected fs path: ${String(path)}`);
    const actual = resolve(String(path));
    if (actual !== scratchRoot && !actual.startsWith(`${scratchRoot}${sep}`)) {
      throw new Error(`Snipaste preload filesystem escaped scratch: ${actual}`);
    }
    return actual;
  };
  return new Proxy(nodeFs, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "promises") {
        blockedCalls.push("fs.promises");
        throw new Error("Unexpected fs.promises access in Snipaste queue contract");
      }
      if (typeof value !== "function") return value;
      const method = typeof property === "string" ? property : String(property);
      if (!allowedSyncMethods.has(method)) {
        return (..._args: unknown[]) => {
          blockedCalls.push(`fs.${method}`);
          throw new Error(`Blocked filesystem method in Snipaste queue contract: fs.${method}`);
        };
      }
      return (...args: unknown[]) => {
        fence(args[0]);
        fsCalls.push(`fs.${method}`);
        return Reflect.apply(value, target, args);
      };
    },
  });
}

function makeFrame(html: string, scratchRoot: string, observed: { fsCalls: string[]; blockedCalls: string[] },
  createWindow?: (...args: any[]) => unknown) {
  const requireNode = createRequire(import.meta.url);
  const { fsCalls, blockedCalls } = observed;
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const scratchFs = createScratchFs(scratchRoot, fsCalls, blockedCalls);
  const childProcess = new Proxy(Object.create(null) as object, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (typeof property !== "string") return undefined;
      return (..._args: unknown[]) => {
        blockedCalls.push(`child_process.${property}`);
        throw new Error(`Blocked optional Snipaste side effect: child_process.${property}`);
      };
    },
  });
  const hostRequire = (specifier: string): unknown => {
    if (specifier === "node:fs" || specifier === "fs") return scratchFs;
    if (specifier === "node:path" || specifier === "path") return requireNode(specifier);
    if (specifier === "node:child_process") return childProcess;
    if (specifier === "electron") return Object.freeze({});
    throw new Error(`Blocked unexpected Snipaste host module: ${specifier}`);
  };
  const unexpected = (name: string) => (..._args: unknown[]) => {
    blockedCalls.push(name);
    throw new Error(`Blocked optional Snipaste side effect: ${name}`);
  };
  const ztools = {
    createBrowserWindow: createWindow ?? unexpected("createBrowserWindow"),
    getCursorScreenPoint: () => ({ x: 810, y: 420 }),
    getDisplayNearestPoint: () => ({ id: "scratch-display", scaleFactor: 2, bounds: { x: -1200, y: 0, width: 1200, height: 900 } }),
    screenCapture: unexpected("screenCapture"),
    copyImage: unexpected("copyImage"),
    copyText: unexpected("copyText"),
    hideMainWindow: unexpected("hideMainWindow"),
    outPlugin: unexpected("outPlugin"),
  };
  const sandbox: Record<string, any> = {
    require: hostRequire,
    Buffer: requireNode("node:buffer").Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    console,
    location: { href: "atools-plugin://fixture/paster.html" },
    screen: { width: 1920, height: 1080 },
    devicePixelRatio: 2,
    ztools,
    utools: ztools,
    fetch: unexpected("fetch"),
    XMLHttpRequest: unexpected("XMLHttpRequest"),
    addEventListener(type: string, listener: (...args: unknown[]) => void) {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: (...args: unknown[]) => void) { listeners.get(type)?.delete(listener); },
  };
  sandbox.window = sandbox;
  const script = html.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  vm.runInNewContext(script, sandbox, { timeout: 2_000 });
  return {
    services: sandbox.services,
    fsCalls,
    blockedCalls,
    close() {
      for (const type of ["pagehide", "atools-plugin-out"]) {
        for (const listener of [...(listeners.get(type) ?? [])]) listener();
      }
      listeners.clear();
    },
  } satisfies PreloadFrame & { fsCalls: string[]; blockedCalls: string[] };
}

it.skipIf(!sourceRoot)("hands off interleaved Snipaste 2.0.1 paster payloads by query ID through isolated preloads", async () => {
  const originalManifestBytes = await readFile(join(sourcePackage, "plugin.json"));
  const manifest = JSON.parse(originalManifestBytes.toString("utf8"));
  expect(manifest).toMatchObject({ author: "harris", version: "2.0.1", preload: "preload/services.cjs", main: "dist/index.html" });

  const sourceDigests = new Map<string, string>();
  const scratchRoot = await mkdtemp(join(tmpdir(), "atools-harris-snipaste-queue-"));
  const pluginRoot = join(scratchRoot, "plugin");
  const scratchPreload = join(pluginRoot, "preload", "services.cjs");
  const graphReads = new Set<string>();
  const observed = { fsCalls: [] as string[], blockedCalls: [] as string[] };
  const capturedWindows: CapturedWindow[] = [];
  let parent: ReturnType<typeof makeFrame> | undefined;
  let firstChild: ReturnType<typeof makeFrame> | undefined;
  let reopenedChild: ReturnType<typeof makeFrame> | undefined;
  let secondChild: ReturnType<typeof makeFrame> | undefined;

  try {
    for (const relative of releaseFiles) {
      const sourcePath = join(sourcePackage, relative);
      const bytes = await readFile(sourcePath);
      sourceDigests.set(sourcePath, digest(bytes));
      const scratchPath = join(pluginRoot, relative);
      await mkdir(dirname(scratchPath), { recursive: true });
      await writeFile(scratchPath, bytes);
      expect(digest(await readFile(scratchPath)), `faithful scratch copy: ${relative}`).toBe(digest(bytes));
    }

    async function prepareScratchPreload() {
      return preparePluginPreload({
        pluginDir: pluginRoot,
        preloadPath: scratchPreload,
        readTextFile: async path => {
          const actual = resolve(path);
          if (actual !== scratchRoot && !actual.startsWith(`${scratchRoot}${sep}`)) {
            throw new Error(`Preload graph escaped scratch: ${actual}`);
          }
          graphReads.add(actual);
          return readFile(actual, "utf8");
        },
      });
    }

    const parentHtml = await prepareScratchPreload();
    parent = makeFrame(parentHtml, scratchRoot, observed, (url: string, options: Record<string, any>, _ready?: () => void) => {
      const queue = JSON.parse(nodeFs.readFileSync(join(pluginRoot, ".runtime/paster-windows/latest-paster.json"), "utf8"));
      capturedWindows.push({ url, options: { ...options, queueAtCreate: queue } });
      return { id: `native-child-${capturedWindows.length}` };
    });

    const firstPayload = {
      id: "paster-contract-a-001",
      title: "Contract A",
      dataUrl: "data:image/png;base64,cGFzdGVyLWE=",
      width: 444,
      height: 333,
      screenX: -710,
      screenY: 206,
      alwaysOnTop: false,
    };
    const secondPayload = {
      id: "paster-contract-b-002",
      title: "Contract B",
      imageDataUrl: "data:image/png;base64,cGFzdGVyLWI=",
      width: 555,
      height: 222,
      screenX: 1270,
      screenY: -91,
      alwaysOnTop: true,
    };
    expect(parent.services.spawnStandalonePasterWindow(firstPayload)).toMatchObject({
      ok: true, mode: "os-browser-window", windowId: "native-child-1", screenX: -710, screenY: 206, width: 444, height: 333,
    });
    expect(parent.services.spawnStandalonePasterWindow(secondPayload)).toMatchObject({
      ok: true, mode: "os-browser-window", windowId: "native-child-2", screenX: 1270, screenY: -91, width: 555, height: 222,
    });
    expect(capturedWindows).toHaveLength(2);
    expect(capturedWindows[0]?.options).toMatchObject({ x: -710, y: 206, width: 444, height: 333, frame: false, transparent: true, alwaysOnTop: false });
    expect(capturedWindows[1]?.options).toMatchObject({ x: 1270, y: -91, width: 555, height: 222, frame: false, transparent: true, alwaysOnTop: true });
    expect(capturedWindows.map(entry => new URL(entry.url, "https://fixture.invalid").searchParams.get("id")))
      .toEqual([firstPayload.id, secondPayload.id]);
    expect(capturedWindows[0]?.url).toMatch(/^dist\/paster\.html\?/);
    expect(capturedWindows[0]?.options.queueAtCreate).toMatchObject({ id: firstPayload.id, title: firstPayload.title, dataUrl: firstPayload.dataUrl });
    expect(capturedWindows[1]?.options.queueAtCreate).toMatchObject({ id: secondPayload.id, title: secondPayload.title, dataUrl: secondPayload.imageDataUrl });

    const childHtml = await prepareScratchPreload();
    const firstQueryId = new URL(capturedWindows[0]!.url, "https://fixture.invalid").searchParams.get("id");
    const secondQueryId = new URL(capturedWindows[1]!.url, "https://fixture.invalid").searchParams.get("id");
    expect(firstQueryId).toBe(firstPayload.id);
    expect(secondQueryId).toBe(secondPayload.id);

    firstChild = makeFrame(childHtml, scratchRoot, observed);
    expect(firstChild.services.readLatestPasterWindowPayload(firstQueryId)).toMatchObject({
      ok: true,
      payload: { id: firstPayload.id, title: firstPayload.title, width: 444, height: 333, screenX: -710, screenY: 206,
        dataUrl: firstPayload.dataUrl, imageDataUrl: firstPayload.dataUrl },
    });
    firstChild.close();
    firstChild = undefined;

    secondChild = makeFrame(childHtml, scratchRoot, observed);
    expect(secondChild.services.readLatestPasterWindowPayload(secondQueryId)).toMatchObject({
      ok: true,
      payload: { id: secondPayload.id, title: secondPayload.title, width: 555, height: 222, screenX: 1270, screenY: -91,
        dataUrl: secondPayload.imageDataUrl, imageDataUrl: secondPayload.imageDataUrl },
    });
    secondChild.close();
    secondChild = undefined;

    reopenedChild = makeFrame(await prepareScratchPreload(), scratchRoot, observed);
    expect(reopenedChild.services.readLatestPasterWindowPayload(firstQueryId)).toMatchObject({
      ok: true,
      payload: { id: firstPayload.id, title: firstPayload.title, dataUrl: firstPayload.dataUrl, imageDataUrl: firstPayload.dataUrl },
    });

    expect(JSON.parse(await readFile(join(pluginRoot, ".runtime/paster-windows/latest-paster.json"), "utf8")))
      .toMatchObject({ id: secondPayload.id, dataUrl: secondPayload.imageDataUrl });
    expect([...graphReads].sort()).toEqual([
      join(pluginRoot, "preload/os-capture.cjs"),
      join(pluginRoot, "preload/services.cjs"),
      join(pluginRoot, "preload/storage-clipboard.cjs"),
    ].sort());
    expect(observed.fsCalls).toEqual(expect.arrayContaining(["fs.mkdirSync", "fs.writeFileSync", "fs.existsSync", "fs.readFileSync"]));
    expect(observed.blockedCalls).toEqual([]);
  } finally {
    parent?.close();
    firstChild?.close();
    secondChild?.close();
    reopenedChild?.close();
    await rm(scratchRoot, { recursive: true, force: true });
    for (const [path, before] of sourceDigests) expect(digest(await readFile(path)), `unchanged published source: ${path}`).toBe(before);
  }
});
