import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index], value = argv[++index];
    if (!['--staged-root', '--owned-temp-parent'].includes(key) || !value || value.startsWith('--')) throw Error('PDF_STAGE_SMOKE_ARGUMENT_INVALID');
    values[key] = value;
  }
  if (!values['--staged-root'] || !values['--owned-temp-parent']) throw Error('PDF_STAGE_SMOKE_ARGUMENT_REQUIRED');
  return values;
}
async function exists(file) {
  try { await lstat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

const args = parseArgs(process.argv.slice(2));
const stagedRoot = path.resolve(args['--staged-root']);
const tempParent = path.resolve(args['--owned-temp-parent']);
if (await realpath(stagedRoot) !== stagedRoot || await realpath(tempParent) !== tempParent) throw Error('PDF_STAGE_SMOKE_ROOT_UNSAFE');
const parentStat = await lstat(tempParent);
if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (typeof process.getuid === 'function' && parentStat.uid !== process.getuid())
  || (process.platform !== 'win32' && (parentStat.mode & 0o777) !== 0o700)) throw Error('PDF_STAGE_SMOKE_TEMP_PARENT_UNSAFE');
const pdfPackage = path.join(stagedRoot, 'image-batch-studio/preload/node_modules/pdf-lib');
const pdfManifest = path.join(pdfPackage, 'package.json');
const processorPath = path.join(stagedRoot, 'image-batch-studio/preload/processor.js');
for (const file of [pdfManifest, processorPath]) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw Error('PDF_STAGE_SMOKE_INPUT_UNSAFE');
}
const packageJson = JSON.parse(await readFile(pdfManifest, 'utf8'));
if (packageJson.name !== 'pdf-lib' || packageJson.version !== '1.17.1' || packageJson.main !== 'cjs/index.js') throw Error('PDF_STAGE_SMOKE_PACKAGE_IDENTITY_MISMATCH');
const processorRequire = createRequire(processorPath);
const PDFDocument = processorRequire('pdf-lib').PDFDocument;
const { mergePdfs } = processorRequire(processorPath);
if (typeof PDFDocument !== 'function' || typeof mergePdfs !== 'function') throw Error('PDF_STAGE_SMOKE_API_MISSING');

const tempRoot = await mkdtemp(path.join(tempParent, 'pdf-stage-smoke-'));
const checks = { fixedPdfInputsCreated: false, processorMergeSucceeded: false, mergedDocumentHasTwoPages: false,
  malformedPdfRejected: false, malformedOutputAbsent: false, tempCleanupComplete: false };
let mergedByteCount = 0;
try {
  const inputs = [path.join(tempRoot, 'input-a.pdf'), path.join(tempRoot, 'input-b.pdf')];
  for (const [index, file] of inputs.entries()) {
    const document = await PDFDocument.create();
    document.addPage([100 + index, 100]);
    await writeFile(file, await document.save(), { flag: 'wx', mode: 0o600 });
  }
  checks.fixedPdfInputsCreated = true;
  const merged = path.join(tempRoot, 'merged.pdf');
  await mergePdfs(inputs, merged);
  const mergedBytes = await readFile(merged);
  if (!mergedBytes.length || mergedBytes.length > 2 * 1024 * 1024) throw Error('PDF_STAGE_SMOKE_MERGED_SIZE_INVALID');
  mergedByteCount = mergedBytes.length;
  checks.processorMergeSucceeded = true;
  const reopened = await PDFDocument.load(mergedBytes);
  checks.mergedDocumentHasTwoPages = reopened.getPageCount() === 2;
  assert.equal(checks.mergedDocumentHasTwoPages, true);

  const malformed = path.join(tempRoot, 'malformed.pdf'), rejectedOutput = path.join(tempRoot, 'must-not-exist.pdf');
  await writeFile(malformed, Buffer.from('%PDF-1.4\nnot-a-valid-document\n%%EOF\n'), { flag: 'wx', mode: 0o600 });
  await assert.rejects(mergePdfs([malformed], rejectedOutput));
  checks.malformedPdfRejected = true;
  checks.malformedOutputAbsent = !(await exists(rejectedOutput));
  assert.equal(checks.malformedOutputAbsent, true);
} finally {
  const resolved = await realpath(tempRoot);
  if (path.dirname(resolved) !== tempParent || !path.basename(resolved).startsWith('pdf-stage-smoke-')) throw Error('PDF_STAGE_SMOKE_CLEANUP_BOUNDARY');
  await rm(resolved, { recursive: true, force: false });
  checks.tempCleanupComplete = !(await exists(tempRoot));
}
if (Object.values(checks).some(value => value !== true)) throw Error('PDF_STAGE_SMOKE_CHECK_FAILED');
process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'passed', runtime: process.version, checks,
  mergedPages: 2, mergedBytes: mergedByteCount })}\n`);
