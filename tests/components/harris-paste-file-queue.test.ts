// @vitest-environment node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createHostClipboardBridge } from "../../src/lib/hostClipboardBridge";
import { createPluginElectronAdapter, pluginElectronAdapterScript } from "../../src/lib/pluginElectronAdapter";
import { decodePluginFileClipboardBuffer } from "../../src/lib/pluginFileClipboardBuffer";

// Executes only Harris's unchanged writePreparedStackItem against the real
// serialized Electron adapter and host clipboard bridge. It does not start the
// Node sidecar, Tauri, WebView, a global hook, or the operating-system clipboard.
const sourceRootSetting = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const originalContract = sourceRootSetting ? describe : describe.skip;
const EXPECTED_STACK_RUNTIME_SHA256 = "6b4d593a45883587ee666c2b63d31055fc4d548fa798f79f8b6c424edef33fd1";
const CONTENT_WRITE_ENDPOINT = `http://127.0.0.1:12345/host/${"a".repeat(64)}`;

type OriginalPaths = { runtime: string; coreIndex: string };
type OriginalRuntime = {
  writePreparedStackItem(
    item: { type: "files"; filePaths: string[] },
    clipboard: Record<string, (...args: unknown[]) => unknown>,
    nativeImage: { createFromPath(path: string): never },
    platform?: string,
  ): boolean;
  PasteStackRuntime: new (
    stackStore: { get(): Promise<{ direction: string; itemIds: string[] }>; put(value: { direction: string; itemIds: string[] }): Promise<{ direction: string; itemIds: string[] }> },
    clipboardStore: { findRecordByItemId(id: string): Promise<unknown> },
    clipboard: Record<string, (...args: unknown[]) => unknown>,
    nativeImage: { createFromPath(path: string): never },
    hook: { start(callback: () => boolean, onStopped: (reason: "accessibility-required" | "exit" | "error") => void): void; stop(): void },
    onChange?: (state: { direction: string; itemIds: string[] }) => void,
  ) => {
    initialize(): Promise<void>;
    replace(input: { direction: string; itemIds: string[] }, persist?: boolean): Promise<{ direction: string; itemIds: string[] }>;
    refreshFromStore(): Promise<{ direction: string; itemIds: string[] }>;
    dispose(): void;
  };
};

function resolveOriginalPaths(sourceRoot: string): OriginalPaths {
  const root = resolve(sourceRoot);
  const pluginRoot = [root, join(root, "pasteboard-pro"), join(root, "plugins/pasteboard-pro")]
    .find(candidate => existsSync(join(candidate, "apps/ztools/preload/paste-stack-runtime.ts")));
  if (!pluginRoot) throw new Error(`Cannot find pasteboard-pro under ${root}`);
  return {
    runtime: join(pluginRoot, "apps/ztools/preload/paste-stack-runtime.ts"),
    coreIndex: join(pluginRoot, "packages/core/src/index.ts"),
  };
}

