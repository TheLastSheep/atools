import assert from "node:assert/strict";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { build, preview } from "vite";

export async function buildStaticBrowserFixture({ projectRoot, entryHtml, outDir }) {
  const absoluteRoot = resolve(projectRoot);
  const absoluteOutDir = resolve(outDir);
  const absoluteEntry = isAbsolute(entryHtml) ? resolve(entryHtml) : resolve(absoluteRoot, entryHtml);
  const entryOutput = relative(absoluteRoot, absoluteEntry).split(sep).join("/");
  assert.ok(entryOutput && !entryOutput.startsWith("../"), "Fixture HTML entry must be inside the project root");

  const result = await build({
    configFile: resolve(absoluteRoot, "vite.config.ts"),
    root: absoluteRoot,
    mode: "test",
    build: {
      outDir: absoluteOutDir,
      emptyOutDir: true,
      rollupOptions: { input: absoluteEntry },
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output);
  const htmlOutput = outputs.find((output) => output.type === "asset" && output.fileName === entryOutput);
  assert.ok(htmlOutput, `Static build must emit the requested fixture HTML entry: ${entryOutput}`);
  return {
    outputFiles: outputs.map((output) => output.fileName).sort(),
    chunkCount: outputs.filter((output) => output.type === "chunk").length,
    assetCount: outputs.filter((output) => output.type === "asset").length,
    htmlFile: htmlOutput.fileName,
  };
}

export function previewStaticBrowserFixture({ projectRoot, outDir, host, port }) {
  const absoluteRoot = resolve(projectRoot);
  return preview({
    configFile: resolve(absoluteRoot, "vite.config.ts"),
    root: absoluteRoot,
    build: { outDir: resolve(outDir) },
    preview: { host, port, strictPort: true },
  });
}
