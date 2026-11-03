import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import type * as ts from "typescript";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type { RendererHostCommand, ZToolsRendererTransport } from "../../packages/ztools-renderer/src/types";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ZTOOLS_ROOT = path.resolve(process.env.ATOOLS_ZTOOLS_SOURCE ?? path.join(REPO_ROOT, "..", "ZTools"));
const ZTOOLS_PACKAGE = path.join(ZTOOLS_ROOT, "package.json");
const ZTOOLS_SRC = path.join(ZTOOLS_ROOT, "src");
const ZTOOLS_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const STORE_PATH = path.join(ZTOOLS_SRC, "renderer/src/stores/commandDataStore.ts");
const SEARCH_RESULTS_PATH = path.join(ZTOOLS_SRC, "renderer/src/components/search/SearchResults.vue");
const COMPATIBILITY_PATCH_PATH = path.join(REPO_ROOT, "packages/ztools-renderer/upstream-compatibility-patches.mjs");
const PINNED_SOURCE_AVAILABLE = existsSync(ZTOOLS_PACKAGE) && existsSync(STORE_PATH);
const previousZtools = (window as unknown as Record<string, unknown>).ztools;
const MAX_SOURCE_FILES = 16;
const MAX_SOURCE_BYTES = 512 * 1024;
const ALLOWED_PACKAGES = new Set(["typescript", "pinia", "vue", "fuse.js", "pinyin-pro"]);

afterEach(() => {
  if (previousZtools === undefined) delete (window as unknown as Record<string, unknown>).ztools;
  else (window as unknown as Record<string, unknown>).ztools = previousZtools;
  vi.restoreAllMocks();
});

