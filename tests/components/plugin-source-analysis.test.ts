// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import { analyzePluginSource, rewritePluginImports } from "../../src/lib/pluginSourceAnalysis";

describe("preload import lexical analysis", () => {
  it("rewrites executable imports while preserving comments, quoted text, regex and property methods", () => {
    const source = String.raw`
      const string = "import('./wrong.js') require('wrong')";
      // import('./comment.js')
      /* require('comment') import('./comment2.js') */
      const regex = /import\(['"]require\('wrong'\)/g;
      if (true) /import\('regex2'\)/.test('x');
      function empty() {} /import\('regex3'\)/.test('x');
      const object = { import(value) { return value; } };
      object.import('./property.js'); object?.import('./optional.js');
      const module = import /* real */ ('./real.js');
      const template = ` + "`text import('wrong') ${import('./template.mjs')} ${`nested ${require('node:path')}`}`" + `;
    `;
    new vm.Script(source);
    const analysis = analyzePluginSource(source);
    expect(analysis.requires).toEqual(["node:path"]);
    expect(analysis.imports.map(call => call.literal)).toEqual(["./real.js", "./template.mjs"]);
    const rewritten = rewritePluginImports(source, "/plugins/demo/preload.cjs");
    expect(rewritten.match(/__atoolsImportModule/g)).toHaveLength(2);
    expect(rewritten).toContain('"import(\'./wrong.js\') require(\'wrong\')"');
    expect(rewritten).toContain("object.import('./property.js')");
    new vm.Script(rewritten);
  });

  it("supports escaped literals and plain templates without evaluating their contents", () => {
    const analysis = analyzePluginSource(String.raw`require('node:\x66s'); import('./co\u0072e.js'); import(` + "`./plain.mjs`" + "); import(pathToFileURL(path).href);");
    expect(analysis.requires).toEqual(["node:fs"]);
    expect(analysis.imports.map(call => call.literal)).toEqual(["./core.js", "./plain.mjs", undefined]);
  });

  it("distinguishes class/private methods from a dynamic import followed by an ASI block", () => {
    const source = `class C { #import() {} run(){ this.#import(); } static import(x) {} async import(x) {} }
      const object={ import(x) {}, other(){}, async import(x){} };
      const value=import('./first.js')
      { import('./second.js')\n {} }
    `;
    new vm.Script(source);
    expect(analyzePluginSource(source).imports.map(call => call.literal)).toEqual(["./first.js", "./second.js"]);
    const rewritten = rewritePluginImports(source, "/plugins/demo/preload.js");
    expect(rewritten).toContain("this.#import()");
    new vm.Script(rewritten);
  });

  it.each([
    "let n=1; n++ / 2; n-- / 2;",
    "const fn=function() {} / 2; const asyncFn=async function() {} / 2;",
    "const fn=(()=>{}) / 2; const C=class {} / 2;",
    "const {x}={x:1}; ({x}={x:2}) / 2;",
  ])("keeps division after expression boundaries from hiding real module access: %s", prefix => {
    const source = prefix + ' require("node:fs"); import("./core.js");';
    new vm.Script(source);
    expect(analyzePluginSource(source).requires).toEqual(["node:fs"]);
    expect(analyzePluginSource(source).imports.map(call => call.literal)).toEqual(["./core.js"]);
    expect(rewritePluginImports(source, "/plugins/demo/preload.js")).toContain('__atoolsImportModule.bind');
  });

  it.each([
    ["import value from './other.js'", true, false],
    ["import './other.js'", true, false],
    ["export * from './other.js'", true, false],
    ["export { x } from './other.js'", true, false],
    ["export function f() { return 42; }", false, false],
    ["export const url = import.meta.url", false, true],
  ])("identifies unsupported ESM dependencies without rewriting declaration syntax", (source, dependencies, meta) => {
    const analysis = analyzePluginSource(source as string);
    expect(analysis.staticDependencies).toBe(dependencies);
    expect(analysis.importMeta).toBe(meta);
    expect(rewritePluginImports(source as string, "/plugins/demo/preload.js")).toBe(source);
  });

  it("exposes only quoted import/export specifier spans on opt-in analysis", () => {
    const source = `import value from './a.js'; export * from './b.js'; export * as ns from './c.js'; export { value } from './d.js'; const lazy = import('./e.js');`;
    const ordinary = analyzePluginSource(source);
    expect(ordinary).not.toHaveProperty("moduleSpecifiers");
    expect(ordinary.staticDependencies).toBe(true);
    const extended = analyzePluginSource(source, { includeModuleSpecifiers: true });
    expect(extended.moduleSpecifiers?.map(({ value, kind }) => [value, kind])).toEqual([
      ["./a.js", "static"], ["./b.js", "static"], ["./c.js", "static"], ["./d.js", "static"], ["./e.js", "dynamic"],
    ]);
    expect(extended.moduleSpecifiers?.every(({ start, end, value }) => source.slice(start + 1, end - 1) === value)).toBe(true);

    const serialized = `(${analyzePluginSource.toString()})("export * as ns from './module.js'")`;
    expect(vm.runInNewContext(serialized).staticDependencies).toBe(true);
  });

  it("does not mistake keywords inside import bindings or regex literals for module declarations", () => {
    const source = `import { export as picked } from './dep.js'; export default /import x from '\\.\\/ghost.js'/;`;
    const analysis = analyzePluginSource(source, { includeModuleSpecifiers: true });
    expect(analysis.moduleSpecifiers?.map(specifier => specifier.value)).toEqual(["./dep.js"]);
    expect(analysis.staticDependencies).toBe(true);
  });

  it("keeps member division lexed as division and finds export-from after a namespace named from", () => {
    const source = `const ratio = options.default / 2; import './real.js'; export * as from from './namespace.js'; export * as 'from' from './string-namespace.js';`;
    const analysis = analyzePluginSource(source, { includeModuleSpecifiers: true });
    expect(analysis.staticDependencies).toBe(true);
    expect(analysis.moduleSpecifiers?.map(specifier => specifier.value)).toEqual([
      "./real.js", "./namespace.js", "./string-namespace.js",
    ]);
    expect(analysis.moduleSpecifiers?.every(({ start, end, value }) => source.slice(start + 1, end - 1) === value)).toBe(true);
  });

  it("recognizes the real original OpenAPI/HAR module sources as self-contained exports", async () => {
    for (const file of ["openapi-contract-gate/core/contract.js", "har-doctor/core/analyze.js"]) {
      const source = await readFile(resolve("ZTools-plugins/plugins", file), "utf8");
      const analysis = analyzePluginSource(source);
      expect(analysis).toEqual({ requires: [], imports: [], staticDependencies: false, importMeta: false });
    }
  });
});
