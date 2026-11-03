// @vitest-environment node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import vm from "node:vm";
import { expect, it } from "vitest";
import { preparePluginPreload } from "../../src/lib/pluginPreload";

// Contract evidence for the unchanged original preload in a borrowed Node host.
// This does not exercise WebView IPC, native text transport, or editor UI.
// The VM is a test harness, not a security sandbox; denied imports observe only
// this fixture's selected optional side-effect entry points.
const sourceRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
it.skipIf(!sourceRoot)("runs Live Markdown services.cjs against fenced scratch files and recovers after async-save conflict", async () => {
  const pluginDir = resolve(sourceRoot!, "live-markdown");
  const preloadPath = join(pluginDir, "preload/services.cjs");
  const scratch = await mkdtemp(join(tmpdir(), "atools-harris-services-"));
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const sourceHashes = new Map<string, string>();
  const requireNode = createRequire(import.meta.url);
  const external: string[] = [];
  const deniedCalls: string[] = [];
  const fsCalls: string[] = [];
  const processModule = requireNode("process") as NodeJS.Process;
  const exitListenersBefore = processModule.listenerCount("exit");
  const ownedExitListeners = new Map<(...args: unknown[]) => void, (...args: unknown[]) => void>();
  const processFacade = Object.freeze({
    pid: 42_424,
    platform: processModule.platform,
    arch: processModule.arch,
    versions: processModule.versions,
    env: Object.freeze({
      HOME: scratch,
      LOCALAPPDATA: join(scratch, "local-app-data"),
      TMPDIR: scratch,
      XDG_DATA_HOME: join(scratch, "xdg-data"),
    }),
    cwd: () => scratch,
    on(event: string, listener: (...args: unknown[]) => void) {
      if (event !== "exit" || typeof listener !== "function") throw new Error(`Blocked process listener: ${event}`);
      ownedExitListeners.set(listener, listener);
      return this;
    },
    once(event: string, listener: (...args: unknown[]) => void) {
      if (event !== "exit" || typeof listener !== "function") throw new Error(`Blocked process listener: ${event}`);
      const once = (...args: unknown[]) => {
        if (!ownedExitListeners.has(listener)) return;
        ownedExitListeners.delete(listener);
        listener(...args);
      };
      ownedExitListeners.set(listener, once);
      return this;
    },
    removeListener(event: string, listener: (...args: unknown[]) => void) {
      if (event !== "exit") throw new Error(`Blocked process listener removal: ${event}`);
      ownedExitListeners.delete(listener);
      return this;
    },
  });
  const fsPathMethods = new Set([
    "accessSync", "chmodSync", "copyFileSync", "existsSync", "lstatSync", "mkdirSync", "openSync",
    "readFileSync", "readdirSync", "realpathSync", "renameSync", "rmSync", "statSync", "unlinkSync", "writeFileSync",
  ]);
  const promisePathMethods = new Set([
    "access", "chmod", "copyFile", "lstat", "mkdir", "open", "readFile", "readdir", "realpath",
    "rename", "rm", "stat", "unlink", "writeFile",
  ]);
  const destinationPathMethods = new Set(["copyFile", "copyFileSync", "rename", "renameSync"]);
  const fencePath = (value: unknown) => {
    if (typeof value !== "string" && !(value instanceof URL)) throw new Error(`Unexpected fs path argument: ${String(value)}`);
    const path = resolve(String(value));
    if (path !== scratch && !path.startsWith(`${scratch}${sep}`)) {
      throw new Error(`Live Markdown host fs escaped scratch: ${path}`);
    }
    return path;
  };
  const wrapFs = (target: object, methods: Set<string>, label: string) => new Proxy(target, {
    get(object, property) {
      const value = Reflect.get(object, property, object);
      if (typeof property !== "string" || !methods.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        fencePath(args[0]);
        if (destinationPathMethods.has(property)) fencePath(args[1]);
        fsCalls.push(`${label}.${property}`);
        return Reflect.apply(value, object, args);
      };
    },
  });
  const guardedFs = new Proxy(fs, {
    get(target, property) {
      if (property === "promises") return wrapFs(fs.promises, promisePathMethods, "fs.promises");
      const value = Reflect.get(target, property, target);
      if (typeof property !== "string" || !fsPathMethods.has(property) || typeof value !== "function") return value;
      return (...args: unknown[]) => {
        fencePath(args[0]);
        if (destinationPathMethods.has(property)) fencePath(args[1]);
        fsCalls.push(`fs.${property}`);
        return Reflect.apply(value, target, args);
      };
    },
  });
  const networkNames = new Set(["node:dns/promises", "node:http", "node:https", "node:net"]);
  const deniedModule = (name: string) => new Proxy({}, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === "default") return deniedModule(name);
      return (..._args: unknown[]) => {
        deniedCalls.push(`${name}.${String(property)}`);
        throw new Error(`Blocked optional side effect: ${name}.${String(property)}`);
      };
    },
  });
  const borrowedHost = (specifier: string): unknown => {
    external.push(specifier);
    if (specifier === "node:fs" || specifier === "fs") return guardedFs;
    if (specifier === "node:os" || specifier === "os") {
      const actual = requireNode(specifier) as object;
      return new Proxy(actual, { get(target, property) {
        return property === "homedir" ? () => scratch : Reflect.get(target, property, target);
      } });
    }
    if (specifier === "process") return processFacade;
    if (specifier === "buffer") return requireNode("buffer");
    if (specifier === "node:child_process" || networkNames.has(specifier)) return deniedModule(specifier);
    const allowed = new Set([
      "node:crypto", "node:events", "node:path", "node:stream", "node:stream/promises",
      "node:string_decoder", "node:timers/promises", "node:url", "node:zlib",
    ]);
    if (allowed.has(specifier)) return requireNode(specifier);
    throw new Error(`Unexpected Live Markdown host module: ${specifier}`);
  };
  const windowListeners = new Map<string, Set<(...args: any[]) => void>>();
  const pluginEnter: ((action: unknown) => void)[] = [];
  const storage = new Map<string, string>();
  const ztoolsHost = {
    dbStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    onPluginEnter: (listener: (action: unknown) => void) => pluginEnter.push(listener),
    setExpendHeight: () => {},
    showOpenDialog: () => { throw new Error("Unexpected dialog call"); },
    showSaveDialog: () => { throw new Error("Unexpected dialog call"); },
  };
  let runtime: { services: any; close: (type: string) => void } | undefined;
  let unsubscribePluginEnter: (() => void) | undefined;
  let releasePromise: Promise<unknown> | undefined;
  let releaseFailure: unknown;
  try {
    const html = await preparePluginPreload({
      pluginDir,
      preloadPath,
      readTextFile: async (path) => {
        const text = await readFile(path, "utf8");
        sourceHashes.set(path, digest(text));
        return text;
      },
      onExternalRequire: (specifier) => { if (!external.includes(specifier)) external.push(specifier); },
    });
    const script = html.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
    const sandbox: Record<string, any> = {
      require: borrowedHost,
      process: processFacade,
      Buffer: requireNode("buffer").Buffer,
      URL, URLSearchParams, AbortController, TextEncoder, TextDecoder,
      setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
      console,
      location: { href: "about:blank" },
      addEventListener(type: string, listener: (...args: any[]) => void) {
        const listeners = windowListeners.get(type) ?? new Set();
        listeners.add(listener);
        windowListeners.set(type, listeners);
      },
      removeEventListener(type: string, listener: (...args: any[]) => void) { windowListeners.get(type)?.delete(listener); },
      document: { getElementById: () => null, querySelectorAll: () => [], scripts: [] },
      utools: ztoolsHost,
      ztools: ztoolsHost,
      fetch: (..._args: unknown[]) => { deniedCalls.push("fetch"); throw new Error("Blocked optional fetch"); },
    };
    sandbox.window = sandbox;
    vm.runInNewContext(script, sandbox, { timeout: 2_000 });
    runtime = {
      services: sandbox.services,
      close(type: string) { for (const listener of [...(windowListeners.get(type) ?? [])]) listener(); },
    };
    const services = runtime.services;
    for (const name of ["readDocument", "writeDocument", "writeDocumentAsync", "createDocument", "subscribePluginEnter"]) {
      expect(services[name], `${name} export`).toBeTypeOf("function");
    }
    expect(services.localAi).toBeDefined();
    expect(services.mcp).toBeDefined();
    expect((await services.mcp.listServers()).some((server: any) => server.builtIn)).toBe(true);
    services.savePersistedState({ webdavConfig: { password: "temporary-secret" } });
    expect(services.loadPersistedState().webdavConfig.password).toBe("temporary-secret");

    const created = services.createDocument(scratch, "验收文档.md", "# 原始内容\n");
    const events: unknown[] = [];
    const unsubscribe = services.subscribePluginEnter((action: unknown) => events.push(action));
    unsubscribePluginEnter = unsubscribe;
    const openFileAction = { code: "typora-workbench", type: "files", payload: [{ path: created.path }] };
    pluginEnter[0](openFileAction);
    unsubscribe();
    pluginEnter[0]({ code: "typora-workbench", type: "files", payload: [{ path: created.path }] });
    expect(events).toEqual([openFileAction]);

    expect(services.readDocument(created.path).content).toBe("# 原始内容\n");
    const saved = services.writeDocument(created.path, "# 同步保存\n");
    expect(saved.content).toBe("# 同步保存\n");
    expect(await readFile(created.path, "utf8")).toBe("# 同步保存\n");

    const asyncSaved = await services.writeDocumentAsync(created.path, "# 异步保存\n", { expectedContent: "# 同步保存\n" });
    expect(asyncSaved.content).toBe("# 异步保存\n");
    await expect(services.writeDocumentAsync(created.path, "# 不应覆盖\n", { expectedContent: "# 同步保存\n" }))
      .rejects.toMatchObject({ code: "DOCUMENT_CONFLICT" });
    expect(await readFile(created.path, "utf8")).toBe("# 异步保存\n");
    expect((await services.writeDocumentAsync(created.path, "# 恢复保存\n", { expectedContent: "# 异步保存\n" })).content)
      .toBe("# 恢复保存\n");
    expect(services.readDocument(created.path).content).toBe("# 恢复保存\n");
    expect(fsCalls.some((call) => call.startsWith("fs.promises.open"))).toBe(true);
  } finally {
    unsubscribePluginEnter?.();
    try {
      if (runtime) {
        const localAi = runtime.services.localAi;
        const observedLocalAi = Object.create(localAi);
        Object.defineProperty(observedLocalAi, "release", {
          value: (...args: unknown[]) => {
            releasePromise = Promise.resolve(Reflect.apply(localAi.release, localAi, args));
            return releasePromise;
          },
        });
        runtime.services.localAi = observedLocalAi;
        // Let the original unload listener call the real, frozen service and
        // capture its Promise without closing its fs adapter before it settles.
        runtime.close("beforeunload");
        await releasePromise;
      }
    } catch (error) {
      releaseFailure = error;
    } finally {
      if (runtime) {
        try {
          runtime.close("atools-plugin-out");
        } catch (error) {
          releaseFailure ??= error;
        }
      }
      windowListeners.clear();
      await rm(scratch, { recursive: true, force: true });
    }
    for (const [path, before] of sourceHashes) expect(digest(await readFile(path, "utf8"))).toBe(before);
    expect(processModule.listenerCount("exit")).toBe(exitListenersBefore);
    expect(ownedExitListeners.size).toBe(0);
    expect([...external]).toContain("node:fs");
    expect([...external]).toEqual(expect.arrayContaining([
      "node:child_process", "node:dns/promises", "node:http", "node:https", "node:net",
    ]));
    expect(deniedCalls).toEqual([]);
    expect(releaseFailure).toBeUndefined();
  }
});
