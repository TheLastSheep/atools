/** Serialize this factory into the isolated plugin document. */
export function createPluginBrowserWorkerBridge(target: Window & {
  Worker?: typeof Worker & { prototype: Worker };
  __atoolsNativeWorker?: typeof Worker;
  navigator: Navigator & { serviceWorker?: ServiceWorkerContainer };
  URL: typeof URL;
  Blob: typeof Blob;
  document: Document;
  location: Location;
}, scopeId?: string) {
  const frame = target as Window & {
    Worker?: typeof Worker & { prototype: Worker };
    __atoolsNativeWorker?: typeof Worker;
    navigator: Navigator & { serviceWorker?: ServiceWorkerContainer };
    URL: typeof URL;
    Blob: typeof Blob;
    document: Document;
    location: Location;
  };
  const validScope = typeof scopeId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scopeId);
  const alreadyWrapped = Boolean(frame.__atoolsNativeWorker);
  const ownedWorkers = new Map<Worker, () => void>();
  let constructing = 0;
  let closed = false;
  const dispose = () => {
    if (!closed) {
      closed = true;
      frame.removeEventListener("atools-plugin-out", dispose);
      frame.removeEventListener("pagehide", dispose);
    }
    for (const terminate of Array.from(ownedWorkers.values())) {
      try { terminate(); } catch (_error) { /* A failed native termination remains owned for retry. */ }
    }
  };

  // This only rewrites local classic-worker URLs. The document's worker-src CSP
  // remains authoritative, so a `worker-src 'none'` document still blocks them.
  if (typeof frame.Worker === "function" && !frame.__atoolsNativeWorker) {
    const NativeWorker = frame.Worker;
    const nativeWorkerTerminate = NativeWorker.prototype.terminate;
    const nativeWorkerAddEventListener = NativeWorker.prototype.addEventListener;
    const revokeObjectUrl = frame.URL.revokeObjectURL.bind(frame.URL);
    frame.__atoolsNativeWorker = NativeWorker;
    frame.Worker = function(scriptUrl: string | URL, options?: WorkerOptions) {
      if (!new.target) throw new TypeError("Worker constructor requires new");
      if (closed || ownedWorkers.size + constructing >= 8) {
        const error = new Error(closed ? "Plugin worker scope is closed" : "Plugin worker limit exceeded");
        error.name = closed ? "InvalidStateError" : "QuotaExceededError";
        throw error;
      }
      // Reserve before coercion, option getters, Blob hooks or the native constructor can re-enter.
      constructing++;
      let reserved = true;
      try {
        const nativeTarget = (new.target as unknown) === frame.Worker ? NativeWorker : new.target;
        let revokeBootstrap = () => {};
        let worker: Worker;
        if (arguments.length === 0) worker = Reflect.construct(NativeWorker, [], nativeTarget) as Worker;
        else {
          const source = String(scriptUrl);
          let parsed: URL | null = null;
          try { parsed = new frame.URL(source, frame.document.baseURI); } catch (_error) {}
          const protocol = parsed ? String(parsed.protocol || "").toLowerCase() : "";
          const sameDocumentHost = parsed && (protocol === "http:" || protocol === "https:")
            && parsed.host === frame.location.host;
          const leasedResource = parsed && (protocol === "atools-plugin:" && parsed.host === "localhost"
            || (protocol === "http:" || protocol === "https:") && parsed.host === "atools-plugin.localhost");
          const localPluginResource = protocol === "asset:" || protocol === "tauri:" || sameDocumentHost || leasedResource;
          if (localPluginResource && (!options || options.type !== "module")) {
            const bootstrapUrl = frame.URL.createObjectURL(new frame.Blob([
              "importScripts(" + JSON.stringify(parsed!.href) + ");",
            ], { type: "application/javascript" }));
            let revoked = false;
            revokeBootstrap = () => {
              if (revoked) return;
              revoked = true;
              revokeObjectUrl(bootstrapUrl);
            };
            try {
              worker = Reflect.construct(NativeWorker, [bootstrapUrl, options], nativeTarget) as Worker;
            } catch (error) {
              revokeBootstrap();
              throw error;
            }
            nativeWorkerAddEventListener.call(worker, "error", revokeBootstrap, { once: true });
          } else worker = Reflect.construct(NativeWorker, [scriptUrl, options], nativeTarget) as Worker;
        }
        const observedTerminate = Object.getOwnPropertyDescriptor(worker, "terminate")?.value;
        const nativeTerminate = typeof observedTerminate === "function"
          ? observedTerminate.bind(worker) : () => nativeWorkerTerminate.call(worker);
        const terminate = () => {
          if (!ownedWorkers.has(worker)) return;
          try { revokeBootstrap(); } finally {
            const result = nativeTerminate();
            ownedWorkers.delete(worker);
            return result;
          }
        };
        ownedWorkers.set(worker, terminate);
        constructing--;
        reserved = false;
        if (!closed) worker.terminate = terminate;
        if (closed) {
          terminate();
          const error = new Error("Plugin worker scope closed during construction");
          error.name = "InvalidStateError";
          throw error;
        }
        return worker;
      } finally { if (reserved) constructing--; }
    } as unknown as typeof Worker;
    frame.Worker.prototype = NativeWorker.prototype;
    try { Object.setPrototypeOf(frame.Worker, NativeWorker); } catch (_error) {}
    frame.addEventListener("atools-plugin-out", dispose);
    frame.addEventListener("pagehide", dispose);
  }
  if (validScope && !alreadyWrapped) {
    // Keep this listener after disposal so a duplicate request receives an honest ACK.
    frame.addEventListener("message", (event: MessageEvent) => {
      const message = event.data;
      if (event.source !== frame.parent || !message || message.__atools_worker_shutdown__ !== true
        || message.scopeId !== scopeId || typeof message.requestId !== "string"
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(message.requestId)) return;
      dispose();
      frame.dispatchEvent(new Event("atools-workers-disposed"));
      frame.parent.postMessage({ __atools_worker_shutdown_ack__: true, requestId: message.requestId,
        scopeId, remaining: ownedWorkers.size + constructing }, "*");
    });
  }

  // Keep the browser's ServiceWorkerContainer surface (including query methods),
  // but never report a fake successful registration for an opaque CSP sandbox.
  let nativeServiceWorker: ServiceWorkerContainer | undefined;
  try { nativeServiceWorker = frame.navigator && frame.navigator.serviceWorker; } catch (_error) {}
  if (nativeServiceWorker && typeof nativeServiceWorker.register === "function") {
    const unsupportedServiceWorker = new Proxy(nativeServiceWorker, {
      get(container, property) {
        if (property === "register") {
          return function() {
            const error = new Error("Service workers are unsupported in the isolated plugin document") as Error & { code?: string };
            error.name = "NotSupportedError";
            error.code = "ERR_ATOOLS_SERVICE_WORKER_UNSUPPORTED";
            return Promise.reject(error);
          };
        }
        const value = Reflect.get(container, property, container);
        return typeof value === "function" ? value.bind(container) : value;
      },
      set(container, property, value) {
        return Reflect.set(container, property, value, container);
      },
    });
    try {
      Object.defineProperty(frame.navigator, "serviceWorker", {
        value: unsupportedServiceWorker,
        configurable: true,
      });
    } catch (_error) {}
  }
}
