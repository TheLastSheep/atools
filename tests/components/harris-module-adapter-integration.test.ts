// @vitest-environment node
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { preparePluginPreload } from "../../src/lib/pluginPreload";
import { makeNodeModuleRequire } from "../../src/lib/nodeModuleBridge";

function runPreload(html: string, hostRequire?: (specifier: string) => unknown) {
  const listeners = new Map<string, Set<() => void>>();
  const sandbox: Record<string, any> = {
    require: hostRequire,
    addEventListener(type: string, listener: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      listeners.get(type)?.delete(listener);
    },
    utools: {},
  };
  sandbox.window = sandbox;
  const script = html.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  vm.runInNewContext(script, sandbox, { timeout: 1000 });
  return {
    services: sandbox.services,
    close(type: "pagehide" | "atools-plugin-out") {
      for (const listener of [...(listeners.get(type) ?? [])]) listener();
    },
    listenerCount: () => [...listeners.values()].reduce((total, set) => total + set.size, 0),
  };
}

async function prepareSource(source: string) {
  return preparePluginPreload({
    pluginDir: "/plugins/adapter",
    preloadPath: "/plugins/adapter/preload.cjs",
    readTextFile: async () => source,
  });
}

describe("CommonJS production preload module adapter", () => {
  it("runs local POSIX paths without a host and retains missing-module errors", async () => {
    const runtime = runPreload(await prepareSource(`
      const path = require('node:path');
      module.exports = {
        destination: () => path.resolve('notes', '../文档/a.md'),
        optional: () => require('unsupported'),
      };
    `));
    expect(runtime.services.destination()).toBe("/plugins/adapter/文档/a.md");
    expect(runtime.services.optional).toThrow("ERR_ATOOLS_PRELOAD_MODULE_NOT_FOUND");
    runtime.close("pagehide");
  });

  it("keeps existing Electron/Node fallback and revokes captured native functions on either exit", async () => {
    for (const exit of ["pagehide", "atools-plugin-out"] as const) {
      const requested: string[] = [];
      const electron = { nativeHost: true };
      const runtime = runPreload(await prepareSource(`
        const { join } = require('path');
        module.exports = {
          join,
          electron: require('electron'),
          unsupported: () => require('node:fs'),
        };
      `), (specifier) => {
        requested.push(specifier);
        if (specifier === "electron") return electron;
        throw Object.assign(new Error("existing host denial"), { code: "EACCES" });
      });
      expect(runtime.services.join("/a", "b")).toBe("/a/b");
      expect(runtime.services.electron).toBe(electron);
      expect(runtime.services.unsupported).toThrow("existing host denial");
      expect(requested).toEqual(["electron", "node:fs"]);
      expect(runtime.listenerCount()).toBe(2);
      runtime.close(exit);
      expect(runtime.listenerCount()).toBe(0);
      expect(() => runtime.services.join("/a", "b")).toThrow("adapter is closed");
      expect(runtime.services.unsupported).toThrow("adapter is closed");
    }
  });
});

