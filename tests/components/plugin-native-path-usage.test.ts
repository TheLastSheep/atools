// @vitest-environment node
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { analyzePluginNativePathUsage } from "../../src/lib/pluginNativePathUsage";
import { analyzePluginSource } from "../../src/lib/pluginSourceAnalysis";

describe("conservative native path usage analysis", () => {
  it.each([
    `require("path").join("/tmp", "file")`,
    `require("node:path").resolve("/tmp", "file")`,
    `require("path/posix").basename("/tmp/file")`,
    `require("node:path/posix").sep`,
    `require("path").posix.normalize("/tmp/../file")`,
    `const pathApi = require("path");\npathApi.join("/tmp", "file")`,
    `require("path")._makeLong("/tmp/file")`,
  ])("proves direct POSIX member use safe: %s", source => {
    expect(analyzePluginNativePathUsage(source)).toEqual({ kind: "safe" });
  });

  it("proves top-level module aliases, POSIX namespace use, destructured aliases, and constants safe", () => {
    const source = `
      const pathApi = require("node:path");
      const joined = pathApi.join("/tmp", "file");
      const resolved = pathApi.posix.resolve("relative");
      const { resolve: resolvePath, basename, sep: pathSeparator, delimiter } = require("path");
      const absolute = resolvePath("/tmp", "file");
      const base = basename(absolute);
      console.log(pathSeparator, delimiter);
      const posixApi = require("path/posix");
      const normalized = posixApi.normalize("/tmp/../file");
    `;
    expect(analyzePluginNativePathUsage(source)).toEqual({ kind: "safe" });
  });

  it.each([
    `require("path").win32.join("C:\\", "file")`,
    `const p = require("node:path"); p.matchesGlob("a", "*")`,
    `const { win32: windows } = require("path")`,
    `const { matchesGlob } = require("node:path")`,
    `require("node:path").notImplemented("x")`,
  ])("requires Node for known unsupported or escaped member use: %s", source => {
    const result = analyzePluginNativePathUsage(source);
    expect(result.kind).toBe("requires-node");
  });

  it.each([
    `const p = require("path"); p.join(process.cwd(), "x")`,
    `const p = require("path"); p.join(Buffer.from("x"), "y")`,
    `__atoolsNodeModuleRequire("path")`,
  ])("keeps Node fallback when injected Node environment globals are used: %s", source => {
    expect(analyzePluginNativePathUsage(source).kind).toBe("requires-node");
  });

  it.each([
    [`const p = require("path"); p[key]("/tmp")`, "computed"],
    [`const p = require("path"); p?.[key]("/tmp")`, "optional computed"],
    [`const p = require("path"); globalThis[key]("path")`, "computed global require escape"],
    [`const p = require("path"); module.exports = p`, "escape"],
    [`const p = require("path"); Object.keys(p)`, "reflection"],
    [`const p = require("path"); p = other`, "rewrite"],
    [`require("path").relative`, "function escape"],
    [`require("path").join = () => "changed"`, "member rewrite"],
    [`const req = require; req("path")`, "require alias"],
    [`require(name)`, "dynamic require"],
    [`function load(require) { return require("path").join("x") }`, "shadowed require"],
    [`const p = require("path"); function f(p) { return p.join("x") }`, "shadowed module alias"],
    [`const { join: joinPath } = require("path"); function f(joinPath) { return joinPath("x") }`, "shadowed function alias"],
    [`const p = require("path"); const read = () => p["join"]("x")`, "computed string member"],
    [`const p = require("path"); eval("p.win32")`, "eval"],
    [`const p = require("path"); Function("return p")`, "Function"],
    [`const p = require("path"); p.constructor`, "constructor"],
    [`const p = require("path"); with (p) { join("x") }`, "with"],
    [`import path from "path"; path.join("x")`, "ESM"],
  ])("returns unknown for conservative fallback: %s (%s)", (source) => {
    expect(analyzePluginNativePathUsage(source).kind).toBe("unknown");
  });

  it.each([
    `const p = require("path"); delete p.sep`,
    `delete require("path").posix.sep`,
    `const p = require("path"); for (p.sep of values) {}`,
    `const p = require("path"); for (p.posix.sep in values) {}`,
    `const p = require("path"); [p.sep] = [":"]`,
    `const p = require("path"); for ([p.sep] of values) {}`,
    `const { sep: pathSeparator } = require("path"); delete pathSeparator`,
    `const p = require("path"); ++p.sep`,
    `const p = require("path"); --p.posix.sep`,
    `const p = require("path"); ({ nest: { value: p.sep } } = source)`,
    `const p = require("path"); for ({ nest: { value: p.sep } } of values) {}`,
    `const p = require("path"); ({ x: p.sep, y: other } = source)`,
    `const p = require("path"); ([p.sep, other] = source)`,
  ])("rejects writes to imported path members: %s", source => {
    expect(analyzePluginNativePathUsage(source).kind).toBe("unknown");
  });

  it("caps reusable aliases before token-by-alias analysis grows", () => {
    const aliases = Array.from({ length: 65 }, (_, index) => `join: join${index}`).join(", ");
    const source = `const { ${aliases} } = require("path");`;
    expect(analyzePluginNativePathUsage(source)).toEqual({ kind: "unknown", reason: "alias-budget" });
  });

  it("ignores path-looking text in strings, comments, and regular expressions", () => {
    const source = String.raw`
      const p = require("path");
      const text = "require('path').win32";
      const pattern = /require\(['"]path['"]\)\.win32/;
      // p.win32 and require('path').matchesGlob
      /* p[key] and require(name) */
      p.join("/tmp", "file");
    `;
    expect(analyzePluginNativePathUsage(source)).toEqual({ kind: "safe" });
  });

  it("returns unknown for backticks and escaped identifiers", () => {
    expect(analyzePluginNativePathUsage("const p = require('path'); const s = `require('path').win32`; p.join('x')").kind).toBe("unknown");
    expect(analyzePluginNativePathUsage(String.raw`const p = require('path'); const p\u0061th = p;`).kind).toBe("unknown");
  });

  it("supports semicolon-free top-level aliases and rejects unproven computed access", () => {
    expect(analyzePluginNativePathUsage("const p=require('path')\np.join('x')")).toEqual({ kind: "safe" });
    expect(analyzePluginNativePathUsage("const p=require('path'); const x = other[key]; p.join('x')").kind).toBe("unknown");
  });

  it("bounds UTF-16, UTF-8, and optional token scanning", () => {
    expect(analyzePluginNativePathUsage("x".repeat(128 * 1024 + 1))).toEqual({ kind: "unknown", reason: "source-budget" });
    expect(analyzePluginNativePathUsage("中".repeat(44 * 1024))).toEqual({ kind: "unknown", reason: "source-budget" });
    expect(analyzePluginNativePathUsage("const x = 1;".repeat(3_400))).toEqual({ kind: "unknown", reason: "token-budget" });
  });

  it("keeps the existing source analysis default shape and exposes tokens only by opt-in", () => {
    const source = `require("node:path").join("x")`;
    const base = analyzePluginSource(source);
    expect(base).not.toHaveProperty("tokens");
    expect(base.requires).toEqual(["node:path"]);
    const withTokens = analyzePluginSource(source, { includeTokens: true });
    expect(withTokens.tokens?.some(token => token.value === "require")).toBe(true);
    expect(withTokens.tokens?.every(token => token.start >= 0 && token.end <= source.length)).toBe(true);
    const serialized = `(${analyzePluginSource.toString()})(${JSON.stringify(source)}, { includeTokens: true })`;
    expect(vm.runInNewContext(serialized).tokens.some((token: { value: string }) => token.value === "require")).toBe(true);
  });
});
