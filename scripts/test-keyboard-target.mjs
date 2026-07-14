import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(tmpdir(), "atools-keyboard-target-"));
const outFile = join(outDir, "keyboardTarget.mjs");

try {
  const sourcePath = new URL("src/lib/keyboardTarget.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(mod.isEditableKeyboardTarget(null), false);
  assert.equal(mod.isEditableKeyboardTarget({}), false);
  assert.equal(mod.isEditableKeyboardTarget({ tagName: "INPUT" }), true);
  assert.equal(mod.isEditableKeyboardTarget({ tagName: "textarea" }), true);
  assert.equal(mod.isEditableKeyboardTarget({ tagName: "SELECT" }), true);
  assert.equal(mod.isEditableKeyboardTarget({ tagName: "button" }), false);
  assert.equal(mod.isEditableKeyboardTarget({ tagName: "div", isContentEditable: true }), true);
  assert.equal(mod.isMainSearchKeyboardTarget(null), false);
  assert.equal(mod.isMainSearchKeyboardTarget({ tagName: "INPUT" }), false);
  assert.equal(mod.isMainSearchKeyboardTarget({
    tagName: "INPUT",
    dataset: { atoolsSearchInput: "true" },
  }), true);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
