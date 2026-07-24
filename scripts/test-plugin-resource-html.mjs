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
const outFile = join(outDir, "pluginResourceHtml.mjs");
const resourceChecklistRow = "插件 HTML 资源兼容由 `pnpm test:plugin-resource-html` 覆盖：`main_url` 子目录、相对 script/style、CSS `url(...)` / `@import`、`srcset`、link icon/modulepreload、常见图片/媒体资源，以及入口 HTML 本地 `<base href>` 下的静态资源会按入口文件目录或声明 base 目录解析，改写后的 `<base>` 会保留原始本地 href marker；运行时动态资源属性解析由 `pnpm test:plugin-resource-runtime` 覆盖，常见动态插入的 image/media/script/link/object 节点、`<style>` 文本、inline `style` 属性、`CSSStyleSheet.insertRule()` 规则，以及 fetch-sensitive 的动态 script/link 通过 `appendChild` / `insertBefore` / `append` / `prepend` / `before` / `after` / `replaceWith` 插入前 preflight 会经父窗口转换本地相对 URL，并在存在当前本地 `<base href>` marker 或插件运行时更新后的 live 本地 `<base href>` 时按声明 base 目录解析。";

try {
  assert.equal(existsSync(sourcePath), true, "pluginResourceHtml helper should exist");

  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

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
  </body>
</html>`;
  const prepared = await mod.preparePluginHtmlResources(html, {
    pluginDir: "/plugins/sample",
    mainFile: "pages/index.html",
    convertFileSrc,
    readTextFile: async (path) => {
      reads.push(path);
      if (path === "/plugins/sample/pages/scripts/app.js") {
        return 'if(!e)throw new Error("Automatic publicPath is not supported in this browser"); window.scriptLoaded = true;';
      }
      if (path === "/plugins/sample/pages/styles/site.css") {
        return "@import './theme/base.css'; @import url('../fonts/font.css') screen; .hero { background: url('../assets/bg image.png?size=2'); } .data { mask: url(data:image/png;base64,abc); }";
      }
      throw new Error(`unexpected read ${path}`);
    },
  });

  assert.deepEqual(reads, [
    "/plugins/sample/pages/scripts/app.js",
    "/plugins/sample/pages/styles/site.css",
  ]);
  assert.match(prepared, /data-atools-plugin-script-src="asset\(\/plugins\/sample\/pages\/scripts\/app\.js\)"/);
  assert.match(prepared, /if\(!e\)e=new URL\("asset\(\/plugins\/sample\/pages\/scripts\/app\.js\)"/);
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

  const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
  assert.match(componentSource, /convertFileSrc/);
  assert.match(componentSource, /preparePluginHtmlResources/);
  assert.doesNotMatch(componentSource, /scriptSrcRegex/);

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assertCheckedChecklistRow(checklist, resourceChecklistRow);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
