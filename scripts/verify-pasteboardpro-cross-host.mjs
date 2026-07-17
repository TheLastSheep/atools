import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createPasteboardProWebDavFixtureServer } from "./pasteboardpro-webdav-fixture-server.mjs";

const execFileAsync = promisify(execFile);
const atoolsRoot = path.resolve(new URL("../", import.meta.url).pathname);
const ztoolsRoot = path.resolve(
  process.env.PASTEBOARDPRO_ZTOOLS_ROOT ??
    path.join(atoolsRoot, "../ztools-pasteboardpro/plugins/pasteboard-pro"),
);
const reportPath = path.join(atoolsRoot, "artifacts/pasteboardpro/cross-host-sync.json");
const nativeEnabled = process.env.ATOOLS_PASTEBOARDPRO_NATIVE === "1";
const nodeLoadOnly = process.env.ATOOLS_PASTEBOARDPRO_NODE_LOAD_ONLY === "1";

if (nodeLoadOnly) {
  await assertWorkspace(ztoolsRoot);
  const modules = await loadZToolsModules(ztoolsRoot);
  try {
    assert.equal(typeof modules.sync.createWebDavVaultClient, "function");
    assert.equal(typeof modules.runtime.syncZToolsVault, "function");
    assert.equal(typeof modules.crypto.deriveVaultKey, "function");
    assert.equal(typeof modules.vault.parseVaultMetadata, "function");
    console.log("PasteboardPro ZTools sync runtime modules loaded through Vite SSR");
  } finally {
    await modules.vite.close();
  }
  process.exit(0);
}

if (!nativeEnabled) {
  throw new Error(
    "Cross-host verification compiles the Rust fixture example. Re-run with ATOOLS_PASTEBOARDPRO_NATIVE=1 in remote/native CI.",
  );
}

await assertWorkspace(ztoolsRoot);
const temporaryRoot = await mkdtemp(path.join(tmpdir(), "pasteboardpro-cross-host-"));
const fixture = await createPasteboardProWebDavFixtureServer();
let vite;

