export type PluginFrameTransportConfig = { pageDocumentId?: string; parentOrigin?: string };
export type PluginFrameTransport = {
  post: (message: Record<string, unknown>, transfer?: Transferable[]) => boolean;
  postLegacy: (message: Record<string, unknown>, targetOrigin?: string, transfer?: Transferable[]) => boolean;
  accept: (event: Pick<MessageEvent, "source" | "origin" | "data">) => boolean;
  ready: () => boolean;
  dispose: () => void;
};
type Handoff = { runId: string; id: string; docNonce: string; generation: number };
type TransportWindow = Pick<Window, "parent" | "addEventListener" | "removeEventListener"> & {
  __ATOOLS_BOOTSTRAP_HANDOFF__?: Handoff;
};

/** Serialized into our own bridges only; never patches a plugin or browser API. */
export function createPluginFrameTransport(target: TransportWindow, config: PluginFrameTransportConfig = {}): PluginFrameTransport {
  const handoff = target.__ATOOLS_BOOTSTRAP_HANDOFF__;
  const documentMode = config.pageDocumentId !== undefined;
  if (documentMode && (!config.pageDocumentId || !config.parentOrigin || config.parentOrigin === "null"
    || config.parentOrigin === "*" || !/^[a-z][a-z\d+.-]*:\/\/[^/?#]+$/i.test(config.parentOrigin)
    || handoff?.runId !== config.pageDocumentId || handoff.id !== config.pageDocumentId
    || typeof handoff.docNonce !== "string" || !/^[0-9a-f]{32}$/.test(handoff.docNonce)
    || !Number.isSafeInteger(handoff.generation) || handoff.generation < 1))
    throw Error("ERR_ATOOLS_DOCUMENT_TRANSPORT_BINDING");
  // Copy the primitive values: replacing the global handoff cannot retarget an installed bridge.
  const binding = documentMode ? Object.freeze({ pageDocumentId: config.pageDocumentId!,
    docNonce: handoff!.docNonce, generation: handoff!.generation }) : undefined;
  const parentOrigin = documentMode ? config.parentOrigin! : "*";
  let disposed = false, readySent = false;
  function post(message: Record<string, unknown>, transfer: Transferable[] = []) {
    if (disposed) return false;
    try {
      target.parent.postMessage(binding ? { ...message, __atoolsDocument: binding } : message, parentOrigin, transfer);
      return true;
    } catch { return false; }
  }
  function postLegacy(message: Record<string, unknown>, _targetOrigin?: string, transfer: Transferable[] = []) {
    // The legacy bridge passed targetOrigin as argument two; only this host-bound
    // transport owns the destination origin. Preserve the optional transfer list.
    if (!post(message, transfer)) throw Error("ERR_ATOOLS_FRAME_TRANSPORT_SEND");
    return true;
  }
  function accept(event: Pick<MessageEvent, "source" | "origin" | "data">) {
    if (disposed || event.source !== target.parent) return false;
    if (!binding) return true;
    const data = event.data, received = data && typeof data === "object" && !Array.isArray(data) && data.__atoolsDocument;
    return event.origin === parentOrigin && !!received && typeof received === "object"
      && received.pageDocumentId === binding.pageDocumentId && received.docNonce === binding.docNonce
      && received.generation === binding.generation;
  }
  function ready() {
    if (!binding || readySent || disposed) return false;
    readySent = true;
    return post({ kind: "atools-bootstrap-payload-ready", runId: binding.pageDocumentId, id: binding.pageDocumentId,
      docNonce: binding.docNonce, generation: binding.generation });
  }
  function dispose() {
    if (disposed) return;
    post({ __atoolsDocumentClosing: true, ...(binding ? { runId: binding.pageDocumentId, id: binding.pageDocumentId,
      docNonce: binding.docNonce, generation: binding.generation } : {}) });
    disposed = true;
    target.removeEventListener("pagehide", dispose);
  }
  if (binding) target.addEventListener("pagehide", dispose, { once: true });
  return Object.freeze({ post, postLegacy, accept, ready, dispose });
}

export function pluginFrameTransportScript(config: PluginFrameTransportConfig = {}) {
  const serialized = JSON.stringify(config).replace(/[<>&]/g, character => ({ "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" })[character]!);
  return `<script>(function(){var transport=(${createPluginFrameTransport.toString()})(window,${serialized});
Object.defineProperty(window,'__ATOOLS_FRAME_TRANSPORT__',{value:transport,configurable:false});
function ready(){setTimeout(function(){transport.ready();},0);}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',ready,{once:true});else ready();
})();</script>`;
}
