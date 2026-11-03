import type { NodeModuleTransport, NodePromiseState } from "./nodeModuleProtocol";

/**
 * Creates the bounded Promise-state polling operation used by the serialized
 * Node bridge. Keep this factory self-contained: nodeModuleBridgeScript embeds
 * its source into the isolated plugin frame.
 */
export function createNodePromisePolling(
  requestAsync: NodeModuleTransport["requestAsync"],
  isCurrent: () => boolean = () => true,
): (handleIds: readonly number[]) => Promise<Map<number, NodePromiseState> | undefined> {
  const maxBatchSize = 32;

  function failure(message: string, code: string): Error & { code: string } {
    const error = new Error(message) as Error & { code: string };
    error.name = "NodeModuleBridgeError";
    error.code = code;
    return error;
  }

  function exactKeys(value: unknown, expected: string[]): value is Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    return keys.length === expected.length && keys.every((key, index) => key === expected.slice().sort()[index]);
  }

  function validPromiseState(value: unknown): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const state = (value as { state?: unknown }).state;
    if (state === "pending") return exactKeys(value, ["state"]);
    if (state === "fulfilled") return exactKeys(value, ["state", "value"]);
    if (state !== "rejected" || !exactKeys(value, ["state", "error"])) return false;
    const error = (value as { error?: unknown }).error;
    if (!error || typeof error !== "object" || Array.isArray(error)) return false;
    const keys = Object.keys(error).sort();
    if (!(keys.length === 1 && keys[0] === "message")
      && !(keys.length === 2 && keys[0] === "code" && keys[1] === "message")) return false;
    const payload = error as { message?: unknown; code?: unknown };
    return typeof payload.message === "string" && (payload.code === undefined || typeof payload.code === "string");
  }

  function assertRequestIds(handleIds: readonly number[]): void {
    if (!Array.isArray(handleIds)) throw failure("Invalid Promise poll request", "ERR_ATOOLS_NODE_POLL_REQUEST");
    const seen = new Set<number>();
    for (const handleId of handleIds) {
      if (!Number.isSafeInteger(handleId) || handleId <= 0 || seen.has(handleId)) {
        throw failure("Invalid Promise poll request", "ERR_ATOOLS_NODE_POLL_REQUEST");
      }
      seen.add(handleId);
    }
  }

  function parseBatch(handleIds: number[], value: unknown): { states: Map<number, NodePromiseState>; fallback: number[] } {
    if (!exactKeys(value, ["states", "fallback"])) {
      throw failure("Invalid batched Promise poll response", "ERR_ATOOLS_NODE_POLL_RESPONSE");
    }
    const response = value as { states: unknown; fallback: unknown };
    if (!Array.isArray(response.states) || !Array.isArray(response.fallback)) {
      throw failure("Invalid batched Promise poll response", "ERR_ATOOLS_NODE_POLL_RESPONSE");
    }
    const requested = new Set(handleIds);
    const seen = new Set<number>();
    const states = new Map<number, NodePromiseState>();
    for (const entry of response.states) {
      if (!exactKeys(entry, ["handleId", "state"])) {
        throw failure("Invalid batched Promise poll state", "ERR_ATOOLS_NODE_POLL_RESPONSE");
      }
      const handleId = entry.handleId;
      if (!Number.isSafeInteger(handleId) || !requested.has(handleId as number) || seen.has(handleId as number)
        || !validPromiseState(entry.state)) {
        throw failure("Invalid batched Promise poll state", "ERR_ATOOLS_NODE_POLL_RESPONSE");
      }
      seen.add(handleId as number);
      states.set(handleId as number, entry.state as NodePromiseState);
    }
    const fallback: number[] = [];
    for (const handleId of response.fallback) {
      if (!Number.isSafeInteger(handleId) || !requested.has(handleId as number) || seen.has(handleId as number)) {
        throw failure("Invalid batched Promise poll fallback", "ERR_ATOOLS_NODE_POLL_RESPONSE");
      }
      seen.add(handleId as number);
      fallback.push(handleId as number);
    }
    if (seen.size !== requested.size) {
      throw failure("Batched Promise poll response omitted a handle", "ERR_ATOOLS_NODE_POLL_RESPONSE");
    }
    return { states, fallback };
  }

  async function requestSingle(handleId: number): Promise<NodePromiseState | undefined> {
    if (!isCurrent()) return undefined;
    let response: unknown;
    try {
      response = await requestAsync("pollPromise", { handleId });
    } catch (error) {
      if (!isCurrent()) return undefined;
      throw error;
    }
    if (!isCurrent()) return undefined;
    if (!validPromiseState(response)) {
      throw failure("Invalid Promise poll response", "ERR_ATOOLS_NODE_POLL_RESPONSE");
    }
    return response as NodePromiseState;
  }

  return async function poll(handleIds: readonly number[]): Promise<Map<number, NodePromiseState> | undefined> {
    if (!isCurrent()) return undefined;
    assertRequestIds(handleIds);
    const requested = [...handleIds];
    const result = new Map<number, NodePromiseState>();
    for (let offset = 0; offset < requested.length; offset += maxBatchSize) {
      if (!isCurrent()) return undefined;
      const batch = requested.slice(offset, offset + maxBatchSize);
      if (batch.length === 1) {
        const state = await requestSingle(batch[0]);
        if (!isCurrent() || state === undefined) return undefined;
        result.set(batch[0], state);
        continue;
      }

      let raw: unknown;
      try {
        raw = await requestAsync("pollPromises", { handleIds: batch });
      } catch (error) {
        if (!isCurrent()) return undefined;
        throw error;
      }
      if (!isCurrent()) return undefined;
      const parsed = parseBatch(batch, raw);
      for (const [handleId, state] of parsed.states) result.set(handleId, state);
      for (const handleId of parsed.fallback) {
        if (!isCurrent()) return undefined;
        const state = await requestSingle(handleId);
        if (!isCurrent() || state === undefined) return undefined;
        result.set(handleId, state);
      }
    }
    if (!isCurrent()) return undefined;
    const ordered = new Map<number, NodePromiseState>();
    for (const handleId of requested) {
      const state = result.get(handleId);
      if (state !== undefined) ordered.set(handleId, state);
    }
    return ordered;
  };
}
