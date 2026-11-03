export const WINDOW_RESIZE_FAILURE_NOTICE = "窗口大小调整失败";

type Ports = {
  hasRuntime: () => boolean;
  invokeResize: (height: number) => Promise<void>;
};

export type LauncherWindowResize = {
  resize: (height: number) => Promise<void>;
  readonly notice: string | null;
  dismiss: () => void;
  dispose: () => void;
};

const MAX_NATIVE_HEIGHT = 0xffff_ffff;

/** Keeps resize errors observable without leaking backend details or rejecting UI event handlers. */
export function createLauncherWindowResize(ports: Ports): LauncherWindowResize {
  let notice = $state<string | null>(null);
  let requestId = 0;
  let disposed = false;

  function current(id: number) {
    return !disposed && id === requestId;
  }

  async function resize(height: number): Promise<void> {
    if (disposed) return;
    const id = ++requestId;

    let available: boolean;
    try {
      available = ports.hasRuntime();
    } catch {
      if (current(id)) notice = WINDOW_RESIZE_FAILURE_NOTICE;
      return;
    }
    if (!available) return;

    if (!Number.isFinite(height)) {
      if (current(id)) notice = WINDOW_RESIZE_FAILURE_NOTICE;
      return;
    }
    const roundedHeight = Math.round(height);
    if (!Number.isSafeInteger(roundedHeight) || roundedHeight < 0 || roundedHeight > MAX_NATIVE_HEIGHT) {
      if (current(id)) notice = WINDOW_RESIZE_FAILURE_NOTICE;
      return;
    }

    try {
      await ports.invokeResize(roundedHeight);
      if (current(id)) notice = null;
    } catch {
      if (current(id)) notice = WINDOW_RESIZE_FAILURE_NOTICE;
    }
  }

  return {
    resize,
    get notice() { return notice; },
    dismiss() { if (!disposed) notice = null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      requestId += 1;
      notice = null;
    },
  };
}
