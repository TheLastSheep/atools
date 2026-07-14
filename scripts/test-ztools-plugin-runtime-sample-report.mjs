import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("../", import.meta.url);
const fixtureRoot = await mkdtemp(join(root.pathname, ".tmp-ztools-runtime-report-"));

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writePlugin(dirName, manifest, files = {}) {
  const dir = join(fixtureRoot, dirName);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "plugin.json"), manifest);
  for (const [name, content] of Object.entries(files)) {
    const filePath = join(dir, name);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }
  return dir;
}

try {
  let mod;
  try {
    mod = await import("./ztools-plugin-runtime-sample-report.mjs");
  } catch {
    assert.fail("ztools-plugin-runtime-sample-report.mjs should export the runtime sample report builder");
  }

  await writePlugin(
    "alpha-ready",
    {
      name: "alpha-ready",
      title: "Alpha Ready",
      version: "1.0.0",
      main: "index.html",
      preload: "preload.js",
      platform: ["darwin"],
      features: [{ code: "alpha", explain: "Alpha", cmds: ["alpha", { type: "regex", match: "^alpha$" }] }],
    },
    {
      "index.html": '<link rel="stylesheet" href="./style/main.css"><script src="./app.js"></script><img src="logo.png">',
      "style/main.css": "body { background: #fff; }",
      "app.js": "window.alpha = true;",
      "logo.png": "png",
      "preload.js": "window.exports = {};",
    },
  );

  await writePlugin(
    "beta-missing-local-resource",
    {
      name: "beta-missing-local-resource",
      title: "Beta Resource Risk",
      version: "1.0.0",
      main: "index.html",
      platform: ["darwin"],
      features: [{ code: "beta", explain: "Beta", cmds: ["beta"] }],
    },
    {
      "index.html": '<script src="./missing.js"></script><main>beta</main>',
    },
  );

  await writePlugin(
    "gamma-external-and-electron",
    {
      name: "gamma-external-and-electron",
      title: "Gamma Runtime Risk",
      version: "1.0.0",
      main: "ui/index.html",
      preload: "preload.js",
      platform: ["darwin"],
      features: [{ code: "gamma", explain: "Gamma", cmds: [{ type: "window", label: "Gamma" }] }],
    },
    {
      "ui/index.html": '<script src="https://cdn.example.com/lib.js"></script><main>gamma</main>',
      "preload.js": 'const { ipcRenderer } = require("electron"); const fs = require("fs");',
    },
  );

  await writePlugin(
    "delta-missing-main",
    {
      name: "delta-missing-main",
      title: "Delta Missing Main",
      version: "1.0.0",
      main: "missing.html",
      platform: ["darwin"],
      features: [{ code: "delta", explain: "Delta", cmds: ["delta"] }],
    },
    {},
  );

  const report = await mod.buildZToolsPluginRuntimeSampleReport(fixtureRoot, {
    generatedAt: "2026-06-05T00:00:00.000Z",
    maxCandidates: 2,
  });

  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.source, fixtureRoot);
  assert.deepEqual(report.summary, {
    scanned_plugins: 4,
    launchable_plugins: 3,
    ready_candidates: 1,
    risk_candidates: 2,
    blocked_plugins: 1,
    html_entry_plugins: 3,
    missing_local_resource_plugins: 1,
    missing_local_resources: 1,
    external_resource_plugins: 1,
    preload_missing_plugins: 0,
    preload_node_risk_plugins: 1,
    preload_electron_require_plugins: 1,
    selected_sample_count: 2,
  });

  assert.deepEqual(
    report.sample_candidates.map((plugin) => [plugin.name, plugin.runtime_status, plugin.score]),
    [
      ["alpha-ready", "ready", 100],
      ["beta-missing-local-resource", "risk", 80],
    ],
  );

  const beta = report.plugins.find((plugin) => plugin.name === "beta-missing-local-resource");
  assert.equal(beta.runtime_status, "risk");
  assert.deepEqual(beta.entry.missing_local_resources, ["missing.js"]);
  assert.ok(beta.warnings.includes("Missing local entry resources: missing.js"));

  const gamma = report.plugins.find((plugin) => plugin.name === "gamma-external-and-electron");
  assert.equal(gamma.runtime_status, "risk");
  assert.deepEqual(gamma.entry.external_resources, ["https://cdn.example.com/lib.js"]);
  assert.equal(gamma.preload.uses_electron_require, true);
  assert.equal(gamma.preload.uses_node_require, true);
  assert.ok(gamma.warnings.includes("External entry resources: https://cdn.example.com/lib.js"));
  assert.ok(gamma.warnings.includes("Preload requires Electron module"));
  assert.ok(gamma.warnings.includes("Preload requires Node modules: fs"));

  const delta = report.plugins.find((plugin) => plugin.name === "delta-missing-main");
  assert.equal(delta.runtime_status, "blocked");
  assert.equal(delta.launch_candidate, false);
  assert.ok(delta.blockers.includes("Missing main file: missing.html"));

  const outputPath = join(fixtureRoot, "runtime-report.json");
  await mod.writeZToolsPluginRuntimeSampleReport(report, outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written.summary.ready_candidates, 1);

  const realReport = JSON.parse(await readFile(new URL("../output/ztools-plugin-runtime-sample-report.json", import.meta.url), "utf8"));
  assert.deepEqual(realReport.summary, {
    scanned_plugins: 125,
    launchable_plugins: 61,
    ready_candidates: 21,
    risk_candidates: 40,
    blocked_plugins: 64,
    html_entry_plugins: 65,
    missing_local_resource_plugins: 10,
    missing_local_resources: 17,
    external_resource_plugins: 6,
    preload_missing_plugins: 4,
    preload_node_risk_plugins: 69,
    preload_electron_require_plugins: 26,
    selected_sample_count: 20,
  });
  assert.equal(
    realReport.sample_candidates.length,
    realReport.summary.selected_sample_count,
    "real runtime sample report should include the selected sample candidate list",
  );

  const checklist = checklistSection(
    await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8"),
    "真实 ZTools 插件运行态样本候选报告：",
    "真实 ZTools 插件激活 smoke plan：",
  );
  for (const row of [
    "报告能成功生成 JSON。",
    "当前基线为 125 scanned、61 launchable、21 ready、40 risk、64 blocked、20 selected sample candidates。",
    "`missing_local_resources` 当前为 17；若升高，需要检查入口 HTML 资源改写、构建产物或样本仓库结构是否变化。",
    "`preload_electron_require_plugins` 当前为 26，`preload_node_risk_plugins` 当前为 69；这些是后续逐插件 runtime smoke 的风险信号，不代表本地启动已失败。",
    "该报告只是候选池和风险分层，不等同于逐插件导入、启用、激活、UI load、bridge 调用和清理。",
  ]) {
    assertCheckedChecklistRow(checklist, row);
  }
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

function assertCheckedChecklistRow(checklist, row) {
  assert.match(
    checklist,
    new RegExp(`^- \\[x\\] ${escapeRegExp(row)}`, "m"),
    `Expected checked macOS smoke checklist row containing: ${row}`,
  );
}

function checklistSection(checklist, startTitle, endTitle) {
  const start = checklist.indexOf(startTitle);
  assert.notEqual(start, -1, `Expected checklist section: ${startTitle}`);
  const end = checklist.indexOf(endTitle, start + startTitle.length);
  assert.notEqual(end, -1, `Expected checklist section end: ${endTitle}`);
  return checklist.slice(start, end);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
