import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { reviewLocalOriginalSource } from "./lib/local-plugin-fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registryPath = path.join(root, "tests/fixtures/local-original-plugin-cases.json");
const defaultOutput = path.join(root, "output/legacy-node-2026-10-16/local-original-source-review.json");

function args(argv) {
  const options = { cleanup: false, caseId: null, output: defaultOutput };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cleanup") options.cleanup = true;
    else if (arg === "--case") options.caseId = argv[++index];
    else if (arg === "--output") options.output = path.resolve(argv[++index] || "");
    else throw Error(`Unknown argument: ${arg}`);
  }
  if (!options.output.startsWith(`${path.join(root, "output")}${path.sep}`)) {
    throw Error("Static source review output must stay under repository output/");
  }
  return options;
}

const options = args(process.argv.slice(2));
if (options.cleanup) {
  await rm(options.output, { force: true });
  process.stdout.write(`${JSON.stringify({ cleaned: options.output })}\n`);
} else {
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const selected = options.caseId ? registry.cases.filter(item => item.caseId === options.caseId) : registry.cases;
  if (!selected.length || selected.length !== (options.caseId ? 1 : registry.cases.length)) {
    throw Error(`Unknown local original plugin case: ${options.caseId}`);
  }
  const cases = [];
  for (const registered of selected) {
    const reviewed = await reviewLocalOriginalSource(registered.caseId);
    cases.push({
      caseId: registered.caseId,
      profile: registered,
      sourceRoot: reviewed.sourceRoot,
      sourceKind: "local_full_directory",
      officialArchiveProvided: false,
      directorySha256: reviewed.witness.directorySha256,
      fileCount: reviewed.witness.fileCount,
      files: reviewed.witness.files,
      directories: reviewed.witness.directories,
      sourceInspection: reviewed.review.sourceInspection,
      sourceBytesUnchanged: true,
      pluginCodeExecutedByReview: false,
    });
  }
  const report = {
    schemaVersion: 1,
    sourceKind: "local_full_directory",
    status: "prepared_for_parent_native_fixture_decision",
    digestAlgorithm: registry.digestAlgorithm,
    verificationScope: "Static source and complete-directory byte review only; no plugin execution, browser session, or native runtime acceptance.",
    cases,
  };
  await mkdir(path.dirname(options.output), { recursive: true });
  await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ sourceReview: options.output, caseCount: cases.length, generatedOnce: true })}\n`);
}
