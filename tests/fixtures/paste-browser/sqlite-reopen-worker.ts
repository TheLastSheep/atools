import { Worker } from "node:worker_threads";

type SeedCleanupResult = { removed: string[]; preserved: { _id?: string } & Record<string, unknown> };
type ReopenResult = SeedCleanupResult & { workerExitCode: number };

/** Runs the SQLite seed cleanup helper with bounded completion and confirmed exit. */
export async function clearStartupSeedsInOwnedWorker(databasePath: string, businessRecordId: string): Promise<ReopenResult> {
  const worker = new Worker(new URL("./sqlite-reopen.mjs", import.meta.url), { workerData: { databasePath, businessRecordId } });
  let exitCode: number | undefined;
  let resolveExit!: (code: number) => void;
  const exitObserved = new Promise<number>(resolve => { resolveExit = resolve; });
  worker.once("exit", code => { exitCode = code; resolveExit(code); });
  const completion = new Promise<ReopenResult>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("SQLite reseed helper Worker did not return both a result and exit status within 5s")), 5000);
    let resultSeen = false;
    let result: SeedCleanupResult | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else if (result && exitCode !== undefined) resolve({ ...result, workerExitCode: exitCode! });
      else reject(new Error("SQLite reseed helper returned no result"));
    };
    const onMessage = (message: any) => {
      if (message?.error) return finish(new Error(`SQLite reseed helper failed: ${String(message.error)}`));
      result = message?.result as SeedCleanupResult | undefined;
      resultSeen = true;
      if (exitCode !== undefined) {
        if (exitCode !== 0) finish(new Error(`SQLite reseed helper exited ${exitCode}`));
        else finish();
      }
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number) => {
      if (code !== 0) return finish(new Error(`SQLite reseed helper exited ${code}`));
      if (resultSeen) finish();
    };
    worker.on("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
  });
  try {
    return await completion;
  } catch (error) {
    let terminationError: unknown;
    if (exitCode === undefined && worker.threadId !== -1) {
      try { void worker.terminate().catch(failure => { terminationError = failure; }); }
      catch (failure) { terminationError = failure; }
    }
    if (exitCode === undefined) {
      const exited = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 1500);
        void exitObserved.then(() => { clearTimeout(timer); resolve(true); });
      });
      if (!exited && exitCode === undefined) {
        const cleanupFailure = new Error("SQLite reseed helper cleanup could not be confirmed");
        Object.assign(cleanupFailure, {
          cause: error,
          atoolsCleanupUnconfirmed: {
            resource: "SQLite reseed helper Worker",
            terminationError: terminationError ? String(terminationError) : null,
          },
        });
        throw cleanupFailure;
      }
    }
    throw error;
  }
}
