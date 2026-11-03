// @vitest-environment node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import vm from "node:vm";
import { expect, it, vi } from "vitest";
import { createPluginClipboardApi } from "../../src/lib/pluginUtoolsBridgeSource/clipboard-api";
import { createClipboardHistoryCodec } from "../../src/lib/pluginUtoolsBridgeSource/clipboard-history";

// This opt-in contract executes the unchanged original mirror and normalizer
// against the production frontend clipboard API. It does not start Tauri,
// WebView, the Node sidecar, or the full Paste preload, and it is not UI acceptance.
const sourceRootSetting = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
const runOriginalContract = sourceRootSetting ? it : it.skip;

type PathSet = {
  pluginDir: string;
  entry: string;
  recordIndex: string;
  coreIndex: string;
};

function resolveOriginalPaths(sourceRoot: string): PathSet {
  const root = resolve(sourceRoot);
  const pluginDir = [root, join(root, "pasteboard-pro"), join(root, "plugins/pasteboard-pro")]
    .find(candidate => existsSync(join(candidate, "apps/ztools/preload/clipboard-store.ts"))) ?? root;
  return {
    pluginDir,
    entry: join(pluginDir, "apps/ztools/preload/clipboard-store.ts"),
    recordIndex: join(pluginDir, "apps/ztools/preload/record-index.ts"),
    coreIndex: join(pluginDir, "packages/core/src/index.ts"),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function loadOriginalStore(paths: PathSet) {
  const requireFromTest = createRequire(import.meta.url);
  const vitePackagePath = requireFromTest.resolve("vite/package.json");
  const requireFromVite = createRequire(vitePackagePath);
  type EsbuildApi = {
    build(options: {
      entryPoints: string[];
      bundle: boolean;
      platform: "node";
      format: "cjs";
      write: false;
      logLevel: "silent";
      alias: Record<string, string>;
    }): Promise<{ outputFiles: Array<{ text: string }> }>;
  };
  const esbuild = requireFromVite("esbuild") as EsbuildApi;
  const bundle = await esbuild.build({
    entryPoints: [paths.entry],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    logLevel: "silent",
    alias: { "@pasteboard-pro/core": paths.coreIndex },
  });
  const output = bundle.outputFiles[0];
  if (!output) throw new Error("esbuild did not return the original clipboard-store bundle");

  const loadedModule: { exports: Record<string, unknown> } = { exports: {} };
  vm.runInNewContext(output.text, {
    module: loadedModule,
    exports: loadedModule.exports,
    require: createRequire(paths.entry),
    Buffer,
    process,
    console,
  }, { timeout: 10_000, filename: paths.entry });
  const exports = loadedModule.exports as Record<string, unknown>;
  if (typeof exports.mirrorHostHistory !== "function"
    || typeof exports.normalizeHostClipboardItem !== "function") {
    throw new Error("Original clipboard-store bundle is missing the expected exports");
  }
  return exports as {
    mirrorHostHistory: (host: unknown, store: unknown, options: Record<string, unknown>) => Promise<unknown>;
    normalizeHostClipboardItem: (value: unknown, deviceId: string) => unknown;
  };
}

function historyRows() {
  const text = {
    id: "clip-1111111111111111", type: "text", timestamp: 1_800_000_000_003,
    preview: "copied text 🧭", content: "copied text 🧭",
  };
  const imagePath = "/Users/harris/Pictures/paste-history/image.png";
  const image = {
    id: "clip-image-2222222222222222", type: "image", timestamp: 1_800_000_000_002,
    preview: "image.png", content: imagePath, imagePath, byteSize: 734_003,
  };
  const filePaths = ["/tmp/paste input/one.txt", "/tmp/paste input/二.png"];
  const files = {
    id: "clip-file-3333333333333333", type: "file", timestamp: 1_800_000_000_001,
    preview: "2 files", files: filePaths.map((path, index) => ({ path, name: index ? "二.png" : "one.txt" })),
    content: filePaths,
  };
  return { rows: [text, image, files], imagePath, filePaths };
}

function permissionedHistoryHost(rows: unknown[], pageOverride?: number) {
  const instanceId = "12345678-1234-4234-8234-123456789abc";
  const historyRead = vi.fn((payload: Record<string, unknown>) => {
    if (payload.operation !== "list") return null;
    return { items: rows, total: rows.length, page: pageOverride ?? payload.page, pageSize: payload.pageSize };
  });
  return {
    instanceId,
    ensureAccess: vi.fn(async (access: string) => {
      if (access !== "history_read") throw new Error(`Unexpected permission: ${access}`);
    }),
    historyRead,
  };
}

function canonicalStore() {
  const records: Array<{ item: { contentFingerprint: string; payload: unknown }; origin: Record<string, unknown> }> = [];
  let cursor: { id: string; timestamp: number } | undefined;
  const put = vi.fn(async (record: (typeof records)[number]) => { records.push(record); });
  const setCursor = vi.fn(async (value: { id: string; timestamp: number }) => { cursor = value; });
  return {
    records,
    put,
    setCursor,
    findByFingerprint: vi.fn(async (fingerprint: string) =>
      records.find(record => record.item.contentFingerprint === fingerprint)?.item),
    getCursor: vi.fn(async () => cursor),
    cursor: () => cursor,
  };
}

runOriginalContract("mirrors mixed production clipboard history through Harris's unchanged normalizer", async () => {
  const paths = resolveOriginalPaths(sourceRootSetting!);
  const sourceFiles = [paths.entry, paths.recordIndex, paths.coreIndex];
  for (const path of sourceFiles) expect(existsSync(path), `Original package source exists: ${path}`).toBe(true);
  const originalHashes = new Map(sourceFiles.map(path => [path, sha256(path)]));

  vi.stubGlobal("window", {});
  try {
    const original = await loadOriginalStore(paths);
    const { rows, imagePath, filePaths } = historyRows();
    const host = permissionedHistoryHost(rows);
    const api = createPluginClipboardApi(vi.fn(), () => host as never, undefined, createClipboardHistoryCodec);
    const page = await api.getHistory(1, 10) as { items: unknown[]; total: number; page: number; pageSize: number };

    expect(host.ensureAccess).toHaveBeenCalledWith("history_read");
    expect(page).toMatchObject({ total: 3, page: 1, pageSize: 10 });
    expect(page.items).toHaveLength(3);
    expect(JSON.stringify(page.items)).not.toContain("base64,");

    const imageRow = page.items.find(item => (item as { type?: unknown }).type === "image");
    expect(imageRow).toBeDefined();
    expect(imageRow).toMatchObject({ imagePath, content: imagePath, byteSize: 734_003 });
    const imageRecord = original.normalizeHostClipboardItem(imageRow, "atools-host");
    expect(imageRecord).toMatchObject({ origin: { host: "ztools", imagePath, blobBytes: 734_003 } });
    expect(JSON.stringify(imageRecord)).not.toContain("base64,");

    const store = canonicalStore();
    const options = { deviceId: "atools-host", pageSize: 10, maxPages: 1 };
    await expect(original.mirrorHostHistory(api, store, options)).resolves.toMatchObject({ imported: 3, skipped: 0, pages: 1 });
    expect(store.put).toHaveBeenCalledTimes(3);
    expect(store.records.map(record => record.item.payload)).toContainEqual(expect.objectContaining({
      filePaths,
    }));
    expect(store.records.find(record => record.origin.imagePath === imagePath)?.origin).toMatchObject({
      host: "ztools", imagePath, blobBytes: 734_003,
    });
    expect(store.cursor()).toEqual({ id: rows[0].id, timestamp: rows[0].timestamp });
    expect(JSON.stringify(store.records)).not.toContain("base64,");

    await expect(original.mirrorHostHistory(api, store, options)).resolves.toMatchObject({ imported: 0, skipped: 3, pages: 1 });
    expect(store.put).toHaveBeenCalledTimes(3);
    expect(store.cursor()).toEqual({ id: rows[0].id, timestamp: rows[0].timestamp });

    const invalidHost = permissionedHistoryHost(rows, 2);
    const invalidApi = createPluginClipboardApi(vi.fn(), () => invalidHost as never, undefined, createClipboardHistoryCodec);
    const untouchedStore = canonicalStore();
    await expect(original.mirrorHostHistory(invalidApi, untouchedStore, options))
      .rejects.toMatchObject({ code: "ERR_ATOOLS_CLIPBOARD_RESPONSE" });
    expect(untouchedStore.put).not.toHaveBeenCalled();
    expect(untouchedStore.setCursor).not.toHaveBeenCalled();
    expect(untouchedStore.cursor()).toBeUndefined();
  } finally {
    try {
      for (const path of sourceFiles) expect(sha256(path), `Original source unchanged: ${path}`).toBe(originalHashes.get(path));
    } finally {
      vi.unstubAllGlobals();
    }
  }
});
