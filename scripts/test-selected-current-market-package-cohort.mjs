import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sha256 } from './lib/published-plugin-fixture.mjs';
import { captureSelectedCurrentMarketCohort, parseCohortOffset, validatePinnedSelection } from './lib/selected-current-market-package-cohort.mjs';

function makePinnedDocuments(count = 10) {
  const plugins = Array.from({ length: count }, (_, index) => ({ name: `tool-${String(index).padStart(2, '0')}`,
    version: `1.${index}.0`, downloadCount: 1000 - Math.floor(index / 2), localMatch: index === 0 ? 'missing' : 'version_mismatch',
    cohort: 'eligible', countStatus: 'known', size: 1200 + index }));
  const catalog = { latest: plugins.map(({ name, version, downloadCount }) => ({ name, version, downloadCount })) };
  const matrix = { threshold: 30, source: { catalogPath: '/fixture/catalog.json' }, plugins: [...plugins,
    { name: 'low-download', version: '1.0.0', downloadCount: 29, localMatch: 'missing', cohort: 'excluded', countStatus: 'known' }] };
  const sorted = [...plugins].sort((left, right) => right.downloadCount - left.downloadCount
    || left.name.localeCompare(right.name) || left.version.localeCompare(right.version));
  return { catalogBytes: Buffer.from(JSON.stringify(catalog)), matrixBytes: Buffer.from(JSON.stringify(matrix)),
    selection: { schemaVersion: 1, catalog: { path: '/fixture/catalog.json', sha256: sha256(Buffer.from(JSON.stringify(catalog))) },
      matrix: { path: '/fixture/matrix.json', sha256: sha256(Buffer.from(JSON.stringify(matrix))) },
      criteria: 'Observed eligible >=30, local name+version not exactly matched; descending downloadCount then name/version; first ten only',
      plugins: sorted.slice(0, Math.min(count, 10)).map(({ name, version, downloadCount, localMatch, size }) =>
        ({ name, version, downloadCount, localMatch, size })) } };
}

const pinned = makePinnedDocuments();
pinned.selection.catalog.path = '/fixture/catalog.json';
assert.equal(validatePinnedSelection({ selection: pinned.selection, matrixBytes: pinned.matrixBytes,
  catalogBytes: pinned.catalogBytes }).selected.length, 10);
assert.equal(parseCohortOffset(undefined), 0);
assert.equal(parseCohortOffset('0'), 0);
assert.equal(parseCohortOffset('10'), 10);
for (const invalid of ['-10', '1', '01', '10.0', '90071992547409920'])
  assert.throws(() => parseCohortOffset(invalid), /offset/);
const pagedDocuments = makePinnedDocuments(23);
const page0 = validatePinnedSelection({ selection: pagedDocuments.selection,
  matrixBytes: pagedDocuments.matrixBytes, catalogBytes: pagedDocuments.catalogBytes });
const page10 = validatePinnedSelection({ selection: pagedDocuments.selection,
  matrixBytes: pagedDocuments.matrixBytes, catalogBytes: pagedDocuments.catalogBytes, offset: 10 });
const page20 = validatePinnedSelection({ selection: pagedDocuments.selection,
  matrixBytes: pagedDocuments.matrixBytes, catalogBytes: pagedDocuments.catalogBytes, offset: 20 });
