import assert from 'node:assert/strict';
import test from 'node:test';
import { validateUpdaterResources, UPDATER_COMMIT } from './ztools-updater-browser-identity.mjs';

function evidence() {
  const resources = [{ path: 'updater.html', bytes: 10, sha256: 'a'.repeat(64) },
    { path: 'assets/app.js', bytes: 100, sha256: 'b'.repeat(64) }];
  const bundle = { resources, totalResourceBytes: 110, totalJavaScriptBytes: 100 };
  const provenance = { schemaVersion: 1, owner: 'atools', role: 'original-updater', sourceCommit: UPDATER_COMMIT, nodeVersion: 'v22.23.3', bundle,
    budget: { passed: true, javascript: { baselineBytes: 104330, maxIncreaseBytes: 16384, maxBytes: 120714 },
      resources: { baselineBytes: 284598, maxIncreaseBytes: 16384, maxBytes: 300982 } }, typeChecks: [{ success: true, exitCode: 0 }] };
  const receipt = { passed: true, published: true, output: 'dist-ztools-updater', bundle };
  const files = Object.fromEntries(resources.map(f => [f.path, { bytes: f.bytes, sha256: f.sha256 }]));
  for (const path of ['ZTools-LICENSE', 'build-provenance.json', 'source-manifest.json']) files[path] = { bytes: 1, sha256: 'c'.repeat(64) };
  return { receipt, provenance, files };
}
test('updater preflight binds every actual emitted resource and both fixed policy caps', () => {
  const e = evidence();
  assert.deepEqual(validateUpdaterResources(e.receipt, e.provenance, e.files), ['assets/app.js', 'updater.html']);
  for (const mutate of [
    e => e.files['assets/app.js'].sha256 = 'd'.repeat(64),
    e => delete e.files['assets/app.js'],
    e => e.files['extra.js'] = { bytes: 1, sha256: 'a'.repeat(64) },
    e => e.receipt.published = false,
    e => e.provenance.role = 'original-main',
    e => e.provenance.sourceCommit = '0'.repeat(40),
    e => e.provenance.bundle.totalResourceBytes++,
    e => e.provenance.budget.resources.maxBytes++,
    e => e.provenance.typeChecks[0].exitCode = 1,
  ]) {
    const bad = evidence(); mutate(bad);
    assert.throws(() => validateUpdaterResources(bad.receipt, bad.provenance, bad.files));
  }
});
test('same-size over-budget bytes cannot pass a resource/provenance/receipt-consistent packet', () => {
  for (const kind of ['javascript', 'resources']) {
    const e = evidence(), item = e.provenance.bundle.resources[1];
    if (kind === 'javascript') {
      item.bytes = 120715; e.files[item.path].bytes = item.bytes;
      e.provenance.bundle.totalJavaScriptBytes = item.bytes;
      e.provenance.bundle.totalResourceBytes = item.bytes + 10;
    } else {
      const css = { path: 'assets/app.css', bytes: 300873, sha256: 'e'.repeat(64) };
      e.provenance.bundle.resources.push(css);
      e.files[css.path] = { bytes: css.bytes, sha256: css.sha256 };
      e.provenance.bundle.totalResourceBytes = 300983;
    }
    assert.throws(() => validateUpdaterResources(e.receipt, e.provenance, e.files));
  }
});
