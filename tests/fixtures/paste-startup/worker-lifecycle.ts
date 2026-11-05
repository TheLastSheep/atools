import { Worker } from "node:worker_threads";

export type PasteStartupEndpoints = {
  node: string;
  data: string;
  history: string;
  write: string;
  contentWrite: string;
  secret: string;
};

type PasteStartupReady = {
  endpoints: PasteStartupEndpoints;
  initialization: { protocolVersion: number; nodeVersion: string; pid: number };
};

type ManagedPasteStartupWorker<TReady extends PasteStartupReady> = {
  worker: Worker;
  endpoints: TReady["endpoints"];
  initialization: TReady["initialization"];
  request<T = unknown>(command: string, value?: unknown, timeoutMs?: number): Promise<T>;
  close(): Promise<{ result: unknown; workerExit: { code: number } }>;
};

/** Owns readiness, bounded requests and cooperative shutdown for a fixture Worker. */
export async function managePasteStartupWorker<TReady extends PasteStartupReady = PasteStartupReady>(
  worker: Worker,
  options: { readyTimeoutMs?: number; requestTimeoutMs?: number; cleanupTimeoutMs?: number } = {},
): Promise<ManagedPasteStartupWorker<TReady>> {
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 6_000;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let nextId = 0;
  let exited = false;
  let exitInfo: { code: number } | undefined;
  let readySettled = false;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveReady!: (value: TReady) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<TReady>((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
    readyTimer = setTimeout(() => settleReady(new Error("Paste startup Worker did not become ready before its deadline")), readyTimeoutMs);
  });
  function settleReady(error?: Error, value?: TReady) {
    if (readySettled) return;
    readySettled = true;
    if (readyTimer) clearTimeout(readyTimer);
    if (error) rejectReady(error);
    else resolveReady(value!);
  }
  function rejectPending(error: Error) {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  }
  const exitPromise = new Promise<{ code: number }>(resolveExit => {
    worker.once("exit", code => {
      exited = true;
      exitInfo = { code };
      if (!readySettled) settleReady(new Error(`Paste startup Worker exited ${code} before ready`));
      rejectPending(new Error(`Paste startup Worker exited ${code}`));
      resolveExit(exitInfo);
    });
  });
  worker.on("error", error => {
    if (!readySettled) settleReady(error);
    rejectPending(error);
  });
  worker.on("message", message => {
    if (message?.type === "fatal" && !readySettled) {
      settleReady(new Error(`Paste startup fixture failed before ready: ${message.error}`));
    } else if (message?.type === "ready" && !readySettled) settleReady(undefined, message as TReady);
    if (!Number.isSafeInteger(message?.id)) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(String(message.error)));
    else waiter.resolve(message.result);
  });
  function request<T = unknown>(command: string, value?: unknown, timeoutMs = requestTimeoutMs): Promise<T> {
    if (exited || worker.threadId === -1) return Promise.reject(new Error("Paste startup Worker has already exited"));
    const id = ++nextId;
    return new Promise<T>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(new Error(`Paste startup Worker request timed out (${command})`));
      }, timeoutMs);
      pending.set(id, { resolve: result => resolveRequest(result as T), reject: rejectRequest, timer });
      try { worker.postMessage({ id, command, value }); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        rejectRequest(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async function terminateAndWait(): Promise<{ code: number }> {
    if (!exited) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          worker.terminate(),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Paste startup Worker termination timed out")), cleanupTimeoutMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exitPromise,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Paste startup Worker exit was not observed")), cleanupTimeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function waitForExitWithin(timeoutMs: number) {
    if (exited) return exitInfo;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        exitPromise,
        new Promise<null>(resolveWait => { timer = setTimeout(() => resolveWait(null), timeoutMs); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async function cooperateThenTerminate(command: "abortStartup" | "shutdown") {
    let cleanupError: unknown;
    try { if (!exited) await request(command, undefined, cleanupTimeoutMs); }
    catch (error) { cleanupError = error; }
    if (!exited) await waitForExitWithin(Math.min(500, cleanupTimeoutMs));
    try { await terminateAndWait(); }
    catch (error) { throw new AggregateError([...(cleanupError ? [cleanupError] : []), error], "Paste startup Worker cleanup was not confirmed"); }
    if (cleanupError) throw cleanupError;
  }
  let initial: TReady;
  try { initial = await ready; }
  catch (error) {
    try { await cooperateThenTerminate("abortStartup"); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], "Paste startup failed and fixture cleanup could not be confirmed"); }
    throw error;
  }
  return {
    worker, ...initial, request,
    async close() {
      let result: unknown;
      let shutdownError: unknown;
      try { if (!exited) result = await request("shutdown", undefined, cleanupTimeoutMs); }
      catch (error) {
        shutdownError = error;
        try { if (!exited) await request("abortStartup", undefined, cleanupTimeoutMs); }
        catch (abortError) { shutdownError = new AggregateError([error, abortError], "Worker shutdown and fallback abort both failed"); }
      } finally {
        if (!exited) await waitForExitWithin(Math.min(500, cleanupTimeoutMs));
        if (!exited) await terminateAndWait();
        else await exitPromise;
      }
      if (shutdownError) throw shutdownError;
      return { result, workerExit: exitInfo! };
    },
  };
}
