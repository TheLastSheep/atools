import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
const fixtureRoot = await mkdtemp(join(root.pathname, ".tmp-ztools-compat-report-"));

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writePlugin(dirName, manifest, files = {}) {
  const dir = join(fixtureRoot, dirName);
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "plugin.json"), manifest);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content);
  }
  return dir;
}

try {
  let mod;
  try {
    mod = await import("./ztools-plugin-compatibility-report.mjs");
  } catch {
    assert.fail("ztools-plugin-compatibility-report.mjs should export the compatibility report builder");
  }

  await writePlugin(
    "alpha-valid",
    {
      name: "alpha-valid",
      title: "Alpha",
      version: "1.0.0",
      main: "index.html",
      preload: "preload.js",
      logo: "logo.png",
      platform: ["darwin", "win32"],
      features: [
        {
          code: "open",
          explain: "Open alpha",
          cmds: ["alpha", { type: "regex", match: "^alpha$", label: "Alpha" }],
        },
        {
          code: "files",
          explain: "Open files",
          cmds: [{ type: "files", label: "Files" }],
        },
      ],
    },
    {
      "index.html": "<main>alpha</main>",
      "preload.js": "window.alpha = true;",
      "logo.png": "png",
    },
  );

  await writePlugin(
    "beta-missing-main",
    {
      name: "beta-missing-main",
      title: "Beta",
      version: "1.0.0",
      main: "missing.html",
      platform: ["darwin"],
      features: [{ code: "beta", explain: "Beta", cmds: ["beta"] }],
    },
    {},
  );

  await writePlugin(
    "gamma-warnings",
    {
      name: "gamma-warnings",
      title: "Gamma",
      version: "1.0.0",
      main: "index.html",
      preload: "missing-preload.js",
      logo: "missing-logo.png",
      platform: ["win32"],
      features: [
        {
          code: "open",
          explain: "Duplicate feature code and unsupported cmd",
          cmds: [{ type: "clipboard", label: "Clipboard" }, { type: "window", label: "Window" }],
        },
      ],
    },
    { "index.html": "<main>gamma</main>" },
  );

  await mkdir(join(fixtureRoot, "node_modules", "ignored", "plugin"), { recursive: true });
  await writeJson(join(fixtureRoot, "node_modules", "ignored", "plugin", "plugin.json"), {
    name: "ignored",
    main: "index.html",
    features: [],
  });

  const report = await mod.buildZToolsPluginCompatibilityReport(fixtureRoot, {
    generatedAt: "2026-06-05T00:00:00.000Z",
  });

  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.source, fixtureRoot);
  assert.deepEqual(report.summary, {
    scanned_plugins: 3,
    compatible_plugins: 1,
    warning_plugins: 1,
    error_plugins: 1,
    feature_count: 4,
    command_count: 6,
    main_missing: 1,
    preload_missing: 1,
    logo_missing: 1,
    platform_unsupported: 1,
    unsupported_cmd_plugins: 1,
    duplicate_feature_codes: 1,
  });
  assert.deepEqual(report.unsupported_cmd_types, { clipboard: 1 });
  assert.deepEqual(report.duplicate_feature_codes, [{ code: "open", plugins: ["alpha-valid", "gamma-warnings"] }]);
  assert.deepEqual(
    report.plugins.map((plugin) => [plugin.name, plugin.status, plugin.feature_count, plugin.command_count]),
    [
      ["alpha-valid", "compatible", 2, 3],
      ["beta-missing-main", "error", 1, 1],
      ["gamma-warnings", "warning", 1, 2],
    ],
  );

  const gamma = report.plugins.find((plugin) => plugin.name === "gamma-warnings");
  assert.ok(gamma.warnings.includes("Platform does not include darwin"));
  assert.ok(gamma.warnings.includes("Missing preload file: missing-preload.js"));
  assert.ok(gamma.warnings.includes("Missing logo file: missing-logo.png"));
  assert.ok(gamma.warnings.includes("Unsupported command types: clipboard"));
  assert.deepEqual(gamma.unsupported_cmd_types, ["clipboard"]);

  const beta = report.plugins.find((plugin) => plugin.name === "beta-missing-main");
  assert.ok(beta.errors.includes("Missing main file: missing.html"));

  const outputPath = join(fixtureRoot, "compat-report.json");
  await mod.writeZToolsPluginCompatibilityReport(report, outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written.summary.scanned_plugins, 3);

  const realReport = JSON.parse(await readFile(new URL("../output/ztools-plugin-compatibility-report.json", import.meta.url), "utf8"));
  assert.ok(realReport.summary.scanned_plugins > 0, "real compatibility report should scan at least one plugin");
  assert.equal(realReport.summary.unsupported_cmd_plugins, 0, "real compatibility report should not find unsupported command types");
  assert.ok(
    realReport.plugins
      .filter((plugin) => plugin.status === "error")
      .every((plugin) => plugin.errors.some((error) => error.startsWith("Missing main file:"))),
    "real compatibility report error plugins should currently be missing built main files",
  );

  const checklist = checklistSection(
    await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8"),
    "真实 ZTools 插件 manifest 兼容扫描：",
    "真实 ZTools 插件运行态样本候选报告：",
  );
  for (const row of [
    "报告能成功生成 JSON。",
    "`summary.scanned_plugins` 大于 0。",
    "`unsupported_cmd_plugins` 保持为 0；若升高，说明 manifest cmd type 解析覆盖回归或样本新增了未支持类型。",
    "`error_plugins` 主要来自源码型插件缺少构建后的 `main` 文件；若已构建插件报缺 main，需要检查安装包路径策略。",
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
