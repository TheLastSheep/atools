import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-ai-connection-view-"));
const outFile = join(outDir, "aiConnectionView.mjs");

try {
  const sourcePath = new URL("src/lib/aiConnectionView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.deepEqual(mod.aiConnectionButtonState({
    hasTauriRuntime: false,
    provider: "compatible",
    configReady: true,
    testing: false,
  }), {
    disabled: true,
    label: "测试连接",
    reason: "需在桌面应用中测试 AI 连接",
  });

  assert.deepEqual(mod.aiConnectionButtonState({
    hasTauriRuntime: true,
    provider: "disabled",
    configReady: false,
    testing: false,
  }), {
    disabled: true,
    label: "测试连接",
    reason: "请先启用 AI 模型提供商",
  });

  assert.deepEqual(mod.aiConnectionButtonState({
    hasTauriRuntime: true,
    provider: "compatible",
    configReady: false,
    testing: false,
  }), {
    disabled: true,
    label: "测试连接",
    reason: "请填写 Base URL、默认模型和必要的 API Key",
  });

  assert.deepEqual(mod.aiConnectionButtonState({
    hasTauriRuntime: true,
    provider: "local",
    configReady: true,
    testing: true,
  }), {
    disabled: true,
    label: "测试中...",
    reason: "正在读取模型列表",
  });

  assert.deepEqual(mod.aiConnectionButtonState({
    hasTauriRuntime: true,
    provider: "local",
    configReady: true,
    testing: false,
  }), {
    disabled: false,
    label: "测试连接",
    reason: "读取 /models 并检查默认模型",
  });

  const rows = mod.aiConnectionRows({
    status: "ok",
    provider: "compatible",
    base_url: "https://api.example.com/v1",
    model: "qwen-max",
    models_count: 4,
    model_found: true,
    duration_ms: 240,
  });
  assert.equal(rows.find((row) => row.label === "连接")?.value, "已连接");
  assert.equal(rows.find((row) => row.label === "模型")?.value, "qwen-max / 已找到");
  assert.equal(rows.find((row) => row.label === "模型列表")?.value, "4 个");
  assert.equal(rows.find((row) => row.label === "耗时")?.value, "240 ms");

  const missingRows = mod.aiConnectionRows({
    status: "ok",
    provider: "local",
    base_url: "http://127.0.0.1:11434/v1",
    model: "missing-model",
    models_count: 2,
    model_found: false,
    duration_ms: 180,
  });
  assert.equal(missingRows.find((row) => row.label === "模型")?.value, "missing-model / 未出现在列表");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
