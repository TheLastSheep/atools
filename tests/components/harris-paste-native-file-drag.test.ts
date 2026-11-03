// @vitest-environment node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import vm from "node:vm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { TextDecoder, TextEncoder } from "node:util";
import { createPluginBridgeDocument, injectPluginBridgeHtml } from "../../src/lib/pluginPanelBridgeCompiler";
import type { FeatureAction } from "../../src/lib/types";

// This opt-in contract loads only Harris's real native-file-drag module. It does
// not execute the shipped preload, Node sidecar, Tauri, or the Paste UI.
const sourceRootSetting = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const originalContract = sourceRootSetting ? describe : describe.skip;
const EXPECTED_PLUGIN_VERSION = "1.3.1";
const EXPECTED_NATIVE_FILE_DRAG_SHA256 = "bbc8524343e7d9142085ff187c52e0f11b69ac1c9d5428eca67f4a67402129ad";
const EXPECTED_DIST_PRELOAD_SHA256 = "6566635ba6f1143379ec980e42248cd666b2fa8d871a621f65e76c04ab1c98d3";
const DRAG_ENDPOINT = `http://127.0.0.1:12345/file-drag/${"c".repeat(64)}`;

type OriginalPaths = { pluginRoot: string; manifest: string; nativeFileDrag: string; distManifest: string; distPreload: string };
type NativeFileDragApi = {
  NativeFileDragService: new (
    store: { findRecordByItemId(itemId: string): Promise<unknown> },
    host: { startDrag?: (paths: string | string[]) => void },
    isFile?: (filePath: string) => boolean,
  ) => {
    refresh(records: unknown[]): void;
    prepare(itemId: string): Promise<boolean>;
    start(itemId: string): boolean;
  };
};
type Request = { method: string; endpoint: string; asynchronous: boolean; contentType: string; body: string };
type Reply = { status?: number; body?: string; responseURL?: string };

const action: FeatureAction = {
  plugin_id: "pasteboard-pro",
  plugin_name: "Paste",
  feature_code: "pasteboard-pro",
  main_url: "index.html",
  plugin_path: "/fixture/pasteboard-pro",
  expand_height: 300,
  payload: null,
};