async function loadOriginalRuntime(sourcePath: string, coreIndex: string): Promise<OriginalRuntime> {
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
      alias: Record<string, string>;
    }): Promise<{ outputFiles: Array<{ text: string }> }>;
  };
  const esbuild = requireFromVite("esbuild") as EsbuildApi;
  const bundle = await esbuild.build({
    entryPoints: [sourcePath], bundle: true, platform: "node", format: "cjs", write: false, logLevel: "silent",
    alias: { "@pasteboard-pro/core": coreIndex },
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("esbuild did not return the original paste-stack-runtime bundle");

  const loadedModule: { exports: Record<string, unknown> } = { exports: {} };
  vm.runInNewContext(output.text, {
    module: loadedModule,
    exports: loadedModule.exports,
    require: createRequire(sourcePath),
    Buffer,
    process,
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
  }, { timeout: 10_000, filename: sourcePath });
  if (typeof loadedModule.exports.writePreparedStackItem !== "function"
    || typeof loadedModule.exports.PasteStackRuntime !== "function") {
    throw new Error("Original paste-stack-runtime bundle is missing a required export");
  }
  return loadedModule.exports as unknown as OriginalRuntime;
}

function productionClipboard(hostClipboard: unknown) {
  const localElectron = { ipcRenderer: { on() {} } };
  const hostWindow: Record<string, any> = {
    require: (specifier: string) => specifier === "electron" ? localElectron : {},
    console,
    utools: { getAppName: () => "ATools", getAppVersion: () => "contract-test" },
    __atoolsHostClipboard: hostClipboard,
  };
  const script = pluginElectronAdapterScript().replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  new Function("window", script)(hostWindow);
  return hostWindow.require("electron").clipboard as Record<string, (...args: unknown[]) => unknown>;
}

function controlledPasteHook() {
  let callback: (() => boolean) | undefined;
  const hook = {
    start(next: () => boolean) { callback = next; },
    stop() { callback = undefined; },
  };
  return {
    hook,
    press() {
      if (!callback) return false;
      try { return callback(); } catch { return false; }
    },
  };
}

originalContract("Harris queued file writes through the production Electron adapter", () => {
  it("routes the original synchronous writeBuffer call into the permissioned typed file route", async () => {
    const paths = resolveOriginalPaths(sourceRootSetting!);
    expect(createHash("sha256").update(readFileSync(paths.runtime)).digest("hex"))
      .toBe(EXPECTED_STACK_RUNTIME_SHA256);
    const original = await loadOriginalRuntime(paths.runtime, paths.coreIndex);
    const wire: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    const hostClipboard = createHostClipboardBridge({
      instanceId: "12345678-1234-4234-8234-123456789abc",
      endpoints: { content_write: CONTENT_WRITE_ENDPOINT },
    }, vi.fn(), (endpoint, payload) => {
      wire.push({ endpoint, payload: structuredClone(payload) });
      return null;
    });
    const clipboard = productionClipboard(hostClipboard);
    const filePaths = ["/tmp/Paste & data/first file.txt", "/tmp/Paste & data/二.txt"];
    const nativeImage = { createFromPath: () => { throw new Error("unexpected image load"); } };

    for (const platform of ["darwin", "win32", "linux"]) {
      expect(() => original.writePreparedStackItem(
        { type: "files", filePaths }, clipboard, nativeImage, platform,
      )).not.toThrow();
    }

    expect(wire).toEqual(["darwin", "win32", "linux"].map(() => ({
      endpoint: CONTENT_WRITE_ENDPOINT,
      payload: { kind: "files", paths: filePaths },
    })));
    hostClipboard.close();
  });

  it("rejects unknown formats, non-clipboard types and extra arguments before transport", () => {
    const wire: Array<Record<string, unknown>> = [];
    const hostClipboard = createHostClipboardBridge({
      instanceId: "12345678-1234-4234-8234-123456789abc",
      endpoints: { content_write: CONTENT_WRITE_ENDPOINT },
    }, vi.fn(), (_endpoint, payload) => {
      wire.push(structuredClone(payload));
      return null;
    });
    const clipboard = productionClipboard(hostClipboard);
    const bytes = Buffer.from("file:///tmp/queue-file.txt\r\n", "utf8");

    expect(() => clipboard.writeBuffer("text/uri-list", bytes, "clipboard")).not.toThrow();
    expect(() => clipboard.writeBuffer("application/x-private", bytes))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_UNSUPPORTED");
    expect(() => clipboard.writeBuffer("text/uri-list", bytes, "selection"))
      .toThrow("Selection clipboard");
    expect(() => clipboard.writeBuffer("text/uri-list", bytes, "clipboard", "extra"))
      .toThrow("clipboard.writeBuffer expects");
    expect(wire).toEqual([{ kind: "files", paths: ["/tmp/queue-file.txt"] }]);
    hostClipboard.close();
  });

  it("rejects over-limit file queues before reaching the permissioned host transport", () => {
    const requestPermission = vi.fn();
    const transport = vi.fn(() => null);
    const hostClipboard = createHostClipboardBridge({
      instanceId: "12345678-1234-4234-8234-123456789abc",
      endpoints: { content_write: CONTENT_WRITE_ENDPOINT },
    }, requestPermission, transport);
    const clipboard = productionClipboard(hostClipboard);
    const uriList = Array.from({ length: 21 }, (_, index) => `file:///tmp/queue-${index}.txt`).join("\r\n") + "\r\n";

    expect(() => clipboard.writeBuffer("text/uri-list", Buffer.from(uriList, "utf8")))
      .toThrow("ERR_ATOOLS_FILE_CLIPBOARD_LIMIT");
    expect(transport).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
    hostClipboard.close();
  });

  it("throws synchronously when a host provider returns an asynchronous write result", async () => {
    const clipboardHost = {
      readText: () => "",
      writeText: () => undefined,
      writeContent: vi.fn(() => Promise.reject(new Error("late failure"))),
    };
    const electron = createPluginElectronAdapter(
      { application: { name: "ATools", version: "test" }, clipboard: clipboardHost },
      undefined,
      undefined,
      decodePluginFileClipboardBuffer,
    );
    const bytes = Buffer.from("file:///tmp/queue-file.txt\r\n", "utf8");
    expect(() => electron.clipboard.writeBuffer("text/uri-list", bytes))
      .toThrow("Invalid synchronous clipboard file write response");
    expect(clipboardHost.writeContent).toHaveBeenCalledWith({ kind: "files", paths: ["/tmp/queue-file.txt"] });
    await Promise.resolve();
  });

  it("consumes the original queued item only after a successful native write and retains it on host failure", async () => {
    const paths = resolveOriginalPaths(sourceRootSetting!);
    expect(createHash("sha256").update(readFileSync(paths.runtime)).digest("hex"))
      .toBe(EXPECTED_STACK_RUNTIME_SHA256);
    const original = await loadOriginalRuntime(paths.runtime, paths.coreIndex);
    const filePaths = ["/tmp/Paste & data/queued.txt"];
    const endpoint = CONTENT_WRITE_ENDPOINT;
    const attempts: Array<{ endpoint: string; payload: Record<string, unknown> }> = [];
    let failWrite = false;
    const hostClipboard = createHostClipboardBridge({
      instanceId: "12345678-1234-4234-8234-123456789abc",
      endpoints: { content_write: endpoint },
    }, vi.fn(), (actualEndpoint, payload) => {
      attempts.push({ endpoint: actualEndpoint, payload: structuredClone(payload) });
      if (failWrite) throw new Error("native file clipboard provider rejected the write");
      return null;
    });
    const clipboard = productionClipboard(hostClipboard);
    const initial = { direction: "forward", itemIds: ["file-record"] };
    let stored = structuredClone(initial);
    const put = vi.fn(async (next: typeof initial) => {
      stored = structuredClone(next);
      return structuredClone(next);
    });
    const stackStore = { async get() { return structuredClone(stored); }, put };
    const clipboardStore = {
      async findRecordByItemId(id: string) {
        return id === "file-record" ? {
          item: { id, kind: "files", payload: { filePaths } },
          origin: { host: "sync", remoteAvailable: true },
        } : undefined;
      },
    };
    const nativeImage = { createFromPath: () => { throw new Error("unexpected image load"); } };
    const controlled = controlledPasteHook();
    const runtime = new original.PasteStackRuntime(
      stackStore, clipboardStore, clipboard, nativeImage, controlled.hook,
    );
    try {
      await runtime.initialize();
      expect(controlled.press()).toBe(true);
      await expect(runtime.refreshFromStore()).resolves.toEqual({ direction: "forward", itemIds: [] });
      expect(stored).toEqual({ direction: "forward", itemIds: [] });
      expect(put).toHaveBeenCalledTimes(1);
      expect(attempts).toEqual([{ endpoint, payload: { kind: "files", paths: filePaths } }]);

      await runtime.replace(initial);
      put.mockClear();
      failWrite = true;
      expect(controlled.press()).toBe(false);
      await expect(runtime.refreshFromStore()).resolves.toEqual(initial);
      expect(stored).toEqual(initial);
      expect(put).not.toHaveBeenCalled();
      expect(attempts).toHaveLength(2);
    } finally {
      runtime.dispose();
      hostClipboard.close();
    }
  });

  it("leaves a pending-permission queue intact and never replays the first denied call", async () => {
    const paths = resolveOriginalPaths(sourceRootSetting!);
    expect(createHash("sha256").update(readFileSync(paths.runtime)).digest("hex"))
      .toBe(EXPECTED_STACK_RUNTIME_SHA256);
    const original = await loadOriginalRuntime(paths.runtime, paths.coreIndex);
    const requestPermission = vi.fn();
    const transport = vi.fn(() => null);
    const hostClipboard = createHostClipboardBridge({
      instanceId: "12345678-1234-4234-8234-123456789abc",
    }, requestPermission, transport);
    const clipboard = productionClipboard(hostClipboard);
    const initial = { direction: "forward", itemIds: ["file-record"] };
    const filePaths = ["/tmp/Paste & data/pending.txt"];
    let stored = structuredClone(initial);
    const put = vi.fn(async (next: typeof initial) => {
      stored = structuredClone(next);
      return structuredClone(next);
    });
    const stackStore = { async get() { return structuredClone(stored); }, put };
    const clipboardStore = {
      async findRecordByItemId(id: string) {
        return id === "file-record" ? {
          item: { id, kind: "files", payload: { filePaths } },
          origin: { host: "sync", remoteAvailable: true },
        } : undefined;
      },
    };
    const nativeImage = { createFromPath: () => { throw new Error("unexpected image load"); } };
    const controlled = controlledPasteHook();
    const runtime = new original.PasteStackRuntime(
      stackStore, clipboardStore, clipboard, nativeImage, controlled.hook,
    );
    try {
      await runtime.initialize();
      expect(controlled.press()).toBe(false);
      expect(controlled.press()).toBe(false);
      await expect(runtime.refreshFromStore()).resolves.toEqual(initial);
      expect(stored).toEqual(initial);
      expect(put).not.toHaveBeenCalled();
      expect(requestPermission.mock.calls).toEqual([["content_write"]]);
      expect(transport).not.toHaveBeenCalled();

      hostClipboard.install("content_write", CONTENT_WRITE_ENDPOINT);
      expect(transport).not.toHaveBeenCalled();
      expect(stored).toEqual(initial);
      expect(put).not.toHaveBeenCalled();

      expect(controlled.press()).toBe(true);
      await expect(runtime.refreshFromStore()).resolves.toEqual({ direction: "forward", itemIds: [] });
      expect(stored).toEqual({ direction: "forward", itemIds: [] });
      expect(put).toHaveBeenCalledTimes(1);
      expect(requestPermission.mock.calls).toEqual([["content_write"]]);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transport).toHaveBeenCalledWith(CONTENT_WRITE_ENDPOINT, { kind: "files", paths: filePaths });
    } finally {
      runtime.dispose();
      hostClipboard.close();
    }
  });
});
