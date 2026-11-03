#!/usr/bin/env node
// Read-only official-source audit. Downloads are data; no plugin code is executed or installed.
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectZip, ZIP_LIMITS } from './lib/published-artifact-zip.mjs';
import { inspectPackage, STATIC_LIMITS } from './lib/published-artifact-package.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(REPO, 'output/legacy-node-2026-10-15/published-artifact-source-audit.json');
const CANONICAL = 'output/legacy-node-2026-10-15/canonical-package-readiness.json';
const HISTORICAL = 'output/ztools-market-top30-report.json';
const CANDIDATES = ['ai-helper', 'json-tools', 'color-helper', 'diff-compare', 'regex-editor'];
const MARKET = 'https://z-tools.top/api/market';
const CATALOG = `${MARKET}/plugins?limit=30&platform=darwin`;
const LIMITS = { requestTimeoutMs: 20000, maxRedirects: 2, jsonBytes: 2 * 1024 * 1024, ...ZIP_LIMITS };
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function selectCandidates(canonical, historical) {
  const requiresBuild = canonical.entries.filter((entry) => entry.readiness === 'requires_build');
  const rows = CANDIDATES.map((id) => {
    const local = requiresBuild.find((entry) => entry.directory === id);
    const prior = historical.plugins.find((entry) => entry.name === id);
    if (!local || !prior?.download_url || local.version !== prior.manifest_version) throw new Error(`Candidate is not a same-version historical requires_build package: ${id}`);
    return { id, localVersion: local.version, localReadiness: local.readiness,
      historical: { observedAt: historical.generated_at, catalogUrl: historical.catalog_url,
        catalogVersion: prior.version, manifestVersion: prior.manifest_version,
        downloadUrl: prior.download_url, locallyComputedSha256: prior.archive_sha256,
        catalogManifestVersionMismatch: prior.version !== prior.manifest_version,
        packageReadyClaim: prior.package_ready } };
  });
  return { requiresBuildCount: requiresBuild.length, rows };
}

export function validateOfficialUrl(value, kind) {
  const url = new URL(value);
  const expectedHost = kind === 'package' ? 'ztools.zosen.link' : 'z-tools.top';
  if (url.protocol !== 'https:' || url.hostname !== expectedHost || url.username || url.password
    || (url.port && url.port !== '443') || url.hash) throw new Error(`Rejected non-official ${kind} URL`);
  if (kind === 'package' && !url.pathname.toLowerCase().endsWith('.zip')) throw new Error('Official resolver did not supply a ZIP URL');
  if (kind === 'json' && !['/api/market/plugins', '/api/market/plugins/download'].includes(url.pathname)) throw new Error('Rejected unexpected official API path');
  return url;
}

export async function fetchBounded(value, kind, trace, request = fetch) {
  let url = validateOfficialUrl(value, kind);
  const signal = AbortSignal.timeout(LIMITS.requestTimeoutMs);
  const maxBytes = kind === 'package' ? LIMITS.archiveBytes : LIMITS.jsonBytes;
  for (let redirect = 0; ; redirect++) {
    const observation = { requestedUrl: url.href, status: null, responseBytes: 0 };
    trace.push(observation);
    let response;
    try {
      response = await request(url, { method: 'GET', redirect: 'manual', signal,
        headers: { 'User-Agent': 'ATools-published-artifact-readonly-audit/1.0', Accept: kind === 'json' ? 'application/json' : 'application/zip' } });
      observation.status = response.status;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirect >= LIMITS.maxRedirects) throw new Error('Official request redirect limit/location rejected');
        const next = validateOfficialUrl(new URL(location, url).href, kind);
        observation.redirectTo = next.href;
        url = next;
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const declared = response.headers.get('content-length');
      observation.declaredBytes = declared === null ? null : Number(declared);
      if (declared !== null && (!Number.isFinite(Number(declared)) || Number(declared) > maxBytes)) {
        await response.body?.cancel(); throw new Error('Official response declared byte quota exceeded');
      }
      const chunks = [];
      if (response.body) for await (const chunk of response.body) {
        observation.responseBytes += chunk.length;
        if (observation.responseBytes > maxBytes) { await response.body.cancel().catch(() => {}); throw new Error('Official response streamed byte quota exceeded'); }
        chunks.push(Buffer.from(chunk));
      }
      observation.finalUrl = url.href;
      return { bytes: Buffer.concat(chunks), url: url.href, contentType: response.headers.get('content-type') };
    } catch (error) {
      observation.error = error.cause?.code ? `${error.message}: ${error.cause.code}` : error.message;
      throw new Error(observation.error);
    }
  }
}