try {
  const modules = await loadZToolsModules(ztoolsRoot);
  vite = modules.vite;
  const configPath = path.join(temporaryRoot, "rust-fixture.json");
  const config = {
    serverUrl: fixture.url,
    username: fixture.username,
    password: fixture.password,
    syncPassword: "cross-host-sync-password-2026",
    dbPath: path.join(temporaryRoot, "rust.sqlite"),
    blobRoot: path.join(temporaryRoot, "rust-blobs"),
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  const phases = {};
  phases.rustSeed = await runRust("seed-sync", configPath);
  assert.equal(phases.rustSeed.status, "success");

  const client = createFixtureClient(modules.sync, fixture);
  const metadataFile = await client.readFile("vault.json");
  assert.ok(metadataFile, "Rust must create vault.json before Node joins");
  const metadata = modules.vault.parseVaultMetadata(
    JSON.parse(new TextDecoder().decode(metadataFile.body)),
  );
  const key = await modules.crypto.deriveVaultKey(
    config.syncPassword,
    modules.vault.base64ToBytes(metadata.kdf.salt),
  );
  const repository = new MemoryRepository();

  phases.nodeInitialPull = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.nodeInitialPull.state, "success");
  assert.equal(repository.item("fixture-item")?.title, "Original secret title");
  assert.equal(repository.pinboard("fixture-board")?.name, "Fixture Inbox");

  await runRust("mutate-title", configPath);
  repository.mutatePinboardAssignment();
  phases.rustConcurrentPush = await runRust("sync", configPath);
  assert.equal(phases.rustConcurrentPush.status, "success");
  phases.nodeConcurrentMerge = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.nodeConcurrentMerge.state, "success");
  phases.rustConcurrentPull = await runRust("sync", configPath);
  assert.equal(phases.rustConcurrentPull.status, "success");
  const mergedRust = await runRust("inspect", configPath);
  const mergedItem = mergedRust.items.find((item) => item.id === "fixture-item");
  assert.equal(mergedItem?.title, "Rust concurrent title");
  assert.equal(mergedItem?.pinboardId, "fixture-board");
  assert.equal(mergedItem?.pinboardOrderKey, "b0");
  assert.equal(repository.item("fixture-item")?.title, "Rust concurrent title");

  fixture.injectResponse({ method: "PUT", path: "index.enc", status: 412 });
  phases.nodeEtagRetry = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.nodeEtagRetry.state, "success");
  assert.equal(phases.nodeEtagRetry.retries, 1);

  fixture.injectResponse({ method: "GET", path: "index.enc", status: 500 });
  phases.serverFailure = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.serverFailure.state, "partial");
  phases.serverRecovery = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.serverRecovery.state, "success");

  const corruptTarget = (await fixture.snapshot()).find((entry) => entry.path.startsWith("objects/"));
  assert.ok(corruptTarget, "Encrypted fixture must contain at least one object");
  const corruptPath = path.join(fixture.root, ...corruptTarget.path.split("/"));
  const originalCiphertext = await readFile(corruptPath);
  await fixture.corrupt(corruptTarget.path);
  phases.corrupted = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.corrupted.state, "corrupted");
  await writeFile(corruptPath, originalCiphertext);
  phases.corruptionRecovery = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.corruptionRecovery.state, "success");

  const authClient = createFixtureClient(modules.sync, fixture, {
    username: fixture.username,
    password: "wrong-fixture-password",
  });
  phases.authRequired = await modules.runtime.syncZToolsVault({
    client: authClient,
    key,
    repository,
  });
  assert.equal(phases.authRequired.state, "auth_required");

  const offlineClient = createFixtureClient(modules.sync, fixture, undefined, async () => {
    throw new TypeError("fixture offline");
  });
  phases.offline = await modules.runtime.syncZToolsVault({
    client: offlineClient,
    key,
    repository,
  });
  assert.equal(phases.offline.state, "offline");

  repository.addInterruptedUploadItem();
  fixture.interruptUpload({ path: "*" });
  phases.interruptedUpload = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.interruptedUpload.state, "offline");
  assert.ok(phases.interruptedUpload.pendingObjects > 0);
  phases.interruptedUploadRecovery = await modules.runtime.syncZToolsVault({
    client,
    key,
    repository,
  });
  assert.equal(phases.interruptedUploadRecovery.state, "success");
  assert.equal(phases.interruptedUploadRecovery.pendingObjects, 0);

  await runRust("delete-item", configPath);
  phases.rustDeletePush = await runRust("sync", configPath);
  assert.equal(phases.rustDeletePush.status, "success");
  phases.nodeTombstonePull = await modules.runtime.syncZToolsVault({ client, key, repository });
  assert.equal(phases.nodeTombstonePull.state, "success");
  assert.equal(repository.item("fixture-item"), undefined);
  assert.ok(repository.tombstone("paste_item", "fixture-item"));
  phases.rustTombstoneConfirm = await runRust("sync", configPath);
  assert.equal(phases.rustTombstoneConfirm.status, "success");
  const deletedRust = await runRust("inspect", configPath);
  assert.equal(deletedRust.items.some((item) => item.id === "fixture-item"), false);
  assert.ok(deletedRust.tombstones.some((entry) => entry.id === "fixture-item"));

  const leakNeedles = [
    "Original secret title",
    "TOP SECRET cross host body",
    "CONFIDENTIAL OCR invoice 424242",
    "Confidential Plan.txt",
    "Rust concurrent title",
    "Node interrupted upload secret",
    config.syncPassword,
    fixture.username,
    fixture.password,
  ];
  const plaintextLeaks = await scanPlaintextLeaks(fixture.root, leakNeedles);
  assert.deepEqual(plaintextLeaks, []);

  const snapshot = await fixture.snapshot();
  const report = {
    schemaVersion: 1,
    fixtureVersion: "pasteboardpro-cross-host-v1",
    generatedAt: new Date().toISOString(),
    pass: true,
    hosts: {
      rust: "ATools sync_pasteboard_vault",
      node: "ZTools syncZToolsVault",
    },
    phases,
    objectCounts: {
      remoteFiles: snapshot.length,
      encryptedObjects: snapshot.filter((entry) => entry.path.startsWith("objects/")).length,
      rustItemsAfterDelete: deletedRust.items.length,
      rustTombstonesAfterDelete: deletedRust.tombstones.length,
      nodeEntitiesAfterDelete: repository.entities.length,
    },
    retries: {
      etag412: phases.nodeEtagRetry.retries,
      fixtureConditionalConflicts: fixture.counters.conditionalConflicts,
    },
    faults: {
      injectedResponses: fixture.counters.injectedResponses,
      interruptedUploads: fixture.counters.interruptedUploads,
      corruptedFiles: fixture.counters.corruptedFiles,
      authRequired: phases.authRequired.state,
      offline: phases.offline.state,
      corrupted: phases.corrupted.state,
    },
    plaintextLeaks,
    requests: {
      total: fixture.requests.length,
      byStatus: Object.fromEntries(
        [...new Set(fixture.requests.map((request) => request.status))]
          .sort((left, right) => left - right)
          .map((status) => [status, fixture.requests.filter((request) => request.status === status).length]),
      ),
    },
    remoteSnapshot: snapshot,
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("PasteboardPro Rust ↔ Node cross-host sync verified");
  console.log(`Report: ${reportPath}`);
} finally {
  await vite?.close();
  await fixture.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}

class MemoryRepository {
  entities = [];
  blobs = new Map();

  async listEntities() {
    return structuredClone(this.entities);
  }

  async applyEntities(entities) {
    this.entities = structuredClone(entities);
  }

  async readBlob(blobId) {
    return structuredClone(this.blobs.get(blobId));
  }

  async writeBlob(blob) {
    this.blobs.set(blob.id, structuredClone(blob));
  }

  item(id) {
    return this.entities.find((entity) => entity.id === id && "kind" in entity);
  }

