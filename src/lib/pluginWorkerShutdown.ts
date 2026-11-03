export type PluginWorkerShutdownTarget = { source: Window; scopeId: string; origin?: string };
export type PluginWorkerShutdownResult = { requested: number; acknowledged: number; timedOut: boolean };
export type PluginWorkerShutdownOptions = {
  timeoutMs?: number;
  messageTarget?: Window;
  signal?: AbortSignal;
};

const DEFAULT_TIMEOUT_MS = 80;
const MAX_TIMEOUT_MS = 250;
const MAX_TARGETS = 64;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Request worker-owned child shutdown and wait briefly for source-bound acknowledgements. */
export function requestPluginWorkerShutdown(
  targets: PluginWorkerShutdownTarget[],
  options: PluginWorkerShutdownOptions = {},
): Promise<PluginWorkerShutdownResult> {
  if (!Array.isArray(targets)) return Promise.reject(new TypeError("Worker shutdown targets must be an array"));
  if (targets.length > MAX_TARGETS) return Promise.reject(new RangeError(`At most ${MAX_TARGETS} worker shutdown targets are supported`));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return Promise.reject(new RangeError("Worker shutdown timeout must be non-negative"));
  if (targets.length === 0) {
    return Promise.resolve({ requested: 0, acknowledged: 0, timedOut: false });
  }
  if (options.signal?.aborted) return Promise.resolve({ requested: 0, acknowledged: 0, timedOut: true });

  const messageTarget = options.messageTarget ?? globalThis.window;
  if (!messageTarget?.addEventListener || !messageTarget?.removeEventListener) {
    return Promise.reject(new TypeError("A message target window is required"));
  }

  const unique = new Map<Window, PluginWorkerShutdownTarget>();
  for (const target of targets) {
    if (!target?.source || typeof target.source.postMessage !== "function" || !UUID_V4.test(target.scopeId)) {
      return Promise.reject(new TypeError("Each worker shutdown target needs a message source and UUIDv4 document scope"));
    }
    const previous = unique.get(target.source);
    if (previous && (previous.origin !== target.origin || previous.scopeId !== target.scopeId)) {
      return Promise.reject(new TypeError("Duplicate worker sources cannot use different origins or document scopes"));
    }
    unique.set(target.source, target);
  }

  const pending = new Map<string, PluginWorkerShutdownTarget>();
  let requested = 0;
  let acknowledged = 0;
  let failedSend = false;
  let sendingComplete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let complete: ((value: PluginWorkerShutdownResult) => void) | undefined;
  let settled = false;

  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    messageTarget.removeEventListener("message", onMessage);
    options.signal?.removeEventListener("abort", onAbort);
  };
  const finish = (timedOut: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    complete?.({ requested, acknowledged, timedOut: timedOut || failedSend });
  };
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { __atools_worker_shutdown_ack__?: unknown; requestId?: unknown; scopeId?: unknown; remaining?: unknown } | null;
    if (!data || data.__atools_worker_shutdown_ack__ !== true || typeof data.requestId !== "string"
      || typeof data.scopeId !== "string" || data.remaining !== 0) return;
    const target = pending.get(data.requestId);
    if (!target || data.scopeId !== target.scopeId || event.source !== target.source
      || (target.origin !== undefined && event.origin !== target.origin)) return;
    pending.delete(data.requestId);
    acknowledged += 1;
    if (pending.size === 0 && sendingComplete) finish(failedSend);
  };
  const onAbort = () => finish(true);

  return new Promise(resolve => {
    complete = resolve;
    messageTarget.addEventListener("message", onMessage);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(true), Math.min(timeoutMs, MAX_TIMEOUT_MS));

    for (const target of unique.values()) {
      if (settled) break;
      const requestId = globalThis.crypto?.randomUUID?.();
      if (!requestId) {
        failedSend = true;
        continue;
      }
      pending.set(requestId, target);
      requested += 1;
      try {
        target.source.postMessage({ __atools_worker_shutdown__: true, requestId, scopeId: target.scopeId }, target.origin ?? "*");
      } catch {
        pending.delete(requestId);
        failedSend = true;
      }
    }
    sendingComplete = true;
    if (pending.size === 0) finish(failedSend);
  });
}
