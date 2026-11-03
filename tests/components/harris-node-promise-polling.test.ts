// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { preparePluginPreload } from "../../src/lib/pluginPreload";
import {
  createProductionLegacyNodeDispatch,
  createProductionPreloadFrame,
  type RecordedNodeRequest,
} from "./helpers/harrisNodePromisePollingFixture";

const sourceRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const reportPath = process.env.ATOOLS_NODE_POLL_REPORT
  ? resolve(process.env.ATOOLS_NODE_POLL_REPORT)
  : undefined;

type MethodTraffic = {
  requests: number;
  requestJsonBytes: number;
  responseJsonBytes: number;
};

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function summarize(requests: RecordedNodeRequest[]) {
  const byTransport = {
    requestSync: { requests: 0, requestJsonBytes: 0, responseJsonBytes: 0, byMethod: {} as Record<string, MethodTraffic> },
    requestAsync: { requests: 0, requestJsonBytes: 0, responseJsonBytes: 0, byMethod: {} as Record<string, MethodTraffic> },
  };
  for (const request of requests) {
    const transport = byTransport[request.transport];
    transport.requests++;
    transport.requestJsonBytes += request.requestJsonBytes;
    transport.responseJsonBytes += request.responseJsonBytes;
    const method = transport.byMethod[request.method] ??= {
      requests: 0,
      requestJsonBytes: 0,
      responseJsonBytes: 0,
    };
    method.requests++;
    method.requestJsonBytes += request.requestJsonBytes;
    method.responseJsonBytes += request.responseJsonBytes;
  }
  const promisePollRequests = requests.filter((request) => request.method === "pollPromise" || request.method === "pollPromises");
  const promisePollRounds = new Map<number, {
    requests: number;
    batchRequests: number;
    singleRequests: number;
    handleQueries: number;
    requestJsonBytes: number;
    responseJsonBytes: number;
  }>();
  for (const request of promisePollRequests) {
    if (request.promisePollRound === undefined) continue;
    const round = promisePollRounds.get(request.promisePollRound) ?? {
      requests: 0,
      batchRequests: 0,
      singleRequests: 0,
      handleQueries: 0,
      requestJsonBytes: 0,
      responseJsonBytes: 0,
    };
    round.requests++;
    if (request.method === "pollPromises") round.batchRequests++;
    else round.singleRequests++;
    round.handleQueries += request.promiseHandleCount ?? 0;
    round.requestJsonBytes += request.requestJsonBytes;
    round.responseJsonBytes += request.responseJsonBytes;
    promisePollRounds.set(request.promisePollRound, round);
  }
  const batchRequests = promisePollRequests.filter((request) => request.method === "pollPromises");
  const singleRequests = promisePollRequests.filter((request) => request.method === "pollPromise");
  return {
    requests: requests.length,
    requestJsonBytes: requests.reduce((total, request) => total + request.requestJsonBytes, 0),
    responseJsonBytes: requests.reduce((total, request) => total + request.responseJsonBytes, 0),
    byTransport,
    promisePolling: {
      requests: promisePollRequests.length,
      handleQueries: promisePollRequests.reduce((total, request) => total + (request.promiseHandleCount ?? 0), 0),
      batchRequests: batchRequests.length,
      singleRequests: singleRequests.length,
      requestJsonBytes: promisePollRequests.reduce((total, request) => total + request.requestJsonBytes, 0),
      responseJsonBytes: promisePollRequests.reduce((total, request) => total + request.responseJsonBytes, 0),
      rounds: [...promisePollRounds.entries()]
        .sort(([left], [right]) => left - right)
        .map(([round, traffic]) => ({ round, ...traffic })),
    },
  };
}

const documents = [
  { name: "one.md", before: "# Draft One\nBefore body one.\n", saved: "# Saved One\n小文本 ✓ one.\n", recovered: "# Recovered One\nRecovery body one.\n" },
  { name: "two.md", before: "# Draft Two\nBefore body two.\n", saved: "# Saved Two\nSmall text two.\n", recovered: "# Recovered Two\nRecovery body two.\n" },
  { name: "three.md", before: "# Draft Three\nBefore body three.\n", saved: "# Saved Three\nSmall text three.\n", recovered: "# Recovered Three\nRecovery body three.\n" },
  { name: "four.md", before: "# Draft Four\nBefore body four.\n", saved: "# Saved Four\nSmall text four.\n", recovered: "# Recovered Four\nRecovery body four.\n" },
] as const;