function loadPinnedStore(
  compiler: typeof import("typescript"),
  transformSource?: (relativePath: string, source: string) => string,
): Record<string, any> {
  const sourceRoot = realpathSync(ZTOOLS_SRC);
  const upstreamRequire = createRequire(ZTOOLS_PACKAGE);
  const sourceFiles = new Map<string, number>();
  const cache = new Map<string, { exports: Record<string, any> }>();

  function pinnedFile(filename: string): string {
    const realFile = realpathSync(filename);
    const relative = path.relative(sourceRoot, realFile);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Pinned store source escaped checkout src: ${filename}`);
    }
    const size = statSync(realFile).size;
    if (!sourceFiles.has(realFile)) {
      const bytes = [...sourceFiles.values()].reduce((sum, item) => sum + item, 0) + size;
      if (sourceFiles.size >= MAX_SOURCE_FILES || bytes > MAX_SOURCE_BYTES) throw new Error("Pinned source budget exceeded");
      sourceFiles.set(realFile, size);
    }
    return realFile;
  }

  function resolveModule(fromFile: string, request: string): string {
    if (request.startsWith("@shared/")) {
      return pinnedFile(path.join(sourceRoot, "shared", `${request.slice("@shared/".length)}.ts`));
    }
    const base = path.resolve(path.dirname(fromFile), request);
    if (path.extname(base)) {
      if (!new Set([".ts", ".png"]).has(path.extname(base))) throw new Error(`Unsupported pinned module: ${request}`);
      return pinnedFile(base);
    }
    for (const extension of [".ts", ".png"]) {
      if (existsSync(`${base}${extension}`)) return pinnedFile(`${base}${extension}`);
    }
    throw new Error(`Pinned store dependency not found: ${request}`);
  }

  function loadFile(filename: string): unknown {
    const absolutePath = pinnedFile(filename);
    const existing = cache.get(absolutePath);
    if (existing) return existing.exports;
    if (path.extname(absolutePath) === ".png") return `fixture-asset:${path.basename(absolutePath)}`;

    const moduleRecord = { exports: {} as Record<string, any> };
    cache.set(absolutePath, moduleRecord);
    const relativePath = path.relative(sourceRoot, absolutePath).split(path.sep).join("/");
    const source = transformSource
      ? transformSource(relativePath, readFileSync(absolutePath, "utf8"))
      : readFileSync(absolutePath, "utf8");
    const compiled = compiler.transpileModule(source, {
      fileName: absolutePath,
      compilerOptions: {
        module: compiler.ModuleKind.CommonJS,
        target: compiler.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const localRequire = (request: string): unknown => {
      if (request.startsWith(".") || request.startsWith("@shared/")) return loadFile(resolveModule(absolutePath, request));
      if (!ALLOWED_PACKAGES.has(request)) throw new Error(`Unexpected pinned store dependency: ${request}`);
      return upstreamRequire(request);
    };
    new Function("require", "module", "exports", compiled.outputText)(localRequire, moduleRecord, moduleRecord.exports);
    return moduleRecord.exports;
  }

  return loadFile(STORE_PATH) as Record<string, any>;
}

function createTransport(
  calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }>,
  settingsOverrides: Record<string, string | null> = {},
): ZToolsRendererTransport {
  return {
    async invoke(command, args) {
      calls.push({ command, args });
      if (command === "get_ztools_renderer_settings") {
        return {
          version: 1,
          settings: Object.fromEntries([
            "settings-general",
            ...Array.from(NAMESPACED_READ_KEYS, (key) => `ztools-renderer:${key}`),
          ].map((key) => [key, settingsOverrides[key] ?? null])),
        };
      }
      if (command === "list_launcher_apps" || command === "list_plugins") return [];
      if (command === "save_renderer_recommendation_pins") {
        const mutation = args?.value as { kind: string; pin?: unknown };
        if (args?.expected !== null || mutation?.kind !== "append" || !mutation.pin) {
          throw new Error("Unexpected recommendation pin mutation fixture");
        }
        return { version: 1, changed: true, raw: JSON.stringify([mutation.pin]) };
      }
      throw new Error(`Unexpected renderer command: ${command}`);
    },
    async listen() { return () => undefined; },
  };
}

type ReviewedPatchApi = {
  RENDERER_COMPATIBILITY_PATCHES: Array<{
    id: string;
    path: string;
    beforeSha256: string;
    afterSha256: string;
  }>;
  applyReviewedRendererCompatibilityPatch(
    relativePath: string,
    source: string,
  ): null | { code: string; patch: { id: string; path: string; beforeSha256: string; afterSha256: string } };
  createReviewedRendererCompatibilityPlugin(upstreamRoot: string): {
    plugin: { transform(code: string, id: string): string | null };
    assertApplied(): Array<{ id: string; path: string; beforeSha256: string; afterSha256: string }>;
  };
};

async function loadReviewedPatchApi(): Promise<ReviewedPatchApi> {
  return await import(pathToFileURL(COMPATIBILITY_PATCH_PATH).href) as ReviewedPatchApi;
}

it.skipIf(!PINNED_SOURCE_AVAILABLE)("routes the pinned original recommendation store through the dedicated host command", async () => {
  expect(execFileSync("git", ["-C", ZTOOLS_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(ZTOOLS_COMMIT);
  expect(execFileSync("git", ["-C", ZTOOLS_ROOT, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim()).toBe("");

  const upstreamRequire = createRequire(ZTOOLS_PACKAGE);
  const compiler = upstreamRequire("typescript") as typeof import("typescript");
  const pinia = upstreamRequire("pinia") as { createPinia(): unknown; setActivePinia(pinia: unknown): void };
  pinia.setActivePinia(pinia.createPinia());
  const { useCommandDataStore } = loadPinnedStore(compiler);
  const calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }> = [];
  const adapter = createZtoolsRendererHostAdapter({ transport: createTransport(calls) });
  const api = new Proxy(adapter.api as unknown as Record<string, unknown>, {
    get(target, property, receiver) {
      if (property === "getApps") return async () => [];
      if (property === "getAllPlugins" || property === "getDisabledPlugins") return async () => [];
      if (property === "getPlatform") return () => "darwin";
      if (property === "localShortcuts") return { getAll: async () => [] };
      if (typeof property === "string" && property.startsWith("on")) return () => () => undefined;
      return Reflect.get(target, property, receiver);
    },
  });
  (window as unknown as Record<string, unknown>).ztools = api;
  const store = useCommandDataStore();
  const command = {
    name: "固定验收项",
    path: "/fixture/unstarted-plugin.asar",
    type: "plugin",
    featureCode: "fixture-feature",
    pluginName: "unstarted-plugin",
  };

  try {
    await store.initializeData();
    await store.pinRecommendation(command);
    expect(store.isRecommendationPinned(command)).toBe(true);
    expect(calls.map(({ command: name }) => name)).toEqual([
      "get_ztools_renderer_settings",
      "save_renderer_recommendation_pins",
    ]);
    expect(calls[1]?.args).toEqual({
      expected: null,
      value: {
        kind: "append",
        pin: {
          path: command.path,
          featureCode: command.featureCode,
          name: command.name,
          pluginName: command.pluginName,
          type: command.type,
        },
      },
    });
    const mutation = calls[1]?.args?.value as { pin: unknown };
    await expect(adapter.api.dbGet("recommendation-pinned")).resolves.toEqual([mutation.pin]);
    expect(calls.map(({ command: name }) => name)).toEqual([
      "get_ztools_renderer_settings",
      "save_renderer_recommendation_pins",
    ]);
  } finally {
    adapter.dispose();
  }
});

it.skipIf(!PINNED_SOURCE_AVAILABLE)(
  "reconciles pinned original local-shortcut history and pins by path and carries renamed persistedName",
  async () => {
    expect(execFileSync("git", ["-C", ZTOOLS_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(ZTOOLS_COMMIT);
    expect(execFileSync("git", ["-C", ZTOOLS_ROOT, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" }).trim()).toBe("");

    const pathA = "/fixture/left/Shared Tool.app";
    const pathB = "/fixture/right/Shared Tool.app";
    const history = [{
      path: pathB,
      name: "Shared Tool",
      type: "direct",
      subType: "local-shortcut",
      lastUsed: 10,
      useCount: 1,
    }];
    const pins = [{
      path: pathB,
      name: "Shared Tool",
      type: "direct",
      subType: "local-shortcut",
    }];
    const upstreamRequire = createRequire(ZTOOLS_PACKAGE);
    const compiler = upstreamRequire("typescript") as typeof import("typescript");
    const pinia = upstreamRequire("pinia") as { createPinia(): unknown; setActivePinia(pinia: unknown): void };
    pinia.setActivePinia(pinia.createPinia());
    const compatibility = await loadReviewedPatchApi();
    const { useCommandDataStore } = loadPinnedStore(compiler, (relativePath, source) => {
      const pinnedPath = `src/${relativePath}`;
      const patched = compatibility.applyReviewedRendererCompatibilityPatch(pinnedPath, source);
      return patched?.code ?? source;
    });
    const calls: Array<{ command: RendererHostCommand; args?: Record<string, unknown> }> = [];
    const adapter = createZtoolsRendererHostAdapter({
      transport: createTransport(calls, {
        "ztools-renderer:command-history": JSON.stringify(history),
        "ztools-renderer:pinned-commands": JSON.stringify(pins),
      }),
    });
    const localShortcuts = [
      {
        id: "shortcut-a",
        name: "Shared Tool",
        path: pathA,
        type: "file",
        addedAt: 1,
        pinyin: "sharedtool",
        pinyinAbbr: "st",
      },
      {
        id: "shortcut-b",
        name: "Shared Tool",
        alias: "Renamed Tool",
        path: pathB,
        type: "file",
        addedAt: 2,
        pinyin: "renamedtool",
        pinyinAbbr: "rt",
      },
    ];
    const api = new Proxy(adapter.api as unknown as Record<string, unknown>, {
      get(target, property, receiver) {
        if (property === "getApps") return async () => [];
        if (property === "getAllPlugins" || property === "getDisabledPlugins") return async () => [];
        if (property === "getPlatform") return () => "darwin";
        if (property === "localShortcuts") return { getAll: async () => localShortcuts };
        if (typeof property === "string" && property.startsWith("on")) return () => () => undefined;
        return Reflect.get(target, property, receiver);
      },
    });
    (window as unknown as Record<string, unknown>).ztools = api;

    try {
      const store = useCommandDataStore();
      await store.initializeData();
      expect(store.getRecentCommands()).toMatchObject([
        { path: pathB, name: "Renamed Tool", persistedName: "Shared Tool" },
      ]);
      expect(store.getPinnedCommands()).toMatchObject([
        { path: pathB, name: "Renamed Tool", persistedName: "Shared Tool" },
      ]);
    } finally {
      adapter.dispose();
    }
  },
);

it.skipIf(!PINNED_SOURCE_AVAILABLE)(
  "applies all fixed, hash-locked renderer compatibility patches",
  async () => {
    const compatibility = await loadReviewedPatchApi();
    const sourceRoot = realpathSync(ZTOOLS_ROOT);
    const storeSource = readFileSync(STORE_PATH, "utf8");
    const searchResultsSource = readFileSync(SEARCH_RESULTS_PATH, "utf8");
    const [storeDescriptor, searchResultsDescriptor, windowStoreDescriptor, dropDescriptor] = compatibility.RENDERER_COMPATIBILITY_PATCHES;
    expect(storeDescriptor).toMatchObject({
      id: "local-shortcut-history-pin-path-identity",
      path: "src/renderer/src/stores/commandDataStore.ts",
    });
    expect(searchResultsDescriptor).toMatchObject({
      id: "local-shortcut-and-app-global-shortcut-identity",
      path: "src/renderer/src/components/search/SearchResults.vue",
    });
    expect(windowStoreDescriptor).toMatchObject({
      id: "builtin-shortcuts-and-auto-update-startup-generation",
      path: "src/renderer/src/stores/windowStore.ts",
    });
    const windowStoreSource = readFileSync(path.resolve(sourceRoot, windowStoreDescriptor.path), "utf8");
    const windowStorePatch = compatibility.applyReviewedRendererCompatibilityPatch(windowStoreDescriptor.path, windowStoreSource);
    expect(windowStorePatch?.patch).toEqual(windowStoreDescriptor);

    const storePatch = compatibility.applyReviewedRendererCompatibilityPatch(
      storeDescriptor.path,
      storeSource,
    );
    const searchResultsPatch = compatibility.applyReviewedRendererCompatibilityPatch(
      searchResultsDescriptor.path,
      searchResultsSource,
    );
    expect(storePatch).not.toBeNull();
    expect(searchResultsPatch).not.toBeNull();
    expect(storePatch?.patch).toEqual(storeDescriptor);
    expect(searchResultsPatch?.patch).toEqual(searchResultsDescriptor);
    expect(searchResultsPatch?.code.match(/app\.subType === 'local-shortcut'/g)).toHaveLength(3);
    expect(
      compatibility.applyReviewedRendererCompatibilityPatch("src/renderer/src/main.ts", "unrelated"),
    ).toBeNull();
    expect(() =>
      compatibility.applyReviewedRendererCompatibilityPatch(
        storeDescriptor.path,
        `${storeSource}\n// unexpected source drift`,
      ),
    ).toThrow(/unexpected before hash/);

    const nonScriptHash = (source: string): string => {
      const scripts = [...source.matchAll(/<script setup lang="ts">[\s\S]*?<\/script>/g)];
      expect(scripts).toHaveLength(1);
      const nonScriptSource = source.replace(
        /<script setup lang="ts">[\s\S]*?<\/script>/,
        "<script setup lang=\"ts\">[reviewed script omitted]</script>",
      );
      return createHash("sha256").update(nonScriptSource, "utf8").digest("hex");
    };
    expect(nonScriptHash(searchResultsPatch!.code)).toBe(nonScriptHash(searchResultsSource));

    const plugin = compatibility.createReviewedRendererCompatibilityPlugin(sourceRoot);
    const storeId = path.resolve(sourceRoot, storeDescriptor.path);
    const searchResultsId = path.resolve(sourceRoot, searchResultsDescriptor.path);
    expect(plugin.plugin.transform(storeSource, `${searchResultsId}?vue&type=style&index=0`)).toBeNull();
    expect(() => plugin.assertApplied()).toThrow(/required source modules were not transformed/);
    expect(plugin.plugin.transform(storeSource, storeId)).toBe(storePatch!.code);
    expect(plugin.plugin.transform(searchResultsSource, searchResultsId)).toBe(searchResultsPatch!.code);
    expect(() => plugin.assertApplied()).toThrow(/required source modules were not transformed/);
    expect(plugin.plugin.transform(windowStoreSource, path.resolve(sourceRoot, windowStoreDescriptor.path))).toBe(windowStorePatch!.code);
    const dropSource = readFileSync(path.resolve(sourceRoot, dropDescriptor.path), "utf8");
    const dropPatch = compatibility.applyReviewedRendererCompatibilityPatch(dropDescriptor.path, dropSource);
    expect(plugin.plugin.transform(dropSource, path.resolve(sourceRoot, dropDescriptor.path))).toBe(dropPatch!.code);
    expect(plugin.assertApplied()).toEqual([storePatch!.patch, searchResultsPatch!.patch, windowStorePatch!.patch, dropPatch!.patch]);
    expect(() => plugin.plugin.transform(storeSource, storeId)).toThrow(/duplicate transform/);
  },
);
