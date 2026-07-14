import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-bridge-capabilities-"));
const outFile = join(outDir, "pluginBridgeCapabilities.mjs");

try {
  const sourcePath = new URL("src/lib/pluginBridgeCapabilities.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  assert.equal(typeof mod.pluginBridgeCapabilityGroups, "function");
  assert.equal(typeof mod.pluginBridgeRuntimeDetail, "function");

  const groups = mod.pluginBridgeCapabilityGroups();
  assert.deepEqual(groups.map((group) => group.id), [
    "data",
    "events",
    "clipboard",
    "input",
    "dialog",
    "window",
    "system",
    "user",
    "context",
  ]);
  assert.deepEqual(groups.map((group) => [group.label, group.status]), [
    ["DB", "ready"],
    ["事件", "partial"],
    ["剪贴板", "partial"],
    ["输入", "partial"],
    ["对话框", "ready"],
    ["窗口", "partial"],
    ["系统", "ready"],
    ["用户", "partial"],
    ["上下文", "partial"],
  ]);
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("db.put"));
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("db.getAttachment"));
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("db.getAttachmentType"));
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("db.replicateStateFromCloud"));
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("dbStorage.setItem"));
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("dbStorage.getItem"));
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("dbStorage.removeItem"));
  assert.ok(groups.find((group) => group.id === "data")?.methods.includes("onDbPull"));
  assert.ok(groups.find((group) => group.id === "events")?.methods.includes("onPluginEnter"));
  assert.ok(groups.find((group) => group.id === "events")?.methods.includes("onPluginOut"));
  assert.ok(groups.find((group) => group.id === "events")?.methods.includes("onPluginDetach"));
  assert.ok(groups.find((group) => group.id === "events")?.methods.includes("onMainPush"));
  assert.ok(groups.find((group) => group.id === "clipboard")?.methods.includes("copyFile"));
  assert.ok(groups.find((group) => group.id === "clipboard")?.methods.includes("copyImage"));
  assert.ok(groups.find((group) => group.id === "input")?.methods.includes("hideMainWindowPasteText"));
  assert.ok(groups.find((group) => group.id === "input")?.methods.includes("hideMainWindowPasteImage"));
  assert.ok(groups.find((group) => group.id === "input")?.methods.includes("hideMainWindowPasteFile"));
  assert.ok(groups.find((group) => group.id === "input")?.methods.includes("hideMainWindowTypeString"));
  assert.ok(groups.find((group) => group.id === "dialog")?.methods.includes("showOpenDialog"));
  assert.ok(groups.find((group) => group.id === "dialog")?.methods.includes("showSaveDialog"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("hideMainWindow"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("showMainWindow"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("getWindowType"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("findInPage"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("stopFindInPage"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("setSubInput"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("removeSubInput"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("subInputSelect"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("startDrag"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("isDarkColors"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("redirect"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("redirectHotKeySetting"));
  assert.ok(groups.find((group) => group.id === "window")?.methods.includes("redirectAiModelsSetting"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("shellOpenExternal"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("system_get_path"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("getNativeId"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("getAppName"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("getAppVersion"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("isDev"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("isMacOS"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("isWindows"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("isLinux"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("getFileIcon"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("shellTrashItem"));
  assert.ok(groups.find((group) => group.id === "system")?.methods.includes("shellBeep"));
  assert.ok(groups.find((group) => group.id === "user")?.methods.includes("getUser"));
  assert.ok(groups.find((group) => group.id === "user")?.methods.includes("fetchUserServerTemporaryToken"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("screenCapture"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("screenColorPick"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("getPrimaryDisplay"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("getAllDisplays"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("getCursorScreenPoint"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("getDisplayNearestPoint"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("getDisplayMatching"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("screenToDipPoint"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("dipToScreenPoint"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("screenToDipRect"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("dipToScreenRect"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("desktopCaptureSources"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("readCurrentBrowserUrl"));
  assert.ok(groups.find((group) => group.id === "context")?.methods.includes("readCurrentFolderPath"));

  assert.equal(
    mod.pluginBridgeRuntimeDetail(),
    "DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文"
  );

  const hostViewSource = await readFile(new URL("src/lib/pluginHostView.ts", root), "utf8");
  assert.match(hostViewSource, /pluginBridgeRuntimeDetail/);
  assert.match(hostViewSource, /detail:\s*pluginBridgeRuntimeDetail\(\)/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
