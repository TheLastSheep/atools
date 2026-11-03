/** Host-only observer injected around complete original source, never editing it. */
export function mainPushBrowserObservation(owner: string) {
  const identity = crypto.randomUUID();
  const probe = { identity, owner, queries: [] as unknown[], enters: [] as unknown[], selections: [] as unknown[], registrations: [] as unknown[] };
  const originalDocument = document, originalWindow = window;
  const callbackIds = new WeakMap<Function, string>();
  const callbackId = (value: Function) => { let id = callbackIds.get(value); if (!id) { id = crypto.randomUUID(); callbackIds.set(value, id); } return id; };
  function report(stage: string) {
    parent.postMessage({ __mainPushFixtureObservation: true, stage, ...probe,
      sameDocument: document === originalDocument, sameWindow: window === originalWindow,
      visible: document.visibilityState, focused: document.hasFocus(), textareaValues: Array.from(document.querySelectorAll('textarea')).map(node => node.value) }, '*');
  }
  const api = (window as unknown as { ztools: Record<string, (...args: unknown[]) => unknown> }).ztools;
  const onMainPush = api.onMainPush, onPluginEnter = api.onPluginEnter;
  api.onMainPush = (query, select) => {
    probe.registrations.push({ kind: 'mainPush', hasSelect: typeof select === 'function', callbackIdentity: callbackId(query as Function) }); report('register');
    return onMainPush((...args: unknown[]) => { probe.queries.push(args[0]); report('query'); return (query as Function)(...args); },
      typeof select === 'function' ? (...args: unknown[]) => { probe.selections.push(args[0]); report('select'); return select(...args); } : undefined);
  };
  api.onPluginEnter = callback => {
    probe.registrations.push({ kind: 'enter', callbackIdentity: callbackId(callback as Function) });
    return onPluginEnter((...args: unknown[]) => {
      probe.enters.push(args[0]); report('enter'); const result = (callback as Function)(...args);
      setTimeout(() => report('after-enter'), 30); return result;
    });
  };
  window.addEventListener('atools-main-push-promote', () => { report('promote'); setTimeout(() => report('after-promote'), 80); });
  report('boot');
}
