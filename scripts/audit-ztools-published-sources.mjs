#!/usr/bin/env node
// Metadata only: resolver URLs are candidates, not verified archives or runtime results.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchBounded, validateOfficialUrl } from './audit-ztools-published-artifacts.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const INPUT = 'output/legacy-node-2026-10-15/canonical-package-readiness.json';
const OUTPUT = 'output/legacy-node-2026-10-15/published-source-catalog.json';
const MARKET = 'https://z-tools.top/api/market';
export const SOURCE_LIMITS = { candidates: 256, concurrency: 3, totalDurationMs: 120000, metadataUrlCharacters: 2048 };

export function sourceCandidates(inventory) {
  assert.ok(Array.isArray(inventory?.entries), 'Canonical inventory must contain entries');
  const rows = inventory.entries.filter(row => row.readiness === 'requires_build').map(row => {
    const id = typeof row.name === 'string' ? row.name.trim() : '';
    assert.ok(id && Buffer.byteLength(id) <= 256, `Invalid published plugin ID for ${row.directory}`);
    return { directory: row.directory, id, localVersion: row.version ?? null,
      localReadiness: row.readiness, declaredPlatforms: row.platform ?? null };
  });
  assert.ok(rows.length <= SOURCE_LIMITS.candidates, 'Published source audit candidate budget exceeded');
  return rows;
}

export function catalogIndex(payload) {
  const index = new Map();
  const entries = [...(Array.isArray(payload?.latest) ? payload.latest : []),
    ...(Array.isArray(payload?.categories) ? payload.categories.flatMap(category =>
      Array.isArray(category?.plugins) ? category.plugins : []) : [])];
  for (const item of entries) {
    if (!item || typeof item.name !== 'string' || index.has(item.name)) continue;
    index.set(item.name, { version: typeof item.version === 'string' ? item.version.slice(0, 128) : null });
  }
  return index;
}

export function resolverObservation(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 'invalid_resolver_payload' };
  }
  const statusFields = Object.fromEntries(['success', 'resultCode', 'errorCode'].filter(key =>
    Object.hasOwn(payload, key)).map(key => [key, String(payload[key]).slice(0, 128)]));
  if (payload.success === false || (payload.errorCode != null && ![0, '0', ''].includes(payload.errorCode))) {
    return { status: 'resolver_rejected', statusFields };
  }
  // This API normally returns downloadUrl directly. An unfamiliar business-code
  // envelope needs review, even if HTTP succeeded and it also contains a URL.
  if (payload.resultCode != null && ![0, '0', ''].includes(payload.resultCode)) {
    return { status: 'resolver_status_needs_review', statusFields };
  }
  if (typeof payload.downloadUrl !== 'string' || !payload.downloadUrl) {
    return { status: payload.zpxDownloadUrl ? 'zpx_only_not_inspected' : 'no_zip_url_advertised', statusFields };
  }
  if (payload.downloadUrl.length > SOURCE_LIMITS.metadataUrlCharacters) {
    return { status: 'resolver_url_needs_review', statusFields, urlCharacters: payload.downloadUrl.length };
  }
  let url;
  try { url = validateOfficialUrl(payload.downloadUrl, 'package').href; }
  catch (error) { return { status: 'resolver_url_rejected', statusFields, error: error.message }; }
  return { status: 'official_zip_url_advertised', statusFields, downloadUrl: url,
    resolverVersion: typeof payload.version === 'string' ? payload.version.slice(0, 128) : null,
    upstreamChecksumProvided: typeof (payload.sha256 ?? payload.checksum) === 'string',
    signatureProvided: typeof payload.signature === 'string', publicKeyProvided: typeof (payload.publicKey ?? payload.public_key) === 'string' };
}

export function sourceFailure(error, target = 'resolver') {
  return { status: error instanceof SyntaxError ? `invalid_${target}_payload` : 'http_or_source_unavailable',
    error: (error instanceof Error ? error.message : String(error)).slice(0, 512) };
}

