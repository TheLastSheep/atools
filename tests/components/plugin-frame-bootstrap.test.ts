import { MessageChannel as RealMessageChannel } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { createPluginFrameBootstrap, PLUGIN_DOCUMENT_HTML_MAX_BYTES } from "../../src/lib/pluginFrameBootstrap";
import { PluginFrameSourceRegistry, pluginDocumentEnvelope } from "../../src/lib/pluginFrameDocumentIdentity";

const ID = "a".repeat(32), NONCE = "b".repeat(32), ORIGIN = "atools-page://a.localhost", PARENT = "atools-panel://localhost";
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const settle = () => new Promise(resolve => setTimeout(resolve, 15));
async function until(read: () => boolean) {
  const end = Date.now() + 1000;
  while (!read()) { if (Date.now() > end) throw Error("Offline MessageChannel deadline"); await new Promise(resolve => setTimeout(resolve, 2)); }
}
function fixture(options: { claim?: () => Promise<unknown>; html?: string; timeoutMs?: number; deferBootstrapLoad?: boolean } = {}) {
  const sources = new PluginFrameSourceRegistry(), offers: unknown[] = [], payloads: unknown[] = [], errors: string[] = [];
  let peer: MessagePort | undefined, claims = 0, htmlReads = 0;
  const source = { postMessage(message: unknown, origin: string, ports: Transferable[]) {
    offers.push({ message, origin }); peer = ports[0] as MessagePort;
    peer.onmessage = event => payloads.push(event.data); peer.start();
  } };
  const reservation = sources.reserveDocument({ kind: "main", source, pageDocumentId: ID, expectedOrigin: ORIGIN, parentOrigin: PARENT });
  const bootstrap = createPluginFrameBootstrap({ sources, source, reservation, timeoutMs: options.timeoutMs ?? 500,
    claim: async () => { claims++; return options.claim?.(); }, getHtml: () => { htmlReads++; return options.html ?? "<p>actual payload</p>"; },
    onClosed: error => errors.push(error.message), createChannel: () => {
      const channel = new RealMessageChannel(); cleanup.push(() => { channel.port1.close(); channel.port2.close(); });
      return channel as unknown as MessageChannel;
    } });
  cleanup.push(() => bootstrap.close());
  if (!options.deferBootstrapLoad) bootstrap.handleLoad();
  const binding = { runId: ID, id: ID, docNonce: NONCE, generation: reservation.generation };
  const message = (data: unknown, changes = {}) => bootstrap.handleMessage({ source, origin: ORIGIN, data, ...changes } as unknown as MessageEvent);
  const hello = (changes = {}) => message({ kind: "atools-bootstrap-hello", ...binding, ...changes });
  const ack = (changes = {}) => peer!.postMessage({ kind: "atools-bootstrap-ack", ...binding, ...changes });
  const ready = (changes = {}) => message({ kind: "atools-bootstrap-payload-ready", ...binding,
    __atoolsDocument: { pageDocumentId: ID, docNonce: NONCE, generation: reservation.generation }, ...changes });
  return { sources, source, reservation, bootstrap, offers, payloads, errors, message, hello, ack, ready,
    get claims() { return claims; }, get htmlReads() { return htmlReads; } };
}

