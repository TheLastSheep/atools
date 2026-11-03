import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, planBuiltinRuntimeStage, sha256Bytes, stageBuiltinRuntimeTree } from './lib/builtin-runtime-staging.mjs';
import { candidateRules, expectedSourceTreeSha256 } from './lib/builtin-runtime-rules.mjs';

function diagnosticField(value, pattern, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes && pattern.test(value) ? value : null;
}
function safeRelativeDiagnostic(value) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= 512 && !value.startsWith('/') && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/u.test(value) && !value.split('/').includes('..') ? value : null;
}

function parseArgs(argv) {
  const result = { write: false, applyCandidateRules: false, target: null, output: null, repoRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--write') result.write = true;
    else if (key === '--apply-candidate-rules') result.applyCandidateRules = true;
    else if (['--output', '--target-platform', '--target-arch', '--repo-root'].includes(key)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error('BUILTIN_STAGE_ARGUMENT_VALUE_REQUIRED');
      if (key === '--output') result.output = value;
      else if (key === '--repo-root') result.repoRoot = value;
      else {
        result.target ||= {};
        result.target[key === '--target-platform' ? 'platform' : 'arch'] = value;
      }
    } else throw Error('BUILTIN_STAGE_UNKNOWN_ARGUMENT');
  }
  if (result.target && (!['darwin', 'win32', 'linux'].includes(result.target.platform) || !['arm64', 'x64', 'universal'].includes(result.target.arch))) throw Error('BUILTIN_STAGE_TARGET_UNSUPPORTED');
  if (result.write && !result.output) throw Error('BUILTIN_STAGE_OUTPUT_REQUIRED');
  if (!result.write && result.output) throw Error('BUILTIN_STAGE_OUTPUT_REQUIRES_WRITE');
  return result;
}

async function assertFreshTarget(output) {
  const targetRoot = path.join(repoRoot, 'target');
  const canonicalTarget = await realpath(targetRoot);
  const destination = path.resolve(repoRoot, output);
  const relative = path.relative(canonicalTarget, destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw Error('BUILTIN_STAGE_OUTPUT_OUTSIDE_TARGET');
  let current = canonicalTarget;
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, segment);
    const exists = await lstat(current).then(info => ({ info }), () => null);
    if (!exists) { await mkdir(current, { mode: 0o700 }); continue; }
    if (!exists.info.isDirectory() || exists.info.isSymbolicLink() || await realpath(current) !== current) throw Error('BUILTIN_STAGE_OUTPUT_PARENT_UNSAFE');
  }
  if (await lstat(destination).then(() => true, () => false)) throw Error('BUILTIN_STAGE_OUTPUT_EXISTS');
  const manifestPath = `${destination}.manifest.json`;
  if (await lstat(manifestPath).then(() => true, () => false)) throw Error('BUILTIN_STAGE_MANIFEST_EXISTS');
  return { destination, manifestPath };
}

async function writeNewManifest(file, value) {
  const handle = await open(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
  try { const bytes = Buffer.from(canonicalJson(value), 'utf8'); await handle.writeFile(bytes); await handle.sync(); return { bytes: bytes.length, sha256: sha256Bytes(bytes) }; }
  finally { await handle.close(); }
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = args.repoRoot ? path.resolve(args.repoRoot) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (args.repoRoot && await realpath(repoRoot) !== repoRoot) throw Error('BUILTIN_STAGE_REPO_ROOT_UNSAFE');
const sourceRoot = path.join(repoRoot, 'resources/plugins/builtin');
const options = { candidateRules, target: args.target, applyCandidateRules: args.applyCandidateRules, expectedSourceTreeSha256 };
const started = performance.now();
try {
  if (!args.write) {
    const plan = await planBuiltinRuntimeStage(sourceRoot, options);
    process.stdout.write(`${JSON.stringify({ status: 'dry-run', sourceTreeSha256: plan.source.sha256, files: plan.source.fileCount,
      directories: plan.source.directoryCount, sourceBytes: plan.source.bytes, plannedBytes: plan.stagedBytes, bytesSaved: plan.bytesSaved,
      excluded: plan.excluded, decisions: plan.decisions, elapsedMs: Math.round(performance.now() - started) })}\n`);
  } else {
    const { destination, manifestPath } = await assertFreshTarget(args.output);
    const result = await stageBuiltinRuntimeTree(sourceRoot, destination, options);
    const manifest = { schemaVersion: 1, sourceRoot: 'resources/plugins/builtin', sourceManifestSha256: result.sourceManifestSha256,
      stagedManifestSha256: result.stagedManifestSha256, sourceFiles: result.sourceFiles, stagedFiles: result.stagedFiles,
      sourceBytes: result.sourceBytes, stagedBytes: result.stagedBytes, bytesSaved: result.bytesSaved,
      sourceUnchanged: result.sourceUnchanged, target: args.target, rulesApplied: args.applyCandidateRules,
      excluded: result.excluded, decisions: result.decisions, entries: result.entries };
    const written = await writeNewManifest(manifestPath, manifest);
    process.stdout.write(`${JSON.stringify({ status: 'staged', output: path.relative(repoRoot, destination), manifest: path.relative(repoRoot, manifestPath),
      manifestBytes: written.bytes, manifestSha256: written.sha256, sourceManifestSha256: result.sourceManifestSha256,
      stagedManifestSha256: result.stagedManifestSha256, sourceFiles: result.sourceFiles, stagedFiles: result.stagedFiles,
      sourceBytes: result.sourceBytes, stagedBytes: result.stagedBytes, bytesSaved: result.bytesSaved, sourceUnchanged: result.sourceUnchanged,
      excluded: result.excluded,
      decisions: result.decisions, elapsedMs: Math.round(performance.now() - started) })}\n`);
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: diagnosticField(error.code, /^[A-Z0-9_]{1,64}$/u, 64) || 'BUILTIN_STAGE_FAILED',
    ruleId: diagnosticField(error.ruleId, /^[a-z0-9][a-z0-9._-]{0,63}$/iu, 64), relativePath: safeRelativeDiagnostic(error.relativePath),
    partialDestination: error.partialDestination ? path.relative(repoRoot, error.partialDestination) : null })}\n`);
  process.exitCode = 1;
}
