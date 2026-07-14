export const HOSTED_BROWSER_WINDOW_ISOLATED_UNSUPPORTED =
  "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED";

export const HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS = 3_000;

export const HOSTED_BROWSER_WINDOW_RPC_METHODS = [
  "describe",
  "executeJavaScript",
  "sendInputEvent",
  "insertCSS",
  "removeInsertedCSS",
  "findInPage",
  "stopFindInPage",
] as const;

export type HostedBrowserWindowRpcMethod =
  (typeof HOSTED_BROWSER_WINDOW_RPC_METHODS)[number];

type HostedBrowserWindowMessageTarget = {
  postMessage(message: unknown, targetOrigin: string, transfer: Transferable[]): void;
};

type HostedBrowserWindowRpcOptions = {
  timeoutMs?: number;
  createChannel?: () => MessageChannel;
};

type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type RpcEntry = {
  generation: number;
  port: MessagePort;
  ready: boolean;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  rejectReady: (reason: Error) => void;
  pending: Map<number, PendingRpc>;
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function supportedRpcMethod(value: unknown): value is HostedBrowserWindowRpcMethod {
  return typeof value === "string"
    && (HOSTED_BROWSER_WINDOW_RPC_METHODS as readonly string[]).includes(value);
}

function rpcLifecycleError(windowId: string, reason: string) {
  return new Error(`Hosted BrowserWindow RPC ${windowId} ${reason}`);
}

export function hostedBrowserWindowUnsupported(actionName: string) {
  return new Error(
    `${HOSTED_BROWSER_WINDOW_ISOLATED_UNSUPPORTED}: ${actionName} is unavailable for an isolated hosted BrowserWindow`,
  );
}

export class HostedBrowserWindowNavigationTokens {
  private sequence = 0;
  private readonly currentByWindow = new Map<string, number>();

  begin(windowId: string) {
    const token = ++this.sequence;
    this.currentByWindow.set(windowId, token);
    return token;
  }

  isCurrent(windowId: string, token: number) {
    return this.currentByWindow.get(windowId) === token;
  }

  assertCurrent(windowId: string, token: number) {
    if (!this.isCurrent(windowId, token)) {
      throw new Error(`Hosted BrowserWindow navigation ${windowId} superseded`);
    }
  }

  close(windowId: string) {
    this.currentByWindow.delete(windowId);
  }

  closeAll() {
    this.currentByWindow.clear();
  }
}

export class HostedBrowserWindowRpcHost {
  private readonly timeoutMs: number;
  private readonly createChannel: () => MessageChannel;
  private readonly entries = new Map<string, RpcEntry>();
  private generationSeq = 0;
  private requestSeq = 0;

  constructor(options: HostedBrowserWindowRpcOptions = {}) {
    this.timeoutMs = Math.max(1, Math.round(options.timeoutMs ?? HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS));
    this.createChannel = options.createChannel ?? (() => new MessageChannel());
  }

  attach(windowId: string, target: HostedBrowserWindowMessageTarget) {
    this.invalidate(windowId, "reloaded");
    const generation = ++this.generationSeq;
    const channel = this.createChannel();
    let resolveReady!: () => void;
    let rejectReady!: (reason: Error) => void;
    const readyPromise = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Lifecycle rejection is observed by waitReady/call. Avoid an unhandled
    // rejection when an iframe disappears before anyone waits for readiness.
    void readyPromise.catch(() => undefined);
    const entry: RpcEntry = {
      generation,
      port: channel.port1,
      ready: false,
      readyPromise,
      resolveReady,
      rejectReady,
      pending: new Map(),
    };
    this.entries.set(windowId, entry);
    entry.port.onmessage = (event) => this.handleMessage(windowId, entry, event.data);
    entry.port.start?.();
    try {
      target.postMessage({
        __atools_hosted_browser_window_rpc_init__: true,
        generation,
      }, "*", [channel.port2]);
    } catch (error) {
      this.invalidate(windowId, `initialization failed: ${errorMessage(error)}`);
      throw error;
    }
    return generation;
  }

  isReady(windowId: string) {
    return this.entries.get(windowId)?.ready === true;
  }

  isAttached(windowId: string) {
    return this.entries.has(windowId);
  }

  async waitReady(windowId: string) {
    const entry = this.entries.get(windowId);
    if (!entry) throw rpcLifecycleError(windowId, "is not attached");
    if (entry.ready) return;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entry.readyPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(rpcLifecycleError(windowId, "readiness timed out")),
            this.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  async call(windowId: string, method: string, args: unknown = {}) {
    if (!supportedRpcMethod(method)) {
      throw new Error(`Unsupported hosted BrowserWindow RPC method: ${method || "(empty)"}`);
    }
    const awaitedEntry = this.entries.get(windowId);
    if (!awaitedEntry) throw rpcLifecycleError(windowId, "is not attached");
    await this.waitReady(windowId);
    const entry = this.entries.get(windowId);
    if (entry !== awaitedEntry) {
      throw rpcLifecycleError(windowId, entry ? "reloaded" : "closed");
    }
    if (!entry || !entry.ready) throw rpcLifecycleError(windowId, "is not ready");
    const reqId = ++this.requestSeq;
    return new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        entry.pending.delete(reqId);
        reject(new Error(`Hosted BrowserWindow RPC ${method} timed out for ${windowId}`));
      }, this.timeoutMs);
      entry.pending.set(reqId, { resolve, reject, timeoutId });
      try {
        entry.port.postMessage({
          __atools_hosted_browser_window_rpc_request__: true,
          generation: entry.generation,
          reqId,
          method,
          args,
        });
      } catch (error) {
        clearTimeout(timeoutId);
        entry.pending.delete(reqId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  invalidate(windowId: string, reason = "invalidated") {
    const entry = this.entries.get(windowId);
    if (!entry) return;
    this.entries.delete(windowId);
    const error = rpcLifecycleError(windowId, reason);
    entry.rejectReady(error);
    for (const pending of entry.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    entry.pending.clear();
    entry.port.onmessage = null;
    entry.port.close();
  }

  close(windowId: string) {
    this.invalidate(windowId, "closed");
  }

  closeAll() {
    for (const windowId of [...this.entries.keys()]) this.close(windowId);
  }

  private handleMessage(windowId: string, entry: RpcEntry, message: unknown) {
    if (this.entries.get(windowId) !== entry) return;
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if (record.generation !== entry.generation) return;
    if (record.__atools_hosted_browser_window_rpc_ready__ === true) {
      if (!entry.ready) {
        entry.ready = true;
        entry.resolveReady();
      }
      return;
    }
    if (record.__atools_hosted_browser_window_rpc_response__ !== true) return;
    const reqId = Number(record.reqId);
    if (!Number.isSafeInteger(reqId) || reqId <= 0) return;
    const pending = entry.pending.get(reqId);
    if (!pending) return;
    entry.pending.delete(reqId);
    clearTimeout(pending.timeoutId);
    if (typeof record.error === "string" && record.error) {
      pending.reject(new Error(record.error));
    } else {
      pending.resolve(record.result);
    }
  }
}
