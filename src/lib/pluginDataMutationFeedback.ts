/**
 * Tracks one safely identifiable failed data mutation and clears its notice only
 * after a newer successful mutation to the same target in the same session.
 */
export function createPluginDataMutationFeedback(
  operationFeedback?: { failed: () => void; resolved: () => void },
) {
  let mutationSequence = 0;
  let activeGeneration: number | undefined;
  let mutationState: { generation: number; sequence: number; identity?: string; status: "pending" | "succeeded" | "failed";
    failureSequence?: number; failureClearable: boolean } | undefined;
  const mutatingOperations = new Set([
    "db.put", "db.remove", "db.bulkDocs", "db.postAttachment", "db.putAttachment",
    "dbStorage.setItem", "dbStorage.removeItem",
    "webStorage.setItem", "webStorage.removeItem", "webStorage.clear",
    "features.set", "features.remove", "startup.set",
  ]);

  // Only retain a bounded direct key. URL-scoped webStorage and batch/attachment
  // writes stay manual-dismiss-only because they have no safe single target ID.
  function mutationIdentity(method: string, args: unknown[]) {
    let namespace: string | undefined, candidate: unknown;
    if (method === "db.put" || method === "db.remove") {
      const document = args[0];
      namespace = "db";
      candidate = typeof document === "string" ? document
        : document && typeof document === "object" ? (document as { _id?: unknown })._id : undefined;
    } else if (method === "dbStorage.setItem" || method === "dbStorage.removeItem") {
      namespace = "dbStorage";
      candidate = args[0];
    }
    if (!namespace || typeof candidate !== "string" || !candidate || candidate !== candidate.trim()
      || /[\s\0/\\]/u.test(candidate) || candidate.includes("://")
      || /^(?:https?|file|data|blob):/iu.test(candidate)
      || /(?:^|[._:-])(?:token|secret|bearer|authorization)(?:$|[._:-])/iu.test(candidate)
      || (!candidate.includes(":") && (/^[a-f0-9]{32,}$/iu.test(candidate) || /^[A-Za-z0-9_-]{43,}={0,2}$/u.test(candidate)))) {
      return undefined;
    }
    const identity = namespace + ":" + candidate;
    return identity.length <= 512 ? identity : undefined;
  }

  function begin(method: string, args: unknown[], current: number) {
    if (!mutatingOperations.has(method)) return undefined;
    if (activeGeneration === undefined) activeGeneration = current;
    const sequence = ++mutationSequence;
    const identity = mutationIdentity(method, args);
    const state = mutationState;
    if (state?.failureSequence !== undefined) {
      if (state.generation === current && state.failureClearable && identity && state.identity === identity) {
        state.sequence = sequence;
        state.status = "pending";
      } else if (state.generation === current && state.failureClearable && state.identity) {
        // Keep the failed target so a later retry of that target can clear it;
        // a different target's success is checked and ignored at completion.
      } else {
        // A different target or a new session makes the one tracked failure
        // ambiguous only when its own failure arrives. Keep the notice safe.
        state.identity = undefined;
        state.failureClearable = false;
      }
      return sequence;
    }
    mutationState = { generation: current, sequence, identity, status: "pending", failureClearable: false };
    return sequence;
  }

  function failed(method: string, args: unknown[], current: number, sequence: number | undefined) {
    if (!mutatingOperations.has(method) || sequence === undefined || current !== activeGeneration) return;
    const identity = mutationIdentity(method, args);
    const state = mutationState;
    if (state?.generation === current && state.sequence === sequence) state.status = "failed";
    if (state?.generation === current && state.identity && state.identity === identity
      && state.sequence > sequence && state.status === "succeeded") return;

    if (state?.generation === current && state.failureSequence !== undefined) {
      if (state.failureClearable && identity && state.identity === identity) {
        if (sequence > state.failureSequence) state.failureSequence = sequence;
      } else {
        state.identity = undefined;
        state.failureClearable = false;
        if (sequence > state.failureSequence) state.failureSequence = sequence;
      }
    } else if (state?.generation === current && identity && state.identity === identity) {
      state.failureSequence = sequence;
      state.failureClearable = true;
    } else {
      mutationState = { generation: current, sequence, status: "failed", failureSequence: sequence, failureClearable: false };
    }
    try { operationFeedback?.failed(); } catch { /* UI feedback must never replace the data error. */ }
  }

  function resolved(method: string, args: unknown[], current: number, sequence: number | undefined) {
    if (sequence === undefined || !mutatingOperations.has(method) || current !== activeGeneration) return;
    const identity = mutationIdentity(method, args);
    const state = mutationState;
    if (state?.generation === current && state.sequence === sequence) state.status = "succeeded";
    if (!state || state.generation !== current || state.failureSequence === undefined || !state.failureClearable
      || !identity || state.identity !== identity || sequence <= state.failureSequence) return;
    state.failureSequence = undefined;
    state.failureClearable = false;
    try { operationFeedback?.resolved(); } catch { /* Feedback cleanup cannot replace a successful data result. */ }
  }

  return {
    begin,
    failed,
    resolved,
    generationChanged(current: number) {
      activeGeneration = current;
      if (mutationState?.failureSequence !== undefined) {
        mutationState.identity = undefined;
        mutationState.failureClearable = false;
      } else mutationState = undefined;
    },
    close() {
      activeGeneration = undefined;
      mutationState = undefined;
    },
  };
}