// This opt-in uses the author's unchanged current package and real temporary files.
// Native transport is a contract stub; Rust I/O/session checks run in host tests.
// This does not claim WebView IPC or native editor UI acceptance.
const sourceRoot = process.env.ATOOLS_HARRIS_PLUGIN_SOURCE;
it.skipIf(!sourceRoot).each([false, true])("opens, saves and reopens the original Harris Live Markdown module (native text I/O: %s)", async nativeTextIo => {
  const pluginDir = resolve(sourceRoot!, "live-markdown");
  const preloadPath = join(pluginDir, "preload/fs-workspace.cjs");
  const originalSource = await readFile(preloadPath, "utf8");
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const sourceDigest = digest(originalSource);
  const scratch = await mkdtemp(join(tmpdir(), "atools-harris-module-"));
  const hostRequire = createRequire(import.meta.url);
  const requests: string[] = [];
  const nativeReads: string[] = [];
  const nativeWrites: { path: string; text: string }[] = [];
  let fallbackReads = 0;
  let fallbackWrites = 0;
  let nodeExistsCalls = 0;
  let nodeStatCalls = 0;
  const nodeBridge = makeNodeModuleRequire({ endpoint: `http://127.0.0.1:43121/node/${"a".repeat(64)}` }, {
    requestSync(method, params) {
      if (method === "readTextPath") {
        nativeReads.push(params.path as string);
        return { handled: true, value: readFileSync(params.path as string, "utf8") };
      }
      if (method === "writeTextPath") {
        if (typeof params.path !== "string" || typeof params.text !== "string") {
          throw new Error("writeTextPath requires string path and text fields");
        }
        nativeWrites.push({ path: params.path, text: params.text });
        writeFileSync(params.path, params.text, "utf8");
        return { handled: true };
      }
      throw new Error(`Unexpected bridge method: ${method}`);
    },
    requestAsync: async () => undefined,
  });
  let runtime: ReturnType<typeof runPreload> | undefined;
  try {
    const html = await preparePluginPreload({
      pluginDir, preloadPath,
      readTextFile: (path) => readFile(path, "utf8"),
    });
    const borrowedHost = Object.assign((specifier: string) => {
      requests.push(specifier);
      if (specifier !== "node:fs" && specifier !== "node:url") {
        throw new Error(`Unexpected host module: ${specifier}`);
      }
      const module = hostRequire(specifier);
      return specifier === "node:fs" ? new Proxy(module, {
        get(target, key) {
          if (key === "readFileSync") return (...args: any[]) => { fallbackReads++; return Reflect.apply(target.readFileSync, target, args); };
          if (key === "writeFileSync") return (...args: any[]) => { fallbackWrites++; return Reflect.apply(target.writeFileSync, target, args); };
          if (key === "existsSync") return (...args: any[]) => { nodeExistsCalls++; return Reflect.apply(target.existsSync, target, args); };
          if (key === "statSync") return (...args: any[]) => { nodeStatCalls++; return Reflect.apply(target.statSync, target, args); };
          return Reflect.get(target, key, target);
        },
      }) : module;
    }, nativeTextIo ? {
      readTextPath: nodeBridge.readTextPath,
      writeTextPath: nodeBridge.writeTextPath,
    } : {});
    runtime = runPreload(html, borrowedHost);
    const initial = runtime.services.createDocument(scratch, "固定文档", "# First\nInitial text.");
    expect(initial.name).toBe("固定文档.md");
    const content = "# Harris compatibility\n\nFixed UTF-8 内容 with **formatting**.\n";
    const saved = runtime.services.writeDocument(initial.path, content);
    const reopened = runtime.services.readDocument(initial.path);
    expect(saved.title).toBe("Harris compatibility");
    expect(reopened.content).toBe(content);
    expect(reopened.excerpt).toBe("Fixed UTF-8 内容 with formatting.");
    expect(await readFile(initial.path, "utf8")).toBe(content);
    const duplicate = runtime.services.createDocument(scratch, "固定文档", "# Second");
    expect(duplicate.name).toBe("固定文档 1.md");
    expect(requests).toEqual(nativeTextIo ? ["node:url", "node:fs"] : ["node:fs", "node:url"]);
    expect(nativeReads.length).toBe(nativeTextIo ? 4 : 0);
    expect(nativeWrites.length).toBe(nativeTextIo ? 3 : 0);
    expect(nativeWrites.map(write => write.text)).toEqual(nativeTextIo
      ? ["# First\nInitial text.", content, "# Second"]
      : []);
    expect(nativeTextIo
      ? nativeWrites.every(write => typeof write.text === "string" && write.path.startsWith(scratch))
      : nativeWrites.length === 0).toBe(true);
    expect(fallbackReads).toBe(nativeTextIo ? 0 : 4);
    expect(fallbackWrites).toBe(nativeTextIo ? 0 : 3);
    expect(nodeExistsCalls).toBeGreaterThan(0);
    expect(nodeStatCalls).toBeGreaterThan(0);
    expect(digest(await readFile(preloadPath, "utf8"))).toBe(sourceDigest);
  } finally {
    runtime?.close("atools-plugin-out");
    nodeBridge.close();
    await rm(scratch, { recursive: true, force: true });
  }
});

it.skipIf(!sourceRoot)("runs original Harris Format Converter text conversion through production CJS and the minimal Node fallback", async () => {
  const pluginDir = resolve(sourceRoot!, "format-converter");
  const preloadPath = join(pluginDir, "preload/text-converter.cjs");
  const requested: string[] = [];
  const originalRequire = createRequire(preloadPath);
  const borrowedHost = (specifier: string) => {
    requested.push(specifier);
    if (specifier !== "node:fs/promises" && specifier !== "iconv-lite") {
      throw new Error(`Unexpected Format Converter host dependency: ${specifier}`);
    }
    return originalRequire(specifier);
  };
  const html = await preparePluginPreload({
    pluginDir,
    preloadPath,
    readTextFile: (path) => readFile(path, "utf8"),
  });
  const runtime = runPreload(html, borrowedHost);
  try {
    const htmlOutput = runtime.services.convertStructured(
      { text: "# Fixed text\n\n- **offline**", html: null, rows: null, json: null },
      "md",
      "html",
    );
    expect(htmlOutput).toContain("<h1>Fixed text</h1>");
    expect(htmlOutput).toContain("<strong>offline</strong>");
    expect(requested).toEqual(["node:fs/promises", "iconv-lite"]);
  } finally {
    runtime.close("atools-plugin-out");
  }
});

it.skipIf(!sourceRoot)("keeps the Format Converter's no-host dependency boundary explicit", async () => {
  const pluginDir = resolve(sourceRoot!, "format-converter");
  const preloadPath = join(pluginDir, "preload/text-converter.cjs");
  const html = await preparePluginPreload({
    pluginDir,
    preloadPath,
    readTextFile: (path) => readFile(path, "utf8"),
  });
  expect(() => runPreload(html)).toThrow("ERR_ATOOLS_PRELOAD_MODULE_NOT_FOUND: node:fs/promises");
});
