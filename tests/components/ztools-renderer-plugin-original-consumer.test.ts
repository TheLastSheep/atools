import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ts from "typescript";
import { createZtoolsRendererHostAdapter } from "../../packages/ztools-renderer/src/hostAdapter";
import { NAMESPACED_READ_KEYS } from "../../packages/ztools-renderer/src/startupReadModel";
import type {
  RendererHostCommand,
  RendererHostListener,
  RendererHostUnlisten,
  ZToolsRendererTransport,
} from "../../packages/ztools-renderer/src/types";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const explicitZtoolsSource = process.env.ATOOLS_ZTOOLS_SOURCE;
const hasExplicitZtoolsSource = explicitZtoolsSource !== undefined;
const ZTOOLS_ROOT = hasExplicitZtoolsSource
  ? path.resolve(explicitZtoolsSource)
  : path.resolve(REPO_ROOT, "..", "ZTools");
const ZTOOLS_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const ZTOOLS_PACKAGE = path.join(ZTOOLS_ROOT, "package.json");
const ZTOOLS_SRC = path.join(ZTOOLS_ROOT, "src");
const PLUGINS_CHANGED_EVENT = "atools://renderer-plugins-changed";
const ENABLED_MAIN_PUSH_KEY = "enabled-main-push-plugin";
const pinnedSourceAvailable = existsSync(ZTOOLS_PACKAGE);
const testWindow = window as unknown as Record<string, unknown>;
const previousZtools = testWindow.ztools;
const MAX_PINNED_SOURCE_FILES = 16;
const MAX_PINNED_SOURCE_BYTES = 512 * 1024;
const ALLOWED_UPSTREAM_PACKAGES = new Set(["typescript", "pinia", "vue", "fuse.js", "pinyin-pro"]);
const pinnedSourceFiles = new Map<string, number>();

function requireAllowlistedPackage(upstreamRequire: NodeRequire, packageName: string): unknown {
  if (!ALLOWED_UPSTREAM_PACKAGES.has(packageName)) {
    throw new Error(`Unexpected pinned consumer dependency: ${packageName}`);
  }
  return upstreamRequire(packageName);
}