describe("real MessageChannel plugin bootstrap", () => {
  it("offers no HTML or authority, claims once after ACK, then accepts only bound payload ready", async () => {
    const f = fixture();
    expect(f.sources.identify(f.source)).toBeNull();
    expect(f.hello()).toBe(true); expect(f.hello()).toBe(false);
    expect(f.offers).toEqual([{ origin: ORIGIN, message: { kind: "atools-bootstrap-offer", runId: ID, id: ID,
      docNonce: NONCE, generation: f.reservation.generation } }]);
    expect(f.claims).toBe(0); expect(f.htmlReads).toBe(0);
    expect(f.ready()).toBe(false);
    f.ack(); f.ack();
    await until(() => f.payloads.length === 1);
    expect(f.claims).toBe(1); expect(f.htmlReads).toBe(1);
    expect(f.sources.identify(f.source)).toBeNull();
    expect(f.ready({ generation: f.reservation.generation + 1 })).toBe(false);
    expect(f.ready({ __atoolsDocument: { pageDocumentId: ID, docNonce: "c".repeat(32), generation: f.reservation.generation } })).toBe(false);
    expect(f.ready()).toBe(true); expect(f.ready()).toBe(false);
    const identity = await f.bootstrap.ready;
    expect(f.sources.isCurrent(f.source, identity)).toBe(true);
    f.bootstrap.handleLoad();
    expect(f.bootstrap.snapshot().phase).toBe("ready");
    f.bootstrap.handleLoad();
    expect(f.bootstrap.snapshot().phase).toBe("closed");
    expect(f.sources.isCurrent(f.source, identity)).toBe(false);
    expect(f.hello()).toBe(false); expect(f.offers).toHaveLength(1);
  });
  it("holds an early ACK until bootstrap load, and accepts ready before payload load without authorizing on load", async () => {
    const f = fixture({ deferBootstrapLoad: true }); f.hello(); f.ack();
    await until(() => f.bootstrap.snapshot().ackReceived);
    expect(f.claims).toBe(0); expect(f.htmlReads).toBe(0); expect(f.payloads).toHaveLength(0);
    expect(f.sources.currentIdentityForHost(f.source)).toBeNull();
    f.bootstrap.handleLoad();
    await until(() => f.payloads.length === 1);
    expect(f.ready()).toBe(true);
    const identity = await f.bootstrap.ready;
    f.bootstrap.handleLoad();
    expect(f.sources.currentIdentityForHost(f.source)).toBe(identity);
    f.bootstrap.handleLoad();
    expect(f.sources.currentIdentityForHost(f.source)).toBeNull();
    expect(f.claims).toBe(1); expect(f.payloads).toHaveLength(1);
  });
  it("rejects source/origin/id/nonce negatives before offering a port", () => {
    const f = fixture(), hello = { kind: "atools-bootstrap-hello", runId: ID, id: ID, docNonce: NONCE };
    for (const change of [{ source: {} }, { origin: PARENT }, { origin: "null" }]) expect(f.message(hello, change)).toBe(false);
    for (const change of [{ id: "other" }, { runId: "other" }, { docNonce: "bad" }]) expect(f.hello(change)).toBe(false);
    expect(f.offers).toHaveLength(0); expect(f.claims).toBe(0);
  });
  it("does not deliver an ACK queued immediately before invalidation", async () => {
    const f = fixture(); f.hello(); f.ack(); f.sources.invalidateDocument(f.reservation);
    await expect(f.bootstrap.ready).rejects.toThrow("INVALIDATED");
    await settle();
    expect(f.payloads).toHaveLength(0); expect(f.claims).toBe(0); expect(f.htmlReads).toBe(0);
  });
  it("does not activate or read HTML if cancelled during native claim", async () => {
    let complete!: () => void;
    const f = fixture({ claim: () => new Promise<void>(resolve => { complete = resolve; }) });
    f.hello(); f.ack(); await until(() => f.claims === 1);
    f.sources.invalidateDocument(f.reservation); complete();
    await expect(f.bootstrap.ready).rejects.toThrow("INVALIDATED"); await settle();
    expect(f.payloads).toHaveLength(0); expect(f.htmlReads).toBe(0);
    expect(f.sources.activateDocument(f.reservation, NONCE)).toBeNull();
  });
  it("claim rejection and expired handshakes remain permanently closed", async () => {
    const f = fixture({ claim: async () => { throw Error("sensitive endpoint must not appear"); } });
    f.hello(); f.ack(); await expect(f.bootstrap.ready).rejects.toThrow("CLAIM_OR_DELIVERY");
    expect(f.errors.join()).not.toContain("sensitive"); expect(f.payloads).toHaveLength(0);
    expect(f.hello()).toBe(false);
    const expired = fixture({ timeoutMs: 2 }); await expect(expired.bootstrap.ready).rejects.toThrow("TIMEOUT");
    expect(expired.hello()).toBe(false); expect(expired.offers).toHaveLength(0);
  });
  it("rejects wrong ACK binding, multi-byte HTML overflow and repeated bootstrap loads", async () => {
    const wrong = fixture(); wrong.hello(); wrong.ack({ docNonce: "c".repeat(32) });
    await expect(wrong.bootstrap.ready).rejects.toThrow("ACK_BINDING"); expect(wrong.claims).toBe(0);
    const oversized = fixture({ html: "é".repeat(PLUGIN_DOCUMENT_HTML_MAX_BYTES / 2 + 1) });
    oversized.hello(); oversized.ack(); await expect(oversized.bootstrap.ready).rejects.toThrow("CLAIM_OR_DELIVERY");
    expect(oversized.payloads).toHaveLength(0);
    const navigated = fixture(); navigated.bootstrap.handleLoad(); navigated.bootstrap.handleLoad();
    await expect(navigated.bootstrap.ready).rejects.toThrow("UNEXPECTED_LOAD");
    expect(navigated.hello()).toBe(false); expect(navigated.offers).toHaveLength(0);
  });
  it("invalidates on a bound pagehide and never accepts off-origin bootstrap errors", async () => {
    const f = fixture(); f.hello(); f.ack(); await until(() => f.payloads.length === 1); f.ready();
    const identity = await f.bootstrap.ready;
    expect(f.message({ kind: "atools-bootstrap-error", runId: ID, id: ID, docNonce: NONCE,
      code: "BOOTSTRAP_HANDOFF_TIMEOUT" }, { origin: "null" })).toBe(false);
    expect(f.message({ __atoolsDocumentClosing: true, runId: ID, id: ID, docNonce: NONCE,
      generation: identity.generation, __atoolsDocument: pluginDocumentEnvelope(identity) })).toBe(true);
    expect(f.sources.isCurrent(f.source, identity)).toBe(false);
  });
});

