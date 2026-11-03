import { listen as listenTauriEvent } from "@tauri-apps/api/event";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import type { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
import type { createHostClipboardController } from "./hostClipboardController";

type Source = MessageEventSource;
type Unlisten = () => void;
type Subscription = {
  source: Source; identity: PluginFrameIdentity; nonce: string; instanceId: string; id: string;
  acknowledged: boolean; removeInvalidation: () => void;
};
const CHANGE_EVENT = "clipboard://history-projected";
const INVALIDATED_EVENT = "host-clipboard://invalidated";
const MAX_SUBSCRIPTIONS = 64;
const MAX_PER_FRAME = 16;

/** Parent-side fanout for committed clipboard history projections; no clipboard contents cross this channel. */
export function createPluginClipboardChangeHub(options: {
  sources: PluginFrameSourceRegistry;
  hostedIpc: ReturnType<typeof createPluginHostedIpcRouter>;
  controller: () => ReturnType<typeof createHostClipboardController> | undefined;
  pluginId: () => string;
  listen?: (event: string, receive: (event: { payload: unknown }) => void) => Promise<Unlisten>;
}) {
  const listen = options.listen ?? ((event: string, receive: (event: { payload: unknown }) => void) =>
    listenTauriEvent(event, value => receive({ payload: value.payload })));
  const subscriptions = new Map<string, Subscription>();
  let unlisteners: Unlisten[] = [], startPromise: Promise<void> | undefined;
  let listenerGeneration = 0, sequence = 0, coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let removeControllerInvalidation: (() => void) | undefined;

  function live(sub: Subscription) {
    const controller = options.controller();
    if (!controller || controller.instanceId !== sub.instanceId || !options.sources.isCurrent(sub.source, sub.identity)) return false;
    if (!controller.configuration().endpoints.history_read) return false;
    try { options.hostedIpc.captureDocumentLease({ source: sub.source, identity: sub.identity }, sub.nonce).assertCurrent(); return true; }
    catch { return false; }
  }
  function remove(sub: Subscription, notifyPage = false) {
    if (subscriptions.get(sub.id) !== sub) return;
    if (notifyPage) options.sources.reply(sub.source, sub.identity, { __atools_clipboard_change_response__: true,
      subscriptionId: sub.id, instanceId: sub.instanceId, documentNonce: sub.nonce, ok: false });
    subscriptions.delete(sub.id);
    sub.removeInvalidation();
    if (subscriptions.size === 0) stopListeners();
  }
  function clearAll(notifyPage = false) { for (const sub of [...subscriptions.values()]) remove(sub, notifyPage); }
  function stopListeners() {
    listenerGeneration++;
    const pending = startPromise;
    startPromise = undefined;
    for (const unlisten of unlisteners.splice(0)) { try { unlisten(); } catch {} }
    if (coalesceTimer !== undefined) clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    removeControllerInvalidation?.(); removeControllerInvalidation = undefined;
    void pending?.catch(() => undefined);
  }
  function observeController(controller: ReturnType<typeof createHostClipboardController>) {
    if (!controller || removeControllerInvalidation) return;
    removeControllerInvalidation = controller.onInvalidated(() => clearAll(true));
  }
  function startIsCurrent(generation: number, controller: ReturnType<typeof createHostClipboardController>) {
    return generation === listenerGeneration && subscriptions.size > 0 && options.controller() === controller
      && Boolean(controller.configuration().endpoints.history_read);
  }
  function startListeners(): Promise<void> {
    if (startPromise) return startPromise;
    const generation = ++listenerGeneration;
    const controller = options.controller();
    const handles: Unlisten[] = [];
    const pending = (async () => {
      try {
        const changeUnlisten = await listen(CHANGE_EVENT, () => scheduleFanout());
        handles.push(changeUnlisten);
        if (!controller || !startIsCurrent(generation, controller)) { for (const handle of handles.splice(0)) { try { handle(); } catch {} } return; }
        const invalidationUnlisten = await listen(INVALIDATED_EVENT, event => {
        const payload = event?.payload;
        const pluginId = payload && typeof payload === "object" ? (payload as Record<string, unknown>).pluginId : undefined;
        if (pluginId === null || pluginId === options.pluginId()) {
          const controller = options.controller();
          clearAll(true);
          void controller?.close();
        }
        });
        handles.push(invalidationUnlisten);
        if (!controller || !startIsCurrent(generation, controller)) { for (const handle of handles.splice(0)) { try { handle(); } catch {} } return; }
        unlisteners.push(...handles.splice(0));
      } catch (error) {
        for (const handle of handles.splice(0)) { try { handle(); } catch {} }
        if (generation === listenerGeneration) { startPromise = undefined; stopListeners(); }
        throw error;
      }
    })();
    startPromise = pending;
    return pending;
  }
  function scheduleFanout() {
    if (coalesceTimer !== undefined || subscriptions.size === 0) return;
    coalesceTimer = setTimeout(() => {
      coalesceTimer = undefined;
      if (sequence >= Number.MAX_SAFE_INTEGER) { clearAll(); return; }
      const currentSequence = ++sequence;
      for (const sub of [...subscriptions.values()]) {
        if (!sub.acknowledged) continue;
        if (!live(sub)) { remove(sub, true); continue; }
        options.sources.reply(sub.source, sub.identity, { __atools_clipboard_change_event__: true,
          subscriptionId: sub.id, instanceId: sub.instanceId, documentNonce: sub.nonce, sequence: currentSequence });
      }
    }, 25);
  }
  function dispatch(source: Source | null, identity: PluginFrameIdentity, data: Record<string, unknown>) {
    if (data.__atools_clipboard_change__ !== true) return false;
    const id = data.subscriptionId, instanceId = data.instanceId, nonce = data.documentNonce;
    const validShape = typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)
      && typeof instanceId === "string" && /^[0-9a-f-]{36}$/.test(instanceId)
      && typeof nonce === "string" && /^[0-9a-f]{32}$/.test(nonce) && !!source;
    const reply = (ok: boolean) => source && options.sources.reply(source, identity, {
      __atools_clipboard_change_response__: true, subscriptionId: typeof id === "string" ? id : "",
      instanceId: typeof instanceId === "string" ? instanceId : "", documentNonce: typeof nonce === "string" ? nonce : "", ok,
    });
    if (!validShape || !options.sources.isCurrent(source!, identity)) { reply(false); return true; }
    if (data.operation === "unsubscribe") {
      const existing = subscriptions.get(id as string);
      if (existing && existing.source === source && existing.instanceId === instanceId && existing.nonce === nonce
        && options.sources.isCurrent(source!, identity) && existing.identity.generation === identity.generation) remove(existing);
      reply(true); return true;
    }
    if (data.operation !== "subscribe" || subscriptions.has(id as string)) { reply(false); return true; }
    const controller = options.controller();
    const sameFrame = [...subscriptions.values()].filter(sub => sub.source === source && sub.identity.generation === identity.generation).length;
    if (!controller || controller.instanceId !== instanceId || !controller.configuration().endpoints.history_read
      || subscriptions.size >= MAX_SUBSCRIPTIONS || sameFrame >= MAX_PER_FRAME) { reply(false); return true; }
    try { options.hostedIpc.captureDocumentLease({ source: source!, identity }, nonce).assertCurrent(); }
    catch { reply(false); return true; }
    const sub: Subscription = { source: source!, identity, nonce: nonce as string, instanceId: instanceId as string,
      id: id as string, acknowledged: false, removeInvalidation: () => undefined };
    sub.removeInvalidation = options.sources.onFrameInvalidated(source!, identity, () => remove(sub));
    subscriptions.set(sub.id, sub);
    observeController(controller);
    if (subscriptions.get(sub.id) !== sub || !live(sub)) { remove(sub); reply(false); return true; }
    void startListeners().then(() => {
      if (!live(sub) || subscriptions.get(sub.id) !== sub) { remove(sub); reply(false); return; }
      sub.acknowledged = true;
      if (!reply(true)) remove(sub);
    }).catch(() => { remove(sub); reply(false); });
    return true;
  }
  function invalidateSource(source: unknown) {
    for (const sub of [...subscriptions.values()]) if (sub.source === source) remove(sub, true);
  }
  function close() { clearAll(); stopListeners(); }
  return { dispatch, invalidateSource, close, snapshot: () => ({ subscriptions: subscriptions.size, listening: unlisteners.length > 0 || !!startPromise }) };
}
