import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outDir = await mkdtemp(join(tmpdir(), "atools-launcher-brand-"));
const built = await buildStaticBrowserFixture({
  projectRoot,
  entryHtml: "tests/components/launcher-brand-browser.html",
  outDir,
});
console.log(JSON.stringify({
  status: "static-build-ready",
  outputDirectory: outDir,
  entry: built.htmlFile,
  chunks: built.chunkCount,
}, null, 2));
