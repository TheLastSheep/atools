// @vitest-environment node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge, type ClipboardAccess } from "../../src/lib/hostClipboardBridge";
import { createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";
import { createPluginNativeImage, validatePluginClipboardImagePayload } from "../../src/lib/pluginNativeImage";

// This checks Harris's unchanged detection module against the production
// clipboard bridge and Electron adapter. It does not start Tauri, WebView, the
// Node sidecar, the full preload, or the Paste UI and is not a native transport
// or permission acceptance test.
const sourceRootSetting = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const originalContract = sourceRootSetting ? describe : describe.skip;
const EXPECTED_PLUGIN_VERSION = "1.3.1";
const EXPECTED_LAYERED_SOURCE_SHA256 = "46fa1d768e648b1f89b9835f5886b9523cf66cf9b3951c67a5cd2e3b323ba6ea";
const EXPECTED_DIST_PRELOAD_SHA256 = "6566635ba6f1143379ec980e42248cd666b2fa8d871a621f65e76c04ab1c98d3";
const READ_ENDPOINT = `http://127.0.0.1:12345/host/${"a".repeat(64)}`;
const IMAGE_ENDPOINT = `http://127.0.0.1:12345/host/${"b".repeat(64)}`;
const APPLICATION = { name: "ATools", version: "contract-test" };
const TIFF_FIXTURE_PATH = resolve("tests/fixtures/harris-paste/small-image.tiff");
const TIFF_BUFFER_LIMIT = 256 * 1024;
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOuoAAAAASUVORK5CYII=",
  "base64",
);
const PNG_PAYLOAD = { dataUrl: `data:image/png;base64,${PNG_BYTES.toString("base64")}`, width: 1, height: 1 };

type OriginalPaths = { pluginRoot: string; manifest: string; layeredDetection: string; distManifest: string; distPreload: string };
type OriginalDetectionApi = {
  detectClipboardImageWithFallback(dependencies: Record<string, unknown>, hostPath?: string | null): Promise<DetectionResult>;
  createLayeredImageDetectionHook(dependencies: Record<string, unknown>):
    (rawItem: unknown, record: CanonicalImageRecord) => Promise<CanonicalImageRecord>;
};
type LoadedOriginalDetection = { api: OriginalDetectionApi; windowFixture: Record<string, unknown> };
type DetectionResult = { success: boolean; imagePath?: string; blobBytes?: number; mediaType?: string; method: string | null; error?: string };
type CanonicalImageRecord = {
  item: { kind: string; payload: Record<string, unknown> };
  origin: { host: string; hostType: string; hostItemId: string; imagePath?: string; [key: string]: unknown };
};
type ClipboardState = {
  formats: Set<string>;
  fileUrl: string | null;
  formatBuffers?: ReadonlyMap<string, Uint8Array>;
  imagePayload?: { dataUrl: string; width: number; height: number } | null;
};
type WireCall = { endpoint: string; payload: Record<string, unknown> };

