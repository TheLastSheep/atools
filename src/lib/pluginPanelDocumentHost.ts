import { createPluginPageDocument } from "./pluginPageDocument";
import { createPluginFrameBootstrap } from "./pluginFrameBootstrap";
import { pluginFrameTransportScript } from "./pluginFrameTransport";
import type { PluginDocumentIdentity, PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";
import { createPluginPageRevocationSubscription, type PluginPageRevocationListener } from "./pluginPageRevocation";
import { registerPluginFrameBootstrapObservation } from "./pluginFrameBootstrapObservation";

type Invoke = <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;

/** One transaction around the actual panel load; no alternate plugin renderer. */
export function createPluginPanelDocumentHost(options: {
  invoke: Invoke; pluginId: string; pluginRoot: string; parentOrigin: string;
  isCurrent: () => boolean; sources: PluginFrameSourceRegistry; onFailure: (error: Error) => void;
  listenNativeRevocation?: PluginPageRevocationListener;
}) {
  const page = createPluginPageDocument(options);
  let stagedHtml = "", staged = false, closed = false;
  let mountTimer: ReturnType<typeof setTimeout> | undefined;
  let bootstrap: ReturnType<typeof createPluginFrameBootstrap> | undefined;
  let unregisterBootstrapObservation = () => {};
  let revocation: ReturnType<typeof createPluginPageRevocationSubscription> | undefined;
  let resolveReady!: (identity: PluginDocumentIdentity) => void, rejectReady!: (error: Error) => void;
  const ready = new Promise<PluginDocumentIdentity>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  function close() {
    if (!closed) {
      closed = true; stagedHtml = ""; clearTimeout(mountTimer);
      unregisterBootstrapObservation(); unregisterBootstrapObservation = () => {};
      revocation?.close();
      bootstrap?.close();
      rejectReady(Error("ERR_ATOOLS_DOCUMENT_CLOSED"));
    }
    return page.close();
  }
  function failed(error: Error) {
    if (closed) return;
    void close();
    options.onFailure(error);
  }
  async function prepare() {
    const config = await page.prepare();
    if (closed) throw Error("ERR_ATOOLS_DOCUMENT_CLOSED");
    if (options.listenNativeRevocation) {
      revocation = createPluginPageRevocationSubscription({ pageDocumentId: config.pageDocumentId,
        listen: options.listenNativeRevocation, onRevoked: () => failed(Error("ERR_ATOOLS_DOCUMENT_NAVIGATED")) });
      await revocation.ready;
      if (closed || !options.isCurrent()) throw Error("ERR_ATOOLS_DOCUMENT_CLOSED");
    }
    return config;
  }
  function stage(html: string) {
    if (closed || staged || !options.isCurrent()) throw Error("ERR_ATOOLS_DOCUMENT_STAGE");
    staged = true; stagedHtml = html;
    mountTimer = setTimeout(() => failed(Error("ERR_ATOOLS_DOCUMENT_MOUNT_TIMEOUT")), 5000);
    // Revoke before the caller assigns src. A later load never revives it.
    options.sources.unregisterMain();
    return page.configuration().bootstrapUrl;
  }
  function mount(node: HTMLIFrameElement) {
    if (closed || !staged || !node.contentWindow || bootstrap) throw Error("ERR_ATOOLS_DOCUMENT_MOUNT");
    const source = node.contentWindow, config = page.configuration();
    clearTimeout(mountTimer);
    const reservation = options.sources.reserveDocument({ kind: "main", source, ...config });
    const current = createPluginFrameBootstrap({ sources: options.sources, reservation, source,
      claim: page.claim, getHtml: () => { const html = stagedHtml; stagedHtml = ""; return html; }, onClosed: failed });
    bootstrap = current;
    if (import.meta.env.VITE_ATOOLS_PAGE_NAVIGATION_OBSERVATION === "true") {
      unregisterBootstrapObservation = registerPluginFrameBootstrapObservation(node, source, config.pageDocumentId, current.snapshot);
    }
    void current.ready.then(identity => {
      if (!closed && options.isCurrent()) resolveReady(identity);
      else void close();
    }, error => failed(error instanceof Error ? error : Error("ERR_ATOOLS_DOCUMENT_READY")));
    const loaded = () => current.handleLoad();
    node.addEventListener("load", loaded);
    return { destroy() { node.removeEventListener("load", loaded); void close(); } };
  }
  return {
    prepare, invoke: page.invoke, resourceUrl: page.resourceUrl, configuration: page.configuration,
    stage, mount, ready, close,
    handleMessage: (event: MessageEvent) => bootstrap?.handleMessage(event) ?? false,
    completeWithOutput(identity: PluginDocumentIdentity, source: unknown) {
      if (closed || !options.sources.isCurrent(source, identity)) return false;
      resolveReady(identity);
      void close();
      return true;
    },
    bridgeScript() { const config = page.configuration(); return pluginFrameTransportScript({ pageDocumentId: config.pageDocumentId, parentOrigin: config.parentOrigin }); },
  };
}
