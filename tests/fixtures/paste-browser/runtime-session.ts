import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { createPluginRuntimePreload } from "../../../src/lib/pluginRuntimePreload";

type FixtureWorker = {
  endpoints: { node: string; data: string };
  initialization: { nodeVersion: string; pid: number; protocolVersion: number };
  worker: { threadId: number };
  request<T = unknown>(command: string, value?: unknown, timeoutMs?: number): Promise<T>;
};
type PackageCopy = { pluginRoot: string; preloadPath: string };
type Runtime = ReturnType<typeof createPluginRuntimePreload>;

const pluginId = "pasteboard-pro";
const fixtureOrigin = "https://pasteboard-pro.fixture.invalid";

/** One original-preload runtime owner bound to exactly one Task20 fixture Worker. */
export function createPasteRuntimeSession(worker: FixtureWorker, packageCopy: PackageCopy, ownerInstanceId = randomUUID()) {
  let sessionId = "";
  let preloadScript = "";
  let prepareAttempted = false;
  let nodeStopResult: unknown;
  let nodeOwnerCloses = 0;
  let safeStorageFixtureCalls = 0;
  let closePromise: Promise<Record<string, unknown>> | undefined;
  const graphReads: string[] = [];
  const commandNames: string[] = [];
  const invoke = async <T = unknown>(command: string, args: Record<string, unknown> = {}) => {
    commandNames.push(command);
    if (command === "prepare_legacy_node") {
      assert.equal(args.pluginId, pluginId);
      assert.equal(args.instanceId, ownerInstanceId);
      sessionId = randomUUID();
      return { sessionId } as T;
    }
    if (command === "get_legacy_node_session") {
      assert.equal(args.sessionId, sessionId);
      return { endpoint: worker.endpoints.node } as T;
    }
    if (command === "close_legacy_node") {
      assert.equal(args.pluginId, pluginId);
      assert.equal(args.instanceId, ownerInstanceId);
      nodeOwnerCloses++;
      nodeStopResult = await worker.request("stopNode");
      return nodeStopResult as T;
    }
    throw new Error(`Unexpected original preload command: ${command}`);
  };
  const runtime: Runtime = createPluginRuntimePreload(invoke, pluginId, () => true, undefined, ownerInstanceId);

  return {
    runtime,
    ownerInstanceId,
    get sessionId() { return sessionId; },
    get prepareAttempted() { return prepareAttempted; },
    get hasOwnerSession() { return sessionId.length > 0; },
    get nodeStopResult() { return nodeStopResult; },
    get nodeOwnerCloses() { return nodeOwnerCloses; },
    get safeStorageFixtureCalls() { return safeStorageFixtureCalls; },
    get commandNames() { return [...commandNames]; },

    async prepare() {
      if (prepareAttempted) throw new Error("Original Paste runtime session may only prepare once");
      prepareAttempted = true;
      preloadScript = await runtime.prepare({
        pluginDir: packageCopy.pluginRoot,
        preloadPath: packageCopy.preloadPath,
        isCurrent: () => true,
        readTextFile: async path => {
          const actual = resolve(path);
          if (actual !== packageCopy.pluginRoot && !actual.startsWith(`${packageCopy.pluginRoot}${sep}`)) {
            throw new Error(`Original preload graph escaped immutable package copy: ${actual}`);
          }
          graphReads.push(actual);
          return readFile(actual, "utf8");
        },
        // This is the bounded fixture grant used by the unchanged original preload.
        onSafeStorageRequired: async () => { safeStorageFixtureCalls++; },
      });
      assert.match(sessionId, /^[0-9a-f-]{36}$/u);
      assert.deepEqual(graphReads, [
        packageCopy.preloadPath,
        resolve(packageCopy.pluginRoot, "chunks/history-search-index-Bm2oYZYG.cjs"),
      ]);
      return preloadScript;
    },

    async closeStrict() {
      closePromise ??= (async () => {
        await runtime.closeStrict();
        assert.equal(nodeOwnerCloses, sessionId ? 1 : 0, "Each prepared owner session closes exactly once");
        return {
          sessionId,
          ownerInstanceId,
          nodeStopResult,
          nodeOwnerCloses,
          commands: [...commandNames],
        };
      })();
      return closePromise;
    },

    snapshot() {
      return {
        ownerInstanceId,
        sessionId,
        pid: worker.initialization.pid,
        nodeVersion: worker.initialization.nodeVersion,
        protocolVersion: worker.initialization.protocolVersion,
        workerThreadId: worker.worker.threadId,
        safeStorageFixtureCalls,
        graphReads: [...graphReads],
        prepared: preloadScript.length > 0,
      };
    },
  };
}

