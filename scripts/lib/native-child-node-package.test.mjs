import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { createChildNodeFixturePackages, reviewedOriginalChildPreload, originalChildPreload, childNodeFixtureValues } from "./native-child-node-package.mjs";
import { pluginPanelNativeFixtureDefines } from "../probe-plugin-panel-native.mjs";

const root = resolve(new URL("../../", import.meta.url).pathname);
test("child-only package keeps generated parents Node-free and copies one complete original child byte-for-byte", async () => {
  const scratch = await mkdtemp("/private/tmp/atools-test-child-node-package-");
  const originalBefore = await readFile(join(root, originalChildPreload.source));
  try {
    const generated = await createChildNodeFixturePackages(root, scratch), packageRoot = join(generated.directory, "file-tree");
    const manifest = JSON.parse(await readFile(join(packageRoot, "plugin.json"), "utf8"));
    assert.equal(manifest.preload, "parent-preload.js"); assert.equal(manifest.version, "0.0.0-synthetic");
    assert.equal(manifest.syntheticFixture.originalPackage, false);
    assert.deepEqual(await readFile(join(packageRoot, "preload-app.js")), originalBefore);
    assert.equal(generated.originalChildPreload.copiedSha256, originalChildPreload.sha256);
    const calls = [], parent = {};
    vm.runInNewContext(await readFile(join(packageRoot, "parent-preload.js"), "utf8"), {
      window: parent, require: name => { calls.push(name); assert.equal(name, "electron"); return { ipcRenderer: { sendTo() {} } }; },
    });
    assert.deepEqual(calls, ["electron"]); assert.equal(parent.__AToolsChildParentPreload.executed, true);
    assert.equal(parent.__AToolsChildSentinel, undefined);
    assert.equal(JSON.parse(await readFile(join(generated.directory, "char-transform/plugin.json"), "utf8")).preload, undefined);
    assert.deepEqual(await readFile(join(root, originalChildPreload.source)), originalBefore);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("complete original child uses actual fixed-package fs bytes then attachment/config APIs in a pure fixture", async () => {
  const scratch = await mkdtemp("/private/tmp/atools-test-child-original-");
  try {
    const generated = await createChildNodeFixturePackages(root, scratch), packageRoot = join(generated.directory, "file-tree");
    const storage = new Map(), attachments = new Map(), fsReads = [];
    const ztools = { dbStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
      db: { postAttachment: (key, bytes) => { attachments.set(key, Buffer.from(bytes)); return { ok: true }; },
        promises: { getAttachment: async key => attachments.get(key) } } };
    const context = vm.createContext({ ztools, TextDecoder, Buffer, console: { log() {} },
      require: name => name === "electron" ? { webFrame: { setZoomFactor() {} } } : name === "fs" ? {
        readFileSync: filename => { assert.equal(filename, "fixture-dictionary.json"); fsReads.push(filename); return readFileSync(join(packageRoot, filename)); },
      } : assert.fail("Unexpected module " + name) });
    context.window = context;
    vm.runInContext((await reviewedOriginalChildPreload(root)).bytes.toString("utf8"), context);
    assert.deepEqual(fsReads, [], "Original child initializes data/zoom without reading a dictionary before its public function is called");
    assert.equal(context.newLocalDict("fixture-dictionary.json", childNodeFixtureValues.metadata), true);
    assert.deepEqual(fsReads, ["fixture-dictionary.json"]);
    assert.deepEqual(JSON.parse(JSON.stringify(await context.readLocalDict(childNodeFixtureValues.metadata.id))), childNodeFixtureValues.dictionary);
    assert.deepEqual(JSON.parse(JSON.stringify(context.readLocalDictConfig())), [childNodeFixtureValues.metadata]);
    assert.equal(storage.get("zoom_rate"), 1);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("generated parent records data-call progress and fixed error classes without replaying failed data writes", async () => {
  const scratch = await mkdtemp("/private/tmp/atools-test-child-main-stage-");
  try {
    const generated = await createChildNodeFixturePackages(root, scratch);
    const html = await readFile(join(generated.directory, "file-tree/index.html"), "utf8"), script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    for (const rejected of [false, true]) {
      let calls = 0; const context = vm.createContext({ ztools: { dbStorage: { setItem() { calls++;
        if (rejected) throw Object.assign(Error("PRIVATE_FIXTURE_BODY"), { name: "PRIVATE_ERROR_NAME", code: "ERR_ATOOLS_DATA_PERMISSION_REQUIRED" });
      } } } }); context.window = context;
      if (rejected) assert.throws(() => vm.runInContext(script, context)); else vm.runInContext(script, context);
      assert.equal(calls, 1); assert.equal(context.__AToolsChildMainStage.entered, true);
      assert.equal(context.__AToolsChildMainStage.attempted, true); assert.equal(context.__AToolsChildMainStage.completed, !rejected);
      assert.equal(context.__AToolsChildMainReady === true, !rejected);
      assert.equal(context.__AToolsChildMainStage.errorClass, rejected ? "UnknownError" : "");
      assert.equal(context.__AToolsChildMainStage.errorCode, rejected ? "ERR_ATOOLS_DATA_PERMISSION_REQUIRED" : "");
      assert.ok(!JSON.stringify(context.__AToolsChildMainStage).includes("PRIVATE_"));
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("unreviewed original bytes reject before package generation", async () => {
  const scratch = await mkdtemp("/private/tmp/atools-test-child-pin-");
  try {
    const target = join(scratch, originalChildPreload.source); await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, "window.unreviewed=true");
    await assert.rejects(createChildNodeFixturePackages(scratch, scratch), /Reviewed original English child preload changed/);
    assert.notEqual(createHash("sha256").update(await readFile(target)).digest("hex"), originalChildPreload.sha256);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

test("child-only compile switch is explicit false by default and isolated from every other flag", () => {
  const previous = process.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE;
  process.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE = "true";
  try {
    assert.equal(pluginPanelNativeFixtureDefines()["import.meta.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE"], '"false"');
    assert.equal(pluginPanelNativeFixtureDefines(false, false, false, false, true)["import.meta.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE"], '"true"');
    for (const flags of [[true, false, false, false], [true, true, false, false], [false, false, true, false], [false, false, false, true]])
      assert.throws(() => pluginPanelNativeFixtureDefines(...flags, true), /Child-only Node acceptance is isolated/);
  } finally { if (previous === undefined) delete process.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE; else process.env.VITE_ATOOLS_CHILD_NODE_ACCEPTANCE = previous; }
});
