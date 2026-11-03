// @vitest-environment node
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { analyzePluginSource } from "../../src/lib/pluginSourceAnalysis";

const statement = 'if(!e)throw new Error("Automatic publicPath is not supported in this browser");';
const option = { includeAutomaticPublicPathFallbacks: true };
const ranges = (source: string) => analyzePluginSource(source, option).automaticPublicPathFallbacks!;

describe("executable automatic publicPath fallback analysis", () => {
  it("returns exact executable statement ranges only when requested", () => {
    const source = `(()=>{let e;${statement}return e;})();`;
    new vm.Script(source);
    const ordinary = analyzePluginSource(source);
    expect(ordinary).not.toHaveProperty("automaticPublicPathFallbacks");
    expect(ranges(source)).toEqual([{ start: source.indexOf(statement), end: source.indexOf(statement) + statement.length }]);
    expect(analyzePluginSource("const e = 1", option).automaticPublicPathFallbacks).toEqual([]);
  });

  it("accepts token trivia without widening the replacement to adjacent statements", () => {
    const target = 'if /* condition */ ( ! e ) throw /* ctor */ new Error ( "Automatic publicPath is not supported in this browser" ) ;';
    const source = `before();${target}else after();`;
    new vm.Script(source);
    expect(ranges(source).map(({ start, end }) => source.slice(start, end))).toEqual([target]);
    const rewritten = source.slice(0, ranges(source)[0].start) + 'if(!e)e="scoped";' + source.slice(ranges(source)[0].end);
    expect(rewritten).toBe('before();if(!e)e="scoped";else after();');
    new vm.Script(rewritten);
  });

  it("does not treat comments, strings, template text or regex literals as executable fallbacks", () => {
    const source = [
      `const quoted = ${JSON.stringify(statement)};`,
      `// ${statement}\n`,
      `/* ${statement} */`,
      "const template = `" + statement + "`;",
      "const interpolated = `" + statement + "${1}" + statement + "`;",
      'const regex = /if\\(!e\\)throw new Error\\("Automatic publicPath is not supported in this browser"\\);/;',
      'if(true) /if\\(!e\\)throw new Error\\("Automatic publicPath is not supported in this browser"\\);/.test("x");'
    ].join("\n");
    new vm.Script(source);
    expect(ranges(source)).toEqual([]);
  });

  it("finds real statements in nested template interpolations while ignoring their raw text", () => {
    const source = 'const text = `raw ' + statement + '${(()=>{' + statement
      + 'return `nested ${(()=>{' + statement + 'return 1;})()}`;})()}`;';
    new vm.Script(source);
    const matches = ranges(source);
    expect(matches).toHaveLength(2);
    expect(matches.every(({ start, end }) => source.slice(start, end) === statement)).toBe(true);
    expect(matches[0].start).toBeGreaterThan(source.indexOf(statement));
    expect(matches[0].end).toBeLessThan(matches[1].start);
  });

  it.each([
    'if(!other)throw new Error("Automatic publicPath is not supported in this browser");',
    'if(!e)throw new TypeError("Automatic publicPath is not supported in this browser");',
    'if(!e)throw new Error("Automatic publicPath is not supported in this browser", cause);',
    'if(!e)throw new Error(("Automatic publicPath is not supported in this browser"));',
    'if(!e)throw new Error(`Automatic publicPath is not supported in this browser`);',
    'if(!e)throw new Error("Automatic publicPath is not supported in this browser")',
    'object.if(!e); throw new Error("Automatic publicPath is not supported in this browser");',
    'object?.if(!e); throw new Error("Automatic publicPath is not supported in this browser");',
    'if(!e)throw new Error("Automatic publicPath is not supported in this browser!");'
  ])("keeps unsupported expression variants unchanged: %s", source => {
    new vm.Script(source);
    expect(ranges(source)).toEqual([]);
  });

  it("does not join tokens across omitted regex/template expressions or throw line breaks", () => {
    for (const source of [
      statement.replace("!e", '/hidden/ !e'),
      statement.replace("!e", '`hidden` !e'),
      statement.replace("throw new", "throw\nnew"),
      statement.replace("throw new", "throw/*\n*/new")
    ]) expect(ranges(source)).toEqual([]);
  });

  it("preserves the ordinary import/require analysis in mixed executable and inert source", () => {
    const source = 'const inert = ' + JSON.stringify(statement) + '; const ratio=object.default/2; '
      + 'require("node:path"); import("./lazy.js"); export * from "./core.js"; '
      + 'function prepare(){' + statement + 'return e;}';
    const ordinary = analyzePluginSource(source);
    const extended = analyzePluginSource(source, { ...option, includeModuleSpecifiers: true });
    const { automaticPublicPathFallbacks, moduleSpecifiers, ...retained } = extended;
    expect(retained).toEqual(ordinary);
    expect(automaticPublicPathFallbacks).toHaveLength(1);
    expect(moduleSpecifiers?.map(({ value }) => value)).toEqual(["./lazy.js", "./core.js"]);
    const serialized = `(${analyzePluginSource.toString()})(${JSON.stringify(source)},${JSON.stringify(option)})`;
    expect(vm.runInNewContext(serialized).automaticPublicPathFallbacks).toEqual(automaticPublicPathFallbacks);
  });
});
