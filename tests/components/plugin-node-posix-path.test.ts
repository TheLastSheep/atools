// @vitest-environment node
import nodePath from "node:path";
import { describe, expect, it } from "vitest";
import { createPluginNodePosixPath } from "../../src/lib/pluginNodePosixPath";

const cwd = "/Users/harris/插件/工作区";
const posix = createPluginNodePosixPath(cwd);
const reference = nodePath.posix;

function codeOf(error: unknown): string | undefined {
  return error instanceof Error ? (error as Error & { code?: string }).code : undefined;
}

describe("plugin-local Node POSIX path", () => {
  it("exposes a POSIX-only object with a self-reference", () => {
    expect(posix.posix).toBe(posix);
    expect(posix.sep).toBe("/");
    expect(posix.delimiter).toBe(":");
    expect("win32" in posix).toBe(false);
    expect("matchesGlob" in posix).toBe(false);
    expect(posix.toNamespacedPath("/a/../b")).toBe("/a/../b");
  });

  it("serializes without any external helper dependency", () => {
    const injectedFactory = new Function(`return (${createPluginNodePosixPath.toString()})`)() as typeof createPluginNodePosixPath;
    const injectedPath = injectedFactory(cwd);
    expect(injectedPath.join("資料", "..", "資料", "檔案.txt")).toBe("資料/檔案.txt");
    expect(injectedPath.resolve("../外部", "./檔案")).toBe(reference.resolve(cwd, "../外部", "./檔案"));
  });

  it.each([
    "", ".", "..", "../", "../../x", "/", "//", "///a//b/", "a/./b/../c", "a///b///",
    "./a//b/../", "../../../../", "a/../../b", "a/..", "a/.", "a//./b", "資料/../📦/",
    "\\server\\share", "a\\b/../c", "nul\0name/./x", "/a/../../b/", "///a/../b//",
  ])("matches Node normalize for %s", value => {
    expect(posix.normalize(value)).toBe(reference.normalize(value));
  });

  it.each([
    [], [""], ["a"], ["a", "b"], ["a", "", "b"], ["/root", "x"], ["a", "/root", "b"],
    ["../x", "./y"], ["", "/foo"], ["/a//b/", "../c"], ["資料", "📦", "..", "檔案"],
  ].map(paths => ({ paths })))("matches Node resolve for arguments %j", ({ paths }) => {
    expect(posix.resolve(...paths)).toBe(reference.resolve(cwd, ...paths));
  });

  it.each([
    [], [""], ["a"], ["a", "b"], ["a", "", "b"], ["/root", "x"], ["a", "/root", "b"],
    ["../x", "./y"], ["//root///", "///leaf/"], ["資料", "..", "📦"], ["a\\b", "c"],
  ].map(paths => ({ paths })))("matches Node join for arguments %j", ({ paths }) => {
    expect(posix.join(...paths)).toBe(reference.join(...paths));
  });

  it.each([
    ["", ""], ["a", "a"], ["a", "b"], ["a/b", "a/c"], ["/a/b", "/a"], ["../a", "../../b"],
    ["資料/目錄", "資料/📦/檔案"], ["/a//b/", "/a/./c/"], ["a\\b", "a\\c"], ["/one", "two"],
  ])("matches Node relative for %s to %s", (from, to) => {
    expect(posix.relative(from, to)).toBe(reference.relative(reference.resolve(cwd, from), reference.resolve(cwd, to)));
  });

  it("validates resolve arguments only until a right-side absolute path wins", () => {
    const invalid = null as unknown as string;
    expect(posix.resolve(invalid, "/tmp")).toBe(reference.resolve(invalid, "/tmp"));
    expect(posix.resolve(3 as unknown as string, "/tmp")).toBe(reference.resolve(3 as unknown as string, "/tmp"));
    expect(() => posix.resolve("/tmp", invalid)).toThrow(
      expect.objectContaining({ code: "ERR_INVALID_ARG_TYPE" }),
    );
  });

  it.each([
    "", ".", "..", "foo", "foo/", "foo//bar", "//foo", "///foo", "/", "//", "///", "/tmp/",
    "資料/📦/file.txt", "a\\b", "nul\0name", "a///b///c/",
  ])("matches Node dirname, basename, extension, and parse for %s", value => {
    expect(posix.dirname(value)).toBe(reference.dirname(value));
    expect(posix.basename(value)).toBe(reference.basename(value));
    expect(posix.extname(value)).toBe(reference.extname(value));
    expect(posix.parse(value)).toEqual(reference.parse(value));
  });

  it.each([
    ["/a/file.txt", ".txt"], ["file.txt", "txt"], ["file.txt", ""], [".env", ".env"], ["a/b/", "b"],
    ["資料/檔案.json", ".json"], ["foo.bar.baz", ".baz"], ["///name", "name"], ["a\\b", "b"],
  ])("matches Node basename suffix for %s with %s", (value, suffix) => {
    expect(posix.basename(value, suffix)).toBe(reference.basename(value, suffix));
  });

  it.each([
    [".b\\..💡b/雪\\b.\\a\\/ 雪b \\/\\/", "a雪/.💡\\", "\\/"],
    ["b\\雪/ 雪/b.aa  .雪\\ /💡/", "/.\\  a /\\雪b.💡💡", "💡/"],
    ["💡a 雪.💡\\b./雪/\\/", "\\a//a雪\\", "\\/"],
  ])("matches Node basename suffix across the component boundary %j", (value, suffix, expected) => {
    expect(reference.basename(value, suffix)).toBe(expected);
    expect(posix.basename(value, suffix)).toBe(expected);
  });

  it("matches Node parse dot-state when the root changes the '..' basename", () => {
    expect(posix.parse("/..")).toEqual({ root: "/", dir: "/", base: "..", ext: ".", name: "." });
    expect(posix.parse("/..")).toEqual(reference.parse("/.."));
    expect(posix.parse("..")).toEqual(reference.parse(".."));
    expect(posix.parse("foo/..")).toEqual(reference.parse("foo/.."));
  });

  it.each([
    {}, { name: "file", ext: "json" }, { name: "file", ext: ".json" }, { dir: "/a", root: "/x", base: "b" },
    { root: "/", base: "b" }, { dir: "/", base: "b" }, { dir: "", root: "/", base: "b" },
    { name: "資料", ext: "md" }, { dir: "資料", name: "📦", ext: ".zip" }, { dir: "/a", base: "" },
    { dir: "/a", name: "name", ext: "." }, { root: "/", name: "name", ext: "x" },
    { dir: "/preferred", root: "/ignored", base: "base", name: "name", ext: "txt" },
  ])("matches Node format including extension-dot behavior for %j", value => {
    expect(posix.format(value)).toBe(reference.format(value));
  });

  it.each(["", "relative", "資料/..", "\\root", "nul\0cwd"])("requires absolute POSIX cwd: %s", value => {
    expect(() => createPluginNodePosixPath(value)).toThrow(expect.objectContaining({ code: "ERR_INVALID_ARG_VALUE" }));
  });

  it("rejects path argument type errors with Node-compatible error identity", () => {
    const invalidCalls: Array<() => unknown> = [
      () => posix.normalize(null as unknown as string),
      () => posix.isAbsolute(1 as unknown as string),
      () => posix.resolve("/safe", null as unknown as string),
      () => posix.join("safe", undefined as unknown as string),
      () => posix.relative("from", 2 as unknown as string),
      () => posix.dirname({} as unknown as string),
      () => posix.basename("x", null as unknown as string),
      () => posix.extname(false as unknown as string),
      () => posix.parse(undefined as unknown as string),
      () => posix.format(null as unknown as { base?: string }),
      () => posix.format([] as unknown as { base?: string }),
      () => posix.format({ base: 1 } as unknown as { base?: string }),
    ];
    for (const call of invalidCalls) {
      let error: unknown;
      try { call(); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(TypeError);
      expect(codeOf(error)).toBe("ERR_INVALID_ARG_TYPE");
    }
  });

  it("enforces the 256 argument and UTF-8 byte budgets without truncating", () => {
    expect(posix.join(...new Array(256).fill("")).length).toBe(1);
    expect(() => posix.join(...new Array(257).fill(""))).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_MODULE_VALUE_BUDGET" }),
    );

    const exactLimit = "界".repeat(349_525) + "a";
    expect(posix.normalize(exactLimit)).toBe(exactLimit);
    expect(() => posix.normalize(exactLimit + "a")).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_MODULE_VALUE_BUDGET" }),
    );
    expect(() => posix.join("a".repeat(524_288), "b".repeat(524_289))).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_MODULE_VALUE_BUDGET" }),
    );
    expect(() => posix.format({ name: "a".repeat(524_288), ext: "b".repeat(524_289) })).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_MODULE_VALUE_BUDGET" }),
    );
    const formatWithExtra = posix.format as unknown as (...args: unknown[]) => string;
    expect(() => formatWithExtra({ name: "a".repeat(524_288) }, "b".repeat(524_289))).toThrow(
      expect.objectContaining({ code: "ERR_ATOOLS_MODULE_VALUE_BUDGET" }),
    );
  });

  it("normalizes a long backtracking path without rescanning the accumulated prefix", () => {
    const segments = 175_000;
    const path = `${"a/".repeat(segments)}${"../".repeat(segments)}`;
    expect(posix.normalize(path)).toBe(reference.normalize(path));
  });

  it("keeps NUL lexical and preserves POSIX identity for non-string namespaced paths", () => {
    expect(posix.normalize("/a\0b/../c")).toBe(reference.normalize("/a\0b/../c"));
    const value = { path: "opaque" };
    expect(posix.toNamespacedPath(value)).toBe(value);
    expect(posix.toNamespacedPath(42)).toBe(42);
  });
});