it.skipIf(!sourceRoot)("measures original Live Markdown async document saves through the production Node bridge", async () => {
  expect(sourceRoot, "ATOOLS_HARRIS_PLUGIN_SOURCE must point to the original plugins directory").toBeTruthy();
  const pluginRoot = resolve(sourceRoot!, "live-markdown");
  const preloadDir = join(pluginRoot, "preload");
  const pluginEntry = join(preloadDir, "async-document-writer.cjs");
  const manifestPath = join(pluginRoot, "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string };
  expect(manifest.version).toBe("0.1.0");

  const originalInputs = [manifestPath, pluginEntry];
  const hashesBefore = Object.fromEntries(originalInputs.map((path) => [
    path.slice(pluginRoot.length + 1), sha256(readFileSync(path)),
  ]));
  const scratch = await mkdtemp(join(tmpdir(), "atools-harris-node-polling-"));
  const pageDir = join(scratch, "documents");
  await mkdir(pageDir);
  await Promise.all(documents.map(({ name, before }) => writeFile(join(pageDir, name), before, "utf8")));

  const sidecar = createProductionLegacyNodeDispatch(pluginEntry);
  const productionSourcePaths = [
    resolve("src/lib/pluginPreload.ts"),
    resolve("src/lib/nodeModuleBridge.ts"),
    resolve("src/lib/nodeModuleTransport.ts"),
    ...sidecar.sourceFiles,
  ];
  const productionSourceHashes = Object.fromEntries(productionSourcePaths.map((path) => [
    path.slice(resolve().length + 1), sha256(readFileSync(path)),
  ]));
  let frame: ReturnType<typeof createProductionPreloadFrame> | undefined;
  try {
    const html = await preparePluginPreload({
      pluginDir: preloadDir,
      preloadPath: pluginEntry,
      maxDurationMs: 5000,
      readTextFile: (path) => readFile(path, "utf8"),
    });
    frame = createProductionPreloadFrame(html, sidecar.dispatch, pluginEntry);
    const fs = frame.sandbox.require("node:fs");
    const path = frame.sandbox.require("node:path");
    const writer = frame.sandbox.services.createAsyncDocumentWriter(fs, path);
    const setupEnd = frame.requests.length;

    const mainStart = frame.requests.length;
    const savedResults = await Promise.all(documents.map(({ name, before, saved }) =>
      writer.writeDocumentAsync(join(pageDir, name), saved, { expectedContent: before })));
    const mainEnd = frame.requests.length;
    const mainTraffic = summarize(frame.requests.slice(mainStart, mainEnd));
    if (process.env.ATOOLS_NODE_POLL_EXPECT_REDUCED === "1") {
      expect(mainTraffic.promisePolling.requests).toBe(9);
      expect(mainTraffic.promisePolling.batchRequests).toBe(9);
      expect(mainTraffic.promisePolling.singleRequests).toBe(0);
      expect(mainTraffic.promisePolling.handleQueries).toBe(36);
    }
    for (let index = 0; index < documents.length; index++) {
      const document = documents[index];
      const result = savedResults[index];
      expect(result.path).toBe(join(pageDir, document.name));
      expect(result.content).toBe(document.saved);
      expect(result.size).toBe(Buffer.byteLength(document.saved));
      expect(await readFile(join(pageDir, document.name), "utf8")).toBe(document.saved);
    }

    const conflictStart = frame.requests.length;
    let conflict: { code?: string; message?: string } | undefined;
    try {
      await writer.writeDocumentAsync(join(pageDir, documents[0].name), "# Must Not Replace\n", {
        expectedContent: "stale external version\n",
      });
    } catch (error) {
      const caught = error as Error & { code?: string };
      conflict = { code: caught.code, message: caught.message };
    }
    const conflictEnd = frame.requests.length;
    expect(conflict?.code).toBe("DOCUMENT_CONFLICT");
    expect(await readFile(join(pageDir, documents[0].name), "utf8")).toBe(documents[0].saved);

    const recoveryStart = frame.requests.length;
    const recovered = await writer.writeDocumentAsync(
      join(pageDir, documents[0].name),
      documents[0].recovered,
      { expectedContent: documents[0].saved },
    );
    const recoveryEnd = frame.requests.length;
    expect(recovered.content).toBe(documents[0].recovered);
    expect(await readFile(join(pageDir, documents[0].name), "utf8")).toBe(documents[0].recovered);

    const closeIndex = frame.requests.length;
    frame.close();
    await new Promise((done) => setTimeout(done, 150));
    const afterClose = frame.requests.slice(closeIndex);
    expect(afterClose.filter((request) => ["poll", "pollPromise", "pollPromises"].includes(request.method))).toEqual([]);

    const hashesAfter = Object.fromEntries(originalInputs.map((path) => [
      path.slice(pluginRoot.length + 1), sha256(readFileSync(path)),
    ]));
    expect(hashesAfter).toEqual(hashesBefore);

    const allRequests = frame.requests;
    const report = {
      schemaVersion: 1,
      task: "Live Markdown 0.1.0 original async-document-writer Node Promise polling measurement",
      measurementLabel: process.env.ATOOLS_NODE_POLL_LABEL ?? (reportPath ? basename(reportPath) : "verification-only"),
      measuredAt: new Date().toISOString(),
      runtime: {
        nodeVersion: process.versions.node,
        fixedNodeBinary: "./src-tauri/binaries/node-aarch64-apple-darwin",
        sidecarProcessSpawned: false,
        guiStarted: false,
        engineStarted: false,
      },
      workload: {
        pluginVersion: manifest.version,
        originalFunction: "createAsyncDocumentWriter(...).writeDocumentAsync",
        parallelIndependentFiles: documents.length,
        fixedInputs: documents.map(({ name, before, saved }) => ({
          name,
          initialUtf8Bytes: Buffer.byteLength(before),
          savedUtf8Bytes: Buffer.byteLength(saved),
          initialSha256: sha256(before),
          savedSha256: sha256(saved),
        })),
        actualFilesystemIo: "Host Node fs operated on four real files under a unique temporary directory.",
      },
      originalPackageInputs: {
        hashScope: "plugin.json and the exact original preload/async-document-writer.cjs used by preparePluginPreload; this is not a full 5.6 GiB package-tree hash.",
        before: hashesBefore,
        after: hashesAfter,
        unchanged: JSON.stringify(hashesBefore) === JSON.stringify(hashesAfter),
      },
      productionContract: {
        preload: "preparePluginPreload executed the unchanged original preload/async-document-writer.cjs source in the VM frame.",
        bridge: "nodeModuleBridgeScript serialized the production bridge and production nodeModuleTransport implementation.",
        legacyNode: "The production codec.cjs, bounded_png_path.cjs, bounded_native_image_path.cjs, and bootstrap.cjs sources were concatenated and dispatch(method, params) executed in this Node runner process.",
        httpMode: "In-process requestSync/requestAsync HTTP contract adapter; no listening HTTP server.",
        filesystemMode: "The adapter returns handled:false for native text shortcuts, then production legacy dispatch invokes real Node fs against temporary files.",
        productionSourceSha256: productionSourceHashes,
      },
      transportLimitations: {
        httpBehavior: "In-process HTTP request/response contract adapter; each production transport call still passes serialized JSON through XMLHttpRequest/fetch adapters.",
        measured: "Exact UTF-8 JSON request and response body bytes and request counts by transport and method.",
        notMeasured: ["real loopback HTTP latency", "Tauri or native IPC latency", "sidecar process startup or scheduling", "GUI or editor latency"],
        byteComparison: "Report bytes are exact for this run. Temporary directory text and generated temp names can change byte totals across runs; compare request counts first and pollPromise bytes separately.",
      },
      phases: {
        preloadAndRequireSetup: summarize(allRequests.slice(0, setupEnd)),
        mainFourFileConcurrentSave: {
          ...mainTraffic,
          successfulFiles: documents.length,
          interpretation: "Only this phase is the before/after baseline workload.",
        },
        conflictAttempt: {
          ...summarize(allRequests.slice(conflictStart, conflictEnd)),
          recoveredErrorCode: conflict?.code,
          unchangedDocumentPreserved: true,
        },
        recoverySave: {
          ...summarize(allRequests.slice(recoveryStart, recoveryEnd)),
          recovered: true,
        },
        fullRunBeforeClose: summarize(allRequests.slice(0, closeIndex)),
        afterClose: {
          ...summarize(afterClose),
          quietWindowMs: 150,
          pollRequests: afterClose.filter((request) => ["poll", "pollPromise", "pollPromises"].includes(request.method)).length,
        },
      },
      dispatchSources: sidecar.sourceFiles.map((path) => path.slice(resolve("crates/atools-plugin/src/legacy_node").length + 1)),
    };
    if (reportPath) {
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  } finally {
    frame?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
