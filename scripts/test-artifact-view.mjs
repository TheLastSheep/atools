import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-artifact-view-"));
const outFile = join(outDir, "artifactView.mjs");

try {
  const sourcePath = new URL("src/lib/artifactView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);
  const mod = await import(pathToFileURL(outFile).href);

  const artifact = (kind, overrides = {}) => ({
    id: `artifact-${kind}`,
    kind,
    label: kind,
    metadata: {},
    ...overrides,
  });

  assert.equal(mod.artifactRenderKind(artifact("screenshot")), "image");
  assert.equal(mod.artifactRenderKind(artifact("csv")), "table");
  assert.equal(mod.artifactRenderKind(artifact("markdown")), "markdown");
  assert.equal(mod.artifactRenderKind(artifact("diff")), "diff");
  assert.equal(mod.artifactRenderKind(artifact("directory")), "file");
  assert.equal(mod.artifactPayload(artifact("json", { uri: "atools://task-runs/run-1/output" }), { ok: true }).ok, true);
  assert.deepEqual(mod.artifactPayload(artifact("table", { metadata: { content: [{ id: 1 }] } }), null), [{ id: 1 }]);
  assert.equal(mod.artifactPayload(artifact("markdown", { metadata: { outputField: "text" } }), { text: "hello" }), "hello");
  assert.equal(mod.artifactLocation(artifact("json", { uri: "atools://task-runs/run-1/output" })), null);
  assert.equal(mod.artifactLocation(artifact("file", { path: "/tmp/report.md" })), "/tmp/report.md");
  assert.equal(mod.artifactPreviewSource(artifact("image", { uri: "https://example.com/private.png" }), false, String), null);
  assert.equal(mod.artifactPreviewSource(artifact("image", { uri: "data:image/png;base64,AA==" }), false, String), "data:image/png;base64,AA==");
  assert.equal(mod.artifactPreviewSource(artifact("image", { path: "/tmp/a.png" }), true, (path) => `asset://${path}`), "asset:///tmp/a.png");

  const table = mod.artifactTable({ items: [{ name: "a", size: 1 }, { name: "b", size: 2 }] });
  assert.deepEqual(table.columns, ["name", "size"]);
  assert.equal(table.rows[1].name, "b");
  const csv = mod.artifactTable('name,note\nalpha,"a,b"');
  assert.equal(csv.rows[0].note, "a,b");

  assert.deepEqual(mod.artifactMarkdownBlocks("# Report\n\n- one\n\n```\nconst ok = true;\n```"), [
    { kind: "heading", level: 1, text: "Report" },
    { kind: "list_item", text: "one", ordered: false },
    { kind: "code", text: "const ok = true;" },
  ]);
  assert.deepEqual(mod.artifactDiffLines("--- a\n+++ b\n-old\n+new\n same").map((line) => line.tone), [
    "header", "header", "remove", "add", "context",
  ]);

  const panel = await readFile(new URL("src/components/AgentPanel.svelte", root), "utf8");
  for (const token of ["artifactRenderKind", "artifactTable", "artifactMarkdownBlocks", "artifactDiffLines", "artifactPreviewSource", "openArtifact", "revealArtifact"]) {
    assert.ok(panel.includes(token), `AgentPanel should use ${token}`);
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
