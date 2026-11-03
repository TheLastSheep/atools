import { createRendererEventSubscriptions } from './eventSubscriptions';
import { denseEventArrayItem, denseEventArrayLength, safeEventRecord } from './safeEventRecord';
import { utf8ByteLength } from './utf8';
import type { RendererHostCommand, ZToolsRendererTransport } from './types';

const UUID = /^[0-9a-f]{32}$/;
const MAX_NOTICE_JSON_BYTES = 256 * 1024;
type FileItem = { path: string; name: string; isDirectory: boolean };
export type MainFileDropNotice = { phase: 'hover'; hovered: boolean } | { phase: 'drop'; files: FileItem[] } | { phase: 'error' };
type Rect = { x: number; y: number; width: number; height: number };
type Request = { op: 'context' } | { op: 'set'; contextId: string; leaseId: string | null; target: Rect | null };
const exact = (record: Record<string, unknown>, names: string[]) => Object.keys(record).length === names.length && names.every(k => Object.hasOwn(record, k));
const id = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

function parseNotice(value: unknown, lease: string): { seq: number; notice: MainFileDropNotice } | null {
  try {
    const r = safeEventRecord(value);
    if (r.version !== 1 || r.leaseId !== lease || !Number.isSafeInteger(r.sequence) || (r.sequence as number) < 1) return null;
    const seq = r.sequence as number;
    if (r.phase === 'hover' && exact(r, ['version','leaseId','sequence','phase','hovered']) && typeof r.hovered === 'boolean') return { seq, notice: { phase: 'hover', hovered: r.hovered } };
    if (r.phase === 'error' && exact(r, ['version','leaseId','sequence','phase','code']) && (r.code === 'INVALID_BATCH' || r.code === 'METADATA_FAILED')) return { seq, notice: { phase: 'error' } };
    if (r.phase !== 'drop' || !exact(r, ['version','leaseId','sequence','phase','files']) || !Array.isArray(r.files) || r.files.length < 1 || r.files.length > 64) return null;
    const files: FileItem[] = []; let total = 0; const seen = new Set<string>();
    const length = denseEventArrayLength(r.files, 64);
    for (let i = 0; i < length; i++) {
      const f = safeEventRecord(denseEventArrayItem(r.files, i));
      if (!exact(f, ['path','name','isDirectory']) || typeof f.path !== 'string' || typeof f.name !== 'string' || typeof f.isDirectory !== 'boolean') return null;
      const pathBytes = utf8ByteLength(f.path);
      const nameBytes = utf8ByteLength(f.name);
      if (!(/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(f.path)) || f.path.includes('\0') || f.name.includes('\0') || !f.name || pathBytes > 4096 || nameBytes > 1024 || seen.has(f.path)) return null;
      total += pathBytes; if (total > 65536) return null;
      seen.add(f.path); files.push({ path: f.path, name: f.name, isDirectory: f.isDirectory });
    }
    const encoded = JSON.stringify({ version: 1, leaseId: lease, sequence: seq, phase: 'drop', files });
    if (utf8ByteLength(encoded) > MAX_NOTICE_JSON_BYTES) return null;
    return { seq, notice: { phase: 'drop', files } };
  } catch { return null; }
}

