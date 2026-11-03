import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import {
  IMAGE_TOOLBOX_CSP,
  prepareImageToolboxNativeFixture,
} from "./image-toolbox-native-fixture.mjs";

const repositoryRoot = resolve(process.env.ATOOLS_REPOSITORY_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const sourcePlugin = join(repositoryRoot, "ZTools-plugins/plugins/Image-Toolbox");
const sourceImage = join(repositoryRoot, "ZTools-plugins/plugins/calculation-paper/logo.png");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function hashTree(directory) {
  const digest = createHash("sha256");
  async function visit(current) {
    const entries = await nodeFs.promises.readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const name = entry.name;
      const path = join(current, name);
      const stat = await nodeFs.promises.lstat(path);
      assert.equal(stat.isSymbolicLink(), false, "fixture input tree must not contain symlinks");
      if (stat.isDirectory()) await visit(path);
      else {
        assert.equal(stat.isFile(), true);
        digest.update(relative(directory, path).split(sep).join("/"));
        digest.update("\0");
        digest.update(await readFile(path));
        digest.update("\0");
      }
    }
  }
  await visit(directory);
  return digest.digest("hex");
}

const originalFiles = [
  "plugin.json",
  "preload.js",
  "core/src/preloadHelpers.js",
  "core/src/app/App.js",
  "core/src/modules/TextModule.js",
  "core/src/modules/ExportModule.js",
];