const seedDocuments = [
  {
    _id: "pasteboard-pro:record:sha256:text-old:v1",
    type: "pasteboard-pro-record",
    record: {
      item: {
        id: "text-old", kind: "text", title: "Accounts payable notes",
        sourceApp: { bundleId: "com.apple.TextEdit", name: "TextEdit" },
        sourceDeviceId: "device-mac-studio", copiedAt: "2026-07-10T08:15:00.000Z",
        updatedAt: "2026-07-10T08:20:00.000Z", contentFingerprint: "sha256:text-old:v1",
        payload: { revision: "revision:text-old:v1", text: "Invoice #1042 is due on July 31 for USD 480.00." },
        pinboardId: "board-work", pinboardOrderKey: "a0", pinned: true,
        fieldClocks: {
          title: { wallMs: 1783671300000, counter: 0, deviceId: "device-mac-studio" },
          payload: { wallMs: 1783671300000, counter: 1, deviceId: "device-mac-studio" },
          pinboardId: { wallMs: 1783671600000, counter: 0, deviceId: "device-mac-studio" },
          pinboardOrderKey: { wallMs: 1783671600000, counter: 1, deviceId: "device-mac-studio" },
          pinned: { wallMs: 1783671600000, counter: 2, deviceId: "device-mac-studio" },
        },
      },
      origin: { host: "ztools", hostItemId: "clipboard-fixture-1", hostType: "text" },
    },
    _rev: "1-sqlite-fixture",
  },
  {
    _id: "pasteboard-pro:record:sha256:files-item:v1",
    type: "pasteboard-pro-record",
    record: {
      item: {
        id: "files-item", kind: "files", title: "Quarterly report attachments",
        sourceApp: { bundleId: "com.apple.finder", name: "Finder" },
        sourceDeviceId: "device-mac-studio", copiedAt: "2026-07-13T11:45:00.000Z",
        updatedAt: "2026-07-13T11:50:00.000Z", contentFingerprint: "sha256:files-item:v1",
        payload: { revision: "revision:files-item:v1", filePaths: [] },
        pinboardId: "board-work", pinboardOrderKey: "a1", pinned: false,
        fieldClocks: {
          payload: { wallMs: 1783943100000, counter: 0, deviceId: "device-mac-studio" },
          pinboardId: { wallMs: 1783943400000, counter: 0, deviceId: "device-mac-studio" },
          pinboardOrderKey: { wallMs: 1783943400000, counter: 1, deviceId: "device-mac-studio" },
          pinned: { wallMs: 1783943400000, counter: 2, deviceId: "device-mac-studio" },
        },
      },
      origin: { host: "ztools", hostItemId: "clipboard-fixture-files-1", hostType: "file" },
    },
    _rev: "1-sqlite-fixture",
  },
  {
    _id: "pasteboard-pro:paste-stack",
    type: "pasteboard-pro-paste-stack",
    state: { direction: "forward", itemIds: ["text-old", "fixture-missing-record"] },
    _rev: "1-sqlite-fixture",
  },
] as const;

/** Moves only the exact three known seed rows between independent startup Workers sharing one SQLite file. */
export async function handoffPasteSeedToSecondSession(worker: FixtureWorker, databasePath: string) {
  const canonicalDatabasePath = await realpath(databasePath);
  const removedIds: string[] = [];
  for (const expected of seedDocuments) {
    const actual = await worker.request<any>("getDoc", expected._id);
    assert.deepEqual(actual, expected, `Refusing to remove non-canonical Paste seed ${expected._id}`);
    let response: Response;
    try {
      response = await fetch(worker.endpoints.data, {
        method: "POST",
        headers: { Origin: fixtureOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({ method: "db.remove", args: [actual] }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      throw new Error("Controlled primary PluginData seed handoff request failed");
    }
    if (!response.ok) throw new Error(`Controlled primary PluginData seed handoff returned HTTP ${response.status}`);
    const envelope = await response.json() as { ok?: boolean; result?: unknown };
    assert.equal(envelope.ok, true, "Primary PluginData seed handoff must succeed");
    assert.deepEqual(envelope.result, { ok: true, id: expected._id, rev: expected._rev });
    removedIds.push(expected._id);
  }
  return { databasePath: canonicalDatabasePath, removedIds };
}

/** Confirms both already-open Worker connections see the byte-equivalent canonical rows. */
export async function verifySharedPasteSeed(primary: FixtureWorker, shelf: FixtureWorker, databasePath: string) {
  const canonicalDatabasePath = await realpath(databasePath);
  const primaryRows: unknown[] = [];
  const shelfRows: unknown[] = [];
  for (const expected of seedDocuments) {
    const primaryValue = await primary.request("getDoc", expected._id);
    const shelfValue = await shelf.request("getDoc", expected._id);
    assert.deepEqual(primaryValue, expected, `Primary does not see canonical seed ${expected._id}`);
    assert.deepEqual(shelfValue, expected, `Shelf does not see canonical seed ${expected._id}`);
    assert.deepEqual(shelfValue, primaryValue, `Both renderers must read the same canonical row ${expected._id}`);
    primaryRows.push({ id: expected._id, type: expected.type });
    shelfRows.push({ id: expected._id, type: expected.type });
  }
  return { databasePath: canonicalDatabasePath, primaryRows, shelfRows };
}
