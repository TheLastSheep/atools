export type PluginPanelLoadRetryPhase = "idle" | "loading" | "failed" | "retrying" | "ready" | "terminal" | "closed";

export type PluginPanelLoadRetrySnapshot = {
  generation: number | null;
  phase: PluginPanelLoadRetryPhase;
  error: string | null;
  retryable: boolean;
  busy: boolean;
};

export type PluginPanelLoadRetryController = ReturnType<typeof createPluginPanelLoadRetryController>;

/** Owns only the failed-panel retry gate; PluginPanel remains the generation authority. */
export function createPluginPanelLoadRetryController(onChange: (state: PluginPanelLoadRetrySnapshot) => void) {
  let generation: number | null = null;
  let phase: PluginPanelLoadRetryPhase = "idle";
  let error: string | null = null;
  let retryToken: number | null = null;
  let nextRetryToken = 0;

  const snapshot = (): PluginPanelLoadRetrySnapshot => ({
    generation,
    phase,
    error,
    // Keep the same retry button mounted while the explicit retry is busy.
    // requestRetry still accepts only `failed`, so this is presentation state,
    // not permission to start another attempt.
    retryable: phase === "failed" || phase === "retrying",
    busy: phase === "retrying",
  });
  const publish = () => onChange(snapshot());
  const owns = (attemptGeneration: number) => generation === attemptGeneration;

  function beginAutomatic(nextGeneration: number) {
    if (generation !== null && nextGeneration <= generation) return false;
    generation = nextGeneration;
    phase = "loading";
    error = null;
    retryToken = null;
    publish();
    return true;
  }

  function requestRetry(expectedGeneration: number) {
    if (!owns(expectedGeneration) || phase !== "failed" || retryToken !== null) return null;
    retryToken = ++nextRetryToken;
    phase = "retrying";
    publish();
    return retryToken;
  }

  function beginRetry(nextGeneration: number, token: number) {
    if (phase !== "retrying" || retryToken !== token || generation === null || nextGeneration <= generation) return false;
    generation = nextGeneration;
    publish();
    return true;
  }

  function succeed(attemptGeneration: number) {
    if (!owns(attemptGeneration) || phase === "terminal" || phase === "closed") return false;
    phase = "ready";
    error = null;
    retryToken = null;
    publish();
    return true;
  }

  function fail(attemptGeneration: number, message: string) {
    if (!owns(attemptGeneration) || (phase !== "loading" && phase !== "retrying")) return false;
    phase = "failed";
    error = message;
    retryToken = null;
    publish();
    return true;
  }

  function terminal(attemptGeneration: number, message: string) {
    if (!owns(attemptGeneration) || phase === "closed") return false;
    phase = "terminal";
    error = message;
    retryToken = null;
    publish();
    return true;
  }

  function invalidate(nextGeneration: number) {
    if (generation !== null && nextGeneration < generation) return false;
    generation = nextGeneration;
    phase = "closed";
    error = null;
    retryToken = null;
    publish();
    return true;
  }

  return { snapshot, beginAutomatic, requestRetry, beginRetry, succeed, fail, terminal, invalidate };
}
