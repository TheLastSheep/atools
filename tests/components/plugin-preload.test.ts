// @vitest-environment node
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";
import { preparePluginPreload, type PluginPreloadOptions } from "../../src/lib/pluginPreload";

async function prepare(files: Record<string, string>, limits: Partial<PluginPreloadOptions> = {}) {
  const reads: string[] = [];
  const html = await preparePluginPreload({
    pluginDir: "/plugins/demo",
    preloadPath: "/plugins/demo/preload.js",
    readTextFile: async (path) => {
      reads.push(path);
      if (!(path in files)) throw Object.assign(new Error("missing file"), { code: "ENOENT" });
      return files[path];
    },
    ...limits,
  });
  return { html, reads };
}

function run(html: string, globals: Record<string, unknown> = {}) {
  const sandbox: Record<string, any> = { console, ...globals };
  sandbox.window = sandbox;
  sandbox.utools = sandbox.ztools = {};
  const source = html.replace(/^<script[^>]*>\n/, "").replace(/\n<\/script>$/, "");
  vm.runInNewContext(source, sandbox, { timeout: 1000 });
  return sandbox;
}

describe("isolated CommonJS preload modules", () => {
  it("reports literal external requires throughout the graph without resolving them as plugin files", async () => {
    const external: string[] = [];
    const sources: string[] = [];
    const { reads } = await prepare({
      "/plugins/demo/preload.js": `
        const fs = require('fs');
        require('node:fs');
        require('@scope/npm-package');
        require('electron');
        require('./helper');
      `,
      "/plugins/demo/helper.js": "require('node:crypto'); module.exports = 42;",
    }, { onExternalRequire: (specifier) => external.push(specifier), onModuleSource: source => sources.push(source) });
    expect(external).toEqual(["fs", "node:fs", "@scope/npm-package", "electron", "node:crypto"]);
    expect(sources).toEqual([expect.stringContaining("require('electron')"), expect.stringContaining("require('node:crypto')")]);
    expect(reads).toEqual(["/plugins/demo/preload.js", "/plugins/demo/helper", "/plugins/demo/helper.js"]);
  });

  it("ignores string/comment/template text and relative requests while finding template interpolation externals", async () => {
    const external: string[] = [];
    await prepare({
      "/plugins/demo/preload.js": `
        // require('comment-fs')
        /* require('block-fs') */
        const text = "require('string-fs')";
        const single = 'require("single-fs")';
        const template = \`require('template-fs') \${require('node:path').sep}\`;
        require('./helper.js');
      `,
      "/plugins/demo/helper.js": "module.exports = require('./value.json');",
      "/plugins/demo/value.json": '{"value":42}',
    }, { onExternalRequire: (specifier) => external.push(specifier) });
    expect(external).toEqual(["node:path"]);
  });

  it("runs real relative modules with JSON, index, package entry, lexical scope and correct filenames", async () => {
    const { html, reads } = await prepare({
      "/plugins/demo/preload.js": `
        // require('../../outside-comment')
        const ignored = "require('../../outside-string')";
        const value = require('./lib');
        const again = require('./lib');
        const packageValue = require('./package');
        module.exports = { value, same: value === again, packageValue, filename: __filename };
      `,
      "/plugins/demo/lib/index.js": `
        const ignored = 42;
        const config = require('../config.json');
        module.exports = { answer: config.answer + ignored, dir: __dirname };
      `,
      "/plugins/demo/config.json": '{"answer": 8}',
      "/plugins/demo/package/package.json": '{"main":"lib/main.cjs"}',
      "/plugins/demo/package/lib/main.cjs": 'module.exports = "package-main";',
    });
    const sandbox = run(html);
    expect(sandbox.services.value).toEqual({ answer: 50, dir: "/plugins/demo/lib" });
    expect(sandbox.services.same).toBe(true);
    expect(sandbox.services.packageValue).toBe("package-main");
    expect(sandbox.services.filename).toBe("/plugins/demo/preload.js");
    expect(reads.some((path) => path.includes("outside"))).toBe(false);
    expect(reads.filter((path) => path === "/plugins/demo/lib/index.js")).toHaveLength(1);
  });

  it("preserves CommonJS cycle exports and retries failed module execution", async () => {
    const { html } = await prepare({
      "/plugins/demo/preload.js": `
        window.count = 0;
        const a = require('./a');
        try { require('./flaky'); } catch (_) {}
        module.exports = { a, retried: require('./flaky') };
      `,
      "/plugins/demo/a.js": `exports.name = 'A'; exports.b = require('./b').seen;`,
      "/plugins/demo/b.js": `exports.seen = require('./a').name;`,
      "/plugins/demo/flaky.js": `if (++window.count === 1) throw new Error('first'); module.exports = window.count;`,
    });
    const sandbox = run(html);
    expect(sandbox.services.a).toEqual({ name: "A", b: "A" });
    expect(sandbox.services.retried).toBe(2);
  });

  it("keeps preload exports local so subsequent browser UMD scripts initialize their globals", async () => {
    const { html } = await prepare({
      "/plugins/demo/preload.js": `module.exports = { service: () => 'preload-value' };`,
    });
    const sandbox = run(html);
    // The same branch selection used by the original released CodeMirror asset.
    vm.runInNewContext(`(function(root, factory) {
      if (typeof exports === 'object' && typeof module !== 'undefined') module.exports = factory();
      else root.CodeMirror = factory();
    })(this, function() { return { fromTextArea: function() { return 'editor'; } }; });`, sandbox);
    expect(sandbox.CodeMirror.fromTextArea()).toBe("editor");
    expect(sandbox.services.service()).toBe("preload-value");
    expect("module" in sandbox).toBe(false);
    expect("exports" in sandbox).toBe(false);
  });

  it("defers optional missing modules but throws explicitly on missing, computed or native imports", async () => {
    const { html, reads } = await prepare({
      "/plugins/demo/preload.js": `
        module.exports = {
          optional() { return require('./missing'); },
          dynamic(name) { return require(name); },
          native() { return require('./native.node'); }
        };
      `,
    });
    const sandbox = run(html);
    expect(() => sandbox.services.optional()).toThrow("MODULE_NOT_FOUND");
    expect(() => sandbox.services.dynamic("./unseen")).toThrow("MODULE_NOT_FOUND");
    expect(() => sandbox.services.native()).toThrow("MODULE_NOT_FOUND");
    expect(reads.some((path) => path.endsWith(".node"))).toBe(false);
  });

  it("discovers literal requires inside nested template expressions without treating text as code", async () => {
    const { html, reads } = await prepare({
      "/plugins/demo/preload.js": 'module.exports = { value: `require("../../fake") ${`${require("./value.json").value}`}` };',
      "/plugins/demo/value.json": '{"value":42}',
    });
    expect(run(html).services.value).toBe('require("../../fake") 42');
    expect(reads.some((path) => path.includes("fake"))).toBe(false);
  });

  it("rejects package entry native addons and ESM without reading them as script source", async () => {
    for (const extension of ["node", "mjs"]) {
      const { html, reads } = await prepare({
        "/plugins/demo/preload.js": 'module.exports = { call() { return require("./package"); } };',
        "/plugins/demo/package/package.json": `{"main":"index.${extension}"}`,
        [`/plugins/demo/package/index.${extension}`]: "module.exports = 42;",
      });
      expect(reads.some((path) => path.endsWith(`.${extension}`))).toBe(false);
      expect(() => run(html).services.call()).toThrow("MODULE_NOT_FOUND");
    }
  });

  it("rejects root traversal before issuing any out-of-root read", async () => {
    const reads: string[] = [];
    await expect(preparePluginPreload({
      pluginDir: "/plugins/demo",
      preloadPath: "/plugins/demo/preload.js",
      readTextFile: async (path) => {
        reads.push(path);
        return "require('../demo-evil/secret.js')";
      },
    })).rejects.toThrow("PATH_OUTSIDE_PLUGIN");
    expect(reads).toEqual(["/plugins/demo/preload.js"]);
    await expect(prepare({}, { preloadPath: "/plugins/other/preload.js" })).rejects.toThrow("PATH_OUTSIDE_PLUGIN");
    await expect(prepare({
      "/plugins/demo/preload.js": "require('./escape')",
      "/plugins/demo/escape/package.json": '{"main":"../../outside.js"}',
    })).rejects.toThrow("PATH_OUTSIDE_PLUGIN");
  });

  it("bounds bytes, modules and unsuccessful resolution reads", async () => {
    await expect(prepare({ "/plugins/demo/preload.js": "module.exports = '你好';" }, { maxBytes: 20 })).rejects.toThrow("PRELOAD_BUDGET");
    await expect(prepare({
      "/plugins/demo/preload.js": "require('./helper')",
      "/plugins/demo/helper.js": "module.exports = 1;",
    }, { maxModules: 1 })).rejects.toThrow("PRELOAD_BUDGET");
    await expect(prepare({ "/plugins/demo/preload.js": "require('./missing')" }, { maxReads: 2 })).rejects.toThrow("PRELOAD_BUDGET");
  });

  it("does not hide backend symlink, permission or size failures as optional missing imports", async () => {
    await expect(prepare({ "/plugins/demo/preload.js": "require('./secret.json')" }, {
      readTextFile: async (path) => {
        if (path.endsWith("preload.js")) return "require('./secret.json')";
        throw "ERR_ATOOLS_PRELOAD_SYMLINK";
      },
    })).rejects.toBe("ERR_ATOOLS_PRELOAD_SYMLINK");
  });

  it("stops graph expansion when the plugin is replaced or the activation deadline expires", async () => {
    let active = true;
    const reads: string[] = [];
    await expect(prepare({}, {
      isCurrent: () => active,
      readTextFile: async (path) => {
        reads.push(path);
        active = false;
        return 'require("./helper")';
      },
    })).rejects.toThrow("CANCELLED");
    expect(reads).toEqual(["/plugins/demo/preload.js"]);
    await expect(prepare({}, {
      maxDurationMs: 10,
      readTextFile: () => new Promise(() => {}),
    })).rejects.toThrow("TIMEOUT");
  });

  it("escapes script closing tags while preserving the original exported text", async () => {
    const { html } = await prepare({ "/plugins/demo/preload.js": "module.exports = { html: '</script><p>text</p>' };" });
    expect(html.match(/<\/script>/gi)).toHaveLength(1);
    expect(run(html).services.html).toBe("</script><p>text</p>");
  });

  it("runs the original char-transform plugin algorithms without Node execution", async () => {
    const pluginDir = resolve("ZTools-plugins/plugins/char-transform");
    const html = await preparePluginPreload({
      pluginDir,
      preloadPath: `${pluginDir}/preload.js`,
      readTextFile: (path) => readFile(path, "utf8"),
    });
    let nodeRequests = 0;
    const sandbox = run(html, {
      require: (request: string) => {
        expect(request).toBe("node:crypto");
        nodeRequests += 1;
        return { createHash: () => { throw new Error("ERR_ATOOLS_NODE_COMPAT_UNSUPPORTED: crypto.createHash"); } };
      },
    });
    expect(sandbox.charTransformApi.transform("Hello HTTP World", "camelCase")).toBe("helloHttpWorld");
    expect(sandbox.charTransformApi.transform("helloHTTPWorld", "snake_case")).toBe("hello_http_world");
    expect(sandbox.charTransformApi.transform("hello world", "constant_case")).toBe("HELLO_WORLD");
    expect(sandbox.charTransformApi.transform("站酷 ATools", "urlEncode")).toBe("%E7%AB%99%E9%85%B7%20ATools");
    expect(nodeRequests).toBe(1);
    expect(() => sandbox.charTransformApi.transform("text", "md5")).toThrow("NODE_COMPAT_UNSUPPORTED");
  });
});
