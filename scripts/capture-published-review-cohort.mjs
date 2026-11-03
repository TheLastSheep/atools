#!/usr/bin/env node
// Capture original official bytes for source review only. Never execute or install them.
import { readFile, writeFile, rm, open, constants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchBounded } from './audit-ztools-published-artifacts.mjs';
import { inspectZip } from './lib/published-artifact-zip.mjs';
import { inspectPackage } from './lib/published-artifact-package.mjs';
import { materializeInspectedFiles, sha256 } from './lib/published-plugin-fixture.mjs';
import { captureSelectedCurrentMarketCohort, parseCohortOffset } from './lib/selected-current-market-package-cohort.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = 'output/legacy-node-2026-10-15/canonical-package-readiness-after-labels.json';
const PRIOR = 'output/legacy-node-2026-10-15/published-artifact-source-audit.json';
const ALLOWED = new Set(['color-helper', 'com-ztools-timestamp', 'todo-neo', 'regex-editor']);

export function selectReviewCandidates(ids, canonical) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 3 || new Set(ids).size !== ids.length)
    throw new Error('Select one to three distinct explicit review IDs');
  return ids.map(id => {
    if (!ALLOWED.has(id)) throw new Error(`ID is outside this bounded review cohort: ${id}`);
    const entry = canonical.entries.find(item => item.directory === id && item.name === id);
    if (!entry || entry.readiness !== 'requires_build') throw new Error(`Not a canonical source-build candidate: ${id}`);
    return { id, localVersion: entry.version, localReadiness: entry.readiness };
  });
}

export async function cleanupCapturedReviewFixtures(rows, remove = rm) {
  const errors = [];
  for (const row of rows) if (row.fixture) {
    try {
      await remove(row.fixture.ownedRoot, { recursive: true, force: true });
      row.fixtureRemovedOnFailure = true;
    } catch (error) {
      row.fixtureRemovedOnFailure = false;
      row.fixtureCleanupError = String(error);
      errors.push({ id: row.id, ownedRoot: row.fixture.ownedRoot, error: String(error) });
    }
  }
  return { allAttempted: true, errors };
}

