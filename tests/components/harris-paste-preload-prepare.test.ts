// @vitest-environment node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createPluginRuntimePreload,
  type PluginRuntimePreloadOptions,
} from "../../src/lib/pluginRuntimePreload";

// This exercises the real bounded source-graph preparation path for Harris's
// unchanged Paste 1.3.1 preload. The native invoke is a contract-shaped
// substitute. It does not run the original preload or start Node, Tauri,
// WebView, or the Paste business UI.
const sourceRootSetting = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const originalPaste = sourceRootSetting ? describe : describe.skip;
const EXPECTED_VERSION = "1.3.1";
const EXPECTED_PLUGIN_ID = "pasteboard-pro";
const EXPECTED_PRELOAD_SHA256 = "6566635ba6f1143379ec980e42248cd666b2fa8d871a621f65e76c04ab1c98d3";
const EXPECTED_HISTORY_CHUNK = "chunks/history-search-index-Bm2oYZYG.cjs";
const EXPECTED_HISTORY_CHUNK_SHA256 = "c5fb4fc0ec568f13dd4b411f13a6d91ead4eeac0bd3a1be904ec15daef9d84d7";
const EXPECTED_WORKER_SHA256 = "4dfd870808aecaaaecc4f0f7996ae2c27d9a0edf2a1c193fb817d36deff518cf";
const SESSION_ID = "12345678-1234-4234-8234-123456789abc";
const NODE_ENDPOINT = `http://127.0.0.1:1234/node/${"a".repeat(64)}`;
const DEFAULT_READ_BUDGET = 1024;
const DEFAULT_BYTE_BUDGET = 2 * 1024 * 1024;
const DEFAULT_MODULE_BUDGET = 128;

type PastePaths = {
  pluginRoot: string;
  distRoot: string;
  manifestPath: string;
  preloadPath: string;
  historyChunkPath: string;
  workerPath: string;
};
type ReadMetrics = {
  startedAt: number;
  reads: string[];
  bytes: number;
  hashes: Map<string, string>;
};
type NativeCall = { command: string; args?: Record<string, unknown> };

function getOriginalPaths(): PastePaths {
  const pluginRoot = resolve(sourceRootSetting!, EXPECTED_PLUGIN_ID);
  const distRoot = resolve(pluginRoot, "dist/ztools");
  return {
    pluginRoot,
    distRoot,
    manifestPath: resolve(distRoot, "plugin.json"),
    preloadPath: resolve(distRoot, "preload.js"),
    historyChunkPath: resolve(distRoot, EXPECTED_HISTORY_CHUNK),
    workerPath: resolve(distRoot, "history-worker.cjs"),
  };
}

function createReadMetrics(): ReadMetrics {
  return { startedAt: performance.now(), reads: [], bytes: 0, hashes: new Map() };
}

function sha256(source: string | Uint8Array): string {
  return createHash("sha256").update(source).digest("hex");
}

function optionsForGraph(paths: PastePaths, entry: string, metrics: ReadMetrics,
  onSafeStorageRequired?: () => Promise<void>): PluginRuntimePreloadOptions {
  return {
    pluginDir: paths.distRoot,
    preloadPath: entry,
    readTextFile: async requestedPath => {
      const path = resolve(requestedPath);
      const pathFromRoot = relative(paths.distRoot, path);
      if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
        throw new Error(`Paste preload read escaped pinned dist/ztools root: ${path}`);
      }
      metrics.reads.push(path);
      const source = await readFile(path, "utf8");
      metrics.bytes += Buffer.byteLength(source, "utf8");
      metrics.hashes.set(path, sha256(source));
      return source;
    },
    ...(onSafeStorageRequired ? { onSafeStorageRequired } : {}),
  };
}

