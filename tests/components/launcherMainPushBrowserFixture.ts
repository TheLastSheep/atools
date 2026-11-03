import App from '../../src/App.svelte';
import '../../src/components/PluginPanel.svelte';
import '../../src/components/SettingsPanel.svelte';
import { mount, unmount, tick, flushSync } from 'svelte';
import { mockIPC, mockWindows, mockConvertFileSrc } from '@tauri-apps/api/mocks';
import type { FeatureAction, SearchResult } from '../../src/lib/types';
import type { MainPushCandidate } from '../../src/lib/pluginMainPushProtocol';
import { mainPushBrowserObservation } from './main-push-browser-observation';

const originals = import.meta.glob('/ZTools-plugins/plugins/{calculation-paper,bookmarks}/**/*.{html,js,json,css,svg}',
  { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const workspace = new URL(location.href).searchParams.get('workspace') || '';
if (!workspace.startsWith('/') || workspace.includes('..') || workspace.endsWith('/')) throw Error('Absolute fixture workspace required');
const root = `${workspace}/ZTools-plugins/plugins/`;
type Internals = { runCallback: (id: number, payload: unknown) => void };
type NodeRequest = (command: string, args?: unknown) => Promise<any>;
const nodeRequest: NodeRequest = (command, args) => (window as unknown as { __mainPushNodeHostRequest: NodeRequest }).__mainPushNodeHostRequest(command, args);
const calls: Array<{ command: string; args: Record<string, any> }> = [];
const listeners = new Map<number, { event: string; handler: number }>();
type FixtureRun = { id: string; capabilityId: string; initiator: { type: string; clientId: string }; status: string; input: Record<string, any>; output: Record<string, any> };
type Pending = { ticket: string; operation: string; candidate: MainPushCandidate; run: FixtureRun; receipt?: Record<string, any>;
  resolve: (value: unknown) => void; held: boolean; permission: boolean; timer?: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pending>();
const taskRuns = new Map<string, FixtureRun>(), admissions = new Map<string, FixtureRun>();
const pipeline: Array<{ stage: string; requestId: string; runnerId: string; operation: string; status: string }> = [];
let holdNextPrepare = false, permissionNextPrepare = false;
const digest = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
const capabilities = Object.fromEntries(await Promise.all(['calculation-paper', 'bookmarks', 'fixture-main-push'].map(async id => [id, 'plugin_main_push_' + await digest(id)])));
const revisions = Object.fromEntries(await Promise.all(['calculation-paper', 'bookmarks', 'fixture-main-push'].map(async id => [id,
  await digest(Object.entries(originals).filter(([path]) => path.startsWith('/ZTools-plugins/plugins/' + id + '/')).sort().map(([path, source]) => path + '\n' + source).join('\n') || 'fixed-contract-page-v2')])));
const leases = new Map<string, string>();
const observations: Array<Record<string, any>> = [];
const rejected: string[] = [];
const sink: unknown[] = [];
const events: Array<{ type: string; trusted: boolean; target: string }> = [];
let sequence = 0, app: ReturnType<typeof mount> | undefined;
let config: { appData: string; home: string };
for (const type of ['pointerdown', 'keydown', 'beforeinput', 'input']) document.addEventListener(type, event => {
  const target = event.target as Element; events.push({ type, trusted: event.isTrusted, target: target?.getAttribute?.('data-atools-search-input') !== null ? 'main-search' : target?.tagName });
}, true);
window.addEventListener('message', event => {
  if (event.data?.__mainPushFixtureObservation !== true || event.origin !== 'null') return;
  if (!Array.from(document.querySelectorAll('iframe')).some(frame => frame.contentWindow === event.source)) return;
  observations.push(structuredClone(event.data));
});
function manifest(id: string) { return JSON.parse(originals[`/ZTools-plugins/plugins/${id}/plugin.json`]); }
function candidate(id: string, code: string, commandType: MainPushCandidate['commandType']): MainPushCandidate {
  const info = id === 'fixture-main-push' ? { title: '固定契约页', features: [{ code, explain: '固定 Promise / literal true' }] } : manifest(id);
  const feature = info.features.find((item: { code: string }) => item.code === code);
  if (!feature) throw Error('Original manifest code differs');
  const result: SearchResult = { code, plugin_id: id, plugin_name: info.title, label: feature.explain, explain: feature.explain, icon: null, score: 100, match_type: commandType };
  return { pluginId: id, featureCode: code, commandType, codeRevision: revisions[id], result };
}
function candidates(query: string): MainPushCandidate[] {
  if (/^\d+\+\d+$/.test(query)) return [candidate('calculation-paper', 'expression', 'regex')];
  if (/^\d+(?:\s+\d+)+$/.test(query)) return [candidate('calculation-paper', 'sum', 'regex'), candidate('calculation-paper', 'average', 'regex')];
  if (query === 'Promise fixture') return [candidate('fixture-main-push', 'promise', 'over')];
  if (/^Fixed(?:\s+(?:Edge|Chrome))?$/.test(query)) return [candidate('bookmarks', 'search', 'over')];
  return [];
}
function action(value: MainPushCandidate, payload: unknown = null): FeatureAction {
  const info = value.pluginId === 'fixture-main-push' ? { main: 'index.html' } : manifest(value.pluginId);
  const pluginPath = value.pluginId === 'fixture-main-push' ? `${workspace}/tests/fixtures/main-push-contract` : root + value.pluginId;
  return { plugin_id: value.pluginId, plugin_name: value.result.plugin_name, feature_code: value.featureCode, feature_label: value.result.label,
    main_url: info.main || '', plugin_path: pluginPath, ...(info.preload ? { preload_path: pluginPath + '/' + info.preload } : {}),
    plugin_permissions: [], expand_height: 500, payload: payload as string | null, entry_type: value.commandType };
}
function observer(id: string) { return `(${mainPushBrowserObservation.toString()})(${JSON.stringify(id)});`; }
function contractHtml() { return `<!doctype html><html><head></head><body><input id="startup-autofocus"><script>
${observer('fixture-main-push')}
window.focus();document.getElementById('startup-autofocus').focus();
window.ztools.onMainPush(action=>Promise.resolve({type:'list',data:[{text:'Fixed Promise result',description:'original option',id:'fixed-private-option'}]}),action=>{window.__fixedSelected=action;return true});
window.ztools.onPluginEnter(action=>{window.__fixedEntered=action});
<\/script></body></html>`; }
function readOriginal(path: unknown) {
  if (typeof path !== 'string') throw Error('Fixture read requires path');
  if (path === `${workspace}/tests/fixtures/main-push-contract/index.html`) return contractHtml();
  if (!path.startsWith(root) || path.slice(root.length).split('/').some(part => part === '..' || part === '.')) throw Error('Original read outside fixed packages');
  const relative = path.slice(root.length); if (!/^(?:calculation-paper|bookmarks)\//.test(relative)) throw Error('Original owner mismatch');
  const value = originals['/ZTools-plugins/plugins/' + relative];
  if (typeof value !== 'string') throw Object.assign(Error('Original text not found: ' + relative), { code: 'ENOENT' });
  return value;
}
function emit(event: string, payload: unknown) {
  for (const [eventId, listener] of listeners) if (listener.event === event)
    (window as unknown as { __TAURI_INTERNALS__: Internals }).__TAURI_INTERNALS__.runCallback(listener.handler, { event, id: eventId, payload });
}
function record(stage: string, entry: Pending) { pipeline.push({ stage, requestId: entry.run.input.requestId, runnerId: entry.run.input.runnerId, operation: entry.operation, status: entry.run.status }); }
function dispatch(entry: Pending) {
  entry.run.status = 'running'; record('dispatched', entry);
  const input = entry.run.input;
  emit('plugin-main-push-dispatch', { requestId: input.requestId, ticket: entry.ticket, runnerId: input.runnerId,
    operation: entry.operation, candidate: entry.candidate, action: action(entry.candidate) });
}
function commit(entry: Pending) {
  if (!entry.receipt || pending.get(entry.run.input.requestId) !== entry) return;
  clearTimeout(entry.timer);
  entry.run.status = entry.receipt.outcome === 'failed' ? 'failed' : entry.receipt.outcome === 'superseded' ? 'cancelled' : 'succeeded';
  entry.run.output = { pluginId: entry.candidate.pluginId, featureCode: entry.candidate.featureCode, operation: entry.operation,
    outcome: entry.receipt.outcome, rowCount: entry.receipt.rowCount, durationMs: entry.receipt.durationMs, runtime: 'plugin-main-push' };
  if (entry.operation === 'prepare' && entry.run.status === 'succeeded' && entry.receipt.outcome === 'ready') admissions.set(entry.run.input.runnerId, entry.run);
  record('durable-commit', entry); pending.delete(entry.run.input.requestId);
  entry.resolve({ ...entry.run.output, runId: entry.run.id, status: entry.run.status });
}
function cancel(requestId: string) {
  const entry = pending.get(requestId); if (!entry) return;
  clearTimeout(entry.timer); entry.run.status = 'cancelled'; record('cancelled', entry); pending.delete(requestId);
  entry.resolve({ runId: entry.run.id, status: 'cancelled' });
}
export function deferNextPrepareCommit(permissionRequired = false) { holdNextPrepare = true; permissionNextPrepare = permissionRequired; }
export function releasePrepareCommits() { for (const entry of pending.values()) if (entry.operation === 'prepare' && entry.held) { entry.held = false; if (entry.receipt) commit(entry); } }
export function grantFixturePreparePermission() { for (const entry of pending.values()) if (entry.permission && entry.run.status === 'awaiting_permission') dispatch(entry); }
mockWindows('main'); mockConvertFileSrc('windows'); // HTTP custom-protocol URLs are fulfilled from pinned package bytes by the driver.
mockIPC(async (command, raw = {}) => {
  const args = raw as Record<string, any>; calls.push({ command, args });
  if (command === 'plugin:event|listen') { const id = ++sequence; listeners.set(id, { event: args.event, handler: args.handler }); return id; }
  if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
  if (command === 'get_setting') return JSON.stringify({ localAppSearch: false, autoPaste: 'never', showRecentInSearch: true });
  if (command === 'feature_catalog') return ['expression', 'sum', 'average'].map(code => candidate('calculation-paper', code, 'regex').result).concat(candidate('bookmarks', 'search', 'over').result);
  if (['search_features', 'search_local_apps', 'list_pending_agent_requests'].includes(command)) return [];
  if (command === 'search_plugin_main_push_candidates') return candidates(args.query);
  if (command === 'get_task_run') { const run = taskRuns.get(args.id); if (!run) throw Error('Unknown fixture TaskRun'); return structuredClone(run); }
  if (command === 'run_plugin_main_push') {
    const value = candidate(args.pluginId, args.featureCode, args.commandType);
    if (value.codeRevision !== args.codeRevision) throw Error('MainPush fixture owner/revision mismatch');
    if (Object.keys(args).some(key => ['payload', 'query', 'option', 'url', 'browser'].includes(key))) throw Error('MainPush native received raw data');
    if (args.operation !== 'prepare') {
      const admission = admissions.get(args.runnerId);
      if (!admission || admission.status !== 'succeeded' || admission.output.outcome !== 'ready'
        || ['pluginId', 'featureCode', 'commandType', 'codeRevision'].some(key => admission.input[key] !== args[key])) {
        pipeline.push({ stage: 'admission-rejected', requestId: args.requestId, runnerId: args.runnerId, operation: args.operation, status: 'failed' });
        throw Error('Prepare TaskRun must be durably succeeded before query/select admission');
      }
    }
    const ticket = crypto.randomUUID();
    const permission = args.operation === 'prepare' && permissionNextPrepare, held = args.operation === 'prepare' && holdNextPrepare;
    if (args.operation === 'prepare') { permissionNextPrepare = false; holdNextPrepare = false; }
    const run: FixtureRun = { id: crypto.randomUUID(), capabilityId: capabilities[args.pluginId], initiator: { type: 'human', clientId: 'atools-ui' },
      input: structuredClone(args), output: {}, status: permission ? 'awaiting_permission' : 'running' };
    taskRuns.set(run.id, run);
    const result = new Promise(resolve => {
      const entry: Pending = { ticket, operation: args.operation, candidate: value, run, resolve, held, permission };
      pending.set(args.requestId, entry); record('started', entry); if (!permission) dispatch(entry);
    });
    return permission ? { permission_required: true, runId: run.id, status: 'awaiting_permission', tool: run.capabilityId } : result;
  }
  if (command === 'complete_plugin_main_push') {
    const entry = pending.get(args.requestId); if (!entry || entry.ticket !== args.ticket || entry.receipt) throw Error('Unknown or duplicate MainPush receipt');
    if (Object.keys(args).some(key => !['ticket', 'requestId', 'outcome', 'rowCount', 'durationMs'].includes(key))) throw Error('MainPush receipt contains raw result');
    const allowed = entry.operation === 'prepare' ? ['ready', 'failed', 'superseded'] : entry.operation === 'query' ? ['handled', 'empty', 'failed', 'superseded'] : ['handled', 'enter', 'failed', 'superseded'];
    if (!allowed.includes(args.outcome) || !Number.isSafeInteger(args.rowCount) || args.rowCount < 0 || args.rowCount > 20
      || !Number.isSafeInteger(args.durationMs) || args.durationMs < 0 || args.durationMs > 3600000
      || entry.operation !== 'query' && args.rowCount !== 0) throw Error('MainPush receipt operation/metadata rejected');
    entry.receipt = structuredClone(args); record('receipt-accepted', entry);
    // A one-shot receipt acknowledgement does not imply durable TaskRun success.
    if (!entry.held) entry.timer = setTimeout(() => commit(entry), 20);
    return null;
  }
  if (command === 'cancel_plugin_main_push') { cancel(args.requestId); return null; }
  if (command === 'close_plugin_main_push_runner') {
    admissions.delete(args.runnerId); for (const [id, entry] of pending) if (entry.run.input.runnerId === args.runnerId) cancel(id);
    return null;
  }
  if (command === 'set_plugin_main_push_waiting') return;
  if (command === 'activate_feature') {
    const value = candidate(args.expectedPluginId, args.code, args.expectedPluginId === 'bookmarks' || args.expectedPluginId === 'fixture-main-push' ? 'over' : 'regex');
    return action(value, args.payload);
  }
  if (command === 'plugin:fs|read_text_file') {
    let text = readOriginal(args.path);
    if (String(args.path).endsWith('/calculation-paper/index.html')) text = text.replace('<script src="index.js">', `<script>${observer('calculation-paper')}<\/script><script src="index.js">`);
    return Array.from(new TextEncoder().encode(text));
  }
  if (command === 'read_plugin_preload_module') {
    if (args.pluginId !== 'bookmarks' || !String(args.modulePath).startsWith(root + 'bookmarks/')) throw Error('Preload owner mismatch');
    const source = readOriginal(args.modulePath);
    return String(args.modulePath).endsWith('/preload.js') ? observer('bookmarks') + '\n' + source : source;
  }
  if (command === 'plugin_legacy_node_usage') return { usage: 'not_detected', requiresNode: false, entryMode: null };
  if (['prepare_legacy_node', 'get_legacy_node_session', 'close_legacy_node'].includes(command)) return nodeRequest(command, args);
  if (command === 'prepare_plugin_paths' && args.pluginId === 'bookmarks' && args.access === 'standard') return { snapshotId: 'fixture-bookmarks-paths' };
  if (command === 'get_plugin_path_snapshot') return { access: 'standard', paths: { appData: config.appData, home: config.home } };
  if (['prepare_plugin_data', 'prepare_plugin_paths', 'prepare_plugin_dialogs', 'prepare_plugin_display', 'prepare_host_clipboard'].includes(command)) return { unavailable: true, usage: 'not_detected' };
  if (command === 'prepare_plugin_resources') { const sessionId = crypto.randomUUID(); leases.set(sessionId, args.pluginId); return { sessionId, pluginRoot: root + args.pluginId }; }
  if (command === 'close_plugin_resources') return;
  if (['close_plugin_data', 'close_plugin_paths', 'close_plugin_dialogs', 'close_host_clipboard', 'expand_window', 'reset_window', 'hide_main_window'].includes(command)) return;
  if (command === 'shell_open') { sink.push({ command, args }); return; }
  rejected.push(command); throw Error('MainPush fixture unauthorized IPC: ' + command);
});
export function resolveLeaseUrl(url: string) {
  const value = new URL(url); if (value.hostname !== 'atools-plugin.localhost') return null;
  const [session, ...segments] = value.pathname.slice(1).split('/').map(decodeURIComponent), owner = leases.get(session);
  if (!owner || segments.some(segment => !segment || /[\\/]/.test(segment) || segment === '.' || segment === '..')) return null;
  return root + owner + '/' + segments.join('/');
}
export async function mountFixture() {
  config = await nodeRequest('fixture_config', {}); localStorage.clear();
  app = mount(App, { target: document.getElementById('app')!, props: { backgroundServices: false } }); flushSync(); await tick();
}
export function snapshot() { return { calls, rejected, observations, sink, events, pipeline, taskRuns: Array.from(taskRuns.values()), pending: pending.size, listeners: listeners.size,
  sourceScope: 'Two complete unchanged original packages; only separate host observation wrapper injection. Native candidate/permissions/TaskRun/custom resource lease are service doubles.' }; }
export async function dispose() {
  if (app) { await unmount(app); app = undefined; } await tick();
  const deadline = performance.now() + 1500; while ((listeners.size || pending.size) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  return snapshot();
}
