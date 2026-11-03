import { constants } from 'node:fs';
import { chmod, lstat, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBounded } from '../audit-ztools-published-artifacts.mjs';
import { inspectZip } from './published-artifact-zip.mjs';
import { inspectPackage } from './published-artifact-package.mjs';
import { materializeInspectedFiles, sha256 } from './published-plugin-fixture.mjs';

export const COHORT_LIMITS = Object.freeze({ candidates: 10, metadataBytes: 2 * 1024 * 1024,
  archiveBytes: 50 * 1024 * 1024, cohortArchiveBytes: 250 * 1024 * 1024,
  sharedDeadlineMs: 300000, operationDeadlineMs: 20000, redirects: 2 });
const MARKET = 'https://z-tools.top/api/market';
const PINNED_SOURCE_BYTES = 64 * 1024 * 1024;
const SELECTION_BYTES = 2 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const REQUIRED_CRITERIA = 'Observed eligible >=30, local name+version not exactly matched; descending downloadCount then name/version; first ten only';
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function sourceRows(catalog) {
  return [...(Array.isArray(catalog?.latest) ? catalog.latest : []),
    ...(Array.isArray(catalog?.categories) ? catalog.categories.flatMap(category =>
      Array.isArray(category?.plugins) ? category.plugins : []) : [])];
}

function validateCatalogIdentity(catalog, plugin) {
  const rows = sourceRows(catalog).filter(row => row?.name === plugin.name && String(row?.version || '') === plugin.version);
  if (!rows.length) throw new Error(`Pinned market catalog row missing: ${plugin.name}@${plugin.version}`);
  const counts = new Set(rows.map(row => Number(row.downloadCount)).filter(Number.isFinite));
  if (counts.size !== 1 || !counts.has(plugin.downloadCount))
    throw new Error(`Pinned market catalog count drift: ${plugin.name}@${plugin.version}`);
}

function eligibleUnmatched(matrix) {
  if (!Array.isArray(matrix?.plugins) || matrix.threshold !== 30) throw new Error('Pinned matrix threshold must be 30');
  return matrix.plugins.filter(row => row?.cohort === 'eligible' && row?.countStatus === 'known'
      && Number.isSafeInteger(row.downloadCount) && row.downloadCount >= matrix.threshold
      && row.localMatch !== 'matched')
    .sort((left, right) => right.downloadCount - left.downloadCount
      || compareText(String(left.name), String(right.name)) || compareText(String(left.version), String(right.version)));
}

export function parseCohortOffset(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value))
    throw new Error('Cohort offset must be a non-negative decimal page offset');
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset % COHORT_LIMITS.candidates !== 0)
    throw new Error('Cohort offset must be a safe multiple of the ten-row page size');
  return offset;
}

