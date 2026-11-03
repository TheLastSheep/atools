import type { DependencyEntry, DependencyIdentity } from "./pluginSourceDependencyProtocol";

export type DependencyOperationSnapshot = {
  operationId: number;
  sourcePath: string;
  active: boolean;
  entry: DependencyEntry;
  identity?: DependencyIdentity;
  reads: number;
  errors: number;
  paused: boolean;
  cancelRequested: boolean;
};

export type DependencySessionEvent = {
  activePath: string | null;
  sessionPath: string | null;
  operation?: DependencyOperationSnapshot;
  origin?: object;
};

type Operation = DependencyOperationSnapshot & { observer?: object };
type Listener = (event: DependencySessionEvent) => void;

let operation: Operation | undefined;
let nextOperationId = 0;
const listeners = new Set<Listener>();

/** One in-memory lease for the selected dependency operation, shared across row/panel lifetimes. */
export const pluginSourceDependencySession = {
  activePath(): string | null { return operation?.active ? operation.sourcePath : null; },
  sessionPath(): string | null { return operation?.sourcePath ?? null; },

  snapshot(sourcePath: string): DependencyOperationSnapshot | undefined {
    return operation?.sourcePath === sourcePath ? copyOperation(operation) : undefined;
  },

  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },

  begin(sourcePath: string, entry: DependencyEntry, origin: object): number | undefined {
    if (operation?.active) return undefined;
    const operationId = ++nextOperationId;
    operation = { operationId, sourcePath, active: true, entry: { ...entry }, reads: 0, errors: 0,
      paused: false, cancelRequested: false };
    notify(origin);
    return operationId;
  },

  updateEntry(operationId: number, entry: DependencyEntry, origin: object): boolean {
    if (!matches(operationId)) return false;
    operation!.entry = { ...entry };
    notify(origin);
    return true;
  },

  setIdentity(operationId: number, identity: DependencyIdentity, entry: DependencyEntry, origin: object, observer?: object): boolean {
    if (!matches(operationId) || !operation!.active) return false;
    operation!.identity = { ...identity };
    operation!.entry = { ...entry };
    operation!.observer = observer;
    operation!.reads = 0;
    operation!.errors = 0;
    operation!.paused = false;
    notify(origin);
    return true;
  },

  updateObservation(operationId: number, values: Pick<DependencyOperationSnapshot,
    "reads" | "errors" | "paused" | "cancelRequested">, origin: object): boolean {
    if (!matches(operationId) || !operation!.active) return false;
    Object.assign(operation!, values);
    notify(origin);
    return true;
  },

  claimObserver(operationId: number, observer: object): DependencyOperationSnapshot | undefined {
    if (!matches(operationId) || !operation!.active || !operation!.identity
      || operation!.observer && operation!.observer !== observer) return undefined;
    operation!.observer = observer;
    return copyOperation(operation!);
  },

  releaseObserver(operationId: number, observer: object): void {
    if (!matches(operationId) || operation!.observer !== observer) return;
    operation!.observer = undefined;
    notify(observer);
  },

  releaseTerminal(operationId: number, identity: DependencyIdentity, entry: DependencyEntry, origin: object): boolean {
    if (!matches(operationId) || !operation!.active || !sameIdentity(operation!.identity, identity)) return false;
    operation!.active = false;
    operation!.observer = undefined;
    operation!.entry = { ...entry };
    notify(origin);
    return true;
  },

  clearInactiveForNewState(): boolean {
    if (!operation || operation.active) return false;
    operation = undefined;
    notify();
    return true;
  },

  /** Test isolation only; production components never clear a live operation. */
  resetForTests(): void {
    if (import.meta.env.MODE !== "test") return;
    operation = undefined;
    notify();
  },
};

function matches(operationId: number): boolean { return operation?.operationId === operationId; }
function sameIdentity(left: DependencyIdentity | undefined, right: DependencyIdentity): boolean {
  return !!left && left.id === right.id && left.action === right.action && left.sourcePath === right.sourcePath
    && left.sourceRevision === right.sourceRevision;
}
function copyOperation(value: Operation): DependencyOperationSnapshot {
  return { operationId: value.operationId, sourcePath: value.sourcePath, active: value.active,
    entry: { ...value.entry }, identity: value.identity && { ...value.identity }, reads: value.reads,
    errors: value.errors, paused: value.paused, cancelRequested: value.cancelRequested };
}
function notify(origin?: object): void {
  const event: DependencySessionEvent = { activePath: operation?.active ? operation.sourcePath : null,
    sessionPath: operation?.sourcePath ?? null,
    operation: operation && copyOperation(operation), origin };
  for (const listener of listeners) listener(event);
}