describe("actual native-served capability-free bootstrap template", () => {
  function nativeFixture() {
    const html = readFileSync("src-tauri/src/plugin_page_runtime/bootstrap.html", "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1].replace("__ATOOLS_BOOTSTRAP_CONFIG__", JSON.stringify({ id: ID, parentOrigin: PARENT }));
    const posts: Array<{ data: Record<string, unknown>; origin: string }> = [], writes: string[] = [];
    const listeners = new Map<string, (event: unknown) => void>(), timers = new Map<number, () => void>(); let timerId = 0;
    const parent = { postMessage: (data: Record<string, unknown>, origin: string) => posts.push({ data, origin }) };
    const target: Record<string, unknown> = { parent, addEventListener: (kind: string, callback: (event: unknown) => void) => listeners.set(kind, callback) };
    runInNewContext(script, { window: target, crypto: { getRandomValues: (array: Uint8Array) => array.fill(11) }, Uint8Array, TextEncoder,
      document: { open() {}, write: (value: string) => writes.push(value), close() {} },
      setTimeout: (callback: () => void, delay: number) => { expect(delay).toBe(5000); timers.set(++timerId, callback); return timerId; },
      clearTimeout: (id: number) => timers.delete(id) });
    const binding = { runId: ID, id: ID, docNonce: posts[0]!.data.docNonce, generation: 3 };
    const wire = new RealMessageChannel(), acknowledgements: Record<string, unknown>[] = [];
    cleanup.push(() => { wire.port1.close(); wire.port2.close(); });
    wire.port1.onmessage = event => acknowledgements.push(event.data); wire.port1.start();
    function offer(changes = {}, eventChanges = {}, ports = [wire.port2]) {
      listeners.get("message")!({ source: parent, origin: PARENT, ports,
        data: { kind: "atools-bootstrap-offer", ...binding, ...changes }, ...eventChanges });
    }
    return { target, writes, posts, timers, wire, acknowledgements, binding, offer };
  }
  it("writes only an actual bound-port payload and preserves the frozen four-field handoff", async () => {
    const f = nativeFixture();
    expect(f.posts).toHaveLength(1); expect(f.posts[0]?.origin).toBe(PARENT);
    f.offer(); await until(() => f.acknowledgements.length === 1);
    expect(f.acknowledgements[0]).toEqual({ kind: "atools-bootstrap-ack", ...f.binding });
    f.wire.port1.postMessage({ kind: "atools-bootstrap-payload-html", ...f.binding, html: "<p>native served template</p>" });
    await until(() => f.writes.length === 1);
    expect(f.writes).toEqual(["<p>native served template</p>"]);
    expect(f.target.__ATOOLS_BOOTSTRAP_HANDOFF__).toEqual(f.binding);
    expect(Object.isFrozen(f.target.__ATOOLS_BOOTSTRAP_HANDOFF__)).toBe(true);
    expect(Object.keys(f.target.__ATOOLS_BOOTSTRAP_HANDOFF__ as object).sort()).toEqual(["docNonce", "generation", "id", "runId"]);
    expect(f.timers.size).toBe(0);
  });
  it("never ACKs or writes after expiry, wrong origin/source/nonce or missing ports", async () => {
    const expired = nativeFixture(); for (const callback of [...expired.timers.values()]) callback();
    expired.offer(); await settle(); expect(expired.acknowledgements).toHaveLength(0); expect(expired.writes).toHaveLength(0);
    for (const invalid of [{ event: { origin: "null" } }, { event: { source: {} } }, { data: { docNonce: "wrong" } }, { ports: [] }]) {
      const f = nativeFixture(); f.offer(invalid.data, invalid.event, invalid.ports);
      await settle(); expect(f.acknowledgements).toHaveLength(0); expect(f.writes).toHaveLength(0);
    }
  });
  it("binding and 8MiB UTF-8 budget failures permanently close the actual port", async () => {
    for (const [changes, code] of [[{ docNonce: "c".repeat(32) }, "BOOTSTRAP_PORT_BINDING_REJECTED"],
      [{ html: "é".repeat(PLUGIN_DOCUMENT_HTML_MAX_BYTES / 2 + 1) }, "BOOTSTRAP_HTML_BUDGET_REJECTED"]] as const) {
      const f = nativeFixture(); f.offer(); await until(() => f.acknowledgements.length === 1);
      f.wire.port1.postMessage({ kind: "atools-bootstrap-payload-html", ...f.binding, html: "small", ...changes });
      await until(() => f.posts.some(post => post.data.code === code));
      expect(f.timers.size).toBe(0); expect(f.writes).toHaveLength(0);
      f.wire.port1.postMessage({ kind: "atools-bootstrap-payload-html", ...f.binding, html: "must not revive" });
      await settle(); expect(f.writes).toHaveLength(0);
    }
  });
});