function registerPinnedSourceFile(filename: string): string {
  const sourceRoot = realpathSync(ZTOOLS_SRC);
  const realFile = realpathSync(filename);
  const relative = path.relative(sourceRoot, realFile);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Pinned consumer source escaped checkout src: ${filename}`);
  }
  if (!statSync(realFile).isFile()) throw new Error(`Pinned source is not a file: ${relative}`);
  if (!pinnedSourceFiles.has(realFile)) {
    const nextBytes =
      [...pinnedSourceFiles.values()].reduce((sum, size) => sum + size, 0) + statSync(realFile).size;
    if (pinnedSourceFiles.size >= MAX_PINNED_SOURCE_FILES || nextBytes > MAX_PINNED_SOURCE_BYTES) {
      throw new Error("Pinned consumer source budget exceeded");
    }
    pinnedSourceFiles.set(realFile, statSync(realFile).size);
  }
  return realFile;
}

function readPinnedSource(filename: string): string {
  return readFileSync(registerPinnedSourceFile(filename), "utf8");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function makePlugin(id: string, name: string, command: string) {
  return {
    id,
    name,
    version: "1.0.0",
    path: `/fixture/plugins/${id}`,
    enabled: true,
    source_kind: "external",
    manifest: {
      name,
      title: name,
      version: "1.0.0",
      main: "index.html",
      features: [{ code: `${id}-feature`, cmds: [command] }],
    },
  };
}

function settingsSnapshot(): Record<string, unknown> {
  const keys = [
    "settings-general",
    ...[...NAMESPACED_READ_KEYS].map((key) => `ztools-renderer:${key}`),
  ];
  return { version: 1, settings: Object.fromEntries(keys.map((key) => [key, null])) };
}

function createTransport() {
  let plugins: unknown[] = [];
  const calls: RendererHostCommand[] = [];
  const listeners = new Map<string, Set<RendererHostListener>>();
  const transport: ZToolsRendererTransport = {
    async invoke(command) {
      calls.push(command);
      if (command === "list_plugins") return JSON.parse(JSON.stringify(plugins));
      if (command === "get_ztools_renderer_settings") return settingsSnapshot();
      throw new Error(`Unexpected renderer command: ${command}`);
    },
    async listen(event, handler): Promise<RendererHostUnlisten> {
      const handlers = listeners.get(event) ?? new Set<RendererHostListener>();
      handlers.add(handler);
      listeners.set(event, handlers);
      return () => handlers.delete(handler);
    },
  };

  return {
    transport,
    calls,
    setPlugins(value: unknown[]) { plugins = value; },
    emit(event: string, payload: unknown = null) {
      for (const handler of [...(listeners.get(event) ?? [])]) handler(payload);
    },
  };
}

function resolvePinnedModulePath(fromFile: string, request: string): string {
  if (request.startsWith("@shared/")) {
    return registerPinnedSourceFile(
      path.join(ZTOOLS_SRC, "shared", `${request.slice("@shared/".length)}.ts`),
    );
  }
  const base = path.resolve(path.dirname(fromFile), request);
  if (path.extname(base)) {
    if (!new Set([".ts", ".png"]).has(path.extname(base))) {
      throw new Error(`Unsupported pinned source module: ${request}`);
    }
    return registerPinnedSourceFile(base);
  }
  for (const extension of [".ts", ".png"]) {
    if (existsSync(`${base}${extension}`)) return registerPinnedSourceFile(`${base}${extension}`);
  }
  throw new Error(`Pinned source dependency not found: ${request}`);
}

function loadPinnedTypeScript(
  entryPath: string,
  compiler: typeof import("typescript"),
): Record<string, any> {
  const upstreamRequire = createRequire(ZTOOLS_PACKAGE);
  const cache = new Map<string, { exports: Record<string, any> }>();

  function loadFile(filename: string): unknown {
    const absolutePath = registerPinnedSourceFile(filename);
    const cached = cache.get(absolutePath);
    if (cached) return cached.exports;
    if (path.extname(absolutePath) === ".png") {
      return `fixture-asset:${path.basename(absolutePath)}`;
    }

    const source = readPinnedSource(absolutePath);
    const moduleRecord = { exports: {} as Record<string, any> };
    cache.set(absolutePath, moduleRecord);
    const compiled = compiler.transpileModule(source, {
      fileName: absolutePath,
      compilerOptions: {
        module: compiler.ModuleKind.CommonJS,
        target: compiler.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    });
    const localRequire = (request: string): unknown => {
      if (request.startsWith(".") || request.startsWith("@shared/")) {
        return loadFile(resolvePinnedModulePath(absolutePath, request));
      }
      return requireAllowlistedPackage(upstreamRequire, request);
    };
    new Function("require", "module", "exports", compiled.outputText)(
      localRequire,
      moduleRecord,
      moduleRecord.exports,
    );
    return moduleRecord.exports;
  }

  return loadFile(entryPath);
}

function loadActualPluginsChangedCallback(
  store: Record<string, any>,
  compiler: typeof import("typescript"),
): () => Promise<void> {
  const appPath = path.join(ZTOOLS_ROOT, "src/renderer/src/App.vue");
  const sfc = readPinnedSource(appPath);
  const script = sfc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("Pinned App.vue script setup was not found");

  const sourceFile = compiler.createSourceFile(
    appPath,
    script,
    compiler.ScriptTarget.Latest,
    true,
    compiler.ScriptKind.TS,
  );
  const callbacks: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      compiler.isCallExpression(node) &&
      node.expression.getText(sourceFile) === "window.ztools.onPluginsChanged"
    ) {
      if (node.arguments[0]) callbacks.push(node.arguments[0]);
    }
    compiler.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (callbacks.length !== 1) {
    throw new Error(`Expected one pinned onPluginsChanged callback, found ${callbacks.length}`);
  }

  const moduleRecord = { exports: undefined as unknown };
  const compiled = compiler.transpileModule(
    `module.exports = (${callbacks[0].getText(sourceFile)});`,
    {
      compilerOptions: {
        module: compiler.ModuleKind.CommonJS,
        target: compiler.ScriptTarget.ES2022,
      },
    },
  );
  new Function("module", "exports", "commandDataStore", compiled.outputText)(
    moduleRecord,
    moduleRecord.exports,
    store,
  );
  if (typeof moduleRecord.exports !== "function") {
    throw new Error("Pinned App.vue onPluginsChanged callback did not compile to a function");
  }
  return moduleRecord.exports as () => Promise<void>;
}

const itWithPinnedSource = pinnedSourceAvailable || hasExplicitZtoolsSource ? it : it.skip;

describe("pinned original plugin-change consumer through the ATools host adapter", () => {
  afterEach(() => {
    if (previousZtools === undefined) delete testWindow.ztools;
    else testWindow.ztools = previousZtools;
  });

  itWithPinnedSource("serializes real App.vue refreshes so the newer plugin command wins", async () => {
    expect(existsSync(ZTOOLS_PACKAGE)).toBe(true);
    expect(execFileSync("git", ["-C", ZTOOLS_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim())
      .toBe(ZTOOLS_COMMIT);
    expect(execFileSync("git", ["-C", ZTOOLS_ROOT, "status", "--porcelain", "--untracked-files=normal"], {
      encoding: "utf8",
    }).trim()).toBe("");

    const upstreamRequire = createRequire(ZTOOLS_PACKAGE);
    const compiler = requireAllowlistedPackage(upstreamRequire, "typescript") as typeof import("typescript");
    const upstreamPinia = requireAllowlistedPackage(upstreamRequire, "pinia") as {
      createPinia: () => unknown;
      setActivePinia(pinia: unknown): void;
    };
    const pinnedDataStore = loadPinnedTypeScript(
      path.join(ZTOOLS_ROOT, "src/renderer/src/stores/commandDataStore.ts"),
      compiler,
    ) as Record<string, any>;
    const pinnedShared = loadPinnedTypeScript(
      path.join(ZTOOLS_ROOT, "src/shared/pluginSettings.ts"),
      compiler,
    ) as Record<string, any>;
    expect(pinnedShared.ENABLED_MAIN_PUSH_PLUGINS_KEY).toBe(ENABLED_MAIN_PUSH_KEY);

    upstreamPinia.setActivePinia(upstreamPinia.createPinia());
    const store = pinnedDataStore.useCommandDataStore() as Record<string, any>;
    const originalReload = store.reloadPluginAvailabilityData.bind(store);
    const reloads: Promise<void>[] = [];
    const appliedPluginNames: string[][] = [];
    let activeReloads = 0;
    let maxConcurrentReloads = 0;
    store.reloadPluginAvailabilityData = () => {
      activeReloads += 1;
      maxConcurrentReloads = Math.max(maxConcurrentReloads, activeReloads);
      const pending = originalReload();
      const observed = pending.then((value: void) => {
        appliedPluginNames.push([...new Set(
          store.commands
            .filter((command: any) => command.type === "plugin")
            .map((command: any) => command.pluginName),
        )].sort());
        return value;
      }).finally(() => { activeReloads -= 1; });
      reloads.push(observed);
      return observed;
    };

    const fixture = createTransport();
    const adapter = createZtoolsRendererHostAdapter({ transport: fixture.transport });
    const heldOldDbGet = deferred<void>();
    const oldDbGetStarted = deferred<void>();
    let holdFirstRead = true;
    const api = new Proxy(adapter.api, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "dbGet") return value;
        return async (key: string): Promise<unknown> => {
          const result = await value(key);
          if (key === ENABLED_MAIN_PUSH_KEY && holdFirstRead) {
            holdFirstRead = false;
            oldDbGetStarted.resolve();
            await heldOldDbGet.promise;
          }
          return result;
        };
      },
    });
    testWindow.ztools = api;
    const onPluginsChanged = loadActualPluginsChangedCallback(store, compiler);
    const unlisten = adapter.api.onPluginsChanged(onPluginsChanged);

    try {
      fixture.setPlugins([makePlugin("old", "Old plugin", "old-command")]);
      fixture.emit(PLUGINS_CHANGED_EVENT);
      await oldDbGetStarted.promise;
      await vi.waitFor(() => {
        expect(adapter.snapshot().pluginCatalog).toMatchObject({ cachedPlugins: 1, readPending: false });
      });
      await Promise.resolve();
      expect(reloads).toHaveLength(1);

      fixture.setPlugins([makePlugin("new", "New plugin", "new-command")]);
      const priorGeneration = adapter.snapshot().pluginCatalog.generation;
      fixture.emit(PLUGINS_CHANGED_EVENT);
      await vi.waitFor(() => {
        expect(adapter.snapshot().pluginCatalog.generation).toBe(priorGeneration + 1);
      });
      for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
      if (reloads.length === 2) {
        // The current non-serial consumer can finish the new event while the old
        // event is held. Let that observable race complete before releasing old data.
        await reloads[1];
        expect(store.commands.some((command: any) => command.name === "new-command")).toBe(true);
      }

      heldOldDbGet.resolve();
      await vi.waitFor(() => expect(reloads).toHaveLength(2));
      await Promise.all(reloads);

      expect(store.commands.some((command: any) => command.name === "new-command")).toBe(true);
      expect(store.commands.some((command: any) => command.name === "old-command")).toBe(false);
      expect(appliedPluginNames).toEqual([["Old plugin"], ["New plugin"]]);
      expect(maxConcurrentReloads).toBe(1);
      expect(fixture.calls).not.toContain("list_launcher_apps");
    } finally {
      heldOldDbGet.resolve();
      await Promise.allSettled(reloads);
      unlisten();
      adapter.dispose();
    }
  }, 15_000);
});
