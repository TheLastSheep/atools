import {
  adapterDisposedError,
  HOST_ERROR_CODES,
  invalidRendererArgument,
  invalidRendererResponse,
  ZToolsRendererHostError,
} from "./errors";

export type RendererWindowDragRequest =
  | { operation: "position" }
  | { operation: "lock"; locked: boolean }
  | { operation: "move"; x: number; y: number };

export interface RendererWindowPosition {
  x: number;
  y: number;
}

export interface RendererWindowDragSnapshot {
  disposed: boolean;
  pending: number;
  queued: number;
  inFlight: RendererWindowDragRequest["operation"] | null;
  pendingPositionReads: number;
  queuedMoves: number;
  queuedLocks: number;
  positionReads: number;
  moveRequests: number;
  lockRequests: number;
  dispatchedPositions: number;
  dispatchedMoves: number;
  dispatchedLocks: number;
  coalescedMoves: number;
  rejectedOperations: number;
  failures: number;
  cancelledReads: number;
  droppedAfterDispose: number;
}

export interface RendererWindowDrag {
  getWindowPosition(): Promise<RendererWindowPosition>;
  setWindowPosition(x: number, y: number): void;
  setWindowSizeLock(locked: boolean): void;
  snapshot(): RendererWindowDragSnapshot;
  dispose(): void;
}

type PositionWaiter = {
  resolve(position: RendererWindowPosition): void;
  reject(error: unknown): void;
};
type PositionOperation = { operation: "position"; waiters: PositionWaiter[] };
type LockOperation = { operation: "lock"; locked: boolean };
type MoveOperation = { operation: "move"; x: number; y: number };
type Operation = PositionOperation | LockOperation | MoveOperation;
type Send = (request: RendererWindowDragRequest) => Promise<unknown>;

const MAX_QUEUED_OPERATIONS = 18;
const MAX_LOCK_BARRIERS = 8;
const MAX_POSITION_WAITERS = 32;

