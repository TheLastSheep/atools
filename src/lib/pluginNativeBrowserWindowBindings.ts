import type { PluginHostedDocumentLease } from "./pluginHostedIpcRouter";
import type { PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";

type ResourceLease = { prepare?: () => Promise<{ sessionId: string; pluginRoot: string; instanceId: string }> };
type NativeInvoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
type Entry = {
  sourceBindingId: string;
  lease: PluginHostedDocumentLease;
  pluginId: string;
  instanceId: string;
  resourceSessionId: string;
  pluginRoot: string;
  revoked: boolean;
  unbind: () => void;
  intents: Set<string>;
  windows: Set<string>;
  revoking?: Promise<void>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE_BINDING = /^[0-9a-f]{64}$/;
const failure = (code: string) => Error(`ERR_ATOOLS_NATIVE_BROWSER_WINDOW_${code}`);

function sameDocument(a: PluginHostedDocumentLease, b: PluginHostedDocumentLease) {
  const left = a.identity, right = b.identity;
  return a.source === b.source && a.documentNonce === b.documentNonce && a.pageDocumentId === b.pageDocumentId
    && left.kind === right.kind && left.generation === right.generation
    && (left.kind !== "child" || (right.kind === "child" && left.windowId === right.windowId));
}

/** Lazily binds authenticated hosted documents and revokes their native windows on replacement. */
export function createPluginNativeBrowserWindowBindings(options: {
  pluginId: () => string;
  resources: () => ResourceLease | undefined;
  invoke: NativeInvoke;
  sources: PluginFrameSourceRegistry;
  onRevoked: (entry: Entry) => Promise<void> | void;
}) {
  const entriesBySource = new Map<unknown, Entry>();
  const openingBySource = new Map<unknown, { lease: PluginHostedDocumentLease; promise: Promise<Entry> }>();

  async function closeSourceBinding(sourceBindingId: string) {
    await options.invoke("close_plugin_window_source", { sourceBindingId }).catch(() => undefined);
  }

  function isEntryCurrent(entry: Entry) {
    try { entry.lease.assertCurrent(); return !entry.revoked; } catch { return false; }
  }

  async function ensure(lease: PluginHostedDocumentLease): Promise<Entry> {
    lease.assertCurrent();
    const existing = entriesBySource.get(lease.source);
    if (existing && !existing.revoked && sameDocument(existing.lease, lease)) return existing;
    if (existing) await revoke(existing);
    const pending = openingBySource.get(lease.source);
    if (pending && sameDocument(pending.lease, lease)) return pending.promise;

    const pluginId = options.pluginId().trim();
    if (!pluginId || pluginId.length > 256) throw failure("PLUGIN_ID");
    const resourceLease = options.resources();
    if (!resourceLease?.prepare) throw failure("RESOURCE_LEASE_UNAVAILABLE");
    const promise = (async () => {
      const resource = await resourceLease.prepare!();
      lease.assertCurrent();
      if (!UUID.test(resource.sessionId) || !UUID.test(resource.instanceId) || !resource.pluginRoot) throw failure("RESOURCE_LEASE_INVALID");
      const frameId = lease.identity.kind === "main" ? "main" : `child:${lease.identity.windowId}`;
      const result = await options.invoke<{ sourceBindingId?: unknown }>("bind_plugin_window_source", {
        pluginId,
        instanceId: resource.instanceId,
        resourceSessionId: resource.sessionId,
        frameId,
        generation: lease.identity.generation,
        documentNonce: lease.documentNonce,
      });
      const sourceBindingId = result?.sourceBindingId;
      if (typeof sourceBindingId !== "string" || !SOURCE_BINDING.test(sourceBindingId)) throw failure("SOURCE_BINDING_INVALID");
      try { lease.assertCurrent(); }
      catch (error) { await closeSourceBinding(sourceBindingId); throw error; }
      const entry: Entry = { sourceBindingId, lease, pluginId, instanceId: resource.instanceId,
        resourceSessionId: resource.sessionId, pluginRoot: resource.pluginRoot,
        revoked: false, unbind: () => undefined, intents: new Set(), windows: new Set() };
      entry.unbind = options.sources.onFrameInvalidated(lease.source, lease.identity, () => { void revoke(entry); });
      try { lease.assertCurrent(); }
      catch (error) { entry.unbind(); await closeSourceBinding(sourceBindingId); throw error; }
      entriesBySource.set(lease.source, entry);
      return entry;
    })();
    openingBySource.set(lease.source, { lease, promise });
    try { return await promise; }
    finally { if (openingBySource.get(lease.source)?.promise === promise) openingBySource.delete(lease.source); }
  }

  async function revoke(entry: Entry) {
    if (entry.revoking) return entry.revoking;
    if (entry.revoked) return;
    entry.revoked = true;
    entry.unbind();
    entry.revoking = (async () => {
      await Promise.all([
        ...[...entry.intents].map(intentId => options.invoke("cancel_plugin_browser_window_intent", { intentId }).catch(() => undefined)),
      ]);
      await closeSourceBinding(entry.sourceBindingId);
      if (entriesBySource.get(entry.lease.source) === entry) entriesBySource.delete(entry.lease.source);
      entry.intents.clear();
      await options.onRevoked(entry);
    })();
    return entry.revoking;
  }

  function trackIntent(entry: Entry, intentId: string) {
    if (!isEntryCurrent(entry)) throw failure("SOURCE_STALE");
    entry.intents.add(intentId);
  }
  function finishIntent(entry: Entry, intentId: string) { entry.intents.delete(intentId); }
  function trackWindow(entry: Entry, windowId: string) { entry.windows.add(windowId); }
  function finishWindow(entry: Entry, windowId: string) { entry.windows.delete(windowId); }
  function closeAll() { return Promise.all([...entriesBySource.values()].map(revoke)).then(() => undefined); }

  return { ensure, revoke, isEntryCurrent, trackIntent, finishIntent, trackWindow, finishWindow, closeAll,
    entries: () => [...entriesBySource.values()] };
}

export type PluginNativeBrowserWindowBinding = Entry;