function resolveOriginalPaths(sourceRoot: string): OriginalPaths {
  const root = resolve(sourceRoot);
  const pluginRoot = [root, join(root, "pasteboard-pro"), join(root, "plugins/pasteboard-pro")]
    .find(candidate => existsSync(join(candidate, "apps/ztools/preload/native-file-drag.ts")));
  if (!pluginRoot) throw new Error(`Cannot find pasteboard-pro native file drag source under ${root}`);
  return {
    pluginRoot,
    manifest: join(pluginRoot, "plugin.json"),
    nativeFileDrag: join(pluginRoot, "apps/ztools/preload/native-file-drag.ts"),
    distManifest: join(pluginRoot, "dist/ztools/plugin.json"),
    distPreload: join(pluginRoot, "dist/ztools/preload.js"),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function loadOriginalNativeFileDrag(sourcePath: string): Promise<NativeFileDragApi> {
  const requireFromTest = createRequire(import.meta.url);
  const requireFromVite = createRequire(requireFromTest.resolve("vite/package.json"));
  type EsbuildApi = {
    build(options: {
      entryPoints: string[];
      bundle: true;
      platform: "node";
      format: "cjs";
      write: false;
      logLevel: "silent";
    }): Promise<{ outputFiles: Array<{ text: string }> }>;
  };
  const esbuild = requireFromVite("esbuild") as EsbuildApi;
  const result = await esbuild.build({
    entryPoints: [sourcePath], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error("esbuild did not return the original native-file-drag bundle");

  const loadedModule: { exports: Record<string, unknown> } = { exports: {} };
  vm.runInNewContext(output.text, {
    module: loadedModule,
    exports: loadedModule.exports,
    require: createRequire(sourcePath),
    process,
    console,
  }, { timeout: 10_000, filename: sourcePath });
  if (typeof loadedModule.exports.NativeFileDragService !== "function") {
    throw new Error("Original native-file-drag bundle is missing NativeFileDragService");
  }
  return loadedModule.exports as unknown as NativeFileDragApi;
}

function productionHost(reply: Reply = {}) {
  const requests: Request[] = [];
  const bridge = createPluginBridgeDocument({
    action,
    windowType: "main",
    browserWindowId: "",
    geometrySnapshot: null,
    workerScope: "harris-native-file-drag-contract",
    mainPushConfig: null,
    webContentsId: 1,
    subInputEpoch: 1,
    appName: "ATools",
    appVersion: "3.0.0",
    fileDrag: { endpoint: DRAG_ENDPOINT },
  });
  const page = injectPluginBridgeHtml("<!doctype html><html><head></head><body><script>window.__pluginScriptRan = true;</script></body></html>", bridge);
  const frame = new JSDOM(page, {
    runScripts: "dangerously",
    beforeParse(window) {
      Object.defineProperties(window, {
        TextDecoder: { value: TextDecoder },
        TextEncoder: { value: TextEncoder },
        XMLHttpRequest: { value: class {
          status = 200;
          responseURL = "";
          responseText = "";
          contentType = "";
          method = "";
          endpoint = "";
          asynchronous = true;
          open(method: string, endpoint: string, asynchronous = true) { this.method = method; this.endpoint = endpoint; this.asynchronous = asynchronous; }
          setRequestHeader(name: string, value: string) { if (name.toLowerCase() === "content-type") this.contentType = value; }
          send(body: string) {
            requests.push({ method: this.method, endpoint: this.endpoint, asynchronous: this.asynchronous, contentType: this.contentType, body });
            this.status = reply.status ?? 200;
            this.responseURL = reply.responseURL ?? this.endpoint;
            this.responseText = reply.body ?? '{"ok":true,"result":{"started":true}}';
          }
        } },
      });
    },
  });
  return {
    requests,
    frame,
    host: frame.window.ztools as unknown as { startDrag?: (paths: string | string[]) => void },
    close: () => frame.window.close(),
  };
}

function createScratchPaths(count: number) {
  const root = mkdtempSync(join(tmpdir(), "atools-harris-native-drag-"));
  const paths = Array.from({ length: count }, (_, index) => join(root, `scratch-${index}.txt`));
  paths.forEach(path => writeFileSync(path, "fixture"));
  function fencedIsFile(filePath: string) {
    const safePath = resolve(filePath);
    const insideRoot = relative(root, safePath);
    if (insideRoot === ".." || insideRoot.startsWith(`..${sep}`) || isAbsolute(insideRoot)) {
      throw new Error(`Original module checked a path outside scratch: ${safePath}`);
    }
    try { return statSync(safePath).isFile(); } catch { return false; }
  }
  return { root, paths, isFile: fencedIsFile, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function fileRecord(id: string, filePaths: string[]) {
  return {
    item: { id, kind: "file", payload: { filePaths } },
    origin: {},
  };
}

function recordStore(records: Array<ReturnType<typeof fileRecord>>) {
  const byId = new Map(records.map(record => [record.item.id, record]));
  return { findRecordByItemId: async (itemId: string) => byId.get(itemId) };
}

originalContract("Harris Paste native file drag public bridge contract", () => {
  let paths: OriginalPaths | undefined;
  let NativeFileDragService: NativeFileDragApi["NativeFileDragService"];
  let nativeFileDragHashBefore = "";
  let distPreloadHashBefore = "";

  beforeAll(async () => {
    paths = resolveOriginalPaths(sourceRootSetting!);
    for (const path of [paths.manifest, paths.nativeFileDrag, paths.distManifest, paths.distPreload]) {
      expect(existsSync(path), `Original package file exists: ${path}`).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as { version?: string };
    const distManifest = JSON.parse(readFileSync(paths.distManifest, "utf8")) as { version?: string };
    expect(manifest.version).toBe(EXPECTED_PLUGIN_VERSION);
    expect(distManifest.version).toBe(EXPECTED_PLUGIN_VERSION);
    nativeFileDragHashBefore = sha256(paths.nativeFileDrag);
    expect(nativeFileDragHashBefore).toBe(EXPECTED_NATIVE_FILE_DRAG_SHA256);
    distPreloadHashBefore = sha256(paths.distPreload);
    expect(distPreloadHashBefore).toBe(EXPECTED_DIST_PRELOAD_SHA256);
    NativeFileDragService = (await loadOriginalNativeFileDrag(paths.nativeFileDrag)).NativeFileDragService;
  });

  afterAll(() => {
    if (!paths) return;
    const nativeFileDragHashAfter = sha256(paths.nativeFileDrag);
    const distPreloadHashAfter = sha256(paths.distPreload);
    expect(nativeFileDragHashAfter, "Original native-file-drag source must remain byte-identical")
      .toBe(nativeFileDragHashBefore);
    expect(distPreloadHashAfter, "Original dist preload must remain byte-identical").toBe(distPreloadHashBefore);
    console.info(`[Harris Paste ${EXPECTED_PLUGIN_VERSION}] native-file-drag.ts sha256 before=${nativeFileDragHashBefore} after=${nativeFileDragHashAfter}`);
    console.info(`[Harris Paste ${EXPECTED_PLUGIN_VERSION}] dist/ztools/preload.js sha256 before=${distPreloadHashBefore} after=${distPreloadHashAfter}`);
  });

  it("returns true for a real scratch file after a synchronous production bridge acknowledgement", async () => {
    const scratch = createScratchPaths(1);
    const fixture = productionHost();
    const calls: Array<string | string[]> = [];
    const host = { startDrag: (value: string | string[]) => { calls.push(value); fixture.host.startDrag!(value); } };
    const service = new NativeFileDragService(recordStore([fileRecord("one", [scratch.paths[0]!])]), host, scratch.isFile);
    try {
      expect(await service.prepare("one")).toBe(true);
      expect(service.start("one")).toBe(true);
      expect(calls).toEqual([scratch.paths[0]]);
      expect(fixture.requests).toEqual([{
        method: "POST", endpoint: DRAG_ENDPOINT, asynchronous: false, contentType: "text/plain",
        body: JSON.stringify({ paths: [scratch.paths[0]] }),
      }]);
      expect((fixture.frame.window as unknown as { __pluginScriptRan?: boolean }).__pluginScriptRan).toBe(true);
    } finally {
      fixture.close();
      scratch.cleanup();
    }
  });

  it("uses one synchronous bridge request for multiple real paths and removes duplicates", async () => {
    const scratch = createScratchPaths(2);
    const fixture = productionHost();
    const calls: Array<string | string[]> = [];
    const host = { startDrag: (value: string | string[]) => { calls.push(value); fixture.host.startDrag!(value); } };
    const service = new NativeFileDragService(
      recordStore([fileRecord("many", [scratch.paths[0]!, scratch.paths[1]!, scratch.paths[0]!])]), host, scratch.isFile,
    );
    try {
      expect(await service.prepare("many")).toBe(true);
      expect(service.start("many")).toBe(true);
      expect(calls).toEqual([[scratch.paths[0], scratch.paths[1]]]);
      expect(fixture.requests).toHaveLength(1);
      expect(fixture.requests[0]).toMatchObject({
        asynchronous: false,
        body: JSON.stringify({ paths: [scratch.paths[0], scratch.paths[1]] }),
      });
    } finally {
      fixture.close();
      scratch.cleanup();
    }
  });

  it("returns false without a bridge or when the synchronous native acknowledgement fails, with no replay", async () => {
    const scratch = createScratchPaths(1);
    const fixture = productionHost({ status: 503 });
    const missingHostRecord = fileRecord("no-host", [scratch.paths[0]!]);
    const serviceWithoutHost = new NativeFileDragService(recordStore([missingHostRecord]), {}, scratch.isFile);
    const failedRecord = fileRecord("failed", [scratch.paths[0]!]);
    const serviceWithHost = new NativeFileDragService(
      recordStore([failedRecord]), fixture.host, scratch.isFile,
    );
    try {
      expect(await serviceWithoutHost.prepare("no-host")).toBe(true);
      expect(serviceWithoutHost.start("no-host")).toBe(false);
      expect(fixture.requests).toHaveLength(0);

      expect(await serviceWithHost.prepare("failed")).toBe(true);
      expect(serviceWithHost.start("failed")).toBe(false);
      expect(serviceWithHost.start("failed")).toBe(false);
      expect(fixture.requests).toHaveLength(1);
    } finally {
      fixture.close();
      scratch.cleanup();
    }
  });

  it("returns false and does not call the bridge for an absent scratch file", async () => {
    const scratch = createScratchPaths(1);
    const fixture = productionHost();
    const service = new NativeFileDragService(recordStore([fileRecord("missing", [scratch.paths[0]!])]), fixture.host, () => false);
    try {
      expect(await service.prepare("missing")).toBe(true);
      expect(service.start("missing")).toBe(false);
      expect(fixture.requests).toHaveLength(0);
    } finally {
      fixture.close();
      scratch.cleanup();
    }
  });
});
