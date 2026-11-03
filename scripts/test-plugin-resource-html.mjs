import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";
import { assertCheckedChecklistRow } from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url);
const sourceUrl = new URL("src/lib/pluginResourceHtml.ts", root);
const sourcePath = sourceUrl.pathname;
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-resource-html-"));
const moduleDir = join(outDir, "src", "lib");
const outFile = join(moduleDir, "pluginResourceHtml.mjs");
const resourceChecklistRow = "插件 HTML 资源兼容由 `pnpm test:plugin-resource-html` 覆盖：`main_url` 子目录、相对 script/style、CSS `url(...)` / `@import`、`srcset`、link icon/modulepreload、常见图片/媒体资源，以及入口 HTML 本地 `<base href>` 下的静态资源会按入口文件目录或声明 base 目录解析，改写后的 `<base>` 会保留原始本地 href marker；运行时动态资源属性解析由 `pnpm test:plugin-resource-runtime` 覆盖，常见动态插入的 image/media/script/link/object 节点、`<style>` 文本、inline `style` 属性、`CSSStyleSheet.insertRule()` 规则，以及 fetch-sensitive 的动态 script/link 通过 `appendChild` / `insertBefore` / `append` / `prepend` / `before` / `after` / `replaceWith` 插入前 preflight 会经父窗口转换本地相对 URL，并在存在当前本地 `<base href>` marker 或插件运行时更新后的 live 本地 `<base href>` 时按声明 base 目录解析。";