export function validatePinnedSelection({ selection, matrixBytes, catalogBytes, offset = 0 }) {
  if (selection?.schemaVersion !== 1 || !Array.isArray(selection.plugins)
    || selection.plugins.length < 1 || selection.plugins.length > COHORT_LIMITS.candidates
    || selection.criteria !== REQUIRED_CRITERIA)
    throw new Error('Selection must contain one to ten pinned rows');
  if (!HASH.test(selection?.matrix?.sha256 || '') || !HASH.test(selection?.catalog?.sha256 || '')
    || sha256(matrixBytes) !== selection.matrix.sha256 || sha256(catalogBytes) !== selection.catalog.sha256)
    throw new Error('Selection source SHA-256 pin mismatch');
  const matrix = JSON.parse(matrixBytes.toString('utf8'));
  const catalog = JSON.parse(catalogBytes.toString('utf8'));
  if (matrix?.source?.catalogPath && path.resolve(matrix.source.catalogPath) !== path.resolve(selection.catalog.path))
    throw new Error('Selection catalog path does not match pinned matrix source');
  const ranked = eligibleUnmatched(matrix);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % COHORT_LIMITS.candidates !== 0)
    throw new Error('Cohort offset must be a safe multiple of the ten-row page size');
  if (offset > 0 && selection.plugins.length !== COHORT_LIMITS.candidates)
    throw new Error('Nonzero cohort pages require a complete ten-row selection anchor');
  const anchor = ranked.slice(0, COHORT_LIMITS.candidates);
  if (selection.plugins.length > anchor.length) throw new Error('Selection exceeds recomputed eligible unmatched rows');
  const seen = new Set();
  selection.plugins.forEach((row, index) => {
    if (!row || typeof row.name !== 'string' || !row.name || typeof row.version !== 'string' || !row.version
      || !Number.isSafeInteger(row.downloadCount) || typeof row.localMatch !== 'string' || row.localMatch === 'matched')
      throw new Error(`Selection row ${index} has invalid identity or eligibility`);
    const key = `${row.name}\0${row.version}`;
    if (seen.has(key)) throw new Error(`Duplicate selection row: ${row.name}@${row.version}`);
    seen.add(key);
    const expected = anchor[index];
    if (!expected || row.name !== expected.name || row.version !== String(expected.version || '')
      || row.downloadCount !== expected.downloadCount || row.localMatch !== expected.localMatch)
      throw new Error(`Selection row ${index} differs from recomputed unmatched ranking`);
    validateCatalogIdentity(catalog, { name: expected.name, version: String(expected.version || ''),
      downloadCount: expected.downloadCount });
  });
  if (offset >= ranked.length) throw new Error('Cohort offset is past the end of the pinned unmatched ranking');
  const pageSize = offset === 0 ? selection.plugins.length : COHORT_LIMITS.candidates;
  const selected = ranked.slice(offset, offset + pageSize).map(expected => {
    const pinned = { name: expected.name, version: String(expected.version || ''),
      downloadCount: expected.downloadCount, localMatch: expected.localMatch, catalogSizeBytes: expected.size ?? null };
    validateCatalogIdentity(catalog, pinned);
    return pinned;
  });
  return { selected, matrix, catalog, offset, pageSize, rankedCandidateCount: ranked.length,
    matrixSha256: selection.matrix.sha256, catalogSha256: selection.catalog.sha256 };
}


async function readBoundedRegular(filename, maxBytes) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes)
    throw new Error('Pinned source must be a bounded regular file');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('Pinned source changed outside its byte budget');
    const bytes = await handle.readFile();
    if (bytes.length > maxBytes) throw new Error('Pinned source exceeded its byte budget');
    return bytes;
  } finally { await handle.close(); }
}

function insideRoot(rootPath, targetPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function rootRelativePath(rootContext, filename) {
  const target = path.resolve(path.isAbsolute(filename) ? filename : path.join(rootContext.logical, filename));
  if (insideRoot(rootContext.logical, target)) return path.relative(rootContext.logical, target);
  let current = target; const suffix = [];
  while (current !== path.dirname(current)) {
    try {
      if (await realpath(current) === rootContext.canonical) {
        if (current !== rootContext.logical && (await lstat(current)).isSymbolicLink())
          throw new Error('Pinned source path may not enter repository root through a symlink');
        return path.join(...suffix.reverse());
      }
    } catch (error) {
      if (error?.code !== 'ENOENT' && !String(error?.message).includes('ENOENT')) throw error;
    }
    suffix.push(path.basename(current)); current = path.dirname(current);
  }
  throw new Error('Pinned source path must stay inside repository root');
}

async function assertNoSymlinkPath(rootContext, relativePath) {
  let current = rootContext.canonical;
  const segments = relativePath.split(path.sep).filter(Boolean);
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error('Pinned source path may not traverse symlinks');
    if (index < segments.length - 1 && !info.isDirectory()) throw new Error('Pinned source parent must be a directory');
  }
  return current;
}