const pageNames = page => page.selected.map(row => row.name);
for (const shortLength of [1, 9]) {
  const shortDocuments = makePinnedDocuments(shortLength);
  const shortSelection = validatePinnedSelection({ selection: shortDocuments.selection,
    matrixBytes: shortDocuments.matrixBytes, catalogBytes: shortDocuments.catalogBytes });
  assert.equal(shortSelection.selected.length, shortLength, `default selection of ${shortLength} must not expand`);
  assert.equal(shortSelection.pageSize, shortLength);
  assert.throws(() => validatePinnedSelection({ selection: shortDocuments.selection,
    matrixBytes: shortDocuments.matrixBytes, catalogBytes: shortDocuments.catalogBytes, offset: 10 }), /complete ten-row/);
}
assert.deepEqual(pageNames(page0), Array.from({ length: 10 }, (_, i) => `tool-${String(i).padStart(2, '0')}`));
assert.deepEqual(pageNames(page10), Array.from({ length: 10 }, (_, i) => `tool-${String(i + 10).padStart(2, '0')}`));
assert.deepEqual(pageNames(page20), ['tool-20', 'tool-21', 'tool-22']);
assert.equal(new Set([...pageNames(page0), ...pageNames(page10), ...pageNames(page20)]).size, 23);
assert([...page0.selected, ...page10.selected, ...page20.selected].every(row => row.downloadCount >= 30));
assert.throws(() => validatePinnedSelection({ selection: pagedDocuments.selection,
  matrixBytes: pagedDocuments.matrixBytes, catalogBytes: pagedDocuments.catalogBytes, offset: 1 }), /multiple/);
assert.throws(() => validatePinnedSelection({ selection: pagedDocuments.selection,
  matrixBytes: pagedDocuments.matrixBytes, catalogBytes: pagedDocuments.catalogBytes, offset: 30 }), /past the end/);
{
  const changedMatrix = JSON.parse(pinned.matrixBytes.toString('utf8'));
  changedMatrix.threshold = 29;
  const matrixBytes = Buffer.from(JSON.stringify(changedMatrix));
  assert.throws(() => validatePinnedSelection({ selection: { ...pinned.selection,
    matrix: { ...pinned.selection.matrix, sha256: sha256(matrixBytes) } }, matrixBytes,
    catalogBytes: pinned.catalogBytes }), /threshold must be 30/);
}
assert.throws(() => validatePinnedSelection({ selection: { ...pinned.selection,
  catalog: { ...pinned.selection.catalog, sha256: '0'.repeat(64) } }, matrixBytes: pinned.matrixBytes,
  catalogBytes: pinned.catalogBytes }), /SHA-256/);
assert.throws(() => validatePinnedSelection({ selection: { ...pinned.selection,
  plugins: [...pinned.selection.plugins, pinned.selection.plugins[0]] }, matrixBytes: pinned.matrixBytes,
  catalogBytes: pinned.catalogBytes }), /one to ten/);
assert.throws(() => validatePinnedSelection({ selection: { ...pinned.selection,
  plugins: pinned.selection.plugins.map((row, index) => index ? row : { ...row, version: '9.9.9' }) },
  matrixBytes: pinned.matrixBytes, catalogBytes: pinned.catalogBytes }), /recomputed unmatched ranking/);
assert.throws(() => validatePinnedSelection({ selection: { ...pinned.selection,
  plugins: pinned.selection.plugins.map((row, index) => index ? row : { ...row, downloadCount: 29 }) },
  matrixBytes: pinned.matrixBytes, catalogBytes: pinned.catalogBytes }), /recomputed unmatched ranking/);
{
  const changedCatalog = JSON.parse(pinned.catalogBytes.toString('utf8'));
  changedCatalog.latest[0].downloadCount++;
  const catalogBytes = Buffer.from(JSON.stringify(changedCatalog));
  assert.throws(() => validatePinnedSelection({ selection: { ...pinned.selection,
    catalog: { ...pinned.selection.catalog, sha256: sha256(catalogBytes) } }, matrixBytes: pinned.matrixBytes,
    catalogBytes }), /catalog count drift/);
}

