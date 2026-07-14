import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-ai-settings-overview-"));
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

  assert.equal(typeof mod.aiOverviewCards, "function", "settingsPages should expose AI overview cards");

  const readyCards = mod.aiOverviewCards({
    providerLabel: "兼容 API",
    providerEnabled: true,
    configReady: true,
    defaultModel: "gpt-4.1-mini",
    useForAgent: true,
    hasApiKey: true,
    lastConnectionOk: true,
    lastConnectionLabel: "连接正常，已找到 gpt-4.1-mini",
    hasTauriRuntime: true,
  });

  assert.deepEqual(readyCards.map((card) => card.label), [
    "模型提供商",
    "默认模型",
    "Agent 默认",
    "连接状态",
  ]);
  assert.equal(readyCards.find((card) => card.label === "模型提供商")?.value, "兼容 API");
  assert.equal(readyCards.find((card) => card.label === "默认模型")?.value, "gpt-4.1-mini");
  assert.equal(readyCards.find((card) => card.label === "Agent 默认")?.value, "启用");
  assert.match(readyCards.find((card) => card.label === "Agent 默认")?.detail ?? "", /ask_ai_model/);
  assert.equal(readyCards.find((card) => card.label === "连接状态")?.value, "连接正常");
  assert.equal(readyCards.find((card) => card.label === "连接状态")?.tone, "ready");

  const incompleteCards = mod.aiOverviewCards({
    providerLabel: "OpenAI",
    providerEnabled: true,
    configReady: false,
    defaultModel: "",
    useForAgent: true,
    hasApiKey: false,
    lastConnectionOk: null,
    lastConnectionLabel: "",
    hasTauriRuntime: true,
  });
  assert.equal(incompleteCards.find((card) => card.label === "默认模型")?.value, "未设置");
  assert.equal(incompleteCards.find((card) => card.label === "默认模型")?.tone, "warning");
  assert.equal(incompleteCards.find((card) => card.label === "Agent 默认")?.value, "未生效");
  assert.match(incompleteCards.find((card) => card.label === "连接状态")?.detail ?? "", /配置完整后/);

  const previewCards = mod.aiOverviewCards({
    providerLabel: "关闭",
    providerEnabled: false,
    configReady: false,
    defaultModel: "",
    useForAgent: false,
    hasApiKey: false,
    lastConnectionOk: null,
    lastConnectionLabel: "",
    hasTauriRuntime: false,
  });
  assert.equal(previewCards.find((card) => card.label === "模型提供商")?.value, "未启用");
  assert.equal(previewCards.find((card) => card.label === "连接状态")?.value, "桌面端测试");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  const macosChecklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(panel.includes("AI 模型概览"), "AI page should render an overview section");
  assert.ok(panel.includes("aiOverviewCards"), "AI page should use the shared AI overview model");
  assert.ok(panel.includes("模型提供商"), "AI page should expose provider state");
  assert.ok(panel.includes("默认模型"), "AI page should expose default model state");
  assert.ok(panel.includes("Agent 默认"), "AI page should expose Agent default state");
  assert.ok(panel.includes("连接状态"), "AI page should expose connection state");
  assert.ok(panel.includes("不会发送聊天内容"), "AI page should explain model test privacy");
  assert.ok(panel.includes("API Key 仅本地保存"), "AI page should explain API key local storage");

  const checkedAiSmokeItems = [
    "设置页 `AI 模型` 不是占位页，显示模型提供商、API Base URL、默认模型、API Key、温度、Agent 默认开关和配置预览。",
    "`AI 模型` 提供商切到 `兼容 API` 时显示配置不完整，Base URL/模型/API Key 输入可编辑；切回 `关闭` 后输入禁用且 Agent 默认开关关闭。",
    "Web 预览下 `AI 模型` 的 `测试连接` 按钮保持禁用，并提示 `需在桌面应用中测试 AI 连接`。",
    "桌面端 `AI 模型` 配置完整后，点击 `测试连接` 只读取 `/models`，并显示连接状态、模型是否出现在列表、模型数量和耗时。",
    "`AI 模型` 连接测试不发送聊天内容，不在页面结果、审计日志或 MCP 客户端配置中展示 API Key。",
    "`AI 模型` 开启 `用于 Agent 默认模型` 后，`ask_ai_model` 工具会使用该配置调用 OpenAI-compatible `/chat/completions`。",
  ];

  for (const item of checkedAiSmokeItems) {
    assert.ok(
      macosChecklist.includes(`- [x] ${item}`),
      `macOS smoke checklist should mark AI model parity item as verified: ${item}`,
    );
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
