import { openSettingsEditingSession } from "./settingsEditingSession";

type SettingsEditingPhase = "loading" | "ready" | "error";
type EditingSession = Awaited<ReturnType<typeof openSettingsEditingSession>>;

type CreateSettingsEditingLifecycleOptions = {
  onPhaseChange: (phase: SettingsEditingPhase) => void;
  openSession?: typeof openSettingsEditingSession;
  timeoutMs?: number;
};

export function createSettingsEditingLifecycle({
  onPhaseChange,
  openSession = openSettingsEditingSession,
  timeoutMs = 5_000,
}: CreateSettingsEditingLifecycleOptions) {
  let generation = 0;
  let disposed = false;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let controller: AbortController | null = null;
  let session: EditingSession | null = null;

  function clearTimeoutIfPending() {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
  }

  function closeQuietly(ownedSession: EditingSession) {
    try {
      ownedSession.close();
    } catch {
      // The lifecycle owns only this view's read lease; keep native details out of UI state.
    }
  }

  function releaseCurrentRead() {
    const activeController = controller;
    const activeSession = session;
    controller = null;
    session = null;
    activeController?.abort();
    if (activeSession) closeQuietly(activeSession);
  }

  function failRead(requestGeneration: number, requestController: AbortController) {
    if (disposed || requestGeneration !== generation) return;
    clearTimeoutIfPending();
    generation += 1;
    if (controller === requestController) controller = null;
    requestController.abort();
    onPhaseChange("error");
  }

  function start() {
    if (disposed) return;
    clearTimeoutIfPending();
    generation += 1;
    releaseCurrentRead();

    const requestGeneration = generation;
    const requestController = new AbortController();
    controller = requestController;
    onPhaseChange("loading");
    timeout = setTimeout(() => {
      if (disposed || requestGeneration !== generation) return;
      timeout = null;
      failRead(requestGeneration, requestController);
    }, timeoutMs);

    let pendingSession: ReturnType<typeof openSettingsEditingSession>;
    try {
      pendingSession = openSession({ signal: requestController.signal });
    } catch {
      failRead(requestGeneration, requestController);
      return;
    }

    void Promise.resolve(pendingSession).then((openedSession) => {
      if (disposed || requestGeneration !== generation || requestController.signal.aborted) {
        closeQuietly(openedSession);
        return;
      }
      clearTimeoutIfPending();
      session = openedSession;
      onPhaseChange("ready");
    }).catch(() => {
      failRead(requestGeneration, requestController);
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    generation += 1;
    clearTimeoutIfPending();
    releaseCurrentRead();
  }

  return { start, dispose };
}