async function withPreparedFixture(run) {
  const scratch = await mkdtemp(join(tmpdir(), "atools-image-toolbox-fixture-test-"));
  try {
    const fixtureRoot = join(scratch, "native-fixture");
    const fixture = await prepareImageToolboxNativeFixture({ repositoryRoot, scratch, fixtureRoot });
    await run({ scratch, fixture });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function observerSource(html) {
  const marker = html.indexOf('const summary={scope:"original Image-Toolbox App through PluginPanel"');
  assert.notEqual(marker, -1, "copied entry should contain the fixture observer");
  const open = html.lastIndexOf("<script>", marker);
  const close = html.indexOf("</script>", marker);
  assert.ok(open >= 0 && close > marker, "observer script wrapper should be complete");
  return html.slice(open + "<script>".length, close);
}

async function executeObserver({ fixture, scratch, violateCsp = false, allowWrite = true, resizeDuringEdit = false, smallViewport = false, annotationOffCanvas = false, zoomAndTranslation = false, unknownImageBounds = false }) {
  const outputBytes = await readFile(sourceImage);
  const dataUrl = `data:image/png;base64,${outputBytes.toString("base64")}`;
  const listeners = new Map();
  const posted = [];
  const writes = [];
  const zoom = zoomAndTranslation ? 0.5 : 1;
  const translate = zoomAndTranslation ? { x: 10, y: 20 } : { x: 0, y: 0 };
  function viewportObject(bounds, unknown = false) {
    return { getBoundingRect(skipGroup, calculate) {
      assert.equal(skipGroup, false, "fresh bounding coordinates are requested");
      assert.equal(calculate, true, "Fabric recalculates viewport coordinates");
      if (unknown) return { left: NaN, top: NaN, width: 200, height: 200 };
      return { left: bounds.left * zoom + translate.x, top: bounds.top * zoom + translate.y,
        width: bounds.width * zoom, height: bounds.height * zoom };
    } };
  }
  const originalImage = { width: 200, height: 200, ...viewportObject({ left: 0, top: 0, width: 200, height: 200 }, unknownImageBounds) };
  const canvasObjects = [originalImage];
  const annotation = { text: "ATools local fixture", fill: "#000000", isEditing: false, exitEditing() {},
    ...viewportObject({ left: annotationOffCanvas ? 390 : 12, top: 12, width: 170, height: 36 }) };
  let canvasWidth = smallViewport || resizeDuringEdit ? 112 : 200;
  let canvasHeight = smallViewport || resizeDuringEdit ? 72 : 200;
  const canvas = {
    getObjects: () => canvasObjects,
    getWidth: () => canvasWidth,
    getHeight: () => canvasHeight,
    resizeForHostLayout() { canvasWidth = 200; canvasHeight = 200; },
    wrapperEl: { parentElement: { getBoundingClientRect: () => ({
      left: 0, top: 0, right: canvasWidth, bottom: canvasHeight, width: canvasWidth, height: canvasHeight,
    }) } },
  };
  const textModule = {
    addText(text) {
      annotation.text = text;
      canvasObjects.push(annotation);
      return annotation;
    },
    setTextColor(color) { annotation.fill = color; },
  };
  const exportModule = { exportToDataURL(format) {
    assert.equal(format, "png");
    return dataUrl;
  } };
  const app = {
    canvasManager: { canvas, originalImage, zoomLevel: zoom },
    toolManager: {
      activateTool(name) { assert.equal(name, "text"); },
      getModule(name) { return name === "text" ? textModule : name === "export" ? exportModule : null; },
    },
  };
  const helperSource = await readFile(join(sourcePlugin, "core/src/preloadHelpers.js"), "utf8");
  const writerStart = helperSource.indexOf("window.writeImageFile =");
  const writerEnd = helperSource.indexOf("\n  };", writerStart);
  assert.ok(writerStart >= 0 && writerEnd > writerStart, "original writeImageFile definition should be present");
  const assignment = helperSource.slice(writerStart, writerEnd + 4);
  const originalWriterExpression = assignment.slice(assignment.indexOf("=") + 1).replace(/;\s*$/, "");
  const originalWriteImageFile = runInNewContext(`(${originalWriterExpression})`, {
    Buffer,
    console: { warn() {} },
    require(specifier) {
      if (specifier === "fs") return nodeFs;
      if (specifier === "path") return nodePath;
      throw new Error("unexpected original helper require");
    },
  });
  const window = {
    __imageToolboxApp: app,
    parent: { postMessage(value, targetOrigin) { posted.push({ value, targetOrigin }); } },
    addEventListener(type, listener) {
      const entries = listeners.get(type) ?? [];
      entries.push(listener);
      listeners.set(type, entries);
    },
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    clearTimeout() {},
    innerWidth: smallViewport ? 112 : 200,
    innerHeight: smallViewport ? 72 : 200,
    devicePixelRatio: 2,
    writeImageFile: allowWrite ? (path, value) => {
      writes.push({ path, value });
      return originalWriteImageFile(path, value);
    } : undefined,
  };
  const document = {
    readyState: "loading",
    addEventListener(type, listener) {
      const entries = listeners.get(`document:${type}`) ?? [];
      entries.push(listener);
      listeners.set(`document:${type}`, entries);
    },
    querySelector(selector) {
      assert.equal(selector, 'meta[http-equiv="Content-Security-Policy"]');
      return { content: IMAGE_TOOLBOX_CSP };
    },
  };
  class FakeImage {
    naturalWidth = 200;
    naturalHeight = 200;
    set src(value) { this.value = value; }
    async decode() { assert.equal(this.value, dataUrl); }
  }
  const html = await readFile(fixture.fixtureEntryPath, "utf8");
  runInNewContext(observerSource(html), {
    window, document, Image: FakeImage, console,
    setTimeout: (callback, delay) => {
      if (resizeDuringEdit && delay === 80) canvas.resizeForHostLayout();
      queueMicrotask(callback);
    },
  });
  if (violateCsp) listeners.get("securitypolicyviolation")?.[0]?.({});
  const enter = listeners.get("atools-plugin-enter")?.[0];
  assert.equal(typeof enter, "function", "observer should install original entry listener");
  // The production head bridge can dispatch entry from its own DCL callback
  // before this body observer's DCL listener runs.
  enter({ detail: { code: "image-edit", type: "files" } });
  listeners.get("document:DOMContentLoaded")?.[0]?.();
  for (let attempt = 0; attempt < 20 && !posted.some(item => item.value?.kind === "atools-image-toolbox-smoke"); attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  const reports = posted.filter(item => item.value?.kind === "atools-image-toolbox-smoke");
  const checkpoints = posted.filter(item => item.value?.kind === "atools-image-toolbox-child-checkpoint");
  assert.equal(reports.length, 1, "observer should send one bounded completion report");
  assert.deepEqual(checkpoints.map(item => [item.value.code, item.value.observed]), [
    ["child-observer-started", true],
    ["child-enter-received", true],
    ["child-app-instance-present", true],
    ["child-domcontentloaded", true],
  ]);
  const summary = reports[0].value.summary;
  assert.equal(reports[0].targetOrigin, "*");
  assert.ok(checkpoints.every(item => item.targetOrigin === "*"));
  return { summary, writes, outputBytes };
}

test("preparation pins original plugin modules and keeps staged observer/input separate from canonical sources", async () => {
  await withPreparedFixture(async ({ fixture }) => {
    assert.equal(fixture.originalPluginSource, sourcePlugin);
    assert.equal(fixture.originalInputSource, sourceImage);
    assert.notEqual(fixture.pluginRoot, fixture.originalPluginSource);
    assert.notEqual(fixture.stagedInputSource, fixture.originalInputSource);
    assert.equal(fixture.outputPath, join(fixture.fixtureRoot, "image-toolbox-export.png"));
    assert.equal(fixture.sourcePins.pluginTreeSha256, await hashTree(sourcePlugin));
    for (const relativePath of originalFiles) {
      const original = await readFile(join(sourcePlugin, relativePath));
      const staged = await readFile(join(fixture.pluginRoot, relativePath));
      assert.deepEqual(staged, original, `staged original file changed: ${relativePath}`);
    }
    assert.equal(fixture.sourcePins.originalAppSha256, hash(await readFile(join(sourcePlugin, "core/src/app/App.js"))));
    assert.equal(fixture.sourcePins.originalTextModuleSha256, hash(await readFile(join(sourcePlugin, "core/src/modules/TextModule.js"))));
    assert.equal(fixture.sourcePins.originalExportModuleSha256, hash(await readFile(join(sourcePlugin, "core/src/modules/ExportModule.js"))));
    assert.equal(fixture.sourcePins.pluginPreloadSha256, hash(await readFile(join(sourcePlugin, "preload.js"))));
    assert.equal(fixture.sourcePins.pluginManifestSha256, hash(await readFile(join(sourcePlugin, "plugin.json"))));
    assert.equal(fixture.sourcePins.originalEntryHtmlSha256, hash(await readFile(join(sourcePlugin, "src/index.html"))));
    assert.deepEqual(await readFile(fixture.stagedInputSource), await readFile(sourceImage));
    const originalEntry = await readFile(fixture.entryPath);
    assert.deepEqual(originalEntry, await readFile(join(sourcePlugin, "src/index.html")));
    const stagedHtml = await readFile(fixture.fixtureEntryPath, "utf8");
    assert.ok(stagedHtml.includes(IMAGE_TOOLBOX_CSP));
    assert.ok(stagedHtml.includes("atools-image-toolbox-smoke"));
    assert.ok(stagedHtml.includes("atools-image-toolbox-child-checkpoint"));
    assert.notDeepEqual(await readFile(join(fixture.pluginRoot, "src/index.html")), originalEntry);
  });
});

test("observer executes original entry event flow, decodes export, and calls original writeImageFile once at the fixed output path", async () => {
  await withPreparedFixture(async ({ scratch, fixture }) => {
    const { summary, writes, outputBytes } = await executeObserver({ fixture, scratch });
    assert.equal(summary.passed, true);
    assert.equal(summary.entryObserved, true);
    assert.equal(summary.imageLoaded, true);
    assert.equal(summary.originalImagePresent, true);
    assert.equal(summary.editVerified, true);
    assert.equal(summary.exportDecoded, true);
    assert.equal(summary.originalWriteImageFileAvailable, true);
    assert.equal(summary.originalWriteImageFileCalled, true);
    assert.equal(summary.outputFileWriteSucceeded, true);
    assert.equal(summary.geometryValid, true);
    assert.equal(summary.imageFullyVisible, true);
    assert.equal(summary.annotationFullyVisible, true);
    assert.deepEqual(JSON.parse(JSON.stringify(summary.imageBounds)), { left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 });
    assert.deepEqual(JSON.parse(JSON.stringify(summary.annotationBounds)), { left: 12, top: 12, width: 170, height: 36, right: 182, bottom: 48 });
    assert.deepEqual(JSON.parse(JSON.stringify(summary.geometry)), {
      canvas: { width: 200, height: 200, zoom: 1 },
      container: { left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 },
      child: { innerWidth: 200, innerHeight: 200, devicePixelRatio: 2 },
    });
    assert.equal(summary.iframeCspMeta, IMAGE_TOOLBOX_CSP);
    assert.equal(summary.iframeCspViolationCount, 0);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, fixture.outputPath);
    assert.equal(writes[0].value, `data:image/png;base64,${outputBytes.toString("base64")}`);
    assert.deepEqual(await readFile(fixture.outputPath), outputBytes);
    assert.equal(hash(await readFile(fixture.outputPath)), hash(outputBytes));
  });
});

test("observer samples geometry after a pending host resize immediately before the unchanged default export", async () => {
  await withPreparedFixture(async ({ scratch, fixture }) => {
    const { summary } = await executeObserver({ fixture, scratch, resizeDuringEdit: true });
    assert.equal(summary.passed, true);
    assert.equal(summary.exportWidth, 200);
    assert.equal(summary.exportHeight, 200);
    assert.deepEqual(JSON.parse(JSON.stringify(summary.geometry)), {
      canvas: { width: 200, height: 200, zoom: 1 },
      container: { left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200 },
      child: { innerWidth: 200, innerHeight: 200, devicePixelRatio: 2 },
    });
  });
});

test("small initial viewport keeps the default full-canvas export but fails visible-content geometry", async () => {
  await withPreparedFixture(async ({ scratch, fixture }) => {
    const { summary, writes } = await executeObserver({ fixture, scratch, smallViewport: true });
    assert.equal(summary.geometry.canvas.width, 112);
    assert.equal(summary.geometry.canvas.height, 72);
    assert.equal(summary.exportWidth, 200);
    assert.equal(summary.exportHeight, 200);
    assert.equal(summary.imageFullyVisible, false);
    assert.equal(summary.annotationFullyVisible, false);
    assert.equal(summary.geometryValid, false);
    assert.equal(summary.passed, false);
    assert.equal(writes.length, 1, "the original default export/write still runs; only acceptance fails");
  });
});

test("partially clipped annotation is retained as a failed visual-content check", async () => {
  await withPreparedFixture(async ({ scratch, fixture }) => {
    const { summary, writes } = await executeObserver({ fixture, scratch, annotationOffCanvas: true });
    assert.equal(summary.geometry.canvas.width, 200);
    assert.equal(summary.imageFullyVisible, true);
    assert.equal(summary.annotationFullyVisible, false);
    assert.equal(summary.passed, false);
    assert.equal(writes.length, 1, "original export still runs before the bounded geometry gate");
  });
});

test("observer reports write and CSP failures without claiming success", async () => {
  await withPreparedFixture(async ({ scratch, fixture }) => {
    const writeFailure = await executeObserver({ fixture, scratch, allowWrite: false });
    assert.equal(writeFailure.summary.originalWriteImageFileAvailable, false);
    assert.equal(writeFailure.summary.passed, false);
    assert.equal(writeFailure.writes.length, 0);
    const cspFailure = await executeObserver({ fixture, scratch, violateCsp: true });
    assert.equal(cspFailure.summary.iframeCspViolationCount, 1);
    assert.equal(cspFailure.summary.passed, false);
  });
});


test("unknown viewport bounds stay unknown instead of coercing null to visible", async () => {
  await withPreparedFixture(async ({ scratch, fixture }) => {
    const { summary, writes } = await executeObserver({ fixture, scratch, unknownImageBounds: true });
    assert.equal(summary.imageFullyVisible, false);
    assert.equal(summary.geometryValid, false);
    assert.equal(summary.passed, false);
    assert.equal(writes.length, 1);
  });
});

test("fresh Fabric viewport bounds honor zoom and translation exactly once", async () => {
  await withPreparedFixture(async ({ scratch, fixture }) => {
    const { summary, writes } = await executeObserver({ fixture, scratch, zoomAndTranslation: true });
    assert.equal(summary.geometry.canvas.zoom, 0.5);
    assert.deepEqual(JSON.parse(JSON.stringify(summary.imageBounds)), { left: 10, top: 20, width: 100, height: 100, right: 110, bottom: 120 });
    assert.deepEqual(JSON.parse(JSON.stringify(summary.annotationBounds)), { left: 16, top: 26, width: 85, height: 18, right: 101, bottom: 44 });
    assert.equal(summary.imageFullyVisible, true);
    assert.equal(summary.annotationFullyVisible, true);
    assert.equal(summary.passed, true);
    assert.equal(writes.length, 1);
  });
});

test("fixture CSP adds only the exact resource-lease origins to script-src", () => {
  const original = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' asset: http://asset.localhost https://asset.localhost; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: asset: http://asset.localhost https://asset.localhost; connect-src ipc: http://ipc.localhost http://127.0.0.1:*; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
  const allowedLeaseOrigins = [
    "atools-plugin://localhost",
    "http://atools-plugin.localhost",
    "https://atools-plugin.localhost",
  ];
  const parse = value => value.split(";").map(part => part.trim()).filter(Boolean).map(part => {
    const [name, ...sources] = part.split(/\s+/);
    return [name, sources];
  });
  const before = parse(original);
  const after = parse(IMAGE_TOOLBOX_CSP);
  assert.deepEqual(after.map(([name]) => name), before.map(([name]) => name));
  for (let index = 0; index < before.length; index += 1) {
    const [name, oldSources] = before[index];
    const [, nextSources] = after[index];
    if (name === "script-src") {
      assert.deepEqual(nextSources, [...oldSources, ...allowedLeaseOrigins], `${name} should add only exact lease origins`);
    } else {
      assert.deepEqual(nextSources, oldSources, `${name} must remain byte-equivalent at source-token level`);
    }
  }
});

test("Rust native fixture CSP constants match the JavaScript fixture policy", async () => {
  const rustPath = resolve(
    process.env.ATOOLS_RUST_CSP_SOURCE ??
      join(repositoryRoot, "src-tauri/src/legacy_runtime/desktop_smoke_native_image_toolbox_entry.rs"),
  );
  const source = await readFile(rustPath, "utf8");
  const rustConstant = name => {
    assert.ok(["FIXTURE_CSP", "CHILD_FIXTURE_CSP"].includes(name));
    const literal = source.match(new RegExp(`pub\\(super\\) const ${name}: &str = "([^"]*)";`));
    if (literal) return literal[1];
    const alias = source.match(new RegExp(`pub\\(super\\) const ${name}: &str = ([A-Z_]+);`));
    assert.ok(alias && name === "CHILD_FIXTURE_CSP" && alias[1] === "FIXTURE_CSP", `Rust constant ${name} must be a literal or the exact child-to-parent alias`);
    return rustConstant("FIXTURE_CSP");
  };
  assert.equal(rustConstant("FIXTURE_CSP"), IMAGE_TOOLBOX_CSP);
  assert.equal(rustConstant("CHILD_FIXTURE_CSP"), rustConstant("FIXTURE_CSP"));
  const nativeTsPath = resolve(
    process.env.ATOOLS_NATIVE_TS_SOURCE ??
      join(repositoryRoot, "tests/components/nativePluginImageToolboxSmoke.ts"),
  );
  const nativeTs = await readFile(nativeTsPath, "utf8");
  const nativeTsExpected = nativeTs.match(/const EXPECTED_FIXTURE_CSP = "([^"]*)";/);
  assert.ok(nativeTsExpected, "native smoke fixture should pin its expected CSP");
  assert.equal(nativeTsExpected[1], IMAGE_TOOLBOX_CSP);
});