/** Serialize drag controls while retaining only the latest mousemove per barrier. */
export function createRendererWindowDrag(send: Send): RendererWindowDrag {
  const queue: Operation[] = [];
  let inFlight: Operation | undefined;
  let disposed = false;
  let coalescedMoves = 0;
  let rejectedOperations = 0;
  let failures = 0;
  let cancelledReads = 0;
  let droppedAfterDispose = 0;
  let positionReads = 0;
  let moveRequests = 0;
  let lockRequests = 0;
  let dispatchedPositions = 0;
  let dispatchedMoves = 0;
  let dispatchedLocks = 0;

  function positionWaiters(operation: Operation | undefined): number {
    return operation?.operation === "position" ? operation.waiters.length : 0;
  }

  function pendingLockState(): boolean | undefined {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const operation = queue[index];
      if (operation.operation === "lock") return operation.locked;
    }
    if (inFlight?.operation === "lock") return inFlight.locked;
    return undefined;
  }

  function hasMoveAfterLastLock(): boolean {
    const operations = [inFlight, ...queue].filter((operation): operation is Operation => Boolean(operation));
    let lastLock = -1;
    operations.forEach((operation, index) => {
      if (operation.operation === "lock") lastLock = index;
    });
    return operations.slice(lastLock + 1).some((operation) => operation.operation === "move");
  }

  function lockCount(): number {
    let count = inFlight?.operation === "lock" ? 1 : 0;
    for (const operation of queue) if (operation.operation === "lock") count += 1;
    return count;
  }

  function addOperation(operation: Operation): boolean {
    if (queue.length >= MAX_QUEUED_OPERATIONS) {
      rejectedOperations += 1;
      return false;
    }
    queue.push(operation);
    pump();
    return true;
  }

  function makeRoomForUnlock(): void {
    const positionReads = queue.filter((operation): operation is PositionOperation =>
      operation.operation === "position");
    let dropped = queue.length - positionReads.length;
    if (positionReads.length >= MAX_QUEUED_OPERATIONS) {
      const removed = positionReads.splice(MAX_QUEUED_OPERATIONS - 1);
      dropped += removed.length;
      const error = invalidRendererArgument("Window drag queue is full");
      for (const operation of removed) rejectPosition(operation, error);
    }
    rejectedOperations += dropped;
    queue.splice(0, queue.length, ...positionReads);
  }

  function enqueuePositionWaiter(waiter: PositionWaiter): void {
    const last = queue[queue.length - 1];
    const joinable = last?.operation === "position"
      ? last
      : queue.length === 0 && inFlight?.operation === "position" ? inFlight : undefined;
    if (joinable?.operation === "position") {
      if (joinable.waiters.length >= MAX_POSITION_WAITERS) {
        rejectedOperations += 1;
        waiter.reject(invalidRendererArgument("Window position read limit reached"));
        return;
      }
      joinable.waiters.push(waiter);
      return;
    }
    const operation: PositionOperation = { operation: "position", waiters: [waiter] };
    if (!addOperation(operation)) {
      waiter.reject(invalidRendererArgument("Window drag queue is full"));
    }
  }

  function validCoordinate(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value)
      && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  }

  function invalidResponse(): ZToolsRendererHostError {
    return invalidRendererResponse("Invalid native window drag response");
  }

  function readPosition(value: unknown): RendererWindowPosition {
    try {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw invalidResponse();
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) throw invalidResponse();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== 2 || !keys.includes("x") || !keys.includes("y")) throw invalidResponse();
      const x = Object.getOwnPropertyDescriptor(value, "x");
      const y = Object.getOwnPropertyDescriptor(value, "y");
      if (!x?.enumerable || !y?.enumerable || !("value" in x) || !("value" in y)
        || !validCoordinate(x.value) || !validCoordinate(y.value)) throw invalidResponse();
      return { x: x.value, y: y.value };
    } catch {
      throw invalidResponse();
    }
  }

  function recordFailure(error: unknown): void {
    if (isDisposedError(error)) return;
    failures += 1;
  }

  function isDisposedError(error: unknown): boolean {
    try {
      return typeof error === "object" && error !== null
        && (error as { code?: unknown }).code === HOST_ERROR_CODES.DISPOSED;
    } catch {
      return false;
    }
  }

  function requestFor(operation: Operation): RendererWindowDragRequest {
    if (operation.operation === "position") return { operation: "position" };
    if (operation.operation === "lock") return { operation: "lock", locked: operation.locked };
    return { operation: "move", x: operation.x, y: operation.y };
  }

  function settlePosition(operation: PositionOperation, result: unknown): void {
    const position = readPosition(result);
    for (const waiter of operation.waiters) waiter.resolve({ ...position });
    operation.waiters.length = 0;
  }

  function rejectPosition(operation: PositionOperation, error: unknown): void {
    for (const waiter of operation.waiters) waiter.reject(error);
    operation.waiters.length = 0;
  }

  function finish(operation: Operation, result: unknown, error?: unknown, failed = false): void {
    if (inFlight !== operation) return;
    inFlight = undefined;
    if (disposed) return;

    if (failed) {
      recordFailure(error);
      if (operation.operation === "position") rejectPosition(operation, error);
      pump();
      return;
    }

    try {
      if (operation.operation === "position") {
        settlePosition(operation, result);
      } else {
        if (result !== null) throw invalidResponse();
      }
    } catch (failure) {
      failures += 1;
      if (operation.operation === "position") rejectPosition(operation, failure);
    }
    pump();
  }

  function pump(): void {
    if (disposed || inFlight || queue.length === 0) return;
    const operation = queue.shift()!;
    inFlight = operation;
    if (operation.operation === "position") dispatchedPositions += 1;
    else if (operation.operation === "move") dispatchedMoves += 1;
    else dispatchedLocks += 1;
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(send(requestFor(operation)));
    } catch (error) {
      finish(operation, undefined, error, true);
      return;
    }
    void pending.then(
      (result) => finish(operation, result),
      (error: unknown) => finish(operation, undefined, error, true),
    );
  }

  function getWindowPosition(): Promise<RendererWindowPosition> {
    if (disposed) {
      droppedAfterDispose += 1;
      const rejected = Promise.reject<RendererWindowPosition>(adapterDisposedError());
      void rejected.catch(() => undefined);
      return rejected;
    }
    positionReads += 1;
    const promise = new Promise<RendererWindowPosition>((resolve, reject) => {
      const operation: PositionWaiter = { resolve, reject };
      enqueuePositionWaiter(operation);
    });
    // The original Vue handler does not await the mousedown callback's promise.
    void promise.catch(() => undefined);
    return promise;
  }

  function setWindowPosition(x: number, y: number): void {
    if (disposed) {
      droppedAfterDispose += 1;
      return;
    }
    if (!validCoordinate(x) || !validCoordinate(y)) {
      rejectedOperations += 1;
      return;
    }
    moveRequests += 1;
    const last = queue[queue.length - 1];
    if (last?.operation === "move") {
      last.x = x;
      last.y = y;
      coalescedMoves += 1;
      return;
    }
    addOperation({ operation: "move", x, y });
  }

  function setWindowSizeLock(locked: boolean): void {
    if (disposed) {
      droppedAfterDispose += 1;
      return;
    }
    if (typeof locked !== "boolean") {
      rejectedOperations += 1;
      return;
    }
    lockRequests += 1;
    if (pendingLockState() === locked && !hasMoveAfterLastLock()) return;
    if (locked && lockCount() >= MAX_LOCK_BARRIERS) {
      rejectedOperations += 1;
      return;
    }
    if (!locked && (lockCount() >= MAX_LOCK_BARRIERS || queue.length >= MAX_QUEUED_OPERATIONS)) {
      makeRoomForUnlock();
    }
    addOperation({ operation: "lock", locked });
  }

  function snapshot(): RendererWindowDragSnapshot {
    const queuedMoves = queue.filter((operation) => operation.operation === "move").length;
    const queuedLocks = queue.filter((operation) => operation.operation === "lock").length;
    const pendingPositionReads = positionWaiters(inFlight)
      + queue.reduce((count, operation) => count + positionWaiters(operation), 0);
    return {
      disposed,
      pending: queue.length + Number(inFlight !== undefined),
      queued: queue.length,
      inFlight: inFlight?.operation ?? null,
      pendingPositionReads,
      queuedMoves,
      queuedLocks,
      positionReads,
      moveRequests,
      lockRequests,
      dispatchedPositions,
      dispatchedMoves,
      dispatchedLocks,
      coalescedMoves,
      rejectedOperations,
      failures,
      cancelledReads,
      droppedAfterDispose,
    };
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const operation of queue) {
      if (operation.operation === "position") {
        cancelledReads += operation.waiters.length;
        rejectPosition(operation, adapterDisposedError());
      }
    }
    queue.length = 0;
    if (inFlight?.operation === "position") {
      cancelledReads += inFlight.waiters.length;
      rejectPosition(inFlight, adapterDisposedError());
    }
  }

  return { getWindowPosition, setWindowPosition, setWindowSizeLock, snapshot, dispose };
}