export function createMainFileDrop(transport: ZToolsRendererTransport, invoke: (command: RendererHostCommand, args?: Record<string, unknown>) => Promise<unknown>) {
  let disposed = false; let current: (() => void) | undefined;
  let barrier: Promise<boolean> = Promise.resolve(true);
  let settingsBlocked = false, hiddenBlocked = false, hideGeneration = 0;
  let refresh: (() => void) | undefined;
  function bind(element: HTMLElement, callback: (notice: MainFileDropNotice) => void) {
    if (disposed) throw new Error('Renderer disposed');
    current?.();
    const prior = barrier;
    let resolveDone!: (clean: boolean) => void;
    const done = new Promise<boolean>(resolve => { resolveDone = resolve; });
    const events = createRendererEventSubscriptions(transport, 'renderer-main-file-drop');
    let active = false, desired = false, dead = false, busy = false, dirty = false, reset = false, ambiguous = false, epoch = 0;
    let lease: string | null = null, context: string | null = null, hoverSeq = 0, contentSeq = 0;
    const notify = (notice: MainFileDropNotice) => { try { callback(notice); } catch { /* Consumer errors cannot block native cleanup. */ } };
    let lastRect = '', awaitingLease = false, contentReady = false;
    let pendingHover: { lease: string; seq: number; notice: MainFileDropNotice } | undefined;
    let pendingContent: { lease: string; seq: number; notice: MainFileDropNotice } | undefined;
    function receive(value: unknown) {
      if (!active || dead) return;
      if (!lease && awaitingLease) {
        try {
          const candidate = safeEventRecord(value); if (!id(candidate.leaseId)) return;
          const item = parseNotice(value, candidate.leaseId); if (!item) return;
          const saved = { lease: candidate.leaseId, ...item };
          if (item.notice.phase === 'hover') { if (!pendingHover || item.seq > pendingHover.seq) pendingHover = saved; }
          else if (!pendingContent || item.seq > pendingContent.seq) pendingContent = saved;
        } catch { /* Invalid payloads are ignored. */ }
        return;
      }
      if (!lease) return;
      const parsed = parseNotice(value, lease); if (!parsed || !contentReady) return;
      if (parsed.notice.phase === 'hover') { if (parsed.seq <= hoverSeq) return; hoverSeq = parsed.seq; }
      else { if (parsed.seq <= contentSeq) return; contentSeq = parsed.seq; }
      notify(parsed.notice);
    }
    const unlisten = events.subscribe(receive);
    const call = (request: Request) => invoke('set_renderer_main_drop_target', { request });
    function rectangle(): Rect | null {
      const r = element.getBoundingClientRect();
      return [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.width > 0 && r.height > 0 ? { x:r.x, y:r.y, width:r.width, height:r.height } : null;
    }
    function schedule() { dirty = true; if (!busy) void run(); }
    async function run() {
      busy = true;
      while (dirty) {
        dirty = false; const generation = epoch;
        try {
          if (ambiguous) {
            if (dead) continue;
            const latest = safeEventRecord(await call({ op:'context' }));
            if (!exact(latest, ['contextId']) || !id(latest.contextId) || latest.contextId === context) continue;
            ambiguous = false; lease = null; context = null; reset = false; lastRect = '';
          }
          if (reset || !active || dead) {
            if (lease && context) {
              const cleared = safeEventRecord(await call({ op:'set', contextId:context, leaseId:lease, target:null }));
              if (!exact(cleared, ['leaseId']) || cleared.leaseId !== null) throw new Error('Invalid revoke');
            }
            lease = null; context = null; lastRect = ''; reset = false;
            if (active && !dead) dirty = true;
            continue;
          }
          if (!(await prior) || !(await events.ready()) || !active || dead || generation !== epoch) continue;
          if (!context) {
            const response = safeEventRecord(await call({ op:'context' }));
            if (!exact(response, ['contextId']) || !id(response.contextId)) throw new Error('Invalid context');
            if (!active || dead || generation !== epoch) continue;
            context = response.contextId;
          }
          const target = rectangle();
          if (!target) {
            contentReady = false;
            if (lease && context) {
              const cleared = safeEventRecord(await call({ op:'set', contextId:context, leaseId:lease, target:null }));
              if (!exact(cleared, ['leaseId']) || cleared.leaseId !== null) throw new Error('Invalid revoke');
              lease = null; context = null; lastRect = '';
            }
            continue;
          }
          const serialized = JSON.stringify(target); if (lease && serialized === lastRect) { contentReady = true; continue; }
          awaitingLease = !lease;
          if (awaitingLease) ambiguous = true;
          const response = safeEventRecord(await call({ op:'set', contextId:context, leaseId:lease, target }));
          awaitingLease = false;
          if (!exact(response, ['leaseId']) || !id(response.leaseId)) throw new Error('Invalid lease');
          lease = response.leaseId; ambiguous = false; lastRect = serialized;
          if (!active || dead || generation !== epoch) { reset = true; dirty = true; }
          else {
            // A queued resize keeps this generation and lease valid for already accepted notices.
            contentReady = true;
            for (const pending of [pendingHover, pendingContent]) if (pending?.lease === lease) {
              if (pending.notice.phase === 'hover') { if (pending.seq > hoverSeq) { hoverSeq = pending.seq; notify(pending.notice); } }
              else if (pending.seq > contentSeq) { contentSeq = pending.seq; notify(pending.notice); }
            }
          }
          pendingHover = undefined; pendingContent = undefined;
        } catch {
          awaitingLease = false; pendingHover = undefined; pendingContent = undefined; lastRect = ''; contentReady = false;
          if (lease && context) {
            try {
              const cleared = safeEventRecord(await call({ op:'set', contextId:context, leaseId:lease, target:null }));
              if (exact(cleared, ['leaseId']) && cleared.leaseId === null) { lease = null; context = null; reset = false; }
            } catch {
              try {
                if (dead) throw new Error('disposed');
                const latest = safeEventRecord(await call({ op:'context' }));
                if (exact(latest, ['contextId']) && id(latest.contextId) && latest.contextId !== context) {
                  lease = null; context = null; reset = false; if (active && !dead) dirty = true;
                }
              } catch { /* Preserve an unconfirmed owned lease. */ }
            }
          }
          if (!dead) { notify({phase:'hover',hovered:false}); notify({phase:'error'}); }
        }
      }
      busy = false;
      if (dead) { unlisten(); events.dispose(); resolveDone(lease === null && !ambiguous); }
    }
    const observer = new ResizeObserver(() => { if (active) schedule(); }); observer.observe(element);
    const onResize = () => { if (active) schedule(); }; window.addEventListener('resize', onResize); window.addEventListener('scroll', onResize, true);
    const onPageHide = () => dispose(); window.addEventListener('pagehide', onPageHide);
    function updateActive() {
      const value = desired && !settingsBlocked && !hiddenBlocked;
      if (dead || active === value) return;
      active = value; epoch++; if (!value) { reset = true; contentReady = false; } hoverSeq = 0; contentSeq = 0;
      if (!value) notify({phase:'hover', hovered:false});
      schedule();
    }
    function setActive(value: boolean) { desired = value; updateActive(); }
    refresh = updateActive;
    function dispose() {
      if (dead) return; dead = true; active = false; contentReady = false; reset = true; epoch++;
      barrier = done;
      observer.disconnect(); window.removeEventListener('resize', onResize); window.removeEventListener('scroll', onResize, true); window.removeEventListener('pagehide', onPageHide);
      schedule(); if (current === dispose) { current = undefined; refresh = undefined; }
    }
    current = dispose;
    return { setActive, dispose };
  }
  return {
    bind,
    settingsBlocked(value: boolean) { if (!disposed && settingsBlocked !== value) { settingsBlocked = value; refresh?.(); } },
    pauseForHide() {
      const generation = ++hideGeneration; hiddenBlocked = true; refresh?.();
      return () => { if (!disposed && hideGeneration === generation && hiddenBlocked) { hiddenBlocked = false; refresh?.(); } };
    },
    onFocus() { hideGeneration++; if (!disposed && hiddenBlocked) { hiddenBlocked = false; refresh?.(); } },
    dispose() { disposed = true; hideGeneration++; current?.(); },
  };
}
