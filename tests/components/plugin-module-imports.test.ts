// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { makePluginModuleImports, type PluginModuleImportConfig, type PluginModuleImporter } from "../../src/lib/pluginModuleImports";

let root: string;
let parent: string;
let released: ReturnType<typeof vi.fn>;
let blobs: Map<string, Blob>;
let importers: PluginModuleImporter[];
function config(extra: Partial<PluginModuleImportConfig> = {}): PluginModuleImportConfig {
  return { pluginDir: root, sources: [], initialBytes: 0, initialModules: 1, initialReads: 1,
    maxBytes: 4096, maxModules: 8, maxReads: 32, maxDurationMs: 1000, ...extra };
}
function hostRequire(fsApi: any = fs) {
  const native = createRequire(parent);
  const require = Object.assign((specifier: string) => specifier === "node:fs" ? fsApi : native(specifier), { releaseCallbacks: released });
  (globalThis as any).window.__atoolsNodeModuleRequire = require;
  return require;
}
function loader(extra: Partial<PluginModuleImportConfig> = {}, importer?: (url: string) => Promise<any>) {
  const instance = makePluginModuleImports(config(extra), undefined, importer || (async url => {
    const source = await blobs.get(url)!.text();
    return import(/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  }));
  importers.push(instance); return instance;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "atools-esm-test-"));
  parent = join(root, "preload.cjs"); await writeFile(parent, "// parent identity");
  released = vi.fn(); blobs = new Map(); importers = [];
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.spyOn(URL, "createObjectURL").mockImplementation(blob => {
    const id = `blob:fixture-${blobs.size}`; blobs.set(id, blob); return id;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(async () => {
  for (const importer of importers) importer.close();
  vi.unstubAllGlobals(); vi.restoreAllMocks(); await rm(root, { recursive: true, force: true });
});

describe("bounded local ESM importer", () => {
  it("executes prefetched exports and synchronous caller closures without starting Node, and caches identity", async () => {
    const source = "export function collect(emit) { emit(7); emit(11); } export const value=42;";
    const importer = loader({ sources: [[join(root, "core.js"), source]], initialBytes: source.length, initialModules: 2 });
    const first = importer(parent, "./core.js");
    expect(importer(parent, "./core.js")).toBe(first);
    const namespace = await first, seen: number[] = [];
    namespace.collect((value: number) => seen.push(value));
    expect(seen).toEqual([7, 11]); expect(namespace.value).toBe(42);
    expect((globalThis as any).window.__atoolsNodeModuleRequire).toBeUndefined();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    importer.close(); importer.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    await expect(importer(parent, "./core.js")).rejects.toThrow("CLOSED");
  });

  it("reads a real canonical file URL under an already supplied Node grant and releases async callbacks", async () => {
    const file = join(root, "core.mjs"); await writeFile(file, "export const text='站酷';");
    hostRequire(); const importer = loader();
    expect((await importer(parent, pathToFileURL(file).href)).text).toBe("站酷");
    expect(released).toHaveBeenCalledTimes(1);
    expect((await importer(parent, "./core.mjs")).text).toBe("站酷");
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("requires authorization before reading an unprefetched module", async () => {
    await writeFile(join(root, "core.js"), "export default 1;");
    await expect(loader()(parent, "./core.js")).rejects.toThrow("REQUIRES_AUTHORIZED_NODE");
  });

  it.each(["https://example.invalid/core.js", "node:fs", "data:text/javascript,export default 1", "./core.js?query", "./core.js#fragment", "../outside.js", "./addon.node"])("rejects unsafe or unsupported input %s before execution", async specifier => {
    hostRequire();
    await expect(loader()(parent, specifier)).rejects.toThrow(/ERR_ATOOLS_ESM_/);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("rejects actual symlink escape even when the requested lexical path is under the plugin", async () => {
    const outside = await mkdtemp(join(tmpdir(), "atools-esm-outside-"));
    try {
      await writeFile(join(outside, "evil.mjs"), "throw Error('must never execute');");
      await symlink(join(outside, "evil.mjs"), join(root, "core.mjs")); hostRequire();
      await expect(loader()(parent, "./core.mjs")).rejects.toThrow("OUTSIDE_PLUGIN");
      expect(URL.createObjectURL).not.toHaveBeenCalled();
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("detects a file changed during its real bounded read", async () => {
    const file = join(root, "core.mjs"), source = "export const value=1;";
    await writeFile(file, source);
    const read = (fd: number, buffer: Uint8Array, offset: number, length: number, position: number, callback: Function) => {
      fs.read(fd, buffer, offset, length, position, (error, size, result) => {
        fs.appendFileSync(file, "\n// changed"); callback(error, size, result);
      });
    };
    hostRequire({ ...fs, read });
    await expect(loader()(parent, "./core.mjs")).rejects.toThrow("SOURCE_CHANGED");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("reserves the remaining shared byte budget before concurrent file reads", async () => {
    await writeFile(join(root, "one.mjs"), "export const one=1;");
    await writeFile(join(root, "two.mjs"), "export const two=2;"); hostRequire();
    const importer = loader({ initialBytes: 10, maxBytes: 30 });
    const results = await Promise.allSettled([importer(parent, "./one.mjs"), importer(parent, "./two.mjs")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => String((result as PromiseRejectedResult).reason))).toEqual([expect.stringContaining("BUDGET")]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });

  it.each([{ maxModules: 1 }, { maxReads: 2 }, { maxBytes: 5 }])("shares initial preparation budgets with runtime reads: %j", async extra => {
    await writeFile(join(root, "core.mjs"), "export const value=1;"); hostRequire();
    await expect(loader(extra)(parent, "./core.mjs")).rejects.toThrow("BUDGET");
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it.each([
    ["import './other.js'; export const a=1", "STATIC_DEPENDENCIES"],
    ["export * from './other.js'", "STATIC_DEPENDENCIES"],
    ["export const url=import.meta.url", "IMPORT_META"],
    ["export const child=()=>import('./other.js')", "NESTED_IMPORT"],
    ["export const fs=require('node:fs')", "REQUIRE"],
  ])("reports explicit unsupported module syntax: %s", async (source, code) => {
    const importer = loader({ sources: [[join(root, "core.js"), source]], initialModules: 2 });
    await expect(importer(parent, "./core.js")).rejects.toThrow(code);
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it("times out a pending module and lets close promptly reject all work and revoke URLs", async () => {
    const importer = loader({ sources: [[join(root, "core.js"), "export default 1;"]], maxDurationMs: 15 }, () => new Promise(() => {}));
    await expect(importer(parent, "./core.js")).rejects.toThrow("TIMEOUT");
    importer.close(); expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    const pending = loader({ sources: [[join(root, "pending.js"), "export default 2;"]] }, () => new Promise(() => {}));
    const loading = pending(parent, "./pending.js"); pending.close();
    await expect(loading).rejects.toThrow("CLOSED");
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("does not accept a parent replaced by a symlink outside the plugin", async () => {
    const outside = await mkdtemp(join(tmpdir(), "atools-esm-parent-"));
    try {
      await writeFile(join(outside, "preload.cjs"), "// wrong parent");
      await rm(parent); await symlink(join(outside, "preload.cjs"), parent);
      hostRequire(); await expect(loader()(parent, "./core.mjs")).rejects.toThrow("OUTSIDE_PLUGIN");
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
});
