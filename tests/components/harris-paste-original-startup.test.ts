// @vitest-environment node
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, mkdir as makeDirectory, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";
import { createFixtureEnvironment } from "../../scripts/lib/legacy-node-environment.mjs";
import {
  createPasteStartupFrame,
  createPasteStartupWorker,
  createReadOnlyBuiltPackage,
  sourceDigestsUnchanged,
} from "../fixtures/paste-startup/frame-fixture";
import { managePasteStartupWorker } from "../fixtures/paste-startup/worker-lifecycle";

const pluginsRoot = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
const sourcePackage = resolve(pluginsRoot, "pasteboard-pro");
const productNode = resolve(process.cwd(), "src-tauri/binaries/node-aarch64-apple-darwin");
const enabled = existsSync(resolve(sourcePackage, "dist/ztools/preload.js")) && existsSync(productNode);

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, message: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`${message}; last observation: ${JSON.stringify(last)}`);
}

it("cleans up startup Workers that exit early, time out, or stop answering", async () => {
  const entry = new URL("../fixtures/paste-startup/worker-lifecycle-failure.mjs", import.meta.url);
  const exited: number[] = [];
  const earlyExit = new Worker(entry, { workerData: { mode: "exit-zero" } });
  earlyExit.on("exit", code => exited.push(code));
  await expect(managePasteStartupWorker(earlyExit, { readyTimeoutMs: 1000, cleanupTimeoutMs: 500 }))
    .rejects.toThrow("exited 0 before ready");
  expect(exited).toEqual([0]);

  const messages: unknown[] = [];
  const timedOut = new Worker(entry, { workerData: { mode: "wait-for-abort" } });
  const timeoutExit: number[] = [];
  timedOut.on("message", message => messages.push(message));
  timedOut.on("exit", code => timeoutExit.push(code));
  const startedAt = Date.now();
  await expect(managePasteStartupWorker(timedOut, {
    readyTimeoutMs: 40, requestTimeoutMs: 100, cleanupTimeoutMs: 500,
  })).rejects.toThrow("did not become ready");
  expect(messages).toContainEqual({ type: "abort-observed" });
  expect(timeoutExit).toEqual([0]);
  expect(Date.now() - startedAt).toBeLessThan(1500);

  const managed = await managePasteStartupWorker(new Worker(entry, { workerData: { mode: "ready" } }), {
    readyTimeoutMs: 1000, requestTimeoutMs: 40, cleanupTimeoutMs: 500,
  });
  await expect(managed.request("hold")).rejects.toThrow("timed out (hold)");
  const pendingAtExit = managed.request("hold", undefined, 1000);
  await managed.worker.terminate();
  await expect(pendingAtExit).rejects.toThrow("Worker exited");
  const terminated = await managed.close();
  expect(terminated.workerExit.code).toBe(1);

  const shutdownMessages: unknown[] = [];
  const shutdownExit: number[] = [];
  const shutdownTimeoutWorker = new Worker(entry, { workerData: { mode: "ready-shutdown-timeout" } });
  shutdownTimeoutWorker.on("message", message => shutdownMessages.push(message));
  shutdownTimeoutWorker.on("exit", code => shutdownExit.push(code));
  const shutdownTimeout = await managePasteStartupWorker(shutdownTimeoutWorker, {
    readyTimeoutMs: 1000, requestTimeoutMs: 40, cleanupTimeoutMs: 500,
  });
  const shutdownStartedAt = Date.now();
  await expect(shutdownTimeout.close()).rejects.toThrow("timed out (shutdown)");
  expect(shutdownMessages).toContainEqual({ type: "abort-observed" });
  expect(shutdownExit).toEqual([0]);
  expect(Date.now() - shutdownStartedAt).toBeLessThan(1500);
});