async function readPinnedFile(rootContext, filename, expectedHash) {
  if (!HASH.test(expectedHash || '')) throw new Error('Pinned source SHA-256 is invalid');
  const relative = await rootRelativePath(rootContext, filename);
  const resolved = await assertNoSymlinkPath(rootContext, relative);
  const before = await lstat(resolved);
  if (!before.isFile() || before.size > PINNED_SOURCE_BYTES)
    throw new Error('Pinned selection source must be a bounded regular file');
  const actualPath = await realpath(resolved);
  if (actualPath !== resolved) throw new Error('Pinned source path may not traverse symlinks');
  const bytes = await readBoundedRegular(resolved, PINNED_SOURCE_BYTES);
  if (sha256(bytes) !== expectedHash) throw new Error('Pinned selection source SHA-256 changed');
  return bytes;
}

function isPackageRequest(options) {
  return options?.headers?.Accept === 'application/zip' || options?.headers?.accept === 'application/zip';
}

async function boundedResponse(response, maxBytes, markExceeded, recordObserved, acceptBytes) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!Number.isFinite(Number(declared)) || Number(declared) > maxBytes)) {
    markExceeded();
    await response.body?.cancel().catch(() => {});
    throw new Error('COHORT_BYTE_BUDGET');
  }
  if (!response.body) return response;
  const reader = response.body.getReader(); let bytes = 0;
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) { controller.close(); return; }
        bytes += next.value.byteLength;
        recordObserved(next.value.byteLength);
        if (bytes > maxBytes) {
          markExceeded(); await reader.cancel().catch(() => {});
          controller.error(new Error('COHORT_BYTE_BUDGET')); return;
        }
        acceptBytes(next.value.byteLength);
        controller.enqueue(next.value);
      } catch (error) { controller.error(error); }
    },
    async cancel(reason) { await reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function requestWithinCohort(deadline, budget, fetcher = fetch, cohortByteLimit = COHORT_LIMITS.cohortArchiveBytes) {
  return async (url, options = {}) => {
    if (deadline.signal.aborted) throw deadline.signal.reason || new Error('COHORT_DEADLINE');
    const packageRequest = isPackageRequest(options);
    const remaining = cohortByteLimit - budget.acceptedArchiveBytes;
    if (packageRequest && (budget.exhausted || remaining <= 0)) {
      budget.exhausted = true; throw new Error('COHORT_BYTE_BUDGET');
    }
    const cap = packageRequest ? Math.min(COHORT_LIMITS.archiveBytes, remaining) : COHORT_LIMITS.metadataBytes;
    const response = await fetcher(url, { ...options,
      signal: AbortSignal.any([deadline.signal, options.signal].filter(Boolean)) });
    return packageRequest ? boundedResponse(response, cap, () => { budget.exhausted = true; },
      bytes => { budget.observedArchiveBytes += bytes; },
      bytes => { budget.acceptedArchiveBytes += bytes; }) : response;
  };
}

async function createReportWriter(filename) {
  const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  return { write: async report => {
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!result.bytesWritten) throw new Error('Capture report write made no progress');
      offset += result.bytesWritten;
    }
  }, close: () => handle.close() };
}

async function createPrivateRoot(parent = tmpdir()) {
  const ownedRoot = await mkdtemp(path.join(parent, 'atools-selected-market-cohort-'));
  try { await chmod(ownedRoot, 0o700); return ownedRoot; }
  catch (error) { await rm(ownedRoot, { recursive: true, force: true }).catch(() => {}); throw error; }
}