/** Deduplicate requests by manifest name, but retain every source directory row. */
export async function resolveSourceRows(rows, readJson, { catalog = new Map(), deadlineAt = Infinity, now = Date.now } = {}) {
  const uniqueIds = [...new Set(rows.map(row => row.id))];
  const observations = new Map();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(SOURCE_LIMITS.concurrency, uniqueIds.length) }, async () => {
    while (cursor < uniqueIds.length) {
      const id = uniqueIds[cursor++];
      const http = [];
      const resolverUrl = `${MARKET}/plugins/download?name=${encodeURIComponent(id)}`;
      if (now() >= deadlineAt) {
        observations.set(id, { resolverUrl, http, status: 'not_requested_due_to_audit_deadline' });
        continue;
      }
      try {
        observations.set(id, { resolverUrl, http, ...resolverObservation(await readJson(resolverUrl, http)) });
      } catch (error) {
        observations.set(id, { resolverUrl, http, ...sourceFailure(error) });
      }
    }
  }));
  return rows.map(row => {
    const advertised = catalog.get(row.id);
    return { ...row, ...observations.get(row.id), catalogVersion: advertised?.version ?? null,
      catalogVersionRelation: !advertised?.version || !row.localVersion ? 'unknown'
        : advertised.version === row.localVersion ? 'same_as_local' : 'different_from_local' };
  });
}

export async function main(argv = process.argv.slice(2)) {
  assert.ok(argv.every(arg => arg === '--selection-only'), 'Usage: node scripts/audit-ztools-published-sources.mjs [--selection-only]');
  const input = await readFile(resolve(ROOT, INPUT));
  const inventory = JSON.parse(input);
  const selected = sourceCandidates(inventory);
  if (argv.includes('--selection-only')) { console.log(JSON.stringify(selected, null, 2)); return; }
  const started = Date.now();
  const signal = AbortSignal.timeout(SOURCE_LIMITS.totalDurationMs);
  const readJson = async (url, trace) => {
    const { bytes } = await fetchBounded(url, 'json', trace, (target, options) =>
      fetch(target, { ...options, signal: AbortSignal.any([signal, options.signal]) }));
    return JSON.parse(bytes.toString('utf8'));
  };
  const catalogUrl = `${MARKET}/plugins?limit=30&platform=darwin`;
  const catalogHttp = [];
  let catalog = new Map(), catalogError, catalogStatus = 'catalog_json_received';
  try { catalog = catalogIndex(await readJson(catalogUrl, catalogHttp)); }
  catch (error) { const failure = sourceFailure(error, 'catalog'); catalogError = failure.error; catalogStatus = failure.status; }
  const rows = await resolveSourceRows(selected, readJson, { catalog, deadlineAt: started + SOURCE_LIMITS.totalDurationMs });
  const summary = rows.reduce((counts, row) => ({ ...counts, [row.status]: (counts[row.status] ?? 0) + 1 }), {});
  const report = { schemaVersion: 1, generatedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    input: { file: INPUT, sha256: createHash('sha256').update(input).digest('hex'), generatedAt: inventory.generatedAt },
    limits: SOURCE_LIMITS, scope: { metadataOnly: true, downloadedArchives: 0, pluginCodeExecuted: false,
      installedPlugins: 0, runtimeAcceptance: false }, catalogUrl, catalogHttp, catalogStatus, catalogError,
    distinctManifestIds: new Set(selected.map(row => row.id)).size, selectedSourceDirectories: selected.length, summary, rows,
    evidenceLimits: ['Advertised resolver URLs have not been downloaded, hashed, unpacked, installed or executed by this audit.',
      'Catalog versions are not archive manifest versions; a missing limited catalog row does not prove no artifact exists.',
      'This audit does not increase static package readiness or runtime compatibility counts.',
      'Every request uses the existing exact official HTTPS host, redirect, 20-second and 2 MiB response bounds. Total deadline also aborts in-flight fetches.',
      'No local source code, credentials or downloaded content is uploaded. Only public manifest names are sent to the official resolver.'] };
  await writeFile(resolve(ROOT, OUTPUT), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output: OUTPUT, selected: selected.length, summary, elapsedMs: Date.now() - started }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
