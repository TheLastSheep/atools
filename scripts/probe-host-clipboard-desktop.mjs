import { mkdtemp, mkdir, readFile, rm, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { build } from "vite";
import { runNativeProcess } from "./lib/native-smoke-process.mjs";
import { captureHostClipboardSources, fingerprintHostArtifact, sameHostFingerprints, validateHostClipboardOutcome, HOST_CLIPBOARD_ORIGINAL_PINS } from "./lib/host-clipboard-native-evidence.mjs";

if (process.platform !== "darwin") throw new Error("Named native pasteboard probe currently requires macOS");
const root = resolve(new URL("../", import.meta.url).pathname);
const output = resolve(process.argv[2] || join(root, "output/legacy-node-2026-10-15/host-clipboard-native-gate.json"));
if (process.argv.length > 3) throw new Error("Usage: probe-host-clipboard-desktop.mjs [output.json]");
await mkdir(dirname(output), { recursive: true });
await access(output).then(() => { throw Error("Preserve earlier native evidence; choose a fresh output path"); }, error => { if (error.code !== "ENOENT") throw error; });
const scratch = await mkdtemp(join(tmpdir(), "atools-host-clipboard-"));
const nativeOutput = join(scratch, "native-report.json");
const report = { schemaVersion: 2, passed: false, scope: "Actual private named macOS pasteboard, opaque Wry fixture and production HTTP/capability/TaskRun pipeline; serialized public clipboard API and pinned existing text-copy preloads. Explicit selected inputs, not a complete compiler/toolchain dependency closure. No general clipboard, AppShell, physical input, new whole-original-plugin or performance acceptance.",
  sourceBinding: {}, artifacts: {}, originalPreloads: [], cleanup: {} };
let executable, failed;
try {
  report.sourceBinding.before = await captureHostClipboardSources(root);
  const outDir = join(scratch, "built");
  await mkdir(outDir);
  const originalPreloads = [];
  for (const { id, sha256 } of HOST_CLIPBOARD_ORIGINAL_PINS) {
    const source = await readFile(join(root, "ZTools-plugins/plugins", id, "preload.js"), "utf8");
    if (createHash("sha256").update(source).digest("hex") !== sha256) throw new Error(`Audited ${id} source changed; inspect it before executing`);
    originalPreloads.push({ id, source, sha256 });
    report.originalPreloads.push({ id, sha256 });
  }
  await build({ configFile: false, root, logLevel: "error", define: {
    __ATOOLS_ORIGINAL_CLIPBOARD_PRELOADS__: JSON.stringify(originalPreloads),
  }, build: {
    outDir, emptyOutDir: false, minify: "esbuild", target: "safari14",
    lib: { entry: join(root, "tests/components/nativeClipboardSmoke.ts"), formats: ["iife"], name: "HostClipboardSmoke", fileName: () => "clipboard.js" },
  } });
  await runNativeProcess("cargo", ["build", "-p", "atools", "--example", "host_clipboard_desktop_smoke", "--features", "legacy-node-smoke", "--offline"], { cwd: root });
  const { stdout } = await promisify(execFile)("cargo", ["metadata", "--no-deps", "--offline", "--format-version", "1"], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  executable = join(JSON.parse(stdout).target_directory, "debug/examples/host_clipboard_desktop_smoke");
  const artifacts = async () => ({ bridge: await fingerprintHostArtifact(join(outDir, "clipboard.js")), executable: await fingerprintHostArtifact(executable) });
  report.artifacts.before = await artifacts();
  try {
    await runNativeProcess(executable, ["--fixture-root", join(scratch, "profile"), "--output", nativeOutput, "--bridge-script", join(outDir, "clipboard.js")], { cwd: root, timeoutMs: 45000 });
  } finally {
    report.native = await readFile(nativeOutput, "utf8").then(JSON.parse).catch(() => null);
    report.artifacts.after = await artifacts();
    report.artifacts.unchanged = sameHostFingerprints(report.artifacts.before, report.artifacts.after);
  }
  report.validation = validateHostClipboardOutcome(report.native);
  report.passed = report.artifacts.unchanged;
} catch (error) {
  failed = error; report.error = String(error?.message || error);
} finally {
  try { report.sourceBinding.after = await captureHostClipboardSources(root);
    report.sourceBinding.unchanged = sameHostFingerprints(report.sourceBinding.before, report.sourceBinding.after); }
  catch (error) { report.sourceBinding.error = String(error?.message || error); }
  try { await rm(scratch, { recursive: true, force: true }); report.cleanup.buildScratchRemoved = true; }
  catch (error) { report.cleanup.error = String(error?.message || error); }
  report.passed = report.passed && report.sourceBinding.unchanged === true && report.cleanup.buildScratchRemoved === true;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ output, passed: report.passed, validation: report.validation, sourcesUnchanged: report.sourceBinding.unchanged, buildScratchRemoved: report.cleanup.buildScratchRemoved }));
if (failed || !report.passed) process.exitCode = 1;
