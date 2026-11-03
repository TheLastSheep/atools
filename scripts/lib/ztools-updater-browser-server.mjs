import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { sha256 } from '../../packages/ztools-build/pinned-inputs.mjs';

/** Only immutable receipt-bound updater assets and observable local tripwires. No build/dev server. */
export async function startUpdaterBrowserServer({ distRoot, identity }) {
  const root = await realpath(distRoot), assets = new Map();
  for (const path of identity.servedPaths) {
    const bytes = await readFile(join(root, path));
    assert.equal(sha256(bytes), identity.files[path].sha256);
    assets.set('/' + path, bytes);
  }
  const state = { requests: [], tripwires: [], rejected: [], closed: false };
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
  let origin, activeWindow = null;
  const server = createServer((request, response) => {
    const path = request.url;
    state.requests.push({ path, method: request.method });
    if (request.headers.host !== new URL(origin).host || request.method !== 'GET') {
      state.rejected.push(path); response.writeHead(403); response.end(); return;
    }
    if (path.startsWith('/tripwire/')) {
      state.tripwires.push(path); response.writeHead(204); response.end(); return;
    }
    if (path === '/favicon.ico') { response.writeHead(204); response.end(); return; }
    const prefix = activeWindow && '/' + activeWindow;
    const bytes = prefix && path.startsWith(prefix + '/') ? assets.get(path.slice(prefix.length)) : null;
    if (!bytes) { state.rejected.push(path); response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': types[extname(path)], 'content-length': bytes.length,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    response.end(bytes);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.equal(address.address, '127.0.0.1');
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, state, activateWindow(id) { assert.match(id, /^[0-9a-f]{32}$/); activeWindow = id; }, async close() {
    if (state.closed) return;
    server.closeAllConnections?.();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    state.closed = true;
  } };
}
