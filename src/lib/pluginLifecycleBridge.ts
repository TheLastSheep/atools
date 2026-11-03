/** Self-contained: the production iframe receives this factory's serialized source. */
export function createPluginLifecycleBridge<T>(target: Window & { console: Pick<Console, "error"> }, normalizeEnter: (detail: Record<string, unknown>) => T) {
  type Entry = { sequence: number; action: T };
  let sequence = 0, pending: Entry | null = null, disposed = false;
  let callback: ((action: T) => unknown) | null = null;
  let startArmed = false, readyDocument: Document | null = null;
  let readyListener: (() => void) | null = null, startTimer: ReturnType<typeof setTimeout> | null = null;
  function reportError(error: unknown) { target.console.error("[ATools lifecycle] callback failed", error); }
  function deliver(entry: Entry) {
    if (disposed || entry.sequence !== sequence || !callback) return;
    try {
      const result = callback(entry.action);
      if (result && typeof (result as PromiseLike<unknown>).then === "function")
        Promise.resolve(result).catch(reportError);
    } catch (error) { reportError(error); }
  }
  function enter(event: Event) {
    if (disposed) return;
    const detail = (event as CustomEvent).detail;
    const entry = { sequence: ++sequence, action: normalizeEnter(detail && typeof detail === "object" ? detail : {}) };
    pending = null;
    if (callback) deliver(entry);
    else pending = entry;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; pending = null; callback = null;
    target.removeEventListener("atools-plugin-enter", enter);
    target.removeEventListener("atools-plugin-out", dispose);
    target.removeEventListener("pagehide", dispose);
    if (readyListener && readyDocument) readyDocument.removeEventListener("DOMContentLoaded", readyListener);
    readyListener = null;
    readyDocument = null;
    if (startTimer !== null) clearTimeout(startTimer);
    startTimer = null;
  }
  /** Runs on one next-task after DOM readiness; removes/cancels work on disposal. */
  function startWhenDocumentReady(document: Document, start: () => void) {
    if (disposed || startArmed) return;
    startArmed = true;
    const scheduleStart = () => {
      if (disposed) return;
      startTimer = setTimeout(() => {
        startTimer = null;
        if (!disposed) start();
      }, 0);
    };
    if (document.readyState === "loading") {
      const onReady = () => {
        document.removeEventListener("DOMContentLoaded", onReady);
        readyListener = null;
        readyDocument = null;
        scheduleStart();
      };
      readyDocument = document;
      readyListener = onReady;
      document.addEventListener("DOMContentLoaded", onReady, { once: true });
    } else scheduleStart();
  }
  target.addEventListener("atools-plugin-enter", enter);
  target.addEventListener("atools-plugin-out", dispose);
  target.addEventListener("pagehide", dispose);
  return {
    startWhenDocumentReady,
    onPluginEnter(next: (action: T) => unknown) {
      if (disposed || typeof next !== "function") return;
      // ZTools replaces the previous callback and buffers only undelivered Enter.
      // React/Vue may subscribe after DOMContentLoaded; do not replay consumed entry.
      callback = next;
      const entry = pending; pending = null;
      if (entry) Promise.resolve().then(() => deliver(entry));
    },
    dispose,
  };
}
