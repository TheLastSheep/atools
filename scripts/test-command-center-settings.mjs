import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [source, smokeChecklist] = await Promise.all([
  readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8"),
  readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.ok(source.includes('activeMenu === "commands"'), "所有指令页应为独立设置页，而不是复用别名说明页");
assert.ok(source.includes("<h3>所有指令</h3>"), "所有指令页应显示主标题");
assert.ok(source.includes("可绑定指令"), "所有指令页应显示可绑定指令统计卡");
assert.ok(source.includes("指令别名"), "所有指令页应显示指令别名统计卡");
assert.ok(source.includes("固定指令"), "所有指令页应显示固定指令统计卡");
assert.ok(source.includes("来源分组"), "所有指令页应显示来源分组统计卡");
assert.ok(source.includes("command-center-summary-grid"), "所有指令页应显示统计卡网格");
assert.ok(source.includes("command-source-list"), "所有指令页应显示左侧来源列表");
assert.ok(source.includes("<span>全部来源</span>"), "所有指令页应提供全部来源筛选");
assert.ok(source.includes("commandCenterSourceFilter = group.id"), "来源筛选应切换到对应来源");
assert.ok(source.includes("commandCenterFilteredRows()"), "所有指令页应根据来源/状态/搜索筛选右侧列表");
assert.ok(source.includes('placeholder="搜索名称、路径、code 或别名"'), "所有指令页应支持名称、路径、code、别名搜索");
assert.ok(source.includes('<option value="all">全部状态</option>'), "所有指令页状态筛选应包含全部");
assert.ok(source.includes('<option value="enabled">仅启用</option>'), "所有指令页状态筛选应包含仅启用");
assert.ok(source.includes('<option value="disabled">仅停用</option>'), "所有指令页状态筛选应包含仅停用");
assert.ok(source.includes("command-target-row"), "所有指令页应渲染指令目标行");
assert.ok(source.includes("{row.sourceLabel.slice(0, 1)}"), "指令行应展示来源标识");
assert.ok(source.includes("<strong>{row.label}</strong>"), "指令行应展示目标名称");
assert.ok(source.includes("{row.statusLabel}"), "指令行应展示启用状态");
assert.ok(source.includes("{row.explain || row.code}"), "指令行应展示说明或 code");
assert.ok(source.includes("<code>{row.code}</code>"), "指令行应展示 code");
assert.ok(source.includes("{row.aliasLabel}"), "指令行应展示别名数量");
assert.ok(source.includes("{row.aliasHint}"), "指令行应展示别名说明");
assert.ok(source.includes("command-alias-preview"), "指令行应展示别名 chip");
assert.ok(source.includes("{row.aliasActionLabel}"), "指令行应展示添加/管理别名入口");
assert.ok(source.includes("loadPinnedCommandCodes"), "所有指令页应加载固定指令");
assert.ok(source.includes("savePinnedCommandCodes"), "所有指令页应持久化固定指令");
assert.ok(source.includes("toggleCommandCenterPinned"), "所有指令页应提供固定/取消固定操作");
assert.ok(source.includes("toggleCommandCenterTarget"), "所有指令页应提供本地/网页目标启停操作");
assert.ok(source.includes("updateLocalLaunchEntry(id, { enabled: !row.enabled })"), "所有指令页应能启停本地启动目标");
assert.ok(source.includes("updateWebQuickOpenEntry(id, { enabled: !row.enabled })"), "所有指令页应能启停网页快开目标");
assert.ok(source.includes("commandCenterTargetToggleLabel"), "所有指令页应根据目标状态显示启用/停用");
assert.ok(source.includes("系统指令不可停用"), "系统指令应明确不可停用，避免假按钮");
assert.ok(source.includes("{row.pinLabel}"), "指令行应显示固定/取消固定按钮");
assert.ok(source.includes("{commandCenterTargetToggleLabel(row)}"), "指令行应显示启用/停用按钮");
assert.ok(source.includes("已固定"), "指令行应展示已固定状态");
assert.ok(source.includes("固定指令"), "汇总区应展示固定指令数量");

assertSmokeChecked(
  "设置页 `所有指令` 不是简单别名页，显示可绑定指令、指令别名、固定指令、来源分组四个统计卡。",
  "macOS smoke checklist should mark the Command Center summary cards complete",
);
assertSmokeChecked(
  "`所有指令` 左侧来源包含 `全部来源`、`系统指令`、`本地启动`、`网页快开`，点击来源后右侧列表只显示该来源目标。",
  "macOS smoke checklist should mark the Command Center source filtering complete",
);
assertSmokeChecked(
  "`所有指令` 右侧列表显示目标名称、启用状态、固定状态、说明、code、别名数量、别名 chip，并按状态显示 `添加别名` 或 `管理别名` 操作入口。",
  "macOS smoke checklist should mark the Command Center target rows complete",
);
assertSmokeChecked(
  "`所有指令` 行级 `启用/停用` 对本地启动和网页快开生效，主搜索匹配结果同步变化；系统指令显示 `不可停用` 且不可点击。",
  "macOS smoke checklist should mark Command Center target enablement toggles complete",
);
assertSmokeChecked(
  "`所有指令` 支持按名称、路径、code、别名或固定状态搜索；状态筛选包含全部/仅启用/仅停用。",
  "macOS smoke checklist should mark Command Center search and status filtering complete",
);