  pinboard(id) {
    return this.entities.find(
      (entity) => entity.id === id && !("kind" in entity) && !("deleted" in entity),
    );
  }

  tombstone(entityType, id) {
    return this.entities.find(
      (entity) => entity.id === id && entity.entityType === entityType && entity.deleted === true,
    );
  }

  mutatePinboardAssignment() {
    const item = this.item("fixture-item");
    assert.ok(item, "Node must have the Rust fixture item before concurrent mutation");
    item.pinboardId = "fixture-board";
    item.pinboardOrderKey = "b0";
    item.pinned = true;
    item.updatedAt = "2026-07-17T00:02:00.000Z";
    const clock = { wallMs: 4_000, counter: 0, deviceId: "node-pinboard" };
    item.fieldClocks.pinboardId = clock;
    item.fieldClocks.pinboardOrderKey = clock;
    item.fieldClocks.pinned = clock;
  }

  addInterruptedUploadItem() {
    const source = this.entities.find((entity) => "kind" in entity);
    assert.ok(source, "A live item is required to create the interrupted upload fixture");
    const item = structuredClone(source);
    item.id = "node-interrupt-item";
    item.title = "Node interrupted upload secret";
    item.contentFingerprint = "node-interrupted-fingerprint";
    item.updatedAt = "2026-07-17T00:02:30.000Z";
    item.fieldClocks.title = { wallMs: 4_500, counter: 0, deviceId: "node-interrupt" };
    this.entities.push(item);
  }
}

function createFixtureClient(syncModule, fixture, credentials, transportOverride) {
  const queue = new syncModule.MemorySyncQueue();
  const selectedCredentials = credentials ?? {
    username: fixture.username,
    password: fixture.password,
  };
  const transport = transportOverride ?? (async (request) => {
    const requestedUrl = new URL(request.url);
    const marker = "/PasteboardPro/v1/";
    const markerIndex = requestedUrl.pathname.indexOf(marker);
    assert.notEqual(markerIndex, -1);
    const relative = requestedUrl.pathname.slice(markerIndex + marker.length);
    const response = await fetch(new URL(relative, fixture.url), {
      method: request.method,
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }),
      redirect: "manual",
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
    };
  });
  return syncModule.createWebDavVaultClient({
    baseUrl: "https://pasteboardpro-fixture.invalid/PasteboardPro/v1/",
    credentials: async () => selectedCredentials,
    transport,
    queue,
  });
}

async function loadZToolsModules(root) {
  const requireFromWorkspace = createRequire(path.join(root, "package.json"));
  let viteEntry;
  try {
    viteEntry = requireFromWorkspace.resolve("vite");
  } catch {
    viteEntry = path.join(root, "node_modules/.pnpm/node_modules/vite/dist/node/index.js");
  }
  const { createServer } = await import(pathToFileURL(viteEntry).href);
  const vite = await createServer({
    root,
    configFile: false,
    appType: "custom",
    logLevel: "error",
    server: { middlewareMode: true },
    ssr: { noExternal: true },
  });
  const [sync, runtime, crypto, vault] = await Promise.all([
    vite.ssrLoadModule("/apps/ztools/preload/sync.ts"),
    vite.ssrLoadModule("/apps/ztools/preload/sync-runtime.ts"),
    vite.ssrLoadModule("/packages/sync-protocol/src/node-crypto.ts"),
    vite.ssrLoadModule("/packages/sync-protocol/src/vault.ts"),
  ]);
  return { vite, sync, runtime, crypto, vault };
}

async function runRust(action, configPath) {
  const { stdout, stderr } = await execFileAsync(
    "cargo",
    [
      "run",
      "--quiet",
      "--manifest-path",
      path.join(atoolsRoot, "src-tauri/Cargo.toml"),
      "--example",
      "pasteboardpro_cross_host",
      "--",
      action,
      configPath,
    ],
    {
      cwd: atoolsRoot,
      env: { ...process.env, CARGO_TERM_COLOR: "never" },
      maxBuffer: 8 * 1_024 * 1_024,
    },
  );
  const line = stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith("PASTEBOARDPRO_FIXTURE_JSON="));
  if (line === undefined) {
    throw new Error(`Rust fixture did not emit JSON for ${action}: ${stderr || stdout}`);
  }
  return JSON.parse(line.slice("PASTEBOARDPRO_FIXTURE_JSON=".length));
}

async function scanPlaintextLeaks(root, needles) {
  const leaks = [];
  for (const file of await filesRecursively(root)) {
    const text = (await readFile(file.absolute)).toString("utf8");
    for (const needle of needles) {
      if (text.includes(needle)) leaks.push({ path: file.relative, needle });
    }
  }
  return leaks;
}

async function filesRecursively(root, relative = "") {
  const output = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...await filesRecursively(root, child));
    else output.push({ absolute: path.join(root, child), relative: child.split(path.sep).join("/") });
  }
  return output;
}

async function assertWorkspace(root) {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(packageJson.name, "pasteboard-pro-workspace");
}
