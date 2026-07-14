import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(tmpdir(), "atools-hotkey-recorder-"));
const outFile = join(outDir, "hotkeyRecorder.mjs");

try {
  const sourcePath = new URL("src/lib/hotkeyRecorder.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const event = (value) => ({
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    code: "",
    key: "",
    ...value,
  });

  assert.equal(mod.shortcutFromKeyboardEvent(event({ altKey: true, key: "z" }), "mac"), "Option+Z");
  assert.equal(
    mod.shortcutFromKeyboardEvent(event({ metaKey: true, shiftKey: true, key: "p" }), "mac"),
    "Command+Shift+P",
  );
  assert.equal(
    mod.shortcutFromKeyboardEvent(event({ ctrlKey: true, key: " " }), "mac"),
    "Control+Space",
  );
  assert.equal(
    mod.shortcutFromKeyboardEvent(event({ ctrlKey: true, altKey: true, key: "k" }), "windows"),
    "Ctrl+Alt+K",
  );
  assert.equal(mod.shortcutFromKeyboardEvent(event({ altKey: true, key: "Alt" }), "mac"), null);
  assert.equal(mod.shortcutFromKeyboardEvent(event({ key: "Escape" }), "mac"), null);
  assert.equal(mod.isCancelKey(event({ key: "Escape" })), true);
  assert.equal(mod.recordingHint("mac"), "请按下新的快捷键，Esc 取消");

  assert.deepEqual(mod.validateShortcut("Option+Z", "mac"), { valid: true, message: "可用" });
  assert.deepEqual(mod.validateShortcut("Z", "mac"), {
    valid: false,
    message: "快捷键需要包含至少一个修饰键",
  });
  assert.deepEqual(mod.validateShortcut("Option", "mac"), {
    valid: false,
    message: "快捷键需要包含主键",
  });
  assert.deepEqual(mod.validateShortcut("Command+Space", "mac"), {
    valid: false,
    message: "该组合通常被系统占用，请换一个快捷键",
  });
  assert.deepEqual(mod.validateShortcut("Control+Space", "mac"), {
    valid: false,
    message: "该组合通常被系统占用，请换一个快捷键",
  });
  assert.equal(mod.shortcutStatusMessage("Command+Space", "mac", "saved"), "该组合通常被系统占用，请换一个快捷键");
  assert.equal(mod.shortcutStatusMessage("Option+Z", "mac", "saving"), "正在保存并注册快捷键");
  assert.equal(
    mod.shortcutStatusMessage("Option+Z", "mac", "error", "Global shortcut already registered"),
    "保存失败：Global shortcut already registered",
  );

  const settingsPanel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(settingsPanel.includes("shortcutStatusMessage"), "SettingsPanel should use the shared shortcut status model");
  assert.ok(settingsPanel.includes("shortcutSaveText()"), "SettingsPanel should derive visible shortcut save text from the shared model");
  assert.ok(settingsPanel.includes("shortcutHasProblem()"), "SettingsPanel should derive shortcut error state from validation and save failures");
  assert.ok(settingsPanel.includes('title={hotkeyStatusText()}'), "Hotkey input should expose the current validation/save status in its title");
  assert.ok(settingsPanel.includes("class:error={shortcutHasProblem()}"), "Hotkey status pills should expose validation/save errors visually");
  assert.ok(settingsPanel.includes("<span>冲突/保存状态</span>"), "SettingsPanel should render the conflict/save status row");
  assert.ok(
    settingsPanel.includes("热键注册失败会显示为保存失败，不再静默成功"),
    "SettingsPanel should explain that native registration failures are not silent",
  );
  assert.ok(settingsPanel.includes("{shortcutSaveText()}</span>"), "Conflict/save status row should render the detailed shortcut status text");

  const checklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(
    checklist.includes("- [x] 设置页录制 `Command+Space` 这类系统保留快捷键时显示冲突风险，不进入静默保存。"),
    "macOS smoke checklist should mark reserved global hotkey warning complete",
  );
  assert.ok(
    checklist.includes("- [x] 真实系统占用导致注册失败时，“冲突/保存状态”显示保存失败和错误详情。"),
    "macOS smoke checklist should mark native global hotkey failure details complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
