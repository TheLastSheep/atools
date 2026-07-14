import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = new URL("../", import.meta.url);
const fixtureRoot = await mkdtemp(join(root.pathname, ".tmp-ztools-activation-plan-"));

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
    mod = await import("./ztools-plugin-activation-plan.mjs");
  } catch {
    assert.fail("ztools-plugin-activation-plan.mjs should export the activation plan builder");
  }

  await writePlugin(
    "alpha-ready",
    {
      name: "alpha ready!",
      title: "Alpha Ready",
      version: "1.0.0",
      main: "index.html",
      preload: "preload.js",
      platform: ["darwin"],
      features: [
        {
          code: "alpha-open",
          explain: "Alpha Open",
          cmds: ["alpha", { type: "regex", match: "^alpha$", label: "Alpha Regex" }],
        },
      ],
    },
    {
      "index.html": '<script src="./app.js"></script><main>alpha</main>',
      "app.js": "window.alpha = true;",
      "preload.js": "window.alphaPreload = true;",
    },
  );

  await writePlugin(
    "beta-regex-only",
    {
      name: "beta.regex",
      title: "Beta Regex",
      version: "1.0.0",
      main: "index.html",
      platform: ["darwin"],
      features: [
        {
          code: "beta-regex",
          explain: "Beta Regex",
          cmds: [{ type: "regex", match: "^beta$", label: "Beta" }],
        },
      ],
    },
    { "index.html": "<main>beta</main>" },
  );

  await writePlugin(
    "gamma-files-only",
    {
      name: "gamma-files",
      title: "Gamma Files",
      version: "1.0.0",
      main: "index.html",
      platform: ["darwin"],
      features: [
        {
          code: "gamma-files",
          explain: "Gamma Files",
          cmds: [{ type: "files", label: "Files" }],
        },
      ],
    },
    { "index.html": "<main>gamma</main>" },
  );

  await writePlugin(
    "delta-blocked",
    {
      name: "delta-blocked",
      title: "Delta Blocked",
      version: "1.0.0",
      main: "missing.html",
      platform: ["darwin"],
      features: [{ code: "delta", explain: "Delta", cmds: ["delta"] }],
    },
    {},
  );

  await writePlugin(
    "ztools-developer-plugin",
    {
      name: "ztools-developer-plugin",
      title: "ZTools Developer",
      version: "1.0.0",
      main: "index.html",
      platform: ["darwin"],
      features: [
        {
          code: "ui.router",
          explain: "ZTools Developer",
          cmds: ["developer"],
        },
      ],
    },
    { "index.html": "<main>developer</main>" },
  );

  const report = await mod.buildZToolsPluginActivationPlan(fixtureRoot, {
    generatedAt: "2026-06-05T00:00:00.000Z",
    maxSamples: 4,
    installRoot: "/tmp/atools-smoke-plugins",
  });

  assert.equal(report.generated_at, "2026-06-05T00:00:00.000Z");
  assert.equal(report.source, fixtureRoot);
  assert.deepEqual(report.summary, {
    scanned_plugins: 5,
    launchable_plugins: 4,
    planned_samples: 4,
    ready_plans: 4,
    risk_plans: 0,
    blocked_skipped: 1,
    text_trigger_plans: 2,
    regex_trigger_plans: 1,
    typed_payload_plans: 1,
    manual_trigger_plans: 0,
    cleanup_required: true,
  });

  assert.deepEqual(
    report.activation_plans.map((plan) => [
      plan.name,
      plan.expected_install_id,
      plan.activation.feature_code,
      plan.activation.trigger_type,
      plan.activation.query,
      plan.render_smoke.safe,
    ]),
    [
      ["alpha ready!", "alpha-ready", "alpha-open", "text", "alpha", true],
      ["beta.regex", "beta-regex", "beta-regex", "regex", "beta", true],
      ["gamma-files", "gamma-files", "gamma-files", "typed_payload", "", true],
      ["ztools-developer-plugin", "ztools-developer-plugin", "ui.router", "text", "developer", false],
    ],
  );

  const alpha = report.activation_plans[0];
  assert.equal(alpha.install.command, "install_ztools_plugin");
  assert.equal(alpha.install.install_root, "/tmp/atools-smoke-plugins");
  assert.equal(alpha.install.overwrite, true);
  assert.equal(alpha.enable.expected_enabled_after_import, true);
  assert.deepEqual(alpha.assertions, {
    plugin_path_exists: true,
    main_exists: true,
    preload_checked: true,
    entry_resources_ok: true,
    runtime_status: "ready",
  });
  assert.deepEqual(alpha.cleanup, {
    uninstall_plugin_id: "alpha-ready",
    remove_plugin_data: true,
    remove_installed_files: true,
  });

  const gamma = report.activation_plans[2];
  assert.deepEqual(gamma.activation.typed_payload, { type: "files", label: "Files" });
  assert.equal(gamma.activation.manual_reason, "requires files payload");

  const developer = report.activation_plans[3];
  assert.match(
    developer.render_smoke.reason,
    /blocks iframe smoke probe/,
    "developer tool plan should explain why render smoke skips it",
  );

  const outputPath = join(fixtureRoot, "activation-plan.json");
  await mod.writeZToolsPluginActivationPlan(report, outputPath);
  const written = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(written.summary.planned_samples, 4);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
