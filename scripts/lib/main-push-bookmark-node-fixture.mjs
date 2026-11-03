import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { bookmarkNodePolicySource } from './main-push-bookmark-node-policy.mjs';
import { trackNativeDescendants } from './native-smoke-descendants.mjs';

/** A real system Node protocol process; native permissions remain an explicit double. */
export async function startBookmarkNodeFixture(root, environment, sink) {
  const plugin = join(root, 'ZTools-plugins/plugins/bookmarks');
  const preload = join(plugin, 'preload.js');
  const codec = await readFile(join(root, 'crates/atools-plugin/src/legacy_node/codec.cjs'), 'utf8');
  const bootstrap = await readFile(join(root, 'crates/atools-plugin/src/legacy_node/bootstrap.cjs'), 'utf8');
  // Bootstrap requires its own builtins before the fixture policy restricts the
  // plugin-facing createRequire; this is source assembly, never package mutation.
  const policy = bookmarkNodePolicySource({ root: environment.root, sink, preload });
  const marker = "const requireFromPlugin = Module.createRequire(process.env.ATOOLS_PRELOAD_ENTRY);";
  assert.equal(bootstrap.split(marker).length, 2, 'Reviewed bootstrap createRequire anchor');
  const source = codec + '\n' + bootstrap.replace(marker, policy + marker);
  const child = spawn(process.execPath, ['--max-old-space-size=128', '-e', source], {
    env: { ...environment.env, ATOOLS_PLUGIN_ID: 'bookmarks', ATOOLS_PLUGIN_DIR: plugin, ATOOLS_PRELOAD_ENTRY: preload },
    stdio: ['pipe', 'pipe', 'pipe'], detached: true,
  });
  const stopGroup = trackNativeDescendants(child, '');
  let sequence = 0, stderr = '', stopping;
  const pending = new Map(), sockets = new Set();
  const stats = { requests: 0, rejected: 0, methods: {} };
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-10000); });
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
  child.on('error', error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
  createInterface({ input: child.stdout }).on('line', line => {
    let response; try { response = JSON.parse(line); } catch { return; }
    const item = pending.get(response.id); if (!item) return;
    pending.delete(response.id); clearTimeout(item.timer);
    if (response.error) item.reject(Error(response.error.message)); else item.resolve(response.result);
  });
  function rpc(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('Bookmark Node timeout: ' + method + ': ' + stderr)); }, 5000);
      pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, jsonrpc: '2.0', method, params }) + '\n');
    });
  }
  const token = randomBytes(32).toString('hex');
  let host;
  const server = createServer(async (request, response) => {
    const allowed = request.headers.host === host && request.headers.origin === 'null' && request.url === '/node/' + token;
    if (!allowed) { stats.rejected++; response.writeHead(401); response.end(); return; }
    response.setHeader('Access-Control-Allow-Origin', 'null'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('Connection', 'close');
    if (request.method === 'OPTIONS') { response.end(); return; }
    if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
    const chunks = []; let bytes = 0;
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 1048576) { request.destroy(); return; } chunks.push(chunk); }
    try {
      const input = JSON.parse(Buffer.concat(chunks)); stats.requests++; stats.methods[input.method] = (stats.methods[input.method] || 0) + 1;
      response.end(JSON.stringify({ ok: true, result: await rpc(input.method, input.params) }));
    } catch (error) { response.end(JSON.stringify({ ok: false, error: { message: error.message } })); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  async function stop() {
    return stopping ||= (async () => {
      const closed = new Promise(resolve => server.close(resolve)); for (const socket of sockets) socket.destroy(); await closed;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Bookmark Node closed')); } pending.clear();
      await stopGroup(); child.kill('SIGKILL');
      let timer; try { await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Bookmark Node exit timeout')), 2000); })]); } finally { clearTimeout(timer); }
      return { listenerClosed: !server.listening, nodeProcessStopped: child.exitCode !== null || child.signalCode !== null, trackedProcessGroupCleanup: true };
    })();
  }
  try {
    const initialize = await rpc('initialize');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    host = '127.0.0.1:' + server.address().port;
    return { endpoint: `http://${host}/node/${token}`, initialize, stats, stop, rpc };
  } catch (error) { await stop(); throw error; }
}
