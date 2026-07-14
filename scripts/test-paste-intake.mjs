import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(tmpdir(), "atools-paste-intake-"));
const outFile = join(outDir, "pasteIntake.mjs");

try {
  const sourcePath = new URL("src/lib/pasteIntake.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const input = {
    files: [
      { name: "invoice.png", type: "image/png", size: 1536, path: "/tmp/invoice.png" },
      { name: "report.pdf", type: "application/pdf", size: 2048, path: "/tmp/report.pdf" },
      { name: "clipboard-image.png", type: "image/png", size: 512 },
    ],
  };
  const items = mod.classifyPastedContent(input);

  assert.deepEqual(items.map((item) => item.kind), ["image", "file", "image"]);
  assert.equal(items[0].name, "invoice.png");
  assert.equal(items[0].path, "/tmp/invoice.png");
  assert.equal(items[2].path, undefined);
  assert.equal(mod.pasteQueryLabel(items), "粘贴了 2 张图片、1 个文件");

  const results = mod.pasteResultsForItems(items);
  assert.deepEqual(results.map((result) => result.plugin_id), ["paste", "paste", "paste", "paste", "paste"]);
  assert.deepEqual(results.map((result) => result.label), [
    "识别图片文字 invoice.png",
    "压缩图片 invoice.png",
    "打开粘贴文件 report.pdf",
    "在 Finder 中显示 report.pdf",
    "保存图片后再处理 clipboard-image.png",
  ]);
  assert.equal(results[0].code, "paste:ocr:paste-0");
  assert.equal(results[4].match_type, "pending");
  assert.ok(results[4].explain.includes("没有本地路径"));
} finally {
  await rm(outDir, { recursive: true, force: true });
}
