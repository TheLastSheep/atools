import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-mcp-request-grants-settings-"));
const outFile = join(outDir, "settingsPages.mjs");

try {
  const sourcePath = new URL("src/lib/settingsPages.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(typeof mod.mcpPendingRequestRows, "function", "settingsPages should expose MCP pending request rows");
  assert.equal(typeof mod.mcpGrantRows, "function", "settingsPages should expose MCP grant rows");

  const pendingRows = mod.mcpPendingRequestRows([
    {
      id: "req-1",
      client_id: "codex",
      tool_name: "rename_files",
      arguments: { files: ["/tmp/a.txt"], dry_run: true },
      scopes: ["file:write", "plugin:data"],
      created_at: "2026-06-03T07:00:00Z",
    },
  ]);

  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0].id, "req-1");
  assert.equal(pendingRows[0].toolName, "rename_files");
  assert.equal(pendingRows[0].clientId, "codex");
  assert.equal(pendingRows[0].scopeLabel, "file:write, plugin:data");
  assert.match(pendingRows[0].argumentPreview, /dry_run/);
  assert.deepEqual(pendingRows[0].actions, ["允许一次", "允许并记住", "拒绝"]);

  const grantRows = mod.mcpGrantRows([
    {
      client_id: "claude-code",
      tool_name: "find_local_files",
      created_at: "2026-06-03T07:00:00Z",
      updated_at: "2026-06-03T07:10:00Z",
    },
  ]);

  assert.equal(grantRows.length, 1);
  assert.equal(grantRows[0].clientId, "claude-code");
  assert.equal(grantRows[0].toolName, "find_local_files");
  assert.equal(grantRows[0].summary, "claude-code · find_local_files");
  assert.equal(grantRows[0].updatedAt, "2026-06-03T07:10:00Z");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("待确认请求"), "MCP page should render pending requests");
  assert.ok(panel.includes("持久授权"), "MCP page should render persistent grants");
  assert.ok(panel.includes("mcpPendingRequestRows"), "MCP page should use the shared pending request row model");
  assert.ok(panel.includes("mcpGrantRows"), "MCP page should use the shared grant row model");
  assert.ok(panel.includes("list_agent_tool_grants"), "MCP page should load persistent grants");
  assert.ok(panel.includes("call_agent_tool"), "MCP page should allow a pending request once");
  assert.ok(panel.includes("grant_agent_tool"), "MCP page should allow and remember a pending request");
  assert.ok(panel.includes("dismiss_pending_agent_request"), "MCP page should reject or dismiss pending requests");
  assert.ok(panel.includes("revoke_agent_tool"), "MCP page should revoke persistent grants");
  assert.ok(panel.includes("允许一次"), "MCP page should expose allow-once action");
  assert.ok(panel.includes("允许并记住"), "MCP page should expose allow-and-remember action");
  assert.ok(panel.includes("撤销"), "MCP page should expose grant revoke action");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
