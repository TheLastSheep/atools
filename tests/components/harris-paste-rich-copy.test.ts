// @vitest-environment node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge } from "../../src/lib/hostClipboardBridge";
import { createPluginElectronAdapter } from "../../src/lib/pluginElectronAdapter";

// This opt-in contract runs Harris's unchanged paste functions against the
// production frontend clipboard bridge and Electron adapter. It does not start
// Tauri, WebView, Node sidecar, OS paste, the full preload, or the plugin UI.
const sourceRootSetting = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const originalContract = sourceRootSetting ? describe : describe.skip;

type OriginalPaths = { pluginRoot: string; pasteItem: string; privacy: string; clipboardStore: string };
type OriginalPasteApi = {
  copyCanonicalRecord(record: object, host: object, plainText?: boolean): Promise<void>;
  pasteCanonicalRecord(record: object, host: object, plainText?: boolean): Promise<{ status: string; directPasteError?: string }>;
  withRichClipboard(host: object, dependencies: {
    write(data: { text: string; html: string }): void;
    leavePlugin(): void;
    waitForTarget?: () => Promise<void>;
    simulatePaste(): unknown;
  }): object;
};

function resolveOriginalPaths(sourceRoot: string): OriginalPaths {
  const root = resolve(sourceRoot);
  const pluginRoot = [root, join(root, "pasteboard-pro"), join(root, "plugins/pasteboard-pro")]
    .find(candidate => existsSync(join(candidate, "apps/ztools/preload/paste-item.ts")));
  if (!pluginRoot) throw new Error(`Cannot find pasteboard-pro under ${root}`);
  return {
    pluginRoot,
    pasteItem: join(pluginRoot, "apps/ztools/preload/paste-item.ts"),
    privacy: join(pluginRoot, "apps/ztools/preload/privacy.ts"),
    clipboardStore: join(pluginRoot, "apps/ztools/preload/clipboard-store.ts"),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function loadOriginalPasteItem(paths: OriginalPaths): Promise<OriginalPasteApi> {
  const requireFromTest = createRequire(import.meta.url);
  const vitePackage = requireFromTest.resolve("vite/package.json");
  const requireFromVite = createRequire(vitePackage);
  type EsbuildApi = {
    build(options: {
      entryPoints: string[];
      bundle: boolean;
      platform: "node";
      format: "cjs";
      write: false;
      logLevel: "silent";
    }): Promise<{ outputFiles: Array<{ text: string }> }>;
  };
  const esbuild = requireFromVite("esbuild") as EsbuildApi;
  const bundle = await esbuild.build({
    entryPoints: [paths.pasteItem], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("esbuild did not return the original paste-item bundle");

  const loadedModule: { exports: Record<string, unknown> } = { exports: {} };
  // Execute the Node-targeted bundle to read its exports; this vm wrapper is
  // only a loader and is not presented as a security sandbox.
  vm.runInNewContext(output.text, {
    module: loadedModule,
    exports: loadedModule.exports,
    require: createRequire(paths.pasteItem),
    Buffer,
    process,
    console,
  }, { timeout: 10_000, filename: paths.pasteItem });
  const exports = loadedModule.exports as Record<string, unknown>;
  if (typeof exports.copyCanonicalRecord !== "function"
    || typeof exports.pasteCanonicalRecord !== "function"
    || typeof exports.withRichClipboard !== "function") {
    throw new Error("Original paste-item bundle is missing a required export");
  }
  return exports as unknown as OriginalPasteApi;
}

const CONTENT_WRITE_ENDPOINT = `http://127.0.0.1:12345/host/${"a".repeat(64)}`;
const HTML = "<p><strong>Rich clipboard text</strong> 🧭</p>";
const TEXT = "Rich clipboard text 🧭";
const application = { name: "ATools", version: "contract-test" };

function richRecord(html = HTML, text = TEXT) {
  return {
    item: {
      id: "item-rich-html",
      kind: "html",
      sourceDeviceId: "device-fixture",
      copiedAt: "2026-10-23T12:00:00.000Z",
      updatedAt: "2026-10-23T12:00:00.000Z",
      contentFingerprint: "sha256:rich-html-record",
      payload: { revision: "sha256:rich-html-payload", html, text },
      pinned: false,
      fieldClocks: {},
    },
    origin: { host: "ztools", hostItemId: "source-item", hostType: "text" },
  };
}

function clipboardHarness(original: OriginalPasteApi, options: {
  grantHtml?: boolean;
  failContentWrite?: Error;
  initiallyClose?: boolean;
} = {}) {
  const steps: string[] = [];
  const wire: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
  const permissionRequests: string[] = [];
  const bridge = createHostClipboardBridge({
    instanceId: "12345678-1234-4234-8234-123456789abc",
    endpoints: options.grantHtml === false ? {} : { content_write: CONTENT_WRITE_ENDPOINT },
  }, access => permissionRequests.push(access), (endpoint, payload) => {
    wire.push({ endpoint, payload: structuredClone(payload) });
    if (endpoint === CONTENT_WRITE_ENDPOINT) {
      steps.push("write");
      if (options.failContentWrite) throw options.failContentWrite;
    }
    return null;
  });
  const electron = createPluginElectronAdapter({ application, clipboard: bridge });
  const baseHost = {
    write: vi.fn(async () => false),
    writeContent: vi.fn(async (content: { type: string; content: unknown }, _shouldPaste: boolean) =>
      content.type === "text" && typeof content.content === "string"),
  };
  const host = original.withRichClipboard(baseHost, {
    write: data => { electron.clipboard.write(data); },
    leavePlugin: () => { steps.push("leave"); },
    waitForTarget: async () => { steps.push("wait"); },
    simulatePaste: () => { steps.push("paste"); },
  });
  if (options.initiallyClose) bridge.close();
  return { bridge, baseHost, electron, host, permissionRequests, steps, wire };
}

originalContract("Harris rich HTML copy and paste host contract", () => {
  let paths: OriginalPaths;
  let original: OriginalPasteApi;
  let sourceHashes = new Map<string, string>();

  beforeAll(async () => {
    paths = resolveOriginalPaths(sourceRootSetting!);
    const sourceFiles = [paths.pasteItem, paths.privacy, paths.clipboardStore];
    for (const path of sourceFiles) expect(existsSync(path), `Original source exists: ${path}`).toBe(true);
    sourceHashes = new Map(sourceFiles.map(path => [path, sha256(path)]));
    vi.stubGlobal("window", {});
    original = await loadOriginalPasteItem(paths);
  });

  afterAll(() => {
    try {
      for (const [path, hash] of sourceHashes) {
        expect(sha256(path), `Original source unchanged: ${path}`).toBe(hash);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("copies the canonical HTML and text verbatim through content_write", async () => {
    const fixture = clipboardHarness(original);
    await expect(original.copyCanonicalRecord(richRecord(), fixture.host)).resolves.toBeUndefined();
    expect(fixture.wire).toEqual([{
      endpoint: CONTENT_WRITE_ENDPOINT,
      payload: { kind: "html", html: HTML, text: TEXT },
    }]);
    expect(fixture.permissionRequests).toEqual([]);
    expect(fixture.steps).toEqual(["write"]);
    expect(fixture.baseHost.writeContent).not.toHaveBeenCalled();
    fixture.bridge.close();
  });

  it("passes only the canonical plain text through the original text host path", async () => {
    const fixture = clipboardHarness(original);
    const htmlWrite = vi.spyOn(fixture.electron.clipboard, "write");
    await expect(original.copyCanonicalRecord(richRecord(), fixture.host, true)).resolves.toBeUndefined();
    expect(fixture.baseHost.writeContent).toHaveBeenCalledOnce();
    expect(fixture.baseHost.writeContent).toHaveBeenCalledWith({ type: "text", content: TEXT }, false);
    expect(htmlWrite).not.toHaveBeenCalled();
    expect(fixture.wire).toEqual([]);
    expect(fixture.steps).toEqual([]);
    fixture.bridge.close();
  });

  it("writes rich HTML before leaving, waiting for the target, then simulating paste", async () => {
    const fixture = clipboardHarness(original);
    await expect(original.pasteCanonicalRecord(richRecord(), fixture.host)).resolves.toEqual({ status: "pasted" });
    expect(fixture.steps).toEqual(["write", "leave", "wait", "paste"]);
    expect(fixture.wire).toEqual([{
      endpoint: CONTENT_WRITE_ENDPOINT,
      payload: { kind: "html", html: HTML, text: TEXT },
    }]);
    expect(fixture.permissionRequests).toEqual([]);
    fixture.bridge.close();
  });

  it("rejects missing permission without writing or simulating a paste", async () => {
    const fixture = clipboardHarness(original, { grantHtml: false });
    await expect(original.pasteCanonicalRecord(richRecord(), fixture.host))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_PERMISSION_REQUIRED" });
    expect(fixture.permissionRequests).toEqual(["content_write"]);
    expect(fixture.wire).toEqual([]);
    expect(fixture.steps).toEqual([]);
    fixture.bridge.close();
  });

  it("rejects a revoked clipboard session without reporting a successful paste", async () => {
    const fixture = clipboardHarness(original, { initiallyClose: true });
    await expect(original.pasteCanonicalRecord(richRecord(), fixture.host))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_CLOSED" });
    expect(fixture.wire).toEqual([]);
    expect(fixture.steps).toEqual([]);
    fixture.bridge.close();
  });

  it("does not leave or simulate paste when the host rejects both rich write attempts", async () => {
    const backendError = new Error("content-write backend rejected the request");
    const fixture = clipboardHarness(original, { failContentWrite: backendError });
    await expect(original.pasteCanonicalRecord(richRecord(), fixture.host))
      .rejects.toMatchObject({ message: expect.stringContaining(backendError.message) });
    expect(fixture.wire).toHaveLength(2); // Original performDirectPaste retries once as copy-only.
    expect(fixture.wire.every(row => row.endpoint === CONTENT_WRITE_ENDPOINT
      && row.payload.kind === "html" && row.payload.html === HTML && row.payload.text === TEXT)).toBe(true);
    expect(fixture.steps).toEqual(["write", "write"]);
  });

  it("rejects HTML beyond the 256 KiB text-plus-markup budget before transport", async () => {
    const fixture = clipboardHarness(original);
    await expect(original.copyCanonicalRecord(richRecord("x".repeat(256 * 1024 + 1), TEXT), fixture.host))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_HOST_CLIPBOARD_LIMIT" });
    expect(fixture.wire).toEqual([]);
    expect(fixture.steps).toEqual([]);
    fixture.bridge.close();
  });
});
