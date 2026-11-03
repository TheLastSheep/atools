import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PLAN_FILE = '.atools-source-build-plan.json';
const PLAN_LIMIT = 64 * 1024;
const STEP_LIMIT = 12;
const TEST_FILE_LIMIT = 128;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function safeRelative(value, maxLength = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !value.startsWith('-') && !value.startsWith('/') && !value.includes('\\')
    && !/\p{Cc}/u.test(value) && !/[*?\[\]{}]/.test(value)
    && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('-'));
}
function validateStep(step) {
  if (!step || typeof step !== 'object' || Array.isArray(step)) return false;
  switch (step.kind) {
    case 'typecheck':
      return exactKeys(step, ['kind', 'cli']) && safeRelative(step.cli)
        && (step.cli.startsWith('node_modules/vue-tsc/')
          || step.cli.startsWith('node_modules/typescript/'));
    case 'viteBuild':
      return exactKeys(step, ['kind', 'cli']) && safeRelative(step.cli)
        && step.cli.startsWith('node_modules/vite/');
    case 'nodeTest':
      return exactKeys(step, ['kind', 'files']) && Array.isArray(step.files)
        && step.files.length >= 1 && step.files.length <= TEST_FILE_LIMIT
        && new Set(step.files).size === step.files.length
        && step.files.every(file => safeRelative(file) && /\.(?:cjs|js|mjs|ts)$/.test(file));
    case 'nodeScript':
      return exactKeys(step, ['kind', 'script']) && safeRelative(step.script)
        && /\.(?:cjs|js|mjs)$/.test(step.script);
    default:
      return false;
  }
}
export function validatePlan(plan) {
  if (!exactKeys(plan, ['schemaVersion', 'toolchain', 'steps']) || plan.schemaVersion !== 3
    || !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > STEP_LIMIT
    || plan.steps.filter(step => step?.kind === 'viteBuild').length !== 1
    || !plan.steps.every(validateStep)) return false;
  const hasNodeTests = plan.steps.some(step => step.kind === 'nodeTest');
  const toolchainKeys = hasNodeTests ? ['viteBackend', 'testEsbuild'] : ['viteBackend'];
  if (!exactKeys(plan.toolchain, toolchainKeys)) return false;
  if (!viteBackend(plan.toolchain.viteBackend)
    || (hasNodeTests && !toolchainBinary(plan.toolchain.testEsbuild))) return false;
  const testFiles = plan.steps.filter(step => step.kind === 'nodeTest').flatMap(step => step.files);
  return testFiles.length <= TEST_FILE_LIMIT && new Set(testFiles).size === testFiles.length;
}
function toolchainBinary(value) {
  return safeRelative(value) && value.startsWith('node_modules/');
}
function viteBackend(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.kind === 'esbuild') return exactKeys(value, ['kind', 'binary']) && toolchainBinary(value.binary);
  return value.kind === 'rolldown' && exactKeys(value, ['kind', 'binding'])
    && toolchainBinary(value.binding) && value.binding.endsWith('.node');
}
export function argsForStep(step) {
  const heapLimit = ['--max-old-space-size=256'];
  switch (step.kind) {
    case 'typecheck': return [...heapLimit, step.cli, '--noEmit'];
    case 'nodeTest': return [...heapLimit, '--import', 'tsx', '--test', '--test-concurrency=1', '--', ...step.files];
    case 'viteBuild': return [...heapLimit, step.cli, 'build', '--outDir', 'dist', '--emptyOutDir'];
    case 'nodeScript': return [...heapLimit, '--', step.script];
    default: throw new Error('SOURCE_BUILD_PLAN_INVALID');
  }
}
export function runPlan(plan, spawn = spawnSync) {
  if (!validatePlan(plan)) return 70;
  for (const step of plan.steps) {
    const env = { ...process.env };
    if (step.kind === 'viteBuild') {
      if (plan.toolchain.viteBackend.kind === 'esbuild') {
        env.ESBUILD_BINARY_PATH = path.resolve(process.cwd(), plan.toolchain.viteBackend.binary);
      } else {
        delete env.ESBUILD_BINARY_PATH;
      }
    } else if (step.kind === 'nodeTest') {
      env.ESBUILD_BINARY_PATH = path.resolve(process.cwd(), plan.toolchain.testEsbuild);
    } else {
      delete env.ESBUILD_BINARY_PATH;
    }
    const result = spawn(process.execPath, argsForStep(step), {
      cwd: process.cwd(), stdio: 'inherit', env,
      shell: false, windowsHide: true,
    });
    if (result.error) return 70;
    if (result.status !== 0) return Number.isInteger(result.status) ? result.status : 70;
  }
  return 0;
}

function main() {
  if (process.argv.length !== 2) return 70;
  const planPath = path.resolve(process.cwd(), PLAN_FILE);
  try {
    const size = statSync(planPath).size;
    if (size <= 0 || size > PLAN_LIMIT) return 70;
    const plan = JSON.parse(readFileSync(planPath, 'utf8'));
    return runPlan(plan);
  } catch {
    return 70;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
