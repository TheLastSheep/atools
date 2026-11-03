import {
  canRetrySearch,
  canRetrySearchFromPointer,
  shouldRetrySearchOnEnter,
  type SearchRetryEligibilityContext,
  type SearchRetryKeyContext,
} from "./searchFeedback";

export type SearchRetryEnterContext = Pick<
  SearchRetryKeyContext,
  | "key"
  | "isMainSearchFocused"
  | "isComposing"
  | "keyCode"
  | "metaKey"
  | "ctrlKey"
  | "altKey"
  | "shiftKey"
>;

type SearchRetryPorts = {
  current: () => SearchRetryEligibilityContext;
  /** Monotonic search ownership token (the launcher searchRunId). */
  searchGeneration: () => number;
  retry: (query: string) => void | Promise<void>;
  focusSearch: () => void;
  onError?: (error: unknown) => void;
};

/** Shares one live-state retry action between the surface button and Enter. */
export function createLauncherSearchRetryController(ports: SearchRetryPorts) {
  let nextAttempt = 0;
  let pending: { query: string; id: number; generation: number } | undefined;

  function retryCurrent(expectedQuery?: string, pointer = false): boolean {
    const state = ports.current();
    const currentGeneration = ports.searchGeneration();
    if (pending && (pending.generation !== currentGeneration || pending.query !== state.query)) pending = undefined;
    const eligible = pointer ? canRetrySearchFromPointer(state) : canRetrySearch(state);
    if (pending && state.feedback.showSpinner) return false;
    // Search completion can publish its retryable feedback just before the async
    // retry promise's finally callback clears `pending`. Terminal feedback is the
    // authoritative signal that another retry may start in this generation.
    if (pending) pending = undefined;
    if (!eligible || (expectedQuery !== undefined && expectedQuery !== state.query)) return false;

    const attempt = { query: state.query, id: ++nextAttempt, generation: currentGeneration };
    pending = attempt;
    try { ports.focusSearch(); } catch (error) { try { ports.onError?.(error); } catch { /* focus cannot block retry */ } }
    const settle = () => {
      if (pending?.id === attempt.id) pending = undefined;
    };
    try {
      const retryResult = ports.retry(attempt.query);
      // retry may synchronously start a new search and increment searchRunId.
      // Keep this attempt pending for that launched generation, not its caller.
      attempt.generation = ports.searchGeneration();
      void Promise.resolve(retryResult)
        .catch(error => { try { ports.onError?.(error); } catch { /* reporting cannot reopen the action */ } })
        .finally(settle);
    } catch (error) {
      try { ports.onError?.(error); } catch { /* reporting cannot reopen the action */ }
      settle();
    }
    return true;
  }

  return {
    retryFromPointer: () => retryCurrent(undefined, true),
    retryFromEnter(context: SearchRetryEnterContext) {
      const state = ports.current();
      if (!shouldRetrySearchOnEnter({ ...state, ...context })) return false;
      return retryCurrent(state.query);
    },
  };
}