async function withCaptureFixture(options = {}, verify) {
  const documents = options.documents || pinned;
  const selection = options.selection || documents.selection;
  const currentCatalog = options.currentCatalog || JSON.parse(documents.catalogBytes.toString('utf8'));
  const { packageVersion, cohortArchiveByteLimit = 262144000, failRetain = false,
    fetchBoundedOverride, fetcherOverride, catalogSymlink = false } = options;
  const root = await mkdtemp(path.join(tmpdir(), 'selected-market-cohort-test-'));
  const catalogPath = path.join(root, 'catalog.json'), matrixPath = path.join(root, 'matrix.json');
  const selectionPath = path.join(root, 'selection.json');
  const localCatalogBytes = Buffer.from(JSON.stringify(JSON.parse(documents.catalogBytes.toString('utf8'))));
  const localMatrix = JSON.parse(documents.matrixBytes.toString('utf8'));
  const sourceCatalogPath = catalogSymlink ? path.join(root, 'catalog-link.json') : catalogPath;
  localMatrix.source.catalogPath = sourceCatalogPath;
  const matrixBytes = Buffer.from(JSON.stringify(localMatrix));
  const boundSelection = { ...selection, catalog: { path: sourceCatalogPath, sha256: sha256(localCatalogBytes) },
    matrix: { path: matrixPath, sha256: sha256(matrixBytes) } };
  const selectionBytes = Buffer.from(JSON.stringify(boundSelection));
  await writeFile(catalogPath, localCatalogBytes, { flag: 'wx' });
  if (catalogSymlink) await symlink('catalog.json', sourceCatalogPath);
  await writeFile(matrixPath, matrixBytes, { flag: 'wx' });
  await writeFile(selectionPath, selectionBytes, { flag: 'wx' });
  const reportWrites = [], removed = [], calls = [];
  let reportCloseCalls = 0;
  let packageCalls = 0, inspectionCalls = 0, materializeCalls = 0, archiveWrites = 0;
  const deps = {
    createReportWriter: async () => ({ write: async value => reportWrites.push(structuredClone(value)),
      close: async () => { reportCloseCalls++; } }),
    createDeadline: milliseconds => AbortSignal.timeout(milliseconds), createPrivateRoot: async () => path.join(root, 'owned'),
    fetchBounded: fetchBoundedOverride || (async (url, kind, trace, request) => {
      calls.push({ url, kind });
      if (url.includes('/plugins?limit=100')) return { bytes: Buffer.from(JSON.stringify(currentCatalog)), url };
      if (url.includes('/plugins/download?name=')) return { bytes: Buffer.from(JSON.stringify({ downloadUrl: 'https://ztools.zosen.link/tool.zip' })), url };
      if (kind === 'package') {
        packageCalls++;
        if (cohortArchiveByteLimit < 262144000) {
          const response = await request(url, { headers: { Accept: 'application/zip' } });
          return { bytes: Buffer.from(await response.arrayBuffer()), url };
        }
        return { bytes: Buffer.from('fixture zip'), url };
      }
      throw new Error(`Unexpected fixture URL: ${url}`);
    }),
    fetcher: fetcherOverride || (async () => new Response('fixture zip', { headers: { 'content-length': '11' } })),
    inspectZip: () => { inspectionCalls++; return { files: new Map([['plugin.json', Buffer.from('{}')]]),
      summary: { nativeFiles: [], symlinkCount: 0, entryCount: 1, extractedToDisk: false } }; },
    inspectPackage: (_files, name) => ({ name, version: packageVersion || localMatrix.plugins.find(row => row.name === name)?.version || boundSelection.plugins[0].version,
      manifestPath: 'plugin.json', platform: ['darwin'], staticEntryComplete: true }),
    materializeInspectedFiles: async () => { materializeCalls++; return { ownedRoot: path.join(root, 'owned', 'item'), contentRoot: path.join(root, 'owned', 'item', 'plugin'), files: [] }; },
    retainArchive: async () => { archiveWrites++; if (failRetain) throw new Error('fixture retention failure'); return path.join(root, 'owned', 'item', 'source.zip'); },
    remove: async target => { removed.push(target); },
    cohortArchiveByteLimit,
  };
  try { await verify({ deps, root, selectionPath, selectionSha256: sha256(selectionBytes), calls, reportWrites, removed,
    get packageCalls() { return packageCalls; }, get inspectionCalls() { return inspectionCalls; },
    get materializeCalls() { return materializeCalls; }, get archiveWrites() { return archiveWrites; },
    get reportCloseCalls() { return reportCloseCalls; } });
    if (reportWrites.length) assert.equal(reportCloseCalls, 1, 'capture must await its report writer close');
  } finally { await rm(root, { recursive: true, force: true }); }
}

