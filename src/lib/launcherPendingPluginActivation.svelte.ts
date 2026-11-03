export type PendingPluginActivation = {
  attemptId: number;
  pluginId: string;
  code: string;
  label: string;
  query: string;
  searchRunId: number;
};

export type PendingAwareResultSelect = ((index: number) => void | Promise<void>) & {
  readonly pendingPluginActivation?: PendingPluginActivation | null;
};

export function createLauncherPendingPluginActivationStore() {
  let nextAttemptId = 0;
  let current = $state<PendingPluginActivation | null>(null);

  return {
    get current() { return current; },
    begin(input: Omit<PendingPluginActivation, "attemptId">) {
      current = { ...input, attemptId: ++nextAttemptId };
      return current;
    },
    isCurrent(attempt: PendingPluginActivation) {
      return current?.attemptId === attempt.attemptId;
    },
    clear(attempt?: PendingPluginActivation) {
      if (!attempt || current?.attemptId === attempt.attemptId) current = null;
    },
    cancel() {
      if (!current) return false;
      current = null;
      nextAttemptId += 1;
      return true;
    },
  };
}

export type LauncherPendingPluginActivationStore = ReturnType<typeof createLauncherPendingPluginActivationStore>;
