import assert from 'node:assert/strict';
import { sourceCandidates, catalogIndex, resolverObservation, resolveSourceRows, sourceFailure, SOURCE_LIMITS } from './audit-ztools-published-sources.mjs';

const url = id => `https://ztools.zosen.link/${id}-1.zip`;
assert.deepEqual(sourceCandidates({ entries: [
  { name: 'different-name', directory: 'source-dir', readiness: 'requires_build', version: '1', platform: ['darwin'] },
  { name: 'ready', directory: 'ready', readiness: 'ready' },
] }), [{ directory: 'source-dir', id: 'different-name', localVersion: '1', localReadiness: 'requires_build', declaredPlatforms: ['darwin'] }]);
assert.throws(() => sourceCandidates({ entries: [{ name: '', directory: 'invalid', readiness: 'requires_build' }] }), /Invalid/);
assert.throws(() => sourceCandidates({ entries: Array.from({ length: SOURCE_LIMITS.candidates + 1 }, () => ({ name: 'id', readiness: 'requires_build' })) }), /budget/);
const catalog = catalogIndex({ latest: [{ name: 'one', version: '2' }], categories: [{ plugins: [{ name: 'one', version: 'old' }, { name: 'two', version: '1' }] }] });
assert.equal(catalog.get('one').version, '2');
assert.equal(resolverObservation({ success: false, downloadUrl: url('one') }).status, 'resolver_rejected');
assert.equal(resolverObservation({ errorCode: 7, downloadUrl: url('one') }).status, 'resolver_rejected');
assert.equal(resolverObservation({ resultCode: 'unfamiliar', downloadUrl: url('one') }).status, 'resolver_status_needs_review');
assert.equal(resolverObservation({ downloadUrl: 'https://example.com/one.zip' }).status, 'resolver_url_rejected');
assert.equal(resolverObservation({ downloadUrl: 'http://ztools.zosen.link/one.zip' }).status, 'resolver_url_rejected');
assert.equal(resolverObservation({ downloadUrl: `https://ztools.zosen.link/${'a'.repeat(3000)}.zip` }).status, 'resolver_url_needs_review');
assert.equal(resolverObservation({ zpxDownloadUrl: 'opaque' }).status, 'zpx_only_not_inspected');
assert.equal(resolverObservation({ downloadUrl: url('one') }).status, 'official_zip_url_advertised');
assert.equal(sourceFailure(new SyntaxError('bad catalog'), 'catalog').status, 'invalid_catalog_payload');
const malformed = await resolveSourceRows([{ id: 'bad-json' }], async (_url, trace) => {
  trace.push({ status: 200 });
  return JSON.parse('{');
});
assert.equal(malformed[0].status, 'invalid_resolver_payload');
assert.equal(malformed[0].http[0].status, 200, 'Malformed JSON retains the successful HTTP evidence');

let active = 0, maximum = 0, requests = 0;
const rows = Array.from({ length: 12 }, (_, i) => ({ id: i === 11 ? 'one' : String(i), localVersion: '1', directory: String(i) }));
rows[0].id = 'one';
const result = await resolveSourceRows(rows, async resolver => {
  requests++; active++; maximum = Math.max(maximum, active);
  await new Promise(resolve => setTimeout(resolve, 2)); active--;
  const id = new URL(resolver).searchParams.get('name');
  if (id === '2') throw Error('HTTP 503');
  return { downloadUrl: url(id) };
}, { catalog });
assert.equal(requests, 11, 'Duplicate manifest IDs share one resolver request');
assert.ok(maximum <= SOURCE_LIMITS.concurrency);
assert.equal(result.length, rows.length);
assert.equal(result[0].catalogVersionRelation, 'different_from_local');
assert.equal(result[2].status, 'http_or_source_unavailable');
assert.equal(result[11].downloadUrl, result[0].downloadUrl);
let expiredRequests = 0;
const expired = await resolveSourceRows(rows, async () => { expiredRequests++; }, { deadlineAt: 1, now: () => 2 });
assert.equal(expiredRequests, 0);
assert.ok(expired.every(row => row.status === 'not_requested_due_to_audit_deadline'));
console.log('Published-source metadata tests passed: exact cohort, manifest IDs, business errors, official URLs, bounded concurrency, duplicate requests and deadline; no network or plugin execution.');