async function runOriginalStartupScenario(scenario: "text" | "files") {
  const isolation = await createFixtureEnvironment();
  const scratchRoot = resolve(isolation.root, "work");
  const pluginDataRoot = resolve(scratchRoot, "plugin-data");
  let fixtureFilePaths: string[] = [];
  let packageCopy: Awaited<ReturnType<typeof createReadOnlyBuiltPackage>> | undefined;
  let worker: Awaited<ReturnType<typeof createPasteStartupWorker>> | undefined;
  const nodeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  let frame: ReturnType<typeof createPasteStartupFrame> | undefined;
  let runtime: ReturnType<typeof createPluginRuntimePreload> | undefined;
  let safeStoragePermissionPortCalls = 0;
  let dataOwnerRequests = 0;
  let dataOwnerCloses = 0;
  const ownerInstanceId = randomUUID();
  const sessionId = randomUUID();
  const nativeCalls: Array<Record<string, unknown>> = [];
  const ipcCalls: Array<Record<string, unknown>> = [];

  const runtimeInvoke = async <T = unknown>(command: string, args: Record<string, unknown> = {}): Promise<T> => {
    nodeCalls.push({ command, args });
    if (command === "prepare_legacy_node") {
      dataOwnerRequests++;
      if (args.pluginId !== "pasteboard-pro" || typeof args.instanceId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(args.instanceId)) {
        throw new Error("fixture Node owner requires a canonical UUID and Paste plugin id");
      }
      if (args.instanceId !== ownerInstanceId) throw new Error("fixture Node owner UUID changed during preload preparation");
      return { sessionId } as T;
    }
    if (command === "get_legacy_node_session") {
      if (!worker || args.sessionId !== sessionId) throw new Error("Fixture Node session id is not owned by this Paste fixture");
      return { endpoint: worker.endpoints.node } as T;
    }
    if (command === "close_legacy_node") {
      dataOwnerCloses++;
      if (args.pluginId !== "pasteboard-pro" || args.instanceId !== ownerInstanceId) {
        throw new Error("Fixture Node close does not match its Paste owner UUID");
      }
      if (!worker) throw new Error("Fixture Node owner lost its managed Worker before close");
      await worker.request("stopNode");
      return undefined as T;
    }
    throw new Error(`Unexpected production runtime command: ${command}`);
  };

  try {
    await makeDirectory(scratchRoot, { recursive: true });
    await makeDirectory(pluginDataRoot, { recursive: true });
    const pluginDataRealRoot = await realpath(pluginDataRoot);
    if (scenario === "files") {
      const fixtureFilesRoot = resolve(pluginDataRealRoot, "queue-fixtures");
      await makeDirectory(fixtureFilesRoot, { recursive: true });
      fixtureFilePaths = ["first file.txt", "二.txt"].map(name => resolve(fixtureFilesRoot, name));
      await Promise.all(fixtureFilePaths.map((path, index) => writeFile(path, `Paste queue fixture file ${index + 1}\n`, { flag: "wx" })));
    }
    packageCopy = await createReadOnlyBuiltPackage(pluginsRoot, scratchRoot);
    worker = await createPasteStartupWorker({
      root: process.cwd(), scratchRoot, pluginRoot: packageCopy.pluginRoot, preloadPath: packageCopy.preloadPath,
      pluginDataRoot: pluginDataRealRoot, fixtureEnv: isolation.env, scenario, filePaths: fixtureFilePaths,
    });
    expect(worker.initialization).toMatchObject({ protocolVersion: 1, nodeVersion: "22.23.3" });
    expect(packageCopy.builtHashes["preload.js"]).toBe("cf394cb02fcf7879f1e3a2410ff5253791275d199c213d6d785055454a3722ba");
    expect(packageCopy.builtHashes["chunks/history-search-index-C5CG7yxr.cjs"]).toBe("83593ecc7176e00c98f80f251785c28b9bdffe92929924a914581ff5af7927c3");

    runtime = createPluginRuntimePreload(runtimeInvoke, "pasteboard-pro", () => true, undefined, ownerInstanceId);
    const graphReads: string[] = [];
    const preload = await runtime.prepare({
      pluginDir: packageCopy.pluginRoot,
      preloadPath: packageCopy.preloadPath,
      isCurrent: () => true,
      readTextFile: async modulePath => {
        const actual = resolve(modulePath);
        if (actual !== packageCopy.pluginRoot && !actual.startsWith(`${packageCopy.pluginRoot}${sep}`)) {
          throw new Error(`Production preload compiler escaped copied build: ${actual}`);
        }
        graphReads.push(actual);
        return readFile(actual, "utf8");
      },
      // This is a fixture port replacing the user TaskRun approval, not evidence of a real grant.
      onSafeStorageRequired: async () => { safeStoragePermissionPortCalls++; },
    });

    frame = createPasteStartupFrame({
      pluginRoot: packageCopy.pluginRoot, indexHtml: packageCopy.indexHtml, preloadScript: preload,
      endpoints: worker.endpoints, pluginDataPath: pluginDataRealRoot, nativeCalls, ipcCalls,
    });
    expect(frame.executed).toContain("electron-adapter");
    expect(frame.executed).toContain("node-modules");
    expect(frame.executed).toContain("original-preload");
    expect(frame.executed.indexOf("electron-adapter")).toBeLessThan(frame.executed.indexOf("node-modules"));
    expect(frame.executed.indexOf("node-modules")).toBeLessThan(frame.executed.indexOf("original-preload"));
    expect(frame.window.pasteboardPro).toBeDefined();
    expect(frame.window.pasteboardPro.getHostCompatibility()).toMatchObject({ supported: true });

    const initialObservation = await waitFor(
      async () => {
        const [doc, stats] = await Promise.all([
          worker.request<any>("getDoc", "pasteboard-pro:paste-stack"), worker.request<any>("stats"),
        ]);
        return { doc, stats, consoleErrors: frame!.consoleErrors, businessErrors: frame!.businessErrors, pasteStackEvents: frame!.pasteStackEvents };
      },
      value => value.doc?._rev !== "1-sqlite-fixture" && value.doc?.state?.itemIds?.length === 1
        && value.doc.state.itemIds[0] === (scenario === "files" ? "files-item" : "text-old"),
      "Original Paste queue initialization did not prune the missing canonical item and persist the valid text item",
      5_000,
    );
    const initialStack = initialObservation.doc;
    expect(initialStack).toMatchObject({
      type: "pasteboard-pro-paste-stack",
      state: { direction: "forward", itemIds: [scenario === "files" ? "files-item" : "text-old"] },
    });
    expect(initialObservation.stats.dataTrace).toContainEqual(expect.objectContaining({
      method: "db.put", id: "pasteboard-pro:paste-stack",
    }));
    expect(initialObservation.businessErrors).toEqual([]);
    expect(initialObservation.consoleErrors).toEqual([]);
    await expect(frame.window.pasteboardPro.getPasteStack()).resolves.toMatchObject({
      direction: "forward", itemIds: [scenario === "files" ? "files-item" : "text-old"],
    });

    const persistedAfterReopen = await worker.request<any>("reopen", "pasteboard-pro:paste-stack");
    expect(persistedAfterReopen).toMatchObject({
      _rev: initialStack._rev,
      state: { direction: "forward", itemIds: [scenario === "files" ? "files-item" : "text-old"] },
    });
    await waitFor(
      () => worker.request<any>("stats"),
      stats => stats.allowedMonitorSpawns === 1,
      "Paste did not start its precise fixture-only keyboard monitor port",
    );

    // The monitor receives a test pipe event only; no Python helper, Accessibility API or OS input hook runs.
    await worker.request("controlPaste", 1);
    const textResult = "Invoice #1042 is due on July 31 for USD 480.00.";
    const expectedFileWrite = { kind: "files", paths: fixtureFilePaths };
    const consumedStack = await waitFor(
      async () => {
        const [stats, doc] = await Promise.all([
          worker.request<any>("stats"), worker.request<any>("getDoc", "pasteboard-pro:paste-stack"),
        ]);
        return { stats, doc };
      },
      value => (scenario === "files"
        ? value.stats.typedClipboardWrites.length === 1
          && JSON.stringify(value.stats.typedClipboardWrites[0]) === JSON.stringify(expectedFileWrite)
        : value.stats.clipboardWrites.includes(textResult)) && value.doc?.state?.itemIds?.length === 0,
      `Original Paste queue did not prepare and consume its canonical ${scenario} item through the controlled host clipboard port`,
    );
    expect(consumedStack.stats.clipboardWrites).toEqual(scenario === "text" ? [textResult] : []);
    expect(consumedStack.stats.typedClipboardWrites).toEqual(scenario === "files" ? [expectedFileWrite] : []);
    if (scenario === "files") {
      expect(consumedStack.stats.methods["host.content_write"]).toBe(1);
      expect(consumedStack.stats.fileMetadata).toEqual(fixtureFilePaths.map((path, index) => ({
        path, isFile: true, size: Buffer.byteLength(`Paste queue fixture file ${index + 1}\n`),
      })));
      expect(JSON.stringify(consumedStack.stats.typedClipboardWrites)).not.toMatch(/base64/iu);
      expect(consumedStack.stats.fileMetadata.every((file: { path: string }) => resolve(file.path).startsWith(`${pluginDataRealRoot}${sep}`))).toBe(true);
    }
    expect(consumedStack.doc.state.itemIds).toEqual([]);
    expect(consumedStack.stats.allowedMonitorSpawns).toBe(1);
    expect(consumedStack.stats.deniedOsCommands).toBe(0);
    expect(consumedStack.stats.secretStorageCalls).toBe(0);
    expect(consumedStack.stats.rejectedRoutes).toBe(0);
    expect(consumedStack.stats.nodeVersion).toBe("22.23.3");
    expect(consumedStack.stats.nodeModules).toEqual(expect.arrayContaining(["process", "buffer", "node:child_process", "node:fs/promises"]));
    expect(consumedStack.stats.methods["node.require"]).toBeGreaterThan(0);
    expect(consumedStack.stats.requests).toBeGreaterThan(0);
    expect(consumedStack.stats.nodeRuntimeMs).toBeGreaterThan(0);
    expect(consumedStack.stats.historyReads).toBeGreaterThan(0);
    await waitFor(
      async () => nativeCalls.filter(call => call.method === "simulateKeyboardTap"),
      calls => calls.length === 1,
      "Paste monitor did not request its controlled keyboard simulation port",
      2_000,
    );
    expect(frame.featureEntries).toBe(0);
    expect(frame.businessErrors).toEqual([]);
    expect(ipcCalls).toEqual([]);
    expect(nativeCalls.filter(call => call.method === "createBrowserWindow")).toHaveLength(0);
    expect(nativeCalls.map(call => call.method)).toEqual(["simulateKeyboardTap"]);
    expect(dataOwnerRequests).toBe(1);
    expect(safeStoragePermissionPortCalls).toBe(1);
    expect(graphReads).toEqual([
      packageCopy.preloadPath,
      resolve(packageCopy.pluginRoot, "chunks/history-search-index-C5CG7yxr.cjs"),
      resolve(packageCopy.pluginRoot, "chunks/clipboard-tombstone-v2-28uC8Qy5.cjs"),
      resolve(packageCopy.pluginRoot, "chunks/index-Cy80EH4d.cjs"),
    ]);
    expect(nodeCalls.map(call => call.command)).toEqual(["prepare_legacy_node", "get_legacy_node_session"]);
    expect(nodeCalls[0]?.args).toEqual({ pluginId: "pasteboard-pro", instanceId: ownerInstanceId });
    expect(nodeCalls[1]?.args).toEqual({ sessionId });

    // Keep the diagnostic small and explicitly separate it from app performance claims.
    console.info("[paste startup fixture diagnostics]", JSON.stringify({
      nodeRpcCount: consumedStack.stats.requests,
      nodeModuleCount: consumedStack.stats.nodeModules.length,
      nodeStartupMs: consumedStack.stats.nodeStartupMs,
      nodeRuntimeMs: consumedStack.stats.nodeRuntimeMs,
      dataMethods: Object.fromEntries(Object.entries(consumedStack.stats.methods).filter(([name]) => name.startsWith("data."))),
      allowedMonitorSpawns: consumedStack.stats.allowedMonitorSpawns,
      deniedOsCommands: consumedStack.stats.deniedOsCommands,
      fixtureOnly: true,
    }));
  } finally {
    frame?.dispose();
    try { await runtime?.closeStrict(); }
    finally {
      try {
        if (worker) {
          const cleanup = await worker.close();
          expect(cleanup.workerExit.code).toBe(0);
          const result = cleanup.result as { childExit?: { code?: number | null; signal?: string | null; error?: string }; listenerClosed?: boolean; databaseClosed?: boolean };
          expect(result).toMatchObject({ listenerClosed: true, databaseClosed: true });
          expect(result.childExit).toBeDefined();
          expect(result.childExit?.error).toBeUndefined();
          expect(result.childExit?.code !== null || Boolean(result.childExit?.signal)).toBe(true);
        }
      } finally {
        if (packageCopy) {
          await chmod(resolve(packageCopy.pluginRoot, "chunks"), 0o700).catch(() => {});
          await chmod(packageCopy.pluginRoot, 0o700).catch(() => {});
        }
        await rm(scratchRoot, { recursive: true, force: true });
        await isolation.cleanup();
        if (packageCopy) await sourceDigestsUnchanged(packageCopy.sourceDigests);
        if (runtime !== undefined) expect(dataOwnerCloses).toBe(1);
      }
    }
  }
}

it.skipIf(!enabled)("runs Harris Paste 1.3.1 original built preload and durably initializes its text queue", async () => {
  await runOriginalStartupScenario("text");
}, 30_000);

it.skipIf(!enabled)("runs Harris Paste 1.3.1 original built preload and consumes its durable files queue", async () => {
  await runOriginalStartupScenario("files");
}, 30_000);
