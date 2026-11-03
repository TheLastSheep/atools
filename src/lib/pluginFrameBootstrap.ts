import {
  type PluginDocumentIdentity, type PluginDocumentReservation, PluginFrameSourceRegistry,
} from "./pluginFrameDocumentIdentity";

export const PLUGIN_DOCUMENT_HTML_MAX_BYTES = 8 * 1024 * 1024;
type MessageSource = { postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void };
type Phase = "awaiting-hello" | "offered" | "claiming" | "delivered" | "ready" | "closed";
type Options = {
  sources: PluginFrameSourceRegistry;
  reservation: PluginDocumentReservation;
  source: MessageSource;
  claim: () => Promise<unknown>;
  getHtml: () => string;
  onClosed?: (reason: Error) => void;
  timeoutMs?: number;
  createChannel?: () => MessageChannel;
};

/** The only authority transition is ACK -> native claim -> current reservation -> activation. */
export function createPluginFrameBootstrap(options: Options) {
  const { sources, reservation, source } = options;
  let phase: Phase = "awaiting-hello", nonce = "", identity: PluginDocumentIdentity | undefined;
  let channel: MessageChannel | undefined, bootstrapLoad = false, payloadLoad = false, ackReceived = false;
  let resolveReady!: (identity: PluginDocumentIdentity) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<PluginDocumentIdentity>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const timeout = setTimeout(() => close("ERR_ATOOLS_DOCUMENT_HANDOFF_TIMEOUT"), Math.max(1, options.timeoutMs ?? 5000));
  let detachInvalidation = () => {};

  function close(reason = "ERR_ATOOLS_DOCUMENT_CLOSED") {
    if (phase === "closed") return;
    phase = "closed";
    clearTimeout(timeout);
    channel?.port1.close(); channel?.port2.close();
    detachInvalidation();
    sources.invalidateDocument(reservation);
    const error = Error(reason);
    rejectReady(error);
    options.onClosed?.(error);
  }
  detachInvalidation = sources.onDocumentInvalidated(reservation, () => close("ERR_ATOOLS_DOCUMENT_INVALIDATED"));
  function current() { return phase !== "closed" && sources.isReserved(reservation, source); }
  function bound(data: Record<string, unknown>) {
    return data.runId === reservation.pageDocumentId && data.id === reservation.pageDocumentId
      && data.docNonce === nonce && data.generation === reservation.generation;
  }
  async function deliverAfterAckAndBootstrapLoad() {
    if (phase !== "offered" || !ackReceived || !bootstrapLoad) return;
    phase = "claiming";
    try {
      await options.claim();
      if (!current() || phase !== "claiming") return;
      const active = sources.activateDocument(reservation, nonce);
      if (!active) throw Error("ERR_ATOOLS_DOCUMENT_ACTIVATION");
      identity = active;
      const html = options.getHtml();
      if (typeof html !== "string" || html.length > PLUGIN_DOCUMENT_HTML_MAX_BYTES
        || new TextEncoder().encode(html).length > PLUGIN_DOCUMENT_HTML_MAX_BYTES)
        throw Error("ERR_ATOOLS_DOCUMENT_HTML_BUDGET");
      if (!current()) return;
      phase = "delivered";
      channel!.port1.postMessage({ kind: "atools-bootstrap-payload-html", runId: reservation.pageDocumentId,
        id: reservation.pageDocumentId, docNonce: nonce, generation: reservation.generation, html });
    } catch {
      // Do not forward arbitrary claim errors, which can contain native secrets.
      close("ERR_ATOOLS_DOCUMENT_CLAIM_OR_DELIVERY");
    }
  }
  function acceptAck(data: unknown) {
    if (phase !== "offered" || ackReceived || !data || typeof data !== "object" || Array.isArray(data)) return;
    const ack = data as Record<string, unknown>;
    if (ack.kind !== "atools-bootstrap-ack" || !bound(ack)) { close("ERR_ATOOLS_DOCUMENT_ACK_BINDING"); return; }
    ackReceived = true;
    void deliverAfterAckAndBootstrapLoad();
  }
  function handleMessage(event: Pick<MessageEvent, "source" | "origin" | "data">) {
    const data = event.data;
    if (!current() || event.source !== source || event.origin !== reservation.expectedOrigin
      || !data || typeof data !== "object" || Array.isArray(data)) return false;
    if (data.runId !== reservation.pageDocumentId || data.id !== reservation.pageDocumentId) return false;
    if (data.kind === "atools-bootstrap-hello") {
      if (phase !== "awaiting-hello" || typeof data.docNonce !== "string" || !/^[0-9a-f]{32}$/.test(data.docNonce)) return false;
      nonce = data.docNonce;
      channel = (options.createChannel ?? (() => new MessageChannel()))();
      channel.port1.onmessage = event_ => { void acceptAck(event_.data); };
      channel.port1.start();
      phase = "offered";
      try {
        source.postMessage({ kind: "atools-bootstrap-offer", runId: reservation.pageDocumentId,
          id: reservation.pageDocumentId, docNonce: nonce, generation: reservation.generation },
        reservation.expectedOrigin, [channel.port2]);
      } catch { close("ERR_ATOOLS_DOCUMENT_OFFER_FAILED"); }
      return true;
    }
    if (data.kind === "atools-bootstrap-error") {
      if (data.docNonce !== nonce || !["BOOTSTRAP_HANDOFF_TIMEOUT", "BOOTSTRAP_PORT_BINDING_REJECTED",
        "BOOTSTRAP_HTML_BUDGET_REJECTED"].includes(data.code)) return false;
      close(data.code);
      return true;
    }
    if (!identity || !sources.identifyEvent(event) || !bound(data)) return false;
    if (data.kind === "atools-bootstrap-payload-ready") {
      if (phase !== "delivered") return false;
      phase = "ready";
      clearTimeout(timeout);
      channel?.port1.close(); channel?.port2.close();
      resolveReady(identity);
      return true;
    }
    if (data.__atoolsDocumentClosing === true) { close("ERR_ATOOLS_DOCUMENT_PAGEHIDE"); return true; }
    return false;
  }
  function handleLoad() {
    if (!current()) return;
    // load is observational only. It never registers a source or opens another port.
    if (phase === "awaiting-hello" || phase === "offered" || phase === "claiming") {
      if (bootstrapLoad) { close("ERR_ATOOLS_DOCUMENT_UNEXPECTED_LOAD"); return; }
      bootstrapLoad = true;
      void deliverAfterAckAndBootstrapLoad();
    } else if (phase === "delivered" || phase === "ready") {
      if (payloadLoad) { close("ERR_ATOOLS_DOCUMENT_UNEXPECTED_LOAD"); return; }
      payloadLoad = true;
    }
  }
  return { ready, handleMessage, handleLoad, close, snapshot: () => ({ phase, bootstrapLoad, payloadLoad, ackReceived }) };
}