try {
  assert.equal(existsSync(sourcePath), true, "pluginResourceHtml helper should exist");

  await (await import("node:fs/promises")).mkdir(moduleDir, { recursive: true });
  for (const name of [
    "pluginResourceHtml", "pluginHtmlScripts", "pluginInlineModules", "pluginSourceAnalysis",
    "pluginResourceFilePath", "pluginPackageResourcePath", "pluginActiveHtmlFontMetadata",
    "optionalRemoteFontMetadata",
  ]) {
    const file = join(root.pathname, `src/lib/${name}.ts`);
    const source = await readFile(file, "utf8");
    const transformed = await transformWithEsbuild(source, file, { format: "esm", target: "esnext", loader: "ts" });
    const executable = transformed.code.replace(/from ["']\.\/(pluginHtmlScripts|pluginInlineModules|pluginSourceAnalysis|pluginResourceFilePath|pluginPackageResourcePath|pluginActiveHtmlFontMetadata|optionalRemoteFontMetadata)["']/g, (_match, dependency) => `from "./${dependency}.mjs"`);
    await writeFile(join(moduleDir, `${name}.mjs`), executable);
  }

  const mod = await import(pathToFileURL(outFile).href);
  assert.equal(typeof mod.pluginMainResourceDir, "function");
  assert.equal(typeof mod.pluginResourceFilePath, "function");
  assert.equal(typeof mod.convertPluginResourceUrl, "function");
  assert.equal(typeof mod.preparePluginHtmlResources, "function");

  assert.equal(
    mod.pluginMainResourceDir("/plugins/sample", "pages/index.html"),
    "/plugins/sample/pages",
  );
  assert.equal(
    mod.pluginMainResourceDir("/plugins/sample", "index.html"),
    "/plugins/sample",
  );
  assert.equal(
    mod.pluginResourceFilePath("/plugins/sample", "pages/index.html", "./scripts/app.js"),
    "/plugins/sample/pages/scripts/app.js",
  );
  assert.equal(
    mod.pluginResourceFilePath("/plugins/sample", "pages/index.html", "../assets/logo.png"),
    "/plugins/sample/assets/logo.png",
  );
  assert.equal(
    mod.pluginResourceFilePath("/plugins/sample", "pages/index.html", "/tmp/absolute.png"),
    "/tmp/absolute.png",
  );
  assert.equal(
    mod.pluginResourceFilePath("/plugins/sample", "pages/index.html", "https://example.com/app.js"),
    null,
  );
  assert.equal(
    mod.pluginResourceFilePath("/plugins/sample", "pages/index.html", "#local"),
    null,
  );

  const convertFileSrc = (path) => `asset(${path})`;
  assert.equal(
    mod.convertPluginResourceUrl("../assets/logo space.png?version=1#icon", {
      pluginDir: "/plugins/sample",
      mainFile: "pages/index.html",
      convertFileSrc,
    }),
    "asset(/plugins/sample/assets/logo space.png)?version=1#icon",
  );
  assert.equal(
    mod.convertPluginResourceUrl("data:image/png;base64,abc", {
      pluginDir: "/plugins/sample",
      mainFile: "pages/index.html",
      convertFileSrc,
    }),
    "data:image/png;base64,abc",
  );

  const reads = [];
  const html = `<!doctype html>
<html>
  <head>
    <link rel="stylesheet" href="./styles/site.css">
    <link rel="icon" href="../assets/icon.svg" type="image/svg+xml">
    <link rel="modulepreload" href="./scripts/chunk.js">
  </head>
  <body>
    <img class="logo" src="../assets/logo.png" srcset="./small.png 1x, ../assets/logo@2x.png 2x, https://example.com/remote.png 3x">
    <source srcset="./media/clip-small.mp4 480w, data:video/mp4;base64,abc 720w" type="video/mp4">
    <script type="module" src="./scripts/app.js"></script>
    <script src="./scripts/legacy.js"></script>
  </body>
</html>`;
  const prepared = await mod.preparePluginHtmlResources(html, {
    pluginDir: "/plugins/sample",
    mainFile: "pages/index.html",
    convertFileSrc,
    readTextFile: async (path) => {
      reads.push(path);
      if (path === "/plugins/sample/pages/scripts/legacy.js") {
        return 'if(!e)throw new Error("Automatic publicPath is not supported in this browser"); window.scriptLoaded = true;';
      }
      if (path === "/plugins/sample/pages/styles/site.css") {
        return "@import './theme/base.css'; @import url('../fonts/font.css') screen; .hero { background: url('../assets/bg image.png?size=2'); } .data { mask: url(data:image/png;base64,abc); }";
      }
      throw new Error(`unexpected read ${path}`);
    },
  });

  assert.deepEqual(reads, [
    "/plugins/sample/pages/scripts/legacy.js",
    "/plugins/sample/pages/styles/site.css",
  ]);
  assert.match(prepared, /data-atools-plugin-script-src="asset\(\/plugins\/sample\/pages\/scripts\/app\.js\)"/);
  assert.match(prepared, /<script type="module"\s+src="asset\(\/plugins\/sample\/pages\/scripts\/app\.js\)"/);
  assert.match(prepared, /if\(!e\)e=new URL\("asset\(\/plugins\/sample\/pages\/scripts\/legacy\.js\)"/);
  assert.match(prepared, /window\.scriptLoaded = true;/);
  assert.doesNotMatch(prepared, /src="\.\/scripts\/app\.js"/);
  assert.match(prepared, /<style data-atools-plugin-href="\.\/styles\/site\.css">/);
  assert.doesNotMatch(prepared, /<link rel="stylesheet"/);
  assert.match(prepared, /href="asset\(\S*\/plugins\/sample\/assets\/icon\.svg\)"/);
  assert.match(prepared, /href="asset\(\S*\/plugins\/sample\/pages\/scripts\/chunk\.js\)"/);
  assert.match(prepared, /src="asset\(\S*\/plugins\/sample\/assets\/logo\.png\)"/);
  assert.match(prepared, /srcset="asset\(\S*\/plugins\/sample\/pages\/small\.png\) 1x, asset\(\S*\/plugins\/sample\/assets\/logo@2x\.png\) 2x, https:\/\/example\.com\/remote\.png 3x"/);
  assert.match(prepared, /srcset="asset\(\S*\/plugins\/sample\/pages\/media\/clip-small\.mp4\) 480w, data:video\/mp4;base64,abc 720w"/);
  assert.match(prepared, /@import "asset\(\/plugins\/sample\/pages\/styles\/theme\/base\.css\)";/);
  assert.match(prepared, /@import url\("asset\(\/plugins\/sample\/pages\/fonts\/font\.css\)"\) screen;/);
  assert.match(prepared, /url\("asset\(\/plugins\/sample\/pages\/assets\/bg image\.png\)\?size=2"\)/);
  assert.match(prepared, /url\(data:image\/png;base64,abc\)/);

  const publicPathLeases = [];
  const leasedBundle = await mod.preparePluginHtmlResources('<script src="./bundle.js"></script><script src="./plain.js"></script>', {
    pluginDir: "/plugins/sample", mainFile: "pages/index.html", convertFileSrc,
    resolveModuleSrc: async file => { publicPathLeases.push(file); return "atools-plugin://localhost/session/pages/bundle.js"; },
    readTextFile: async file => file.endsWith("bundle.js")
      ? 'if(!e)throw new Error("Automatic publicPath is not supported in this browser"); window.bundle=true;'
      : 'window.plain=true;',
  });
  assert.deepEqual(publicPathLeases, ["/plugins/sample/pages/bundle.js"], "only bundles requiring automatic publicPath lazily acquire a lease");
  assert.match(leasedBundle, /data-atools-plugin-public-path-src="atools-plugin:\/\/localhost\/session\/pages\/bundle\.js"/);
  assert.match(leasedBundle, /if\(!e\)e=new URL\("atools-plugin:\/\/localhost\/session\/pages\/bundle\.js", document.baseURI\)\.href/);
  assert.match(leasedBundle, /data-atools-plugin-script-src="asset\(\/plugins\/sample\/pages\/plain\.js\)"/);
  await assert.rejects(mod.preparePluginHtmlResources('<script src="bundle.js"></script>', {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { throw Error("revoked resource lease"); },
    readTextFile: async () => 'if(!e)throw new Error("Automatic publicPath is not supported in this browser");',
  }), /revoked resource lease/, "failed lease never falls back to an unscoped asset publicPath");
  const decoySource = '/* if(!e)throw new Error("Automatic publicPath is not supported in this browser"); */\n'
    + 'const text = \'if(!e)throw new Error("Automatic publicPath is not supported in this browser");\';';
  const decoyHtml = await mod.preparePluginHtmlResources('<script src="./decoy.js"></script>', {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { throw Error("inert text must not allocate a lease"); }, readTextFile: async () => decoySource,
  });
  assert.ok(decoyHtml.includes(decoySource));
  assert.doesNotMatch(decoyHtml, /data-atools-plugin-public-path-src/);
  const inertExternalHtml = '<!-- <script src="unused.js"></script> --><template><script src="unused.js"></script></template>'
    + '<textarea><script src="unused.js"></script></textarea><script type="application/json" src="unused.js"></script>';
  const inertExternalResult = await mod.preparePluginHtmlResources(inertExternalHtml, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { throw Error("inert HTML must not allocate a lease"); },
    readTextFile: async () => { throw Error("inert HTML must not read a script"); },
  });
  assert.equal(inertExternalResult, inertExternalHtml);

  const baseReads = [];
  const baseHtml = `<!doctype html>
<html>
  <head>
    <base href="./app/">
    <link rel="stylesheet" href="styles/base.css">
    <link rel="icon" href="icons/icon.svg">
  </head>
  <body>
    <img src="images/logo.png">
    <script src="scripts/base.js"></script>
  </body>
</html>`;
  const preparedWithBase = await mod.preparePluginHtmlResources(baseHtml, {
    pluginDir: "/plugins/sample",
    mainFile: "pages/index.html",
    convertFileSrc,
    readTextFile: async (path) => {
      baseReads.push(path);
      if (path === "/plugins/sample/pages/app/scripts/base.js") {
        return "window.baseScriptLoaded = true;";
      }
      if (path === "/plugins/sample/pages/app/styles/base.css") {
        return ".base { background: url('../shared/bg.png'); }";
      }
      throw new Error(`unexpected base read ${path}`);
    },
  });

  assert.deepEqual(baseReads, [
    "/plugins/sample/pages/app/scripts/base.js",
    "/plugins/sample/pages/app/styles/base.css",
  ]);
  assert.match(preparedWithBase, /<base href="asset\(\/plugins\/sample\/pages\/app\/\)" data-atools-plugin-base-href="\.\/app\/">/);
  assert.match(preparedWithBase, /data-atools-plugin-script-src="asset\(\/plugins\/sample\/pages\/app\/scripts\/base\.js\)"/);
  assert.match(preparedWithBase, /window\.baseScriptLoaded = true;/);
  assert.doesNotMatch(preparedWithBase, /src="scripts\/base\.js"/);
  assert.match(preparedWithBase, /<style data-atools-plugin-href="styles\/base\.css">/);
  assert.doesNotMatch(preparedWithBase, /<link rel="stylesheet" href="styles\/base\.css"/);
  assert.match(preparedWithBase, /href="asset\(\/plugins\/sample\/pages\/app\/icons\/icon\.svg\)"/);
  assert.match(preparedWithBase, /src="asset\(\/plugins\/sample\/pages\/app\/images\/logo\.png\)"/);
  assert.match(preparedWithBase, /url\("asset\(\/plugins\/sample\/pages\/app\/shared\/bg\.png\)"\)/);

  const leases = [];
  const contentWorkbenchHtml = `<main><script type="module">
import { normalizeText } from './src/core/index.mjs?rev=4#core';
export { normalizeText } from "./src/core/index.mjs?rev=4#core";
const lazy = () => import('../shared/lazy.mjs');
window.result = normalizeText('  hi  ');
</script></main>`;
  const contentWorkbenchPrepared = await mod.preparePluginHtmlResources(contentWorkbenchHtml, {
    pluginDir: "/plugins/content-workbench", mainFile: "pages/index.html", convertFileSrc,
    resolveModuleSrc: async (path) => { leases.push(path); return `atools-plugin://localhost/session/${path.slice(1)}`; },
    readTextFile: async () => { throw new Error("unexpected file read"); },
  });
  assert.deepEqual(leases, ["/plugins/content-workbench/pages/src/core/index.mjs", "/plugins/content-workbench/shared/lazy.mjs"]);
  assert.match(contentWorkbenchPrepared, /data-atools-plugin-module-imports="\[&quot;atools-plugin:\/\/localhost\/session\/plugins\/content-workbench\/pages\/src\/core\/index\.mjs\?rev=4#core&quot;,&quot;atools-plugin:\/\/localhost\/session\/plugins\/content-workbench\/shared\/lazy\.mjs&quot;\]"/);
  assert.match(contentWorkbenchPrepared, /import \{ normalizeText \} from "atools-plugin:\/\/localhost\/session\/plugins\/content-workbench\/pages\/src\/core\/index\.mjs\?rev=4#core"/);
  assert.match(contentWorkbenchPrepared, /export \{ normalizeText \} from "atools-plugin:\/\/localhost\/session\/plugins\/content-workbench\/pages\/src\/core\/index\.mjs\?rev=4#core"/);
  assert.match(contentWorkbenchPrepared, /import\("atools-plugin:\/\/localhost\/session\/plugins\/content-workbench\/shared\/lazy\.mjs"\)/);

  await assert.rejects(mod.preparePluginHtmlResources('<script type="module">import "../../outside.mjs";</script>', {
    pluginDir: "/plugins/sample", mainFile: "pages/index.html", convertFileSrc,
    resolveModuleSrc: async () => { throw new Error("out-of-root imports must fail before leasing"); },
    readTextFile: async () => "",
  }), /ERR_ATOOLS_INLINE_MODULE_PATH/);

  const escapedUrlPrepared = await mod.preparePluginHtmlResources('<script type="module">import "./escaped.mjs";</script>', {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => `lease</script>\u2028tail`, readTextFile: async () => "",
  });
  assert.match(escapedUrlPrepared, /import "lease\\u003c\/script>\\u2028tail"/);
  assert.ok(escapedUrlPrepared.includes(`data-atools-plugin-module-imports="[&quot;lease&lt;/script&gt;${String.fromCharCode(0x2028)}tail&quot;]"`));

  const keywordAndRegex = await mod.preparePluginHtmlResources(`<script type="module">import { export as picked } from "./dep.js"; export default /import x from '\\.\\/ghost.js'/;</script>`, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => "lease(dep)", readTextFile: async () => "",
  });
  assert.match(keywordAndRegex, /from "lease\(dep\)"/);
  assert.match(keywordAndRegex, /\/import x from '\\\.\\\/ghost\.js'\//);
  await transformWithEsbuild(keywordAndRegex.match(/<script[^>]*>([\s\S]*?)<\/script>/i)[1], "fixture.mjs", { format: "esm", target: "esnext", loader: "js" });

  const memberAndNamespace = await mod.preparePluginHtmlResources(`<script type="module">const ratio = options.default / 2; import './real.js'; export * as from from './namespace.js';</script><script type="module">export * as 'from' from './string-namespace.js';</script>`, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async path => `lease(${path.split("/").pop()})`, readTextFile: async () => "",
  });
  assert.match(memberAndNamespace, /options\.default \/ 2/);
  assert.match(memberAndNamespace, /import "lease\(real\.js\)"/);
  assert.match(memberAndNamespace, /export \* as from from "lease\(namespace\.js\)"/);
  assert.match(memberAndNamespace, /export \* as 'from' from "lease\(string-namespace\.js\)"/);
  for (const match of memberAndNamespace.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    await transformWithEsbuild(match[1], "fixture.mjs", { format: "esm", target: "esnext", loader: "js" });
  }

  let untouchedResolverCalls = 0;
  const noImportHtml = '<script type="module">/* import "./fake.js" */ const x = "import \'./fake.js\'"; const t = `import "./fake.js"`; const r = /import\\("\.\/fake\.js"\\)/;</script>';
  const noImportPrepared = await mod.preparePluginHtmlResources(noImportHtml, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { untouchedResolverCalls++; return "never"; }, readTextFile: async () => "",
  });
  assert.equal(noImportPrepared, noImportHtml);
  assert.equal(untouchedResolverCalls, 0);

  const suffixAndBase = await mod.preparePluginHtmlResources('<base href="./app/"><script type="module">import "./entry.mjs?x=1#part";</script>', {
    pluginDir: "/plugins/sample", mainFile: "pages/index.html", convertFileSrc,
    resolveModuleSrc: async (path) => `lease(${path})`, readTextFile: async () => "",
  });
  assert.match(suffixAndBase, /from|import "lease\(\/plugins\/sample\/pages\/app\/entry\.mjs\)\?x=1#part"/);

  let duplicateLeaseCalls = 0;
  await mod.preparePluginHtmlResources('<script type="module">import "./same.mjs"; import "./same.mjs";</script>', {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { duplicateLeaseCalls++; return "lease(same)"; }, readTextFile: async () => "",
  });
  assert.equal(duplicateLeaseCalls, 1, "duplicate specifiers share one resolved lease");

  await assert.rejects(() => mod.preparePluginHtmlResources('<script type="module">import "./missing.mjs";</script>', {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { throw new Error("resolver rejected"); }, readTextFile: async () => "",
  }), /resolver rejected/);
  await assert.rejects(() => mod.preparePluginHtmlResources(`<script type="module">import "./x.mjs";${" ".repeat(256 * 1024)}</script>`, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => "lease(x)", readTextFile: async () => "",
  }), /ERR_ATOOLS_INLINE_MODULE_BUDGET/);
  let budgetResolverCalls = 0;
  const duplicateHeavy = `<script type="module">${Array.from({ length: 129 }, () => 'import "./same.mjs";').join("")}</script>`;
  await assert.rejects(() => mod.preparePluginHtmlResources(duplicateHeavy, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { budgetResolverCalls++; return "lease(same)"; }, readTextFile: async () => "",
  }), /ERR_ATOOLS_INLINE_MODULE_BUDGET/);
  assert.equal(budgetResolverCalls, 0, "reference budget rejects before requesting a lease");
  const oversizedPageModules = Array.from({ length: 9 }, () => `<script type="module">/*${"x".repeat(240 * 1024)}*/</script>`).join("");
  await assert.rejects(() => mod.preparePluginHtmlResources(oversizedPageModules, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { budgetResolverCalls++; return "lease(never)"; }, readTextFile: async () => "",
  }), /ERR_ATOOLS_INLINE_MODULE_BUDGET/);
  assert.equal(budgetResolverCalls, 0, "page scan budget includes modules without imports");

  const inertAndActiveHtml = `<!-- <script type="module">import "../../outside/comment.mjs"</script> -->
<template><script type="module">import "../../outside/template.mjs"</script><template><script>nested</script></template></template>
<style>.x::before { content: '<script type="module">import "../../outside/style.mjs"</script>'; }</style>
<textarea><script type="module">import "../../outside/textarea.mjs"</script></textarea><title><script>title text</script></title>
<noscript><script type="module">import "../../outside/noscript.mjs"</script></noscript>
<script type="module" data-note=">">const text = '<template><script>'; import "./real.mjs";</script>`;
  const inertLeaseCalls = [];
  const inertPrepared = await mod.preparePluginHtmlResources(inertAndActiveHtml, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async (path) => { inertLeaseCalls.push(path); return `lease(${path})`; },
    readTextFile: async () => { throw new Error("resource loading is not part of inline discovery"); },
  });
  assert.deepEqual(inertLeaseCalls, ["/plugins/sample/real.mjs"]);
  assert.equal((inertPrepared.match(/data-atools-plugin-module-imports=/g) ?? []).length, 1);
  assert.match(inertPrepared, /<script type="module" data-note=">" data-atools-plugin-module-imports=/);
  assert.match(inertPrepared, /import "lease\(\/plugins\/sample\/real\.mjs\)"/);
  assert.match(inertPrepared, /outside\/(?:comment|template|style|textarea|noscript)\.mjs/);

  const remoteImports = '<script type="module">import "react"; import "https://cdn.example/x.mjs"; import "//cdn.example/y.mjs";</script>';
  assert.equal(await mod.preparePluginHtmlResources(remoteImports, {
    pluginDir: "/plugins/sample", mainFile: "index.html", convertFileSrc,
    resolveModuleSrc: async () => { throw new Error("non-local import should not lease"); }, readTextFile: async () => "",
  }), remoteImports);

  const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  assert.match(componentSource, /convertFileSrc/);
  assert.match(componentSource, /import\s*\{\s*createPluginPanelDocumentSourceHost\s*\}\s*from\s*["']\.\.\/lib\/pluginPanelDocumentSourceHost["']/);
  assert.match(componentSource, /const\s+pluginPanelDocumentSourceHost\s*=\s*createPluginPanelDocumentSourceHost\s*\(/);
  assert.doesNotMatch(componentSource, /scriptSrcRegex/);
  for (const relativePath of ["src/lib/pluginPanelLoadController.ts", "src/lib/pluginPanelBrowserWindowRuntime.ts"]) {
    const source = await readFile(new URL(relativePath, root), "utf8");
    assert.match(source, /import\s*\{[^}]*\bpreparePluginHtmlResources\b[^}]*\}\s*from\s*["']\.\/pluginResourceHtml["']/);
    assert.match(source, /await\s+preparePluginHtmlResources\s*\(/);
  }

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assertCheckedChecklistRow(checklist, resourceChecklistRow);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