function resolveOriginalPaths(sourceRoot: string): OriginalPaths {
  const root = resolve(sourceRoot);
  const pluginRoot = [root, join(root, "pasteboard-pro"), join(root, "plugins/pasteboard-pro")]
    .find(candidate => existsSync(join(candidate, "apps/ztools/preload/layered-image-detection.ts")));
  if (!pluginRoot) throw new Error(`Cannot find pasteboard-pro layered image source under ${root}`);
  return {
    pluginRoot,
    manifest: join(pluginRoot, "plugin.json"),
    layeredDetection: join(pluginRoot, "apps/ztools/preload/layered-image-detection.ts"),
    distManifest: join(pluginRoot, "dist/ztools/plugin.json"),
    distPreload: join(pluginRoot, "dist/ztools/preload.js"),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function loadOriginalDetection(paths: OriginalPaths): Promise<LoadedOriginalDetection> {
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
  const bundle = await esbuild.build({
    entryPoints: [paths.layeredDetection], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("esbuild did not return the original layered-image-detection bundle");

  const loadedModule: { exports: Record<string, unknown> } = { exports: {} };
  const windowFixture: Record<string, unknown> = {};
  vm.runInNewContext(output.text, {
    module: loadedModule,
    exports: loadedModule.exports,
    require: createRequire(paths.layeredDetection),
    Buffer,
    process,
    console,
    window: windowFixture,
  }, { timeout: 10_000, filename: paths.layeredDetection });
  const original = loadedModule.exports as Record<string, unknown>;
  if (typeof original.detectClipboardImageWithFallback !== "function"
    || typeof original.createLayeredImageDetectionHook !== "function") {
    throw new Error("Original layered-image-detection bundle is missing required exports");
  }
  return { api: original as unknown as OriginalDetectionApi, windowFixture };
}

function createClipboardHarness(state: ClipboardState) {
  const calls: WireCall[] = [];
  const formatReads: Array<{ format: string; value: string | null }> = [];
  const bufferWireReads: Array<{ format: string; request: Record<string, unknown>; response: { base64: string; byteLength: number } }> = [];
  const permissionRequests: ClipboardAccess[] = [];
  const bridge = createHostClipboardBridge({
    instanceId: "12345678-1234-4234-8234-123456789abc",
    endpoints: { read: READ_ENDPOINT, image: IMAGE_ENDPOINT },
  }, access => permissionRequests.push(access), (endpoint, payload) => {
    calls.push({ endpoint, payload: structuredClone(payload) });
    if (endpoint === IMAGE_ENDPOINT) return state.imagePayload ?? null;
    if (endpoint !== READ_ENDPOINT) throw new Error(`Unexpected clipboard endpoint ${endpoint}`);
    if (payload.operation === "hasFormat" && typeof payload.format === "string") {
      return state.formats.has(payload.format);
    }
    if (payload.operation === "readFormat" && typeof payload.format === "string") {
      const value = payload.format === "public.file-url" ? state.fileUrl : null;
      formatReads.push({ format: payload.format, value });
      return value;
    }
    if (payload.operation === "readFormatBuffer" && typeof payload.format === "string") {
      const bytes = state.formatBuffers?.get(payload.format) ?? new Uint8Array();
      const response = { base64: Buffer.from(bytes).toString("base64"), byteLength: bytes.byteLength };
      bufferWireReads.push({ format: payload.format, request: structuredClone(payload), response });
      return response;
    }
    return null;
  }, validatePluginClipboardImagePayload);
  const electron = createPluginElectronAdapter({
    application: APPLICATION,
    clipboard: bridge,
    createNativeImage: value => createPluginNativeImage(value),
    createBuffer: bytes => Buffer.from(bytes),
  });
  return { bridge, calls, electron, formatReads, bufferWireReads, permissionRequests };
}

function createScratch() {
  const root = mkdtempSync(join(tmpdir(), "atools-harris-paste-image-"));
  const imageDir = join(root, "detected-images");
  mkdirSync(imageDir);
  function fencedPath(value: string): string {
    const path = resolve(value);
    const pathFromRoot = relative(root, path);
    if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
      throw new Error(`Original module attempted filesystem access outside scratch: ${path}`);
    }
    return path;
  }
  return {
    root,
    imageDir,
    sourcePath: join(root, "source image # 例.png"),
    dependencies(clipboard: unknown) {
      return {
        clipboard,
        fs: {
          access: async (path: string, mode?: number) => fs.access(fencedPath(path), mode),
          readFile: async (path: string) => fs.readFile(fencedPath(path)),
          writeFile: async (path: string, data: Buffer) => fs.writeFile(fencedPath(path), data),
        },
        imageDir,
        uuid: () => "contract-image-id",
        cryptoHash: (data: Buffer) => createHash("sha256").update(data).digest("hex"),
        now: () => 1_798_000_000_000,
        isFile: (path: string) => {
          const safePath = fencedPath(path);
          try { return statSync(safePath).isFile(); } catch { return false; }
        },
      };
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

function imageRecord(): CanonicalImageRecord {
  return {
    item: { kind: "image", payload: { revision: "sha256:image-fixture", blobId: "host-image" } },
    origin: { host: "ztools", hostType: "image", hostItemId: "host-image-without-path" },
  };
}

async function withErrorQueueFixture<T>(windowFixture: Record<string, unknown>, queue: unknown,
  callback: () => Promise<T>): Promise<T> {
  const hadQueue = Object.prototype.hasOwnProperty.call(windowFixture, "pasteboardProErrorQueue");
  const previousQueue = windowFixture.pasteboardProErrorQueue;
  windowFixture.pasteboardProErrorQueue = queue;
  try { return await callback(); }
  finally {
    if (hadQueue) windowFixture.pasteboardProErrorQueue = previousQueue;
    else delete windowFixture.pasteboardProErrorQueue;
  }
}

originalContract("Harris Paste layered image detection clipboard format contract", () => {
  let paths: OriginalPaths | undefined;
  let original: OriginalDetectionApi;
  let originalWindow: Record<string, unknown>;
  let sourceHashBefore = "";
  let distPreloadHashBefore = "";

  beforeAll(async () => {
    paths = resolveOriginalPaths(sourceRootSetting!);
    for (const path of [paths.manifest, paths.layeredDetection, paths.distManifest, paths.distPreload]) {
      expect(existsSync(path), `Original source exists: ${path}`).toBe(true);
    }
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as { version?: string };
    const distManifest = JSON.parse(readFileSync(paths.distManifest, "utf8")) as { version?: string };
    expect(manifest.version).toBe(EXPECTED_PLUGIN_VERSION);
    expect(distManifest.version).toBe(EXPECTED_PLUGIN_VERSION);
    sourceHashBefore = sha256(paths.layeredDetection);
    expect(sourceHashBefore).toBe(EXPECTED_LAYERED_SOURCE_SHA256);
    distPreloadHashBefore = sha256(paths.distPreload);
    expect(distPreloadHashBefore).toBe(EXPECTED_DIST_PRELOAD_SHA256);
    const loaded = await loadOriginalDetection(paths);
    original = loaded.api;
    originalWindow = loaded.windowFixture;
  });

  afterAll(() => {
    if (!paths) return;
    const sourceHashAfter = sha256(paths.layeredDetection);
    expect(sourceHashAfter, "Original layered-image source must remain byte-identical")
      .toBe(sourceHashBefore);
    const distPreloadHashAfter = sha256(paths.distPreload);
    expect(distPreloadHashAfter, "Original dist preload must remain byte-identical").toBe(distPreloadHashBefore);
    console.info(`[Harris Paste ${EXPECTED_PLUGIN_VERSION}] layered-image-detection.ts sha256 before=${sourceHashBefore} after=${sourceHashAfter}`);
    console.info(`[Harris Paste ${EXPECTED_PLUGIN_VERSION}] dist/ztools/preload.js sha256 before=${distPreloadHashBefore} after=${distPreloadHashAfter}`);
  });

  it("decodes a percent-encoded public.file-url through production adapters and stores identical PNG bytes", async () => {
    const scratch = createScratch();
    const state: ClipboardState = { formats: new Set(["public.file-url"]), fileUrl: null };
    const fixture = createClipboardHarness(state);
    try {
      await fs.writeFile(scratch.sourcePath, PNG_BYTES);
      state.fileUrl = pathToFileURL(scratch.sourcePath).href;
      expect(state.fileUrl).toContain("%20");
      expect(state.fileUrl).toContain("%23");
      expect(state.fileUrl).toContain("%E4%BE%8B");

      const dependencies = scratch.dependencies(fixture.electron.clipboard);
      const result = await original.detectClipboardImageWithFallback(dependencies);
      expect(result).toMatchObject({ success: true, method: "file-url-decode", blobBytes: PNG_BYTES.length });
      expect(result.imagePath).toBe(join(scratch.imageDir, "1798000000000-contract-image-id.png"));
      expect(readFileSync(result.imagePath!)).toEqual(PNG_BYTES);
      expect(fixture.calls).toContainEqual({
        endpoint: READ_ENDPOINT,
        payload: { operation: "hasFormat", format: "public.file-url" },
      });
      expect(fixture.calls).toContainEqual({
        endpoint: READ_ENDPOINT,
        payload: { operation: "readFormat", format: "public.file-url" },
      });
      expect(fixture.formatReads).toContainEqual({ format: "public.file-url", value: state.fileUrl });
      expect(fixture.permissionRequests).toEqual([]);
    } finally {
      fixture.bridge.close();
      scratch.cleanup();
    }
  });

  it("adds the detected source path to an image record that has no imagePath", async () => {
    const scratch = createScratch();
    const state: ClipboardState = { formats: new Set(["public.file-url"]), fileUrl: null };
    const fixture = createClipboardHarness(state);
    try {
      await fs.writeFile(scratch.sourcePath, PNG_BYTES);
      state.fileUrl = pathToFileURL(scratch.sourcePath).href;
      const hook = original.createLayeredImageDetectionHook(scratch.dependencies(fixture.electron.clipboard));
      const result = await hook(null, imageRecord());
      expect(result.origin.imagePath).toBe(join(scratch.imageDir, "1798000000000-contract-image-id.png"));
      expect(result.origin.blobBytes).toBe(PNG_BYTES.length);
      expect(readFileSync(result.origin.imagePath!)).toEqual(PNG_BYTES);
    } finally {
      fixture.bridge.close();
      scratch.cleanup();
    }
  });

  it("stores the original public.tiff bytes when file-url is absent and TIFF is larger than readImage PNG", async () => {
    const scratch = createScratch();
    const tiffBytes = readFileSync(TIFF_FIXTURE_PATH);
    const ifdOffset = tiffBytes.readUInt32LE(4);
    const entryCount = tiffBytes.readUInt16LE(ifdOffset);
    const entryTags = new Set(Array.from({ length: entryCount }, (_, index) =>
      tiffBytes.readUInt16LE(ifdOffset + 2 + index * 12)));
    const entryOffsetFor = (tag: number) => Array.from({ length: entryCount }, (_, index) =>
      ifdOffset + 2 + index * 12).find(offset => tiffBytes.readUInt16LE(offset) === tag);
    expect(tiffBytes.subarray(0, 2).toString("ascii")).toBe("II");
    expect(tiffBytes.readUInt16LE(2)).toBe(42);
    expect(ifdOffset + 2 + entryCount * 12 + 4).toBeLessThanOrEqual(tiffBytes.length);
    expect(entryTags.has(256)).toBe(true);
    expect(entryTags.has(257)).toBe(true);
    for (const tag of [256, 257]) {
      const entryOffset = entryOffsetFor(tag)!;
      const fieldType = tiffBytes.readUInt16LE(entryOffset + 2);
      expect([3, 4]).toContain(fieldType);
      expect(tiffBytes.readUInt32LE(entryOffset + 4)).toBe(1);
      const dimension = fieldType === 3
        ? tiffBytes.readUInt16LE(entryOffset + 8)
        : tiffBytes.readUInt32LE(entryOffset + 8);
      expect(dimension).toBe(2);
    }
    expect(tiffBytes.length).toBeGreaterThan(PNG_BYTES.length);

    const state: ClipboardState = {
      formats: new Set(["public.tiff"]), fileUrl: null,
      formatBuffers: new Map([["public.tiff", tiffBytes]]), imagePayload: PNG_PAYLOAD,
    };
    const fixture = createClipboardHarness(state);
    try {
      const nativeImage = fixture.electron.clipboard.readImage();
      expect(nativeImage.isEmpty()).toBe(false);
      expect(nativeImage.toPNG()).toEqual(PNG_BYTES);
      expect(Buffer.isBuffer(nativeImage.toPNG())).toBe(true);

      const result = await original.detectClipboardImageWithFallback(scratch.dependencies(fixture.electron.clipboard));
      expect(result).toMatchObject({
        success: true, method: "readimage-extract", blobBytes: tiffBytes.length, mediaType: "image/tiff",
      });
      expect(readFileSync(result.imagePath!)).toEqual(tiffBytes);
      expect(fixture.calls).toContainEqual({
        endpoint: READ_ENDPOINT, payload: { operation: "hasFormat", format: "public.file-url" },
      });
      expect(fixture.bufferWireReads).toContainEqual({
        format: "public.tiff",
        request: { operation: "readFormatBuffer", format: "public.tiff" },
        response: { base64: tiffBytes.toString("base64"), byteLength: tiffBytes.length },
      });
      expect(fixture.permissionRequests).toEqual([]);
    } finally {
      fixture.bridge.close();
      scratch.cleanup();
    }
  });

  it("falls back to PNG after an oversized TIFF read, then recovers to TIFF on the same bridge", async () => {
    const scratch = createScratch();
    const tiffBytes = readFileSync(TIFF_FIXTURE_PATH);
    const oversizedTiff = Buffer.concat([tiffBytes, Buffer.alloc(TIFF_BUFFER_LIMIT + 1 - tiffBytes.length)]);
    const formatBuffers = new Map([["public.tiff", oversizedTiff]]);
    const state: ClipboardState = {
      formats: new Set(["public.tiff"]), fileUrl: null,
      formatBuffers, imagePayload: PNG_PAYLOAD,
    };
    const fixture = createClipboardHarness(state);
    try {
      expect(() => fixture.electron.clipboard.readBuffer("public.tiff")).toThrow(/256 KiB/i);

      const result = await original.detectClipboardImageWithFallback(scratch.dependencies(fixture.electron.clipboard));
      expect(result).toMatchObject({
        success: true, method: "readimage-extract", blobBytes: PNG_BYTES.length, mediaType: "image/png",
      });
      expect(readFileSync(result.imagePath!)).toEqual(PNG_BYTES);
      expect(fixture.bufferWireReads).toHaveLength(2);
      expect(fixture.bufferWireReads.every(read => read.request.operation === "readFormatBuffer"
        && read.request.format === "public.tiff" && read.response.byteLength === oversizedTiff.length)).toBe(true);

      formatBuffers.set("public.tiff", tiffBytes);
      const recovered = await original.detectClipboardImageWithFallback(scratch.dependencies(fixture.electron.clipboard));
      expect(recovered).toMatchObject({
        success: true, method: "readimage-extract", blobBytes: tiffBytes.length, mediaType: "image/tiff",
      });
      expect(readFileSync(recovered.imagePath!)).toEqual(tiffBytes);
      expect(fixture.bufferWireReads).toHaveLength(3);
      expect(fixture.bufferWireReads[2]).toEqual({
        format: "public.tiff",
        request: { operation: "readFormatBuffer", format: "public.tiff" },
        response: { base64: tiffBytes.toString("base64"), byteLength: tiffBytes.length },
      });
      expect(fixture.permissionRequests).toEqual([]);
    } finally {
      fixture.bridge.close();
      scratch.cleanup();
    }
  });

  it("preserves the original failure diagnostics and recovers using the same bridge when file-url appears", async () => {
    const scratch = createScratch();
    const state: ClipboardState = { formats: new Set(["public.tiff"]), fileUrl: null };
    const fixture = createClipboardHarness(state);
    const errorQueue = { addError: vi.fn() };
    const hook = original.createLayeredImageDetectionHook(scratch.dependencies(fixture.electron.clipboard));
    try {
      await fs.writeFile(scratch.sourcePath, PNG_BYTES);
      const record = imageRecord();
      await withErrorQueueFixture(originalWindow, errorQueue, async () => {
        await expect(hook(null, record)).rejects.toThrow(
          "Layered image detection failed - cannot extract image without host support",
        );
      });

      expect(errorQueue.addError).toHaveBeenCalledOnce();
      expect(errorQueue.addError.mock.calls[0][0]).toMatchObject({
        version: "1.0.0",
        failureLevel: null,
        attemptedMethod: null,
        hasPublicFileUrl: false,
        hasTiffFlavor: false,
        readImageIsEmpty: true,
        lastErrorMessage: "Unable to detect image from clipboard after trying all detection methods",
        clipboardFlavors: ["public.tiff"],
      });
      expect(fixture.calls.some(call => call.endpoint === IMAGE_ENDPOINT)).toBe(true);
      expect(fixture.calls.some(call => call.endpoint === READ_ENDPOINT
        && call.payload.operation === "hasFormat" && call.payload.format === "public.file-url")).toBe(true);

      state.formats.add("public.file-url");
      state.fileUrl = pathToFileURL(scratch.sourcePath).href;
      const recovered = await hook(null, record);
      expect(recovered.origin.imagePath).toBe(join(scratch.imageDir, "1798000000000-contract-image-id.png"));
      expect(readFileSync(recovered.origin.imagePath!)).toEqual(PNG_BYTES);
      expect(errorQueue.addError).toHaveBeenCalledOnce();
      expect(fixture.permissionRequests).toEqual([]);
    } finally {
      fixture.bridge.close();
      scratch.cleanup();
    }
  });
});
