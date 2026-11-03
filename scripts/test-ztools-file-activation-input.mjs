import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  resolveFileActivationInputs,
} from "./lib/ztools-file-activation-input.mjs";
import {
  buildZToolsPluginActivationPlan,
  parseActivationPlanArgs,
} from "./ztools-plugin-activation-plan.mjs";

const fixtureRoot = await mkdtemp(join(tmpdir(), "atools-file-activation-"));
const execFileAsync = promisify(execFile);

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

async function writePlugin(root, directory, name, featureCode, command) {
  const pluginRoot = join(root, directory);
  await mkdir(pluginRoot, { recursive: true });
  await writeJson(join(pluginRoot, "plugin.json"), {
    name,
    title: name,
    version: "1.0.0",
    main: "index.html",
    platform: ["darwin"],
    features: [{ code: featureCode, explain: `${name} file feature`, cmds: [command] }],
  });
  await writeFile(join(pluginRoot, "index.html"), `<main>${name}</main>`);
  return pluginRoot;
}

const markdownCommand = {
  type: "files",
  fileType: "file",
  extensions: ["md", "markdown"],
  minLength: 1,
  maxLength: 2,
};

try {
  const markdownPath = join(fixtureRoot, "fixed-note.md");
  await writeFile(markdownPath, "fixed test contents are not part of the activation plan\n");

  const legacyPlugin = await writePlugin(fixtureRoot, "legacy", "legacy-plan", "legacy-open", "legacy");
  const legacy = await buildZToolsPluginActivationPlan(legacyPlugin, {
    generatedAt: "2026-10-23T00:00:00.000Z",
  });
  assert.equal(legacy.activation_plans.length, 1);
  assert.deepEqual(
    Object.keys(legacy.activation_plans[0].activation),
    ["feature_code", "feature_label", "trigger_type", "command_type", "query", "typed_payload", "manual_reason"],
    "the legacy plan activation shape remains unchanged when --input-file is omitted",
  );
  assert.equal(legacy.activation_plans[0].activation.trigger_type, "text");
  assert.equal(legacy.activation_plans[0].activation.query, "legacy");

  const inputArgs = parseActivationPlanArgs(["--source", legacyPlugin, "--input-file", markdownPath]);
  assert.deepEqual(inputArgs.inputFiles, [markdownPath]);
  assert.throws(() => parseActivationPlanArgs(["--input-file"]), /requires a non-empty absolute path/);
  assert.throws(() => parseActivationPlanArgs(["--input-file", "--source", legacyPlugin]), /requires a non-empty absolute path/);
  assert.throws(() => parseActivationPlanArgs(["--input-file", ""]), /requires a non-empty absolute path/);
  assert.throws(
    () => parseActivationPlanArgs(Array.from({ length: 21 }, () => ["--input-file", markdownPath]).flat()),
    /at most 20 paths/,
  );
  await assert.rejects(resolveFileActivationInputs(["relative.md"]), /must be absolute/);
  await assert.rejects(resolveFileActivationInputs([`${fixtureRoot}\ninvalid.md`]), /control characters/);
  await assert.rejects(resolveFileActivationInputs([`/${"a".repeat(8192)}`]), /exceeds 8192 UTF-8 bytes/);
  await assert.rejects(resolveFileActivationInputs([fixtureRoot]), /regular file/);
  await assert.rejects(resolveFileActivationInputs([markdownPath, markdownPath]), /duplicate/);
  await assert.rejects(resolveFileActivationInputs([]), /at least one/);

  const liveSourceRoot = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
  const livePluginRoot = join(liveSourceRoot, "live-markdown");
  const liveManifestPath = join(livePluginRoot, "plugin.json");
  const liveManifestBytes = await readFile(liveManifestPath);
  const liveManifestDigest = createHash("sha256").update(liveManifestBytes).digest("hex");

  const livePlan = await buildZToolsPluginActivationPlan(livePluginRoot, { inputFiles: [markdownPath] });
  assert.equal(livePlan.activation_plans.length, 1);
  const activation = livePlan.activation_plans[0].activation;
  assert.equal(activation.feature_code, "typora-workbench");
  assert.equal(activation.feature_label, "打开 Live Markdown 实时预览编辑器（支持大纲、文件树、数学公式、Mermaid 图表与多排版主题）");
  assert.equal(activation.trigger_type, "files");
  assert.equal(activation.command_type, "files");
  assert.equal(activation.query, "");
  assert.equal(activation.typed_payload, null);
  assert.equal(activation.manual_reason, "");
  assert.deepEqual(activation.file_paths, [await realpath(markdownPath)]);
  assert.equal(livePlan.summary.file_trigger_plans, 1);
  assert.equal(JSON.stringify(livePlan).includes("fixed test contents"), false);

  const cliResult = await execFileAsync(process.execPath, [
    fileURLToPath(new URL("./ztools-plugin-activation-plan.mjs", import.meta.url)),
    "--source", livePluginRoot,
    "--input-file", markdownPath,
    "--json",
  ], { encoding: "utf8" });
  const cliPlan = JSON.parse(cliResult.stdout);
  assert.equal(cliPlan.activation_plans[0].activation.trigger_type, "files");
  assert.deepEqual(cliPlan.activation_plans[0].activation.file_paths, [await realpath(markdownPath)]);

  const wrongSuffixPath = join(fixtureRoot, "fixed-note.json");
  await writeFile(wrongSuffixPath, "{}");
  await assert.rejects(
    buildZToolsPluginActivationPlan(livePluginRoot, { inputFiles: [wrongSuffixPath] }),
    /No single plugin feature accepts all --input-file paths/,
  );

  const multiRoot = join(fixtureRoot, "multiple-plugins");
  await writePlugin(multiRoot, "first", "first-plugin", "first-file", markdownCommand);
  await writePlugin(multiRoot, "second", "second-plugin", "second-file", markdownCommand);
  await assert.rejects(
    buildZToolsPluginActivationPlan(multiRoot, { inputFiles: [markdownPath] }),
    /requires --source to resolve exactly one launchable plugin plan/,
  );

  const digestAfter = createHash("sha256").update(await readFile(liveManifestPath)).digest("hex");
  assert.equal(digestAfter, liveManifestDigest, "the original Live Markdown manifest stays unchanged");
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log("ZTools file activation input tests passed");
