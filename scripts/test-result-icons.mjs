import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-result-icons-"));
const outFile = join(outDir, "resultIcons.mjs");

try {
  const sourcePath = new URL("src/lib/resultIcons.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const convert = (path) => `asset://localhost/${encodeURIComponent(path)}`;

  assert.equal(mod.resultIconSrc(null, true, convert), null);
  assert.equal(mod.resultIconSrc("", true, convert), null);
  assert.equal(mod.resultIconSrc("data:image/png;base64,abc", false, convert), "data:image/png;base64,abc");
  assert.equal(mod.resultIconSrc("https://example.com/icon.png", false, convert), "https://example.com/icon.png");
  assert.equal(mod.resultIconSrc("asset://localhost/icon.png", false, convert), "asset://localhost/icon.png");

  assert.equal(mod.resultIconSrc("/Applications/Code.app/Contents/Resources/AppIcon.icns", false, convert), null);
  assert.equal(
    mod.resultIconSrc("/Applications/Code.app/Contents/Resources/AppIcon.icns", true, convert),
    "asset://localhost/%2FApplications%2FCode.app%2FContents%2FResources%2FAppIcon.icns",
  );
  assert.equal(
    mod.resultIconSrc("C:\\Program Files\\App\\icon.ico", true, convert),
    "asset://localhost/C%3A%5CProgram%20Files%5CApp%5Cicon.ico",
  );
  assert.equal(mod.resultIconSrc("/tmp/missing.png", true, () => {
    throw new Error("runtime unavailable");
  }), null);

  assert.equal(mod.hasTauriAssetRuntime(), false);
  globalThis.window = { __TAURI_INTERNALS__: {} };
  assert.equal(mod.hasTauriAssetRuntime(), true);
  globalThis.window = { __TAURI_IPC__: () => {} };
  assert.equal(mod.hasTauriAssetRuntime(), true);
  delete globalThis.window;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
