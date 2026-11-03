export type RendererCallback = (...args: never[]) => unknown;

const ignoreCallbackError = () => undefined;

export function dispatchRendererCallbacks<Callback extends RendererCallback>(
  subscribers: ReadonlyMap<number, Callback>,
  args: readonly unknown[],
  onError: () => void = ignoreCallbackError,
  canDeliver?: () => boolean,
  settlementCollector?: Promise<unknown>[],
): void {
  const recipients = Array.from(subscribers.entries());
  for (const [id, callback] of recipients) {
    if ((canDeliver && !canDeliver()) || subscribers.get(id) !== callback) continue;
    try {
      const result = (callback as unknown as (...values: unknown[]) => unknown)(...args);
      const settlement = Promise.resolve(result).catch(onError);
      settlementCollector?.push(settlement);
    } catch {
      onError();
    }
  }
}

export function createRendererCallbackRegistry<Name extends string>(names: readonly Name[], limit: number, onError: () => void = ignoreCallbackError) {
  const callbacks = new Map<Name, Map<number, RendererCallback>>();
  let callbackId = 0;
  for (const name of names) callbacks.set(name, new Map());

  return {
    has(name: string): boolean {
      return callbacks.has(name as Name);
    },
    add(name: Name, callback: RendererCallback): (() => void) | undefined {
      const set = callbacks.get(name);
      if (!set || set.size >= limit) return;
      const id = ++callbackId;
      set.set(id, callback);
      return () => { set.delete(id); };
    },
    emit(name: Name, args: readonly unknown[]): void {
      const set = callbacks.get(name);
      if (!set) return;
      dispatchRendererCallbacks(set, args, onError);
    },
    async emitAndWait(name: Name, args: readonly unknown[], canDeliver?: () => boolean): Promise<void> {
      const set = callbacks.get(name);
      if (!set) return;
      const settlements: Promise<unknown>[] = [];
      dispatchRendererCallbacks(set, args, onError, canDeliver, settlements);
      await Promise.all(settlements);
    },
    count(): number {
      let total = 0;
      for (const set of callbacks.values()) total += set.size;
      return total;
    },
    clear(): void {
      for (const set of callbacks.values()) set.clear();
    },
  };
}