async function retainArchive(fixture, bytes) {
  const archivePath = path.join(fixture.ownedRoot, 'source.zip');
  const handle = await open(archivePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  return archivePath;
}

export async function captureSelectedCurrentMarketCohort({ selectionPath, selectionSha256, outputPath, root, offset = 0, dependencies = {} }) {
  if (!HASH.test(selectionSha256 || '')) throw new Error('Caller must provide an approved selection SHA-256');
  const rootContext = { logical: path.resolve(root), canonical: await realpath(root) };
  const selectionRelative = await rootRelativePath(rootContext, selectionPath);
  const selectionCanonicalPath = await assertNoSymlinkPath(rootContext, selectionRelative);
  const selectionBytes = await readBoundedRegular(selectionCanonicalPath, SELECTION_BYTES);
  if (sha256(selectionBytes) !== selectionSha256) throw new Error('Caller-approved selection SHA-256 mismatch');
  const selection = JSON.parse(selectionBytes.toString('utf8'));
  const catalogBytes = await readPinnedFile(rootContext, selection.catalog?.path, selection.catalog?.sha256);
  const matrixBytes = await readPinnedFile(rootContext, selection.matrix?.path, selection.matrix?.sha256);
  const pins = validatePinnedSelection({ selection, matrixBytes, catalogBytes, offset });
  const deadline = dependencies.createDeadline
    ? dependencies.createDeadline(COHORT_LIMITS.sharedDeadlineMs) : AbortSignal.timeout(COHORT_LIMITS.sharedDeadlineMs);
  const deadlineState = deadline instanceof AbortSignal ? { signal: deadline } : deadline;
  const budget = { observedArchiveBytes: 0, acceptedArchiveBytes: 0, exhausted: false };
  const cohortByteLimit = dependencies.cohortArchiveByteLimit ?? COHORT_LIMITS.cohortArchiveBytes;
  const request = requestWithinCohort(deadlineState, budget, dependencies.fetcher || fetch, cohortByteLimit);
  const fetchJson = dependencies.fetchBounded || fetchBounded;
  const zipInspector = dependencies.inspectZip || inspectZip, packageInspector = dependencies.inspectPackage || inspectPackage;
  const materialize = dependencies.materializeInspectedFiles || materializeInspectedFiles;
  const remove = dependencies.remove || rm, archiveWriter = dependencies.retainArchive || retainArchive;
  const rootFactory = dependencies.createPrivateRoot || createPrivateRoot;
  const ownedRoot = await rootFactory(dependencies.tempParent);
  let reportWriter;
  try {
    reportWriter = dependencies.createReportWriter
      ? await dependencies.createReportWriter(outputPath) : await createReportWriter(outputPath);
  } catch (error) {
    await remove(ownedRoot, { recursive: true, force: true });
    throw error;
  }
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), status: 'capturing',
    purpose: 'Pinned official market package bytes retained for static source review only',
    source: { selectionPath, selectionSha256, catalogPath: selection.catalog.path, catalogSha256: pins.catalogSha256,
      matrixPath: selection.matrix.path, matrixSha256: pins.matrixSha256 },
    selectionPage: { offset: pins.offset, pageSize: pins.pageSize,
      rankedEligibleUnmatchedCount: pins.rankedCandidateCount, selectedCount: pins.selected.length,
      nextOffset: pins.pageSize === COHORT_LIMITS.candidates
        && pins.offset + pins.selected.length < pins.rankedCandidateCount
        ? pins.offset + COHORT_LIMITS.candidates : null },
    limits: { ...COHORT_LIMITS, cohortArchiveBytes: cohortByteLimit, sequential: true,
      totalArchiveBytesObserved: 0, totalArchiveBytesAccepted: 0,
      cohortByteBudgetExhausted: false,
      streamByteAccounting: 'Observed includes complete response chunks already yielded by the transport, including a final over-limit chunk; accepted counts only bytes within per-archive and aggregate budgets. Over-limit bytes are rejected before ZIP inspection or retention; physical network receipt cannot be rolled back.',
      deadlineScope: 'Network abort plus checks between candidates; ZIP/package inspection is locally byte-bounded but not preempted by the timer' },
    scope: { pluginCodeExecuted: false, installed: false, dependenciesInstalled: false,
      publisherSignatureVerified: false, upstreamChecksumVerified: false, runtimeAcceptance: false,
      privateDirectoryIsNotOsSandbox: true },
    ownedRoot, candidates: pins.selected.map(plugin => ({ ...plugin, expectedVersion: plugin.version,
      status: 'pending', http: [], fixture: null, archive: null })), cleanup: { state: 'retained_for_source_review' } };
  let currentCatalog = null;
  try {
    try {
      const result = await fetchJson(`${MARKET}/plugins?limit=100&platform=darwin`, 'json', report.currentCatalogHttp ||= [], request);
      currentCatalog = JSON.parse(result.bytes.toString('utf8'));
      report.currentCatalog = { finalUrl: result.url, checkedAt: new Date().toISOString(), exactVersionRows: [] };
    } catch (error) {
      report.currentCatalogError = String(error);
      for (const row of report.candidates) { row.status = 'failed_current_catalog_fetch'; row.error = String(error); }
    }
    if (currentCatalog) {
      for (let index = 0; index < report.candidates.length; index++) {
        const row = report.candidates[index];
        if (deadlineState.signal.aborted) {
          row.status = 'not_attempted_shared_deadline'; row.error = 'Shared capture deadline elapsed';
          for (const pending of report.candidates.slice(index + 1)) pending.status = 'not_attempted_shared_deadline';
          break;
        }
        if (budget.exhausted) {
          row.status = 'not_attempted_cohort_byte_budget';
          for (const pending of report.candidates.slice(index + 1)) pending.status = 'not_attempted_cohort_byte_budget';
          break;
        }
        const marketRows = sourceRows(currentCatalog).filter(item => item?.name === row.name
          && String(item?.version || '') === row.expectedVersion);
        if (!marketRows.length) {
          row.status = 'failed_current_catalog_version_drift';
          row.error = `Current official catalog no longer contains ${row.name}@${row.expectedVersion}`;
          await reportWriter.write(report);
          continue;
        }
        report.currentCatalog.exactVersionRows.push({ name: row.name, version: row.expectedVersion, present: true });
        let fixture = null;
        row.status = 'fetching';
        try {
          const resolverUrl = `${MARKET}/plugins/download?name=${encodeURIComponent(row.name)}`;
          const metadataResult = await fetchJson(resolverUrl, 'json', row.http, request);
          const metadata = JSON.parse(metadataResult.bytes.toString('utf8'));
          if (typeof metadata.downloadUrl !== 'string') throw new Error('Official resolver did not return a ZIP URL');
          const observedBeforePackage = budget.observedArchiveBytes;
          const acceptedBeforePackage = budget.acceptedArchiveBytes;
          const downloaded = await fetchJson(metadata.downloadUrl, 'package', row.http, request);
          const observedDelta = budget.observedArchiveBytes - observedBeforePackage;
          const acceptedDelta = budget.acceptedArchiveBytes - acceptedBeforePackage;
          if (observedDelta === 0 && acceptedDelta === 0) {
            budget.observedArchiveBytes += downloaded.bytes.length;
            const allowance = Math.min(COHORT_LIMITS.archiveBytes, cohortByteLimit - acceptedBeforePackage);
            if (downloaded.bytes.length > allowance) {
              budget.exhausted = true;
              report.limits.totalArchiveBytesObserved = budget.observedArchiveBytes;
              throw new Error('COHORT_BYTE_BUDGET');
            }
            budget.acceptedArchiveBytes += downloaded.bytes.length;
          } else if (observedDelta !== downloaded.bytes.length || acceptedDelta !== downloaded.bytes.length) {
            budget.exhausted = true;
            throw new Error('Bounded response byte accounting mismatch');
          }
          report.limits.totalArchiveBytesObserved = budget.observedArchiveBytes;
          report.limits.totalArchiveBytesAccepted = budget.acceptedArchiveBytes;
          const digest = sha256(downloaded.bytes), inspected = zipInspector(downloaded.bytes);
          const packageInfo = packageInspector(inspected.files, row.name);
          row.archive = { bytes: downloaded.bytes.length, sha256: digest, url: downloaded.url,
            publisherSignatureVerified: false, upstreamChecksumVerified: false };
          row.package = packageInfo; row.zip = inspected.summary;
          if (packageInfo.name !== row.name || packageInfo.version !== row.expectedVersion) {
            row.status = 'failed_downloaded_version_mismatch';
            row.error = `Resolved package manifest is ${packageInfo.name}@${packageInfo.version}; expected ${row.name}@${row.expectedVersion}`;
            await reportWriter.write(report);
            continue;
          }
          if (inspected.summary.nativeFiles.length || inspected.summary.symlinkCount
            || packageInfo.platform && !packageInfo.platform.includes('darwin'))
            throw new Error('Native, symlink, or non-darwin package requires a separate review path');
          fixture = await materialize(inspected.files, ownedRoot);
          row.fixture = fixture;
          const archivePath = await archiveWriter(fixture, downloaded.bytes);
          const manifestDirectory = path.posix.dirname(packageInfo.manifestPath);
          Object.assign(fixture, { id: row.name, version: packageInfo.version, archivePath, archiveSha256: digest,
            archiveBytes: downloaded.bytes.length, sourceUrl: downloaded.url, resolverUrl, http: row.http,
            zip: inspected.summary, package: packageInfo,
            pluginRoot: manifestDirectory === '.' ? fixture.contentRoot : path.join(fixture.contentRoot, manifestDirectory),
            noPluginCodeExecuted: true, retainedForSourceReview: true });
          row.status = 'captured_pending_source_review';
        } catch (error) {
          if (fixture) {
            try { await remove(fixture.ownedRoot, { recursive: true, force: true }); row.fixtureRemovedOnFailure = true; }
            catch (cleanupError) { row.fixtureRemovedOnFailure = false; row.fixtureCleanupError = String(cleanupError); }
            row.fixture = null;
          }
          row.status = error?.message === 'COHORT_BYTE_BUDGET' ? 'failed_cohort_byte_budget'
            : deadlineState.signal.aborted ? 'failed_shared_deadline' : 'failed_capture_or_inspection';
          row.error = String(error);
          if (row.status === 'failed_cohort_byte_budget') budget.exhausted = true;
        }
        await reportWriter.write(report);
      }
    }
    if (budget.exhausted) {
      const afterFirstPending = report.candidates.findIndex(row => row.status === 'not_attempted_cohort_byte_budget');
      if (afterFirstPending < 0) {
        const next = report.candidates.find(row => row.status === 'pending');
        if (next) next.status = 'not_attempted_cohort_byte_budget';
      }
    }
    report.limits.totalArchiveBytesObserved = budget.observedArchiveBytes;
    report.limits.totalArchiveBytesAccepted = budget.acceptedArchiveBytes;
    report.limits.cohortByteBudgetExhausted = budget.exhausted;
    report.status = report.candidates.every(row => row.status === 'captured_pending_source_review')
      ? 'captured_pending_source_review' : 'completed_with_row_failures';
    const retained = report.candidates.some(row => row.fixture && row.status === 'captured_pending_source_review');
    if (!retained) {
      try {
        await remove(ownedRoot, { recursive: true, force: true });
        report.cleanup = { state: 'removed_no_successful_packages' };
      } catch (error) { report.cleanup = { state: 'remove_failed', error: String(error), ownedRoot }; }
    } else report.cleanup = { state: 'retained_for_source_review', cleanupOwner: 'Parent source-review workflow' };
    report.finishedAt = new Date().toISOString();
    report.implementationSha256 = sha256(await readFile(fileURLToPath(import.meta.url)));
    await reportWriter.write(report);
    return report;
  } catch (error) {
    await remove(ownedRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await reportWriter.close();
  }
}
