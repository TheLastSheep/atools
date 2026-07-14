import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-permission-preview-"));
const outFile = join(outDir, "permissionPreview.mjs");

try {
  const sourcePath = new URL("src/lib/permissionPreview.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  const request = {
    id: "req-1",
    client_id: "codex",
    tool_name: "rename_files",
    arguments: {
      dry_run: true,
      files: [
        { source: "/Users/harris/Downloads/a.png", target: "/Users/harris/Archive/a.png" },
        { source: "/Users/harris/Downloads/b.png", target: "/Users/harris/Archive/b.png" },
      ],
    },
    scopes: ["file_read", "file_write"],
    created_at: "2026-06-02T00:00:00Z",
  };

  const preview = mod.permissionRequestPreview(request);
  assert.equal(preview.dryRun, true);
  assert.deepEqual(preview.paths, [
    "/Users/harris/Downloads/a.png",
    "/Users/harris/Archive/a.png",
    "/Users/harris/Downloads/b.png",
    "/Users/harris/Archive/b.png",
  ]);
  assert.deepEqual(preview.scopeLabels, ["读取文件", "修改文件"]);
  assert.equal(preview.riskLevel, "medium");
  assert.ok(preview.risks.some((item) => item.includes("dry-run")));
  assert.ok(preview.risks.some((item) => item.includes("修改文件")));
  assert.ok(preview.risks.some((item) => item.includes("涉及 4 个本地路径")));

  const shellPreview = mod.permissionRequestPreview({
    ...request,
    tool_name: "open_or_reveal_path",
    arguments: { path: "/Applications/Terminal.app", reveal: true },
    scopes: ["shell"],
  });
  assert.equal(shellPreview.dryRun, false);
  assert.equal(shellPreview.riskLevel, "high");
  assert.ok(shellPreview.risks.some((item) => item.includes("执行命令")));
  assert.deepEqual(shellPreview.paths, ["/Applications/Terminal.app"]);

  const systemSettingsPreview = mod.permissionRequestPreview({
    ...request,
    tool_name: "system_settings",
    arguments: { setting: "launch_agent", enabled: true },
    scopes: ["system_settings"],
  });
  assert.equal(systemSettingsPreview.riskLevel, "high");
  assert.ok(systemSettingsPreview.risks.some((item) => item.includes("系统设置")));

  const safePreview = mod.permissionRequestPreview({
    ...request,
    tool_name: "search_clipboard",
    arguments: { query: "invoice" },
    scopes: ["clipboard_read"],
  });
  assert.equal(safePreview.riskLevel, "low");
  assert.equal(safePreview.paths.length, 0);
  assert.ok(safePreview.risks.some((item) => item.includes("审计记录")));

  const dialog = await readFile(new URL("../src/components/PermissionConfirmDialog.svelte", import.meta.url), "utf8");
  assert.ok(dialog.includes("Agent 权限确认"), "Permission dialog should identify the confirmation surface");
  assert.ok(dialog.includes('<h2 id="permission-title">{request.tool_name}</h2>'), "Permission dialog should render the tool name");
  assert.ok(dialog.includes("<dt>客户端</dt>"), "Permission dialog should render the client label");
  assert.ok(dialog.includes("<dd>{request.client_id}</dd>"), "Permission dialog should render the client id");
  assert.ok(dialog.includes("<dt>Scope</dt>"), "Permission dialog should render scope information");
  assert.ok(dialog.includes("{#each request.scopes as scope}"), "Permission dialog should render all requested scopes");
  assert.ok(dialog.includes("scopeLabel(scope)"), "Permission dialog should render human-readable scope labels");
  assert.ok(dialog.includes("<dt>执行模式</dt>"), "Permission dialog should render the execution mode label");
  assert.ok(dialog.includes('preview.dryRun ? "dry-run 预览" : "可能执行"'), "Permission dialog should distinguish dry-run from executable requests");
  assert.ok(dialog.includes("<h3>关键参数</h3>"), "Permission dialog should render key arguments");
  assert.ok(dialog.includes("argumentPairs(request.arguments)"), "Permission dialog should derive key arguments from request arguments");
  assert.ok(dialog.includes("<summary>完整 JSON</summary>"), "Permission dialog should keep full arguments available");
  assert.ok(dialog.includes('<section class="path-box">'), "Permission dialog should render a path section when paths exist");
  assert.ok(dialog.includes("<h3>涉及路径</h3>"), "Permission dialog should label involved paths");
  assert.ok(dialog.includes("{#each preview.paths as path}"), "Permission dialog should render all preview paths");
  assert.match(dialog, /\.permission-card\s*\{[\s\S]*?max-height: calc\(100vh - 32px\);[\s\S]*?overflow: auto;/, "Permission card should scroll instead of covering action buttons");
  assert.match(dialog, /code\s*\{[\s\S]*?white-space: pre-wrap;[\s\S]*?overflow-wrap: anywhere;/, "Path and argument code cells should wrap long values");
  assert.ok(dialog.includes('<section class={`risk-box ${preview.riskLevel}`}>'), "Permission dialog should style risk level explicitly");
  assert.ok(dialog.includes("{#each preview.risks as item}"), "Permission dialog should render concrete risk hints");

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(
    checklist.includes("- [x] 权限确认弹窗显示客户端、工具名、scope、执行模式和关键参数。"),
    "macOS smoke checklist should mark permission dialog summary complete",
  );
  assert.ok(
    checklist.includes("- [x] 文件类调用在弹窗中显示 `涉及路径`，路径列表能横向滚动或换行，不遮挡操作按钮。"),
    "macOS smoke checklist should mark permission dialog path presentation complete",
  );
  assert.ok(
    checklist.includes("- [x] `shell`、`file_write`、`system_settings` 等高/中风险 scope 在弹窗中显示明确风险提示。"),
    "macOS smoke checklist should mark permission dialog risk hints complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