function countPreparedModules(html: string): number {
  return [...html.matchAll(/\["[^"\n]+", function\(require, module, exports, __filename, __dirname\) \{/g)].length;
}

function expectWithinDefaultBudgets(metrics: ReadMetrics, moduleCount = metrics.hashes.size): void {
  expect(metrics.reads.length).toBeLessThanOrEqual(DEFAULT_READ_BUDGET);
  expect(metrics.bytes).toBeLessThanOrEqual(DEFAULT_BYTE_BUDGET);
  expect(moduleCount).toBeLessThanOrEqual(DEFAULT_MODULE_BUDGET);
}

function reportReadDiagnostics(paths: PastePaths, metrics: ReadMetrics, entry: string, expectedSha256: string,
  moduleCount = metrics.hashes.size): void {
  console.info("[Harris Paste preload prepare]", JSON.stringify({
    sourcePath: entry,
    sourceSha256: metrics.hashes.get(entry),
    expectedSha256,
    readCount: metrics.reads.length,
    sourceBytes: metrics.bytes,
    moduleCount,
    elapsedMs: Number((performance.now() - metrics.startedAt).toFixed(2)),
    nodeVersion: process.version,
    distRoot: paths.distRoot,
  }));
}

function makeUnexpectedInvoke(calls: NativeCall[]) {
  return vi.fn(async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    throw new Error(`Unexpected native Node startup while preflight was denied: ${command}`);
  });
}

originalPaste("Harris Paste 1.3.1 real preload graph preparation", () => {
  let paths: PastePaths;

  beforeAll(async () => {
    paths = getOriginalPaths();
    const [manifestText, preloadSource, historyChunkSource, workerSource] = await Promise.all([
      readFile(paths.manifestPath, "utf8"),
      readFile(paths.preloadPath, "utf8"),
      readFile(paths.historyChunkPath, "utf8"),
      readFile(paths.workerPath, "utf8"),
    ]);
    const manifest = JSON.parse(manifestText) as { name?: string; version?: string };
    expect(manifest.name).toBe(EXPECTED_PLUGIN_ID);
    expect(manifest.version).toBe(EXPECTED_VERSION);
    expect(sha256(preloadSource)).toBe(EXPECTED_PRELOAD_SHA256);
    expect(sha256(historyChunkSource)).toBe(EXPECTED_HISTORY_CHUNK_SHA256);
    expect(sha256(workerSource)).toBe(EXPECTED_WORKER_SHA256);
    expect(preloadSource).toContain(`require("./${EXPECTED_HISTORY_CHUNK}")`);
    expect(preloadSource).toContain("safeStorage");
    expect(preloadSource).toContain("require(\"electron\")");
    expect(workerSource).toContain('require("node:worker_threads")');
    expect(workerSource).toContain(`require("./${EXPECTED_HISTORY_CHUNK}")`);
  });

  it("denies safeStorage before exposing an executable preload or opening Node", async () => {
    const metrics = createReadMetrics();
    const calls: NativeCall[] = [];
    const invoke = makeUnexpectedInvoke(calls);
    const loader = createPluginRuntimePreload(invoke, EXPECTED_PLUGIN_ID, () => true);
    const safeStorage = vi.fn(async () => { throw new Error("ERR_ATOOLS_SECRET_STORAGE_PERMISSION_DENIED"); });
    let preloadReturned = false;
    const preparation = loader.prepare(optionsForGraph(paths, paths.preloadPath, metrics, safeStorage))
      .then(html => { preloadReturned = true; return html; });

    await expect(preparation).rejects.toThrow("ERR_ATOOLS_SECRET_STORAGE_PERMISSION_DENIED");
    expect(preloadReturned).toBe(false);
    expect(safeStorage).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    expect(metrics.hashes.get(paths.preloadPath)).toBe(EXPECTED_PRELOAD_SHA256);
    expect(metrics.hashes.get(paths.historyChunkPath)).toBe(EXPECTED_HISTORY_CHUNK_SHA256);
    expect(metrics.reads).toContain(paths.preloadPath);
    expect(metrics.reads).toContain(paths.historyChunkPath);
    expect(metrics.hashes.size).toBe(2);
    expectWithinDefaultBudgets(metrics);
    reportReadDiagnostics(paths, metrics, paths.preloadPath, EXPECTED_PRELOAD_SHA256);
  });

  it("waits for safeStorage approval and reuses one native environment for the original preload and worker child", async () => {
    const metrics = createReadMetrics();
    const additionalMetrics = createReadMetrics();
    const repeatedMetrics = createReadMetrics();
    const calls: NativeCall[] = [];
    const order: string[] = [];
    let approveSafeStorage!: () => void;
    const approval = new Promise<void>(resolveApproval => { approveSafeStorage = resolveApproval; });
    const safeStorage = vi.fn(async () => {
      order.push("safeStorage:required");
      await approval;
      order.push("safeStorage:approved");
    });
    const invoke = vi.fn(async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      order.push(command);
      if (command === "prepare_legacy_node") {
        expect(args?.pluginId).toBe(EXPECTED_PLUGIN_ID);
        expect(args?.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        return { sessionId: SESSION_ID } as T;
      }
      if (command === "get_legacy_node_session") {
        expect(args).toEqual({ sessionId: SESSION_ID });
        return { endpoint: NODE_ENDPOINT } as T;
      }
      if (command === "close_legacy_node") {
        expect(args?.pluginId).toBe(EXPECTED_PLUGIN_ID);
        expect(args?.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        return undefined as T;
      }
      throw new Error(`Unexpected native command: ${command}`);
    });
    const loader = createPluginRuntimePreload(invoke, EXPECTED_PLUGIN_ID, () => true);
    const pending = loader.prepare(optionsForGraph(paths, paths.preloadPath, metrics, safeStorage));

    await vi.waitFor(() => expect(safeStorage).toHaveBeenCalledTimes(1));
    expect(order).toEqual(["safeStorage:required"]);
    expect(calls).toEqual([]);
    approveSafeStorage();
    const html = await pending;
    const htmlModuleCount = countPreparedModules(html);
    order.push("preload:return");

    expect(order).toEqual([
      "safeStorage:required", "safeStorage:approved", "prepare_legacy_node",
      "get_legacy_node_session", "preload:return",
    ]);
    expect(NODE_ENDPOINT).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/node\/[a-f0-9]{64}$/);
    expect(html.indexOf("data-atools-node-modules")).toBeLessThan(html.indexOf("data-atools-plugin-preload"));
    expect(html).toContain('return localRequire("electron")');
    expect(html).toContain("Electron requires the local host shim");
    expect(html).toContain("safeStorage");
    expect(html).toContain(`require("./${EXPECTED_HISTORY_CHUNK}")`);
    expect(htmlModuleCount).toBe(2);
    expect(calls.map(call => call.command)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);
    expect(JSON.stringify(calls[0])).not.toContain(NODE_ENDPOINT);
    expect(calls[1]).toEqual({ command: "get_legacy_node_session", args: { sessionId: SESSION_ID } });

    const repeatedHtml = await loader.prepare(optionsForGraph(paths, paths.preloadPath, repeatedMetrics,
      async () => { order.push("safeStorage:approved-again"); }));
    expect(repeatedHtml.indexOf("data-atools-node-modules")).toBeLessThan(repeatedHtml.indexOf("data-atools-plugin-preload"));
    expect(calls.map(call => call.command)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);

    // This real child CJS graph requires node:worker_threads but no safeStorage.
    // It therefore exercises prepareAdditional's reuse of the already-open
    // parent environment without launching or evaluating the worker source.
    const workerHtml = await loader.prepareAdditional(optionsForGraph(paths, paths.workerPath, additionalMetrics));
    expect(workerHtml.indexOf("data-atools-node-modules")).toBeLessThan(workerHtml.indexOf("data-atools-plugin-preload"));
    expect(workerHtml).toContain('require("node:worker_threads")');
    expect(workerHtml).toContain(`require("./${EXPECTED_HISTORY_CHUNK}")`);
    expect(calls.map(call => call.command)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);

    expect(metrics.hashes.get(paths.preloadPath)).toBe(EXPECTED_PRELOAD_SHA256);
    expect(metrics.hashes.get(paths.historyChunkPath)).toBe(EXPECTED_HISTORY_CHUNK_SHA256);
    expect(additionalMetrics.hashes.get(paths.workerPath)).toBe(EXPECTED_WORKER_SHA256);
    expect(additionalMetrics.hashes.get(paths.historyChunkPath)).toBe(EXPECTED_HISTORY_CHUNK_SHA256);
    const repeatedModuleCount = countPreparedModules(repeatedHtml);
    const additionalModuleCount = countPreparedModules(workerHtml);
    expect(repeatedModuleCount).toBe(2);
    expect(additionalModuleCount).toBe(2);
    expectWithinDefaultBudgets(metrics, htmlModuleCount);
    expectWithinDefaultBudgets(repeatedMetrics, repeatedModuleCount);
    expectWithinDefaultBudgets(additionalMetrics, additionalModuleCount);
    reportReadDiagnostics(paths, metrics, paths.preloadPath, EXPECTED_PRELOAD_SHA256, htmlModuleCount);
    reportReadDiagnostics(paths, repeatedMetrics, paths.preloadPath, EXPECTED_PRELOAD_SHA256, repeatedModuleCount);
    reportReadDiagnostics(paths, additionalMetrics, paths.workerPath, EXPECTED_WORKER_SHA256, additionalModuleCount);

    await loader.close();
    await loader.close();
    expect(calls.map(call => call.command)).toEqual([
      "prepare_legacy_node", "get_legacy_node_session", "close_legacy_node",
    ]);
    expect(calls[2]?.args).toEqual(calls[0]?.args);
  });
});
