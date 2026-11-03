export type RendererWindowNotificationCommand = "expand_window" | "hide_main_window";

export interface RendererWindowNotificationsSnapshot {
  pendingReplies: number;
  failures: number;
  cancelled: number;
  dropped: number;
}

export interface RendererWindowNotifications {
  resizeWindow(height: number): void;
  hideWindow(): void;
  snapshot(): RendererWindowNotificationsSnapshot;
}

const DISPOSED_CODE = "ERR_ATOOLS_ZTOOLS_DISPOSED";

export function createRendererWindowNotifications(
  send: (
    command: RendererWindowNotificationCommand,
    args?: Record<string, unknown>,
  ) => Promise<unknown>,
  isDisposed: () => boolean,
  beforeHide?: () => () => void,
): RendererWindowNotifications {
  let pendingReplies = 0;
  let failures = 0;
  let cancelled = 0;
  let dropped = 0;

  function rejectAsDisposed(error: unknown): boolean {
    try {
      return typeof error === "object" && error !== null
        && (error as { code?: unknown }).code === DISPOSED_CODE;
    } catch {
      return false;
    }
  }

  function shouldDrop(): boolean {
    try {
      if (!isDisposed()) return false;
    } catch {
      failures += 1;
      return true;
    }

    dropped += 1;
    return true;
  }

  function recordFailure(error: unknown): void {
    if (rejectAsDisposed(error)) cancelled += 1;
    else failures += 1;
  }

  function sendLive(
    command: RendererWindowNotificationCommand,
    args?: Record<string, unknown>,
    onFailure?: () => void,
  ): void {
    let pending: Promise<unknown>;
    try {
      pending = Promise.resolve(send(command, args));
    } catch (error) {
      recordFailure(error);
      onFailure?.();
      return;
    }

    pendingReplies += 1;
    void pending.then(
      () => {
        pendingReplies -= 1;
      },
      (error: unknown) => {
        pendingReplies -= 1;
        recordFailure(error);
        onFailure?.();
      },
    );
  }

  return {
    resizeWindow(height) {
      if (shouldDrop()) return;
      if (!Number.isInteger(height) || height < 1 || height > 10_000) {
        failures += 1;
        return;
      }
      sendLive("expand_window", { height });
    },

    hideWindow() {
      if (shouldDrop()) return;
      sendLive("hide_main_window", undefined, beforeHide?.());
    },

    snapshot() {
      return { pendingReplies, failures, cancelled, dropped };
    },
  };
}