await withCaptureFixture({ documents: pagedDocuments }, async fixture => {
  const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath,
    selectionSha256: fixture.selectionSha256, outputPath: path.join(fixture.root, 'result.json'),
    root: fixture.root, offset: 10, dependencies: fixture.deps });
  assert.deepEqual(report.candidates.map(row => row.name), pageNames(page10));
  assert.deepEqual(report.selectionPage, { offset: 10, pageSize: 10, rankedEligibleUnmatchedCount: 23,
    selectedCount: 10, nextOffset: 20 });
  assert(report.candidates.every(row => row.status === 'captured_pending_source_review'));
});

await withCaptureFixture({ currentCatalog: { latest: [] } }, async fixture => {
  const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath, selectionSha256: fixture.selectionSha256,
    outputPath: path.join(fixture.root, 'result.json'), root: fixture.root, dependencies: fixture.deps });
  assert.equal(report.candidates[0].status, 'failed_current_catalog_version_drift');
  assert.equal(fixture.calls.some(call => call.url.includes('/plugins/download?name=')), false);
});

await withCaptureFixture({ selection: { ...pinned.selection, plugins: pinned.selection.plugins.slice(0, 1) } }, async fixture => {
  const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath, selectionSha256: fixture.selectionSha256,
    outputPath: path.join(fixture.root, 'result.json'), root: await realpath(fixture.root), dependencies: fixture.deps });
  assert.equal(report.candidates[0].status, 'captured_pending_source_review');
  assert.equal(report.selectionPage.pageSize, 1);
  assert.equal(report.selectionPage.selectedCount, 1);
  assert.equal(report.selectionPage.nextOffset, null);
  assert.match(report.candidates[0].archive.sha256, /^[a-f0-9]{64}$/);
  assert.equal(report.scope.pluginCodeExecuted, false);
  assert.equal(report.cleanup.state, 'retained_for_source_review');
});

await withCaptureFixture({ selection: { ...pinned.selection, plugins: pinned.selection.plugins.slice(0, 9) } }, async fixture => {
  const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath,
    selectionSha256: fixture.selectionSha256, outputPath: path.join(fixture.root, 'result.json'),
    root: fixture.root, dependencies: fixture.deps });
  assert.equal(report.selectionPage.pageSize, 9);
  assert.equal(report.selectionPage.selectedCount, 9);
  assert.equal(report.selectionPage.nextOffset, null);
});

await withCaptureFixture({ selection: { ...pinned.selection, plugins: pinned.selection.plugins.slice(0, 1) } }, async fixture => {
  await assert.rejects(captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath,
    outputPath: path.join(fixture.root, 'missing-anchor.json'), root: fixture.root, dependencies: fixture.deps }),
  /Caller must provide an approved selection SHA-256/);
  await assert.rejects(captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath,
    selectionSha256: '0'.repeat(64), outputPath: path.join(fixture.root, 'result.json'),
    root: fixture.root, dependencies: fixture.deps }), /approved selection SHA-256 mismatch/);
  assert.equal(fixture.calls.length, 0);
});

await withCaptureFixture({ catalogSymlink: true, selection: { ...pinned.selection, plugins: pinned.selection.plugins.slice(0, 1) } }, async fixture => {
  await assert.rejects(captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath,
    selectionSha256: fixture.selectionSha256, outputPath: path.join(fixture.root, 'result.json'),
    root: fixture.root, dependencies: fixture.deps }), /may not traverse symlinks/);
  assert.equal(fixture.calls.length, 0);
});

await withCaptureFixture({ packageVersion: '9.9.9' }, async fixture => {
  const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath, selectionSha256: fixture.selectionSha256,
    outputPath: path.join(fixture.root, 'result.json'), root: fixture.root, dependencies: fixture.deps });
  assert.equal(report.candidates[0].status, 'failed_downloaded_version_mismatch');
  assert.equal(report.candidates[0].fixture, null);
});

