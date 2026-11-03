/** One event-driven deadline; visible permission waiting is measured separately. */
export function createPluginMainPushDeadline(duration: number) {
  let remaining = duration, started = performance.now(), waiting = false, closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reject!: (error: Error) => void;
  const expired = new Promise<never>((_, fail) => { reject = fail; });
  void expired.catch(() => undefined);
  function arm() { started = performance.now(); timer = setTimeout(() => reject(Error("ERR_MAIN_PUSH_STARTUP_TIMEOUT")), remaining); }
  arm();
  return { wait<T>(value: Promise<T>) { return Promise.race([value, expired]).finally(() => { closed = true; clearTimeout(timer); }); },
    setWaiting(next: boolean) { if (closed || waiting === next) return; waiting = next;
      if (next) { clearTimeout(timer); remaining = Math.max(0, remaining - (performance.now() - started)); } else arm(); },
    close() { if (closed) return; closed = true; clearTimeout(timer); reject(Error("ERR_MAIN_PUSH_SUPERSEDED")); } };
}