function parseOptions(argv, allowedFlags, requiredFlags) {
  if (argv.length % 2 !== 0) throw new Error('Every option must have one value');
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (!allowedFlags.has(flag) || options.has(flag) || !value || value.startsWith('--'))
      throw new Error('Unknown, repeated, or incomplete option');
    options.set(flag, value);
  }
  for (const flag of requiredFlags) if (!options.has(flag)) throw new Error(`Missing required option ${flag}`);
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--selection-file')) {
    const options = parseOptions(argv, new Set(['--selection-file', '--selection-sha256', '--output', '--offset']),
      ['--selection-file', '--selection-sha256', '--output']);
    const output = path.resolve(options.get('--output'));
    const offset = parseCohortOffset(options.get('--offset'));
    const report = await captureSelectedCurrentMarketCohort({
      selectionPath: path.resolve(options.get('--selection-file')), selectionSha256: options.get('--selection-sha256'),
      outputPath: output, root: ROOT, offset,
    });
    console.log(JSON.stringify({ output, status: report.status, selectionPage: report.selectionPage,
      candidates: report.candidates.map(row => ({ name: row.name, version: row.expectedVersion, status: row.status,
        archiveSha256: row.archive?.sha256 ?? null })) }));
    return report;
  }
  const value = flag => { const at = argv.indexOf(flag); return at < 0 ? null : argv[at + 1]; };
  if (argv.some((arg, i) => i % 2 === 0 && !['--ids', '--output'].includes(arg))
    || argv.length !== 4 || !value('--ids') || !value('--output'))
    throw new Error('Usage: --ids color-helper,com-ztools-timestamp,todo-neo --output PATH');
  const output = path.resolve(value('--output'));
  const canonicalBytes = await readFile(path.join(ROOT, CANONICAL));
  const selection = selectReviewCandidates(value('--ids').split(','), JSON.parse(canonicalBytes));
  const prior = JSON.parse(await readFile(path.join(ROOT, PRIOR), 'utf8'));
  const deadline = AbortSignal.timeout(120000);
  const request = (url, options) => fetch(url, { ...options, signal: AbortSignal.any([deadline, options.signal]) });
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(),
    purpose: 'Original published package bytes retained solely for non-executing source review',
    source: { canonical: CANONICAL, canonicalSha256: sha256(canonicalBytes), priorAudit: PRIOR },
    limits: { candidates: 3, sequential: true, cooperativeDeadlineMs: 120000,
      deadlineScope: 'Shared HTTP abort signal and a check before each candidate; local inspection/materialization is bounded by byte/entry quotas but is not preempted by this timer',
      perOperationTimeoutMs: 20000, metadataBytes: 2097152, archiveBytes: 52428800 },
    scope: { pluginCodeExecuted: false, installed: false, dependenciesInstalled: false, runtimeAcceptance: false,
      staticUncertaintyDoesNotAuthorizeExecution: true, privateDirectoryIsNotOsSandbox: true },
    candidates: [], status: 'capturing', cleanupOwner: 'Parent source-review/native verification workflow' };
  try {
    for (const selected of selection) {
      deadline.throwIfAborted();
      const row = { ...selected, http: [], status: 'fetching', fixture: null };
      report.candidates.push(row);
      const resolverUrl = `https://z-tools.top/api/market/plugins/download?name=${encodeURIComponent(row.id)}`;
      const metadata = JSON.parse((await fetchBounded(resolverUrl, 'json', row.http, request)).bytes.toString('utf8'));
      if (typeof metadata.downloadUrl !== 'string') throw new Error(`${row.id}: resolver omitted ZIP URL`);
      const downloaded = await fetchBounded(metadata.downloadUrl, 'package', row.http, request);
      const digest = sha256(downloaded.bytes);
      const pin = prior.candidates.find(item => item.id === row.id)?.archive?.locallyComputedSha256;
      if (pin && pin !== digest) throw new Error(`${row.id}: official bytes changed since prior audit`);
      const inspected = inspectZip(downloaded.bytes);
      const packageInfo = inspectPackage(inspected.files, row.id);
      row.package = packageInfo; row.zip = inspected.summary;
      row.archive = { locallyComputedSha256: digest, bytes: downloaded.bytes.length, url: downloaded.url,
        priorAuditPin: pin ?? null, priorAuditPinMatched: pin ? true : null,
        publisherSignatureVerified: false, upstreamChecksumVerified: false };
      if (inspected.summary.nativeFiles.length || inspected.summary.symlinkCount
        || packageInfo.platform && !packageInfo.platform.includes('darwin'))
        throw new Error(`${row.id}: native/symlink/platform candidate requires a separate workflow`);
      const fixture = await materializeInspectedFiles(inspected.files);
      row.fixture = fixture;
      const archivePath = path.join(fixture.ownedRoot, 'source.zip');
      const handle = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(downloaded.bytes); } finally { await handle.close(); }
      const manifestDirectory = path.posix.dirname(packageInfo.manifestPath);
      Object.assign(fixture, { id: row.id, version: packageInfo.version, archivePath, archiveSha256: digest,
        archiveBytes: downloaded.bytes.length, sourceUrl: downloaded.url, resolverUrl, http: row.http,
        zip: inspected.summary, package: packageInfo,
        pluginRoot: manifestDirectory === '.' ? fixture.contentRoot : path.join(fixture.contentRoot, manifestDirectory),
        noPluginCodeExecuted: true, retainedForSourceReview: true });
      row.status = 'captured_pending_source_review';
      await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    }
    report.status = 'captured_pending_source_review';
  } catch (error) {
    report.status = 'failed'; report.error = String(error);
    report.failureCleanup = await cleanupCapturedReviewFixtures(report.candidates);
    throw error;
  } finally {
    report.finishedAt = new Date().toISOString();
    report.implementationSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ output, status: report.status,
    candidates: report.candidates.map(row => ({ id: row.id, version: row.package.version,
      files: row.fixture.files.length, sha256: row.archive.locallyComputedSha256,
      staticEntryComplete: row.package.staticEntryComplete, pluginRoot: row.fixture.pluginRoot })) }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