await withCaptureFixture({ cohortArchiveByteLimit: 2 }, async fixture => {
  const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath, selectionSha256: fixture.selectionSha256,
    outputPath: path.join(fixture.root, 'result.json'), root: fixture.root, dependencies: fixture.deps });
  assert.equal(report.candidates[0].status, 'failed_cohort_byte_budget');
  assert.equal(report.candidates[1].status, 'not_attempted_cohort_byte_budget');
  assert.equal(report.limits.totalArchiveBytesObserved, 0);
  assert.equal(report.limits.totalArchiveBytesAccepted, 0);
});

{
  let packageRequests = 0, emitted = 0;
  const fetchBoundedOverride = async (url, kind, _trace, request) => {
    if (url.includes('/plugins?limit=100')) return { bytes: pinned.catalogBytes, url };
    if (url.includes('/plugins/download?name=')) return { bytes: Buffer.from(JSON.stringify({ downloadUrl: 'https://ztools.zosen.link/tool.zip' })), url };
    if (kind !== 'package') throw new Error(`Unexpected fixture URL: ${url}`);
    packageRequests++;
    const response = await request(url, { headers: { Accept: 'application/zip' } });
    return { bytes: Buffer.from(await response.arrayBuffer()), url };
  };
  const fetcherOverride = async () => new Response(new ReadableStream({
    pull(controller) {
      if (emitted === 0) { emitted++; controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5])); }
      else if (emitted === 1) { emitted++; controller.enqueue(Uint8Array.from([6, 7, 8, 9, 10, 11, 12])); }
      else controller.close();
    },
  }));
  await withCaptureFixture({ cohortArchiveByteLimit: 8, fetchBoundedOverride, fetcherOverride,
    selection: { ...pinned.selection, plugins: pinned.selection.plugins.slice(0, 2) } }, async fixture => {
    const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath,
      selectionSha256: fixture.selectionSha256, outputPath: path.join(fixture.root, 'result.json'),
      root: fixture.root, dependencies: fixture.deps });
    assert.equal(report.candidates[0].status, 'failed_cohort_byte_budget');
    assert.equal(report.candidates[1].status, 'not_attempted_cohort_byte_budget');
    assert.equal(report.limits.totalArchiveBytesObserved, 12);
    assert.equal(report.limits.totalArchiveBytesAccepted, 5);
    assert.equal(report.limits.cohortByteBudgetExhausted, true);
    assert.equal(packageRequests, 1);
    assert.equal(fixture.inspectionCalls, 0);
    assert.equal(fixture.materializeCalls, 0);
    assert.equal(fixture.archiveWrites, 0);
    assert.equal(fixture.removed.includes(path.join(fixture.root, 'owned')), true);
    assert.equal(fixture.reportWrites.at(-1).limits.totalArchiveBytesObserved, 12);
    assert.equal(fixture.reportWrites.at(-1).limits.totalArchiveBytesAccepted, 5);
    assert.equal(fixture.reportWrites.at(-1).candidates[1].status, 'not_attempted_cohort_byte_budget');
    assert.equal(fixture.reportWrites.at(-1).cleanup.state, 'removed_no_successful_packages');
    assert.equal(fixture.reportCloseCalls, 1);
  });
}

await withCaptureFixture({ failRetain: true }, async fixture => {
  const report = await captureSelectedCurrentMarketCohort({ selectionPath: fixture.selectionPath, selectionSha256: fixture.selectionSha256,
    outputPath: path.join(fixture.root, 'result.json'), root: fixture.root, dependencies: fixture.deps });
  assert.equal(report.candidates[0].status, 'failed_capture_or_inspection');
  assert.equal(report.candidates[0].fixtureRemovedOnFailure, true);
  assert.ok(fixture.removed.includes(path.join(fixture.root, 'owned', 'item')));
});

console.log('selected current-market package cohort contracts verified');
