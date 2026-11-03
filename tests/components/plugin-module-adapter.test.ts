import { runInNewContext } from "node:vm";
import * as nodePath from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPluginModuleAdapter, pluginModuleAdapterExpression } from "../../src/lib/pluginModuleAdapter";
import { createPluginNodePosixPath } from "../../src/lib/pluginNodePosixPath";

type AdaptedRequire = ReturnType<typeof createPluginModuleAdapter>;
type HostRequire = ((specifier: string) => unknown) & {
  readTextPath?: (path: string) => { handled: true; value: string } | { handled: false };
  writeTextPath?: (path: string, text: string) => { handled: true } | { handled: false };
};
type PathFacade = {
  posix: PathFacade;
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
  normalize: (value: string) => string;
  isAbsolute: (value: string) => boolean;
  dirname: (value: string) => string;
  basename: (value: string) => string;
  extname: (value: string) => string;
  relative: (from: string, to: string) => string;
  sep: string;
  [key: string]: any;
};

function makeAdapter(cwd = "/plugins/live-markdown", hostRequire?: HostRequire) {
  return createPluginModuleAdapter(cwd, hostRequire, createPluginNodePosixPath);
}

describe("Plugin CommonJS module adapter", () => {
  it("returns one local facade for every POSIX path alias and keeps posix identity stable", () => {
    const hostRequire = vi.fn(() => { throw new Error("POSIX aliases must stay local"); });
    const adapted = makeAdapter("/plugins/live-markdown", hostRequire);
    const aliases = ["path", "node:path", "path/posix", "node:path/posix"];
    const modules = aliases.map(name => adapted(name));

    expect(modules.every(module => module === modules[0])).toBe(true);
    const path = modules[0] as PathFacade;
    expect(path.posix).toBe(path);
    expect(path.posix.posix).toBe(path);
    expect(path.resolve).toBe(path.resolve);
    expect(aliases.every(name => adapted.canHandle(name))).toBe(true);
    expect(adapted.canHandle("node:fs")).toBe(false);
    expect(hostRequire).not.toHaveBeenCalled();
    adapted.close();
  });

  it("exposes native local members through reflection without triggering host fallback", () => {
    const hostPath = { win32: { join: () => "host-windows-path" } };
    const hostRequire = vi.fn(() => hostPath);
    const path = makeAdapter("/workspace/plugin", hostRequire)("node:path") as PathFacade;

    expect("join" in path).toBe(true);
    expect("posix" in path).toBe(true);
    expect("_makeLong" in path).toBe(true);
    expect("notAPathMember" in path).toBe(false);
    expect("win32" in path).toBe(false);
    expect(Object.keys(path)).toEqual(expect.arrayContaining(["join", "resolve", "posix", "_makeLong", "sep"]));
    expect(Object.getOwnPropertyDescriptor(path, "join")).toMatchObject({
      configurable: true,
      enumerable: true,
      value: path.join,
    });
    expect(Object.getOwnPropertyDescriptor(path, "_makeLong")).toMatchObject({
      configurable: true,
      enumerable: true,
      value: path.toNamespacedPath,
    });

    const { join, posix } = path;
    const spread = { ...path } as PathFacade;
    expect(join("a", "b")).toBe("a/b");
    expect(posix).toBe(path);
    expect(spread.join).toBe(join);
    expect(spread.posix).toBe(path);
    expect(hostRequire).not.toHaveBeenCalled();
  });

  it("keeps unknown, CommonJS interop, and symbol probes local", () => {
    const hostRequire = vi.fn(() => { throw new Error("unknown path probes must not use Node"); });
    const path = makeAdapter("/workspace/plugin", hostRequire)("path") as PathFacade;

    expect(path.__esModule).toBeUndefined();
    expect(path[Symbol.toStringTag]).toBeUndefined();
    expect(Object.prototype.toString.call(path)).toBe("[object Object]");
    expect(path.notAPathMember).toBeUndefined();
    expect(path.constructor).toBeUndefined();
    expect(path.toString).toBeUndefined();
    expect("constructor" in path).toBe(false);
    expect("toString" in path).toBe(false);
    expect("__esModule" in path).toBe(false);
    expect(Symbol.toStringTag in path).toBe(false);
    expect(Object.getOwnPropertyDescriptor(path, Symbol.toStringTag)).toBeUndefined();
    expect(hostRequire).not.toHaveBeenCalled();
  });

  it("shares one fs facade for aliases only when the POSIX host supplies native text reads", () => {
    const hostWrite = vi.fn(() => "host write");
    const fsModule = { readFileSync: vi.fn(() => "host"), writeFileSync: hostWrite, constants: { O_RDONLY: 0 } };
    const hostRequire = Object.assign(vi.fn((specifier: string) => {
      if (specifier === "node:fs") return fsModule;
      throw new Error(`Unexpected module: ${specifier}`);
    }), {
      readTextPath: vi.fn((path: string) => ({ handled: true as const, value: `native:${path}` })),
    });
    const adapted = makeAdapter("/workspace/plugin", hostRequire);
    const fs = adapted("fs") as typeof fsModule;
    const nodeFs = adapted("node:fs");

    expect(nodeFs).toBe(fs);
    expect(adapted.canHandle("fs")).toBe(false);
    expect(adapted.canHandle("node:fs")).toBe(false);
    expect(hostRequire).not.toHaveBeenCalled();
    expect(hostRequire.readTextPath).not.toHaveBeenCalled();
    expect((fs as any).readFileSync("/workspace/plugin/notes.md", "utf8")).toBe("native:/workspace/plugin/notes.md");
    expect(hostRequire.readTextPath).toHaveBeenCalledWith("/workspace/plugin/notes.md");
    expect(fsModule.readFileSync).not.toHaveBeenCalled();
    expect((fs as any).writeFileSync).toBe(hostWrite);
    expect((fs as any).constants).toBe(fsModule.constants);
    expect(hostRequire.mock.calls).toEqual([["node:fs"]]);

    const read = (fs as any).readFileSync;
    adapted.close();
    expect(() => read("/workspace/plugin/notes.md", "utf8"))
      .toThrow(expect.objectContaining({ code: "ERR_ATOOLS_PLUGIN_FS_CLOSED" }));
    expect(fsModule.readFileSync).not.toHaveBeenCalled();
  });

  it("creates a write-only POSIX fs facade without changing the host read method", () => {
    const hostRead = vi.fn(() => "host read");
    const hostWrite = vi.fn(() => "host write");
    const fsModule = { readFileSync: hostRead, writeFileSync: hostWrite };
    const hostRequire = Object.assign(vi.fn((specifier: string) => {
      if (specifier === "node:fs") return fsModule;
      throw new Error(`Unexpected module: ${specifier}`);
    }), {
      writeTextPath: vi.fn((path: string, text: string) => ({ handled: true as const })),
    });
    const adapted = makeAdapter("/workspace/plugin", hostRequire);
    const fs = adapted("fs") as any;

    expect(adapted("node:fs")).toBe(fs);
    expect(adapted.canHandle("fs")).toBe(false);
    expect(fs.writeFileSync("/workspace/plugin/notes.md", "hello")).toBeUndefined();
    expect(hostRequire.writeTextPath).toHaveBeenCalledWith("/workspace/plugin/notes.md", "hello");
    expect(hostRead).not.toHaveBeenCalled();
    expect(hostWrite).not.toHaveBeenCalled();
    expect(fs.readFileSync).toBe(hostRead);
    expect(hostRequire.mock.calls).toEqual([["node:fs"]]);
    adapted.close();
  });

  it("keeps fs aliases on the original host when no native provider or POSIX cwd exists", () => {
    const module = { readFileSync: vi.fn(() => "host") };
    const noProvider = vi.fn(() => module);
    const ordinary = makeAdapter("/workspace/plugin", noProvider);
    expect(ordinary("fs")).toBe(module);
    expect(ordinary("node:fs")).toBe(module);
    expect(noProvider.mock.calls).toEqual([["fs"], ["node:fs"]]);
    ordinary.close();

    const readTextPath = vi.fn(() => ({ handled: true as const, value: "must not run" }));
    const writeTextPath = vi.fn(() => ({ handled: true as const }));
    const windowsHost = Object.assign(vi.fn(() => module), { readTextPath, writeTextPath });
    const windows = makeAdapter("C:\\plugins\\demo", windowsHost);
    expect(windows("fs")).toBe(module);
    expect(windows("node:fs")).toBe(module);
    expect(readTextPath).not.toHaveBeenCalled();
    expect(writeTextPath).not.toHaveBeenCalled();
    expect(windowsHost.mock.calls).toEqual([["fs"], ["node:fs"]]);
    windows.close();
  });

  it("implements common POSIX path calls locally without consulting the host", () => {
    const hostRequire = vi.fn(() => { throw new Error("local path methods must not fall back"); });
    const path = makeAdapter("/workspace/plugin", hostRequire)("node:path") as PathFacade;

    expect(path.join("/workspace", "plugin", "notes", "../readme.md")).toBe("/workspace/plugin/readme.md");
    expect(path.resolve("notes", "../readme.md")).toBe("/workspace/plugin/readme.md");
    expect(path.normalize("./notes//draft/../readme.md")).toBe("notes/readme.md");
    expect(path.isAbsolute("/workspace/plugin/readme.md")).toBe(true);
    expect(path.dirname("/workspace/plugin/readme.md")).toBe("/workspace/plugin");
    expect(path.basename("/workspace/plugin/readme.md")).toBe("readme.md");
    expect(path.extname("/workspace/plugin/readme.md")).toBe(".md");
    expect(path.relative("/workspace/plugin", "/workspace/plugin/readme.md")).toBe("readme.md");
    expect(path.sep).toBe("/");
    expect(hostRequire).not.toHaveBeenCalled();
  });

  it("defers only known unsupported path members to the existing host require", () => {
    const win32 = { join: vi.fn(() => "host-windows-path") };
    const matchesGlob = vi.fn(() => true);
    const hostPath = { ...nodePath, win32, matchesGlob };
    const hostRequire = vi.fn((specifier: string) => {
      if (specifier === "node:path") return hostPath;
      throw new Error(`Unexpected module: ${specifier}`);
    });
    const adapted = makeAdapter("/workspace/plugin", hostRequire);
    const path = adapted("path") as PathFacade;

    expect(hostRequire).not.toHaveBeenCalled();
    expect(path._makeLong).toBe(path.toNamespacedPath);
    expect(hostRequire).not.toHaveBeenCalled();
    expect(path.win32).toBe(win32);
    expect(hostRequire.mock.calls).toEqual([["node:path"]]);
    expect(path.win32.join("a", "b")).toBe("host-windows-path");
    expect(path.matchesGlob("draft.md", "*.md")).toBe(true);
    expect(matchesGlob).toHaveBeenCalledWith("draft.md", "*.md");
    expect(hostRequire.mock.calls).toEqual([["node:path"], ["node:path"], ["node:path"]]);
    adapted.close();
  });

  it.each(["C:\\plugins\\live-markdown", "D:/plugins/live-markdown", "\\\\server\\share\\plugin"])(
    "delegates all path aliases to the host for non-POSIX cwd %s",
    cwd => {
      const returned = new Map<string, object>();
      const hostRequire = vi.fn((specifier: string) => {
        const module = { specifier };
        returned.set(specifier, module);
        return module;
      });
      const adapted = makeAdapter(cwd, hostRequire);

      for (const specifier of ["path", "node:path", "path/posix", "node:path/posix"]) {
        expect(adapted.canHandle(specifier)).toBe(false);
        expect(adapted(specifier)).toBe(returned.get(specifier));
      }
      expect(hostRequire.mock.calls).toEqual([["path"], ["node:path"], ["path/posix"], ["node:path/posix"]]);
      adapted.close();
    },
  );

  it("preserves host exceptions and keeps MODULE_NOT_FOUND when no host exists", () => {
    const hostFailure = Object.assign(new Error("host permission denied"), { code: "PERMISSION_DENIED" });
    const hostRequire = vi.fn(() => { throw hostFailure; });
    const adapted = makeAdapter("/workspace/plugin", hostRequire);
    let observed: unknown;
    try { adapted("node:fs"); } catch (error) { observed = error; }
    expect(observed).toBe(hostFailure);

    const withoutHost = makeAdapter();
    let missing: unknown;
    try { withoutHost("node:crypto"); } catch (error) { missing = error; }
    expect(missing).toMatchObject({ code: "MODULE_NOT_FOUND" });
    let unsupportedPath: unknown;
    try { (withoutHost("path") as PathFacade).win32; } catch (error) { unsupportedPath = error; }
    expect(unsupportedPath).toMatchObject({ code: "MODULE_NOT_FOUND" });

    const pathFailureRequire = vi.fn(() => { throw hostFailure; });
    const pathFailureAdapter = makeAdapter("/workspace/plugin", pathFailureRequire);
    let pathFailure: unknown;
    try { (pathFailureAdapter("path") as PathFacade).win32; } catch (error) { pathFailure = error; }
    expect(pathFailure).toBe(hostFailure);
    adapted.close();
    withoutHost.close();
    pathFailureAdapter.close();
  });

  it("rejects new requires and previously extracted local functions after close", () => {
    const hostRequire = vi.fn(() => nodePath);
    const adapted = makeAdapter("/workspace/plugin", hostRequire);
    const path = adapted("path") as PathFacade;
    const resolve = path.resolve;
    expect(resolve("notes.md")).toBe("/workspace/plugin/notes.md");
    adapted.close();
    adapted.close();

    expect(() => adapted("node:fs")).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_PLUGIN_MODULE_ADAPTER_CLOSED" }));
    expect(() => resolve("notes.md")).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_PLUGIN_MODULE_ADAPTER_CLOSED" }));
    expect(() => path.dirname).toThrow(expect.objectContaining({ code: "ERR_ATOOLS_PLUGIN_MODULE_ADAPTER_CLOSED" }));
    expect(hostRequire).not.toHaveBeenCalled();
    expect(hostRequire("node:path")).toBe(nodePath);
  });

  it("serializes a self-contained adapter expression and safely escapes special cwd text", () => {
    const cwd = "/plugins/</script>\n\"quoted\"\\backslash-雪";
    const expression = pluginModuleAdapterExpression(cwd, "hostRequire");
    const hostRequire = vi.fn(() => { throw new Error("ordinary POSIX operations must remain local"); });
    Object.assign(hostRequire, {
      readTextPath: vi.fn((path: string) => ({ handled: true as const, value: `vm:${path}` })),
      writeTextPath: vi.fn((path: string, text: string) => ({ handled: true as const })),
    });
    const adapted = runInNewContext(expression, { hostRequire }) as AdaptedRequire;

    expect(expression).not.toContain("</script");
    expect(expression).toContain("\\u003c/script>");
    expect(adapted.canHandle("node:path")).toBe(true);
    const path = adapted("node:path") as PathFacade;
    expect(path.resolve()).toBe(cwd);
    expect(path.posix).toBe(path);
    const fs = adapted("node:fs") as any;
    expect(adapted("fs")).toBe(fs);
    expect(adapted.canHandle("node:fs")).toBe(false);
    expect(fs.readFileSync(`${cwd}/notes.md`, "utf8")).toBe(`vm:${cwd}/notes.md`);
    expect((hostRequire as any).readTextPath).toHaveBeenCalledWith(`${cwd}/notes.md`);
    expect(fs.writeFileSync(`${cwd}/notes.md`, "vm-write")).toBeUndefined();
    expect((hostRequire as any).writeTextPath).toHaveBeenCalledWith(`${cwd}/notes.md`, "vm-write");
    expect(hostRequire).not.toHaveBeenCalled();
    adapted.close();
  });
});
