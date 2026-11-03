/** Browser-only FakeNative ports at the real Tauri JS API boundary. No production bridge replacement. */
export function installUpdaterBrowserFixture(options) {
  const ownerId = options.windowId;
  Object.defineProperty(window, '__ATOOLS_UPDATER_WINDOW_ID__', { value: ownerId });
  let sequence = 1, current = options.snapshot, appearance = options.appearance, nextId = 0;
  const callbacks = new Map(), listeners = new Map(), actions = [], calls = [], errors = [], tracking = [];
  const clone = value => JSON.parse(JSON.stringify(value));
  const originalAdd = EventTarget.prototype.addEventListener, originalRemove = EventTarget.prototype.removeEventListener;
  const capture = value => typeof value === 'boolean' ? value : !!value?.capture;
  function owned(target, type, opts) {
    if (type === 'change' && target instanceof MediaQueryList) return 'media';
    if (type === 'pagehide' && target === window) return 'pagehide';
    if (target instanceof Element && target.matches('.update-window') &&
      (type === 'pointerdown' || ['click', 'auxclick'].includes(type) && capture(opts))) return 'dom';
    return null;
  }
  EventTarget.prototype.addEventListener = function(type, callback, opts) {
    const kind = owned(this, type, opts);
    if (kind) tracking.push({ target: this, type, callback, capture: capture(opts), kind, active: true });
    return originalAdd.call(this, type, callback, opts);
  };
  EventTarget.prototype.removeEventListener = function(type, callback, opts) {
    for (const item of tracking) if (item.target === this && item.type === type && item.callback === callback && item.capture === capture(opts)) item.active = false;
    return originalRemove.call(this, type, callback, opts);
  };
  const busy = () => !!current.operationId || ['downloading', 'installing', 'restarting'].includes(current.phase);
  const reject = message => Promise.reject({ code: 'fixture_rejected', message });
  window.__TAURI_INTERNALS__ = {
    transformCallback(callback) { const id = ++nextId; callbacks.set(id, callback); return id; },
    async invoke(command, args) {
      calls.push(clone({ command, args }));
      if (command === 'plugin:event|listen') {
        if (!['renderer-updater-state', 'renderer-updater-appearance'].includes(args.event) ||
          args.target?.kind !== 'Webview' || args.target.label !== `renderer-updater-${ownerId}`) return reject('Wrong event target');
        const id = ++nextId; listeners.set(id, { ...args }); return id;
      }
      if (command === 'plugin:event|unlisten') { listeners.delete(args.eventId); return; }
      if (command !== 'renderer_updater_window') return reject('Unknown command');
      const r = args.request;
      if (r.windowId !== ownerId) return reject('Wrong window ID');
      if (r.op === 'ready' || r.op === 'status') return clone(current);
      if (r.op === 'appearance') return clone(appearance);
      if (r.op === 'close') return busy() ? reject('Busy') : { closed: true };
      if (r.op === 'drag') return { started: true };
      if (r.op === 'open-link') {
        const url = new URL(r.href);
        if (!current.candidate || r.candidateId !== current.candidate.candidateId ||
          !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          /[\u0000-\u001f\u007f]/.test(r.href) || new TextEncoder().encode(r.href).length > 8192) return reject('Invalid link');
        return { opened: true };
      }
      if (r.op === 'start' || r.op === 'install-downloaded') {
        if (busy() || !current.candidate || current.candidate.candidateId !== r.candidateId || actions.length) return reject('Stale or busy confirmation');
        return new Promise((resolve, fail) => actions.push({ resolve, fail, candidateId: r.candidateId }));
      }
      return reject('Unknown operation');
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener(_event, id) {
    const item = listeners.get(id); if (item) callbacks.delete(item.handler);
  } };
  function emit(event, payload) {
    for (const [id, item] of [...listeners]) if (item.event === event) callbacks.get(item.handler)?.({ event, id, payload: clone(payload) });
  }
  originalAdd.call(window, 'unhandledrejection', event => errors.push(String(event.reason)));
  originalAdd.call(window, 'error', event => errors.push(event.message));
  Object.defineProperty(window, '__UPDATER_BROWSER_FIXTURE__', { value: {
    publish(patch) { sequence = Math.max(sequence, current.sequence) + 1; current = { ...current, sequence, ...clone(patch) }; emit('renderer-updater-state', { windowId: ownerId, snapshot: current }); return clone(current); },
    emitSnapshot(snapshot, windowId = ownerId) { emit('renderer-updater-state', { windowId, snapshot }); },
    appearance(patch) { appearance = { ...appearance, sequence: appearance.sequence + 1, ...clone(patch) }; emit('renderer-updater-appearance', appearance); },
    complete(reply = current) { if (!actions.length) throw Error('No pending FakeNative operation'); actions.shift().resolve(clone(reply)); },
    fail(message = 'Synthetic install failed') { if (!actions.length) throw Error('No pending FakeNative operation'); actions.shift().fail({ code: 'install_unknown', message }); },
    snapshot() { return { state: clone(current), appearance: clone(appearance), calls: clone(calls), pending: actions.length,
      nativeListeners: listeners.size, callbacks: callbacks.size, ownedListeners: Object.fromEntries(['dom', 'media', 'pagehide'].map(kind => [kind, tracking.filter(x => x.active && x.kind === kind).length])), errors: [...errors] }; },
  } });
}

export function updaterFixtureState(windowId, candidateId, body = '# Release\n\n**Safe** [release](https://example.com/release)') {
  return {
    windowId,
    snapshot: { version: 1, sequence: 1, phase: 'available', checked: true, operationId: null,
      candidate: { candidateId, currentVersion: '3.0.0', version: '3.0.1', date: null, body },
      progress: { downloaded: 0, total: null }, error: null },
    appearance: { windowId, sequence: 1, platform: 'win32', material: 'acrylic', nativeMaterial: 'none',
      materialApplied: false, theme: 'system', effectiveTheme: 'light', opacity: 0.9, opacityApplied: false,
      acrylicOpacity: { light: 57, dark: 42 }, error: null },
  };
}

export function updaterBrowserBootstrap(options) {
  return `(${installUpdaterBrowserFixture.toString()})(${JSON.stringify(options)})`;
}