async function fetchJson(url, trace) {
  const result = await fetchBounded(url, 'json', trace);
  return JSON.parse(result.bytes.toString('utf8'));
}
function findCatalogPlugin(catalog, id) {
  const entries = [...(Array.isArray(catalog?.latest) ? catalog.latest : []),
    ...(Array.isArray(catalog?.categories) ? catalog.categories.flatMap((category) => Array.isArray(category.plugins) ? category.plugins : []) : [])];
  const plugin = entries.find((entry) => entry?.name === id);
  return plugin ? { name: plugin.name, version: String(plugin.version || ''), size: plugin.size ?? null,
    upstreamChecksum: plugin.checksum ?? plugin.sha256 ?? null, signature: plugin.signature ?? null,
    publicKey: plugin.publicKey ?? plugin.public_key ?? null } : null;
}

async function auditCandidate(candidate, catalog, owned, trace) {
  const result = { ...candidate, currentCatalogEntry: findCatalogPlugin(catalog, candidate.id),
    resolverUrl: `${MARKET}/plugins/download?name=${encodeURIComponent(candidate.id)}`, http: [], status: 'pending' };
  try {
    const resolved = await fetchJson(result.resolverUrl, result.http);
    result.resolver = { downloadUrl: typeof resolved.downloadUrl === 'string' ? resolved.downloadUrl : null,
      zpxDownloadUrl: typeof resolved.zpxDownloadUrl === 'string' ? resolved.zpxDownloadUrl : null,
      upstreamChecksum: resolved.checksum ?? resolved.sha256 ?? null,
      signature: resolved.signature ?? null, publicKey: resolved.publicKey ?? resolved.public_key ?? null };
    if (!result.resolver.downloadUrl) throw new Error('Official download API has no ZIP downloadUrl; ZPX is not inspected');
    validateOfficialUrl(result.resolver.downloadUrl, 'package');
    const downloaded = await fetchBounded(result.resolver.downloadUrl, 'package', result.http);
    const sha256 = digest(downloaded.bytes);
    result.archive = { actualUrl: downloaded.url, bytes: downloaded.bytes.length, locallyComputedSha256: sha256,
      historicalSha256Match: sha256 === candidate.historical.locallyComputedSha256,
      publisherSignatureVerified: false, upstreamChecksumVerified: false,
      trustBoundary: 'Computed SHA-256 identifies downloaded bytes only; it is not an upstream checksum, publisher signature, provenance attestation or install authorization.' };
    await writeFile(path.join(owned, `${candidate.id}.zip`), downloaded.bytes, { flag: 'wx' });
    const inspected = inspectZip(downloaded.bytes);
    result.zip = inspected.summary;
    result.package = inspectPackage(inspected.files, candidate.id);
    result.version = { local: candidate.localVersion, historicalManifest: candidate.historical.manifestVersion,
      currentCatalog: result.currentCatalogEntry?.version ?? null, downloadedManifest: result.package.version,
      localMatchesDownloaded: candidate.localVersion === result.package.version,
      catalogMatchesDownloaded: !result.currentCatalogEntry ? null : result.currentCatalogEntry.version === result.package.version };
    result.status = !result.version.localMatchesDownloaded ? 'downloaded_version_mismatch'
      : !result.package.staticEntryComplete ? 'static_package_needs_review'
        : result.zip.nativeFiles.length ? 'requires_native_review' : 'static_package_reviewable';
  } catch (error) {
    result.status = result.http.some((entry) => entry.error) ? 'http_or_source_unavailable' : 'package_inspection_failed';
    result.error = error.message;
  }
  trace.push(result);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some((arg) => arg !== '--selection-only')) throw new Error('Usage: node scripts/audit-ztools-published-artifacts.mjs [--selection-only]');
  const canonical = JSON.parse(await readFile(path.join(REPO, CANONICAL), 'utf8'));
  const historical = JSON.parse(await readFile(path.join(REPO, HISTORICAL), 'utf8'));
  const selection = selectCandidates(canonical, historical);
  if (argv.includes('--selection-only')) { console.log(JSON.stringify(selection, null, 2)); return; }
  let previous = null;
  try { previous = JSON.parse(await readFile(OUTPUT, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const implementationSnapshot = await Promise.all(['scripts/audit-ztools-published-artifacts.mjs',
    'scripts/lib/published-artifact-zip.mjs', 'scripts/lib/published-artifact-package.mjs'].map(async (file) => ({
    file, sha256: digest(await readFile(path.join(REPO, file))) })));
  const report = { schemaVersion: 2, generatedAt: new Date().toISOString(), revisionNotes: [
    'Revision 2 replaces regex JS import matching with bounded lexical scanning: supports multiline imports/exports; skips comments/string examples; conservatively flags unparsed/computed imports. ZIP parent-path checks use a Map rather than repeated scans. Inline data URI payloads are counted, not copied into this report.',
    'ZIP binary validation and static package/reference analysis now use separate modules. Final hardening streams HTML/CSS references, caps package reference edges/unique missing paths and diagnostic samples/strings, and records observed/omitted counts. No budget is widened to promote scan completeness.',
    'The initial 2026-10-15 run classified json-tools as static_package_incomplete from assets/file. That regex-derived result is superseded; it was not evidence of a broken upstream package.' ],
  previousObservation: previous ? { generatedAt: previous.generatedAt, finishedAt: previous.finishedAt,
    summary: previous.summary, candidates: previous.candidates.map((item) => ({ id: item.id, status: item.status,
      downloadUrl: item.archive?.actualUrl ?? null, locallyComputedSha256: item.archive?.locallyComputedSha256 ?? null,
      missingStaticFiles: item.package?.missingStaticFiles ?? [] })) } : null,
  implementationSnapshot, sources: { canonical: CANONICAL,
    canonicalGeneratedAt: canonical.generatedAt, historical: HISTORICAL, historicalGeneratedAt: historical.generated_at,
    officialCatalog: CATALOG }, selection: { requiresBuildCount: selection.requiresBuildCount, candidateIds: CANDIDATES,
    policy: 'Exactly five requested same-version candidates, selected from local requires_build and historical observed artifacts; URLs are obtained from current official resolver responses, never inferred from filenames.' },
  limits: { ...LIMITS, staticReferences: STATIC_LIMITS }, scope: { noInstall: true, noDependencyInstallation: true, noBuild: true, noPluginExecution: true,
    noPreloadExecution: true, noArchiveExtractionToDisk: true, downloadedContentUploaded: false,
    temporaryDownloadCleanup: false, runtimeAcceptance: false,
    existingHelperAssessment: 'Existing scripts/ztools-market-top30-report.mjs checks listed names then extracts; Rust market ZIP checks are not exposed as a standalone ZIP inspection CLI. This audit uses a bounded, dependency-free central-directory preflight and in-memory CRC-checked reads, without extraction.' },
  catalogHttp: [], candidates: [], evidenceLimits: [
    'HTTP success, static entry completeness and historical digest matches do not establish runtime/business compatibility or current installer acceptance.',
    'No upstream signature/checksum is invented. Any provided values are recorded as unverified observations; local archive hashes are not publisher signatures.',
    'Static references are literal-only; unparsed/computed imports are flagged for review, while runtime fetches and Node/package dependency completeness remain unverified.',
    'The official catalog uses its existing limit=30 darwin endpoint; a missing catalog entry is not proof of no published artifact.',
    'Host restriction is applied to the initial URL and every redirect; no credentials, cookies, local source code or downloaded plugin content are sent.' ] };
  const owned = await mkdtemp(path.join(tmpdir(), 'atools-published-artifact-audit-'));
  try {
    let catalog = null;
    try { catalog = await fetchJson(CATALOG, report.catalogHttp); }
    catch (error) { report.catalogError = error.message; }
    for (const candidate of selection.rows) await auditCandidate(candidate, catalog, owned, report.candidates);
  } finally {
    await rm(owned, { recursive: true, force: true });
    report.scope.temporaryDownloadCleanup = true;
  }
  report.finishedAt = new Date().toISOString();
  report.summary = report.candidates.reduce((summary, candidate) => {
    summary[candidate.status] = (summary[candidate.status] || 0) + 1;
    return summary;
  }, {});
  await mkdir(path.dirname(OUTPUT), { recursive: true });
  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: path.relative(REPO, OUTPUT), summary: report.summary, temporaryDownloadCleanup: true }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
