import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { get, writable, type Readable } from "svelte/store";

export type AppUpdaterPhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "error";

export type AppUpdateMetadata = {
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
};

export type AppUpdateProgress = {
  event: "downloading" | "installing";
  downloaded: number;
  total: number | null;
};

export type AppUpdaterState = {
  phase: AppUpdaterPhase;
  update: AppUpdateMetadata | null;
  checkedAt: string | null;
  downloaded: number;
  total: number | null;
  errorCode: string;
  errorMessage: string;
  promptVisible: boolean;
};

export type AppUpdaterError = {
  code: string;
  message: string;
};

export type AppUpdaterDependencies = {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(
    event: string,
    handler: (event: { payload: AppUpdateProgress }) => void,
  ): Promise<() => void>;
  setTimer(handler: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
  now(): Date;
  isDesktop(): boolean;
};

export type AppUpdaterController = {
  state: Readable<AppUpdaterState>;
  snapshot(): AppUpdaterState;
  check(source: "startup" | "manual"): Promise<AppUpdateMetadata | null>;
  scheduleStartupCheck(): () => void;
  installAndRestart(): Promise<void>;
  dismiss(): void;
  startProgressListener(): Promise<() => void>;
};

const initialState: AppUpdaterState = {
  phase: "idle",
  update: null,
  checkedAt: null,
  downloaded: 0,
  total: null,
  errorCode: "",
  errorMessage: "",
  promptVisible: false,
};

const defaultDependencies: AppUpdaterDependencies = {
  invoke: (command, args) => tauriInvoke(command, args),
  listen: async (event, handler) =>
    tauriListen<AppUpdateProgress>(event, (message) => handler(message)),
  setTimer: (handler, delay) => globalThis.setTimeout(handler, delay),
  clearTimer: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
  now: () => new Date(),
  isDesktop: () => {
    if (typeof window === "undefined") return false;
    const runtime = window as Window & {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
      __TAURI_IPC__?: unknown;
    };
    return (
      "__TAURI_INTERNALS__" in runtime ||
      "__TAURI__" in runtime ||
      "__TAURI_IPC__" in runtime
    );
  },
};

function normalizeUpdaterError(error: unknown): AppUpdaterError {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return { code: value.code, message: value.message };
    }
  }
  if (error instanceof Error) {
    return { code: "internal", message: error.message || "更新操作失败" };
  }
  if (typeof error === "string" && error.trim()) {
    return { code: "internal", message: error };
  }
  return { code: "internal", message: "更新操作失败" };
}

export function createAppUpdaterController(
  deps: AppUpdaterDependencies = defaultDependencies,
): AppUpdaterController {
  const store = writable<AppUpdaterState>({ ...initialState });
  let inFlightCheck: Promise<AppUpdateMetadata | null> | null = null;

  function setError(error: AppUpdaterError, promptVisible = false): void {
    store.update((state) => ({
      ...state,
      phase: "error",
      errorCode: error.code,
      errorMessage: error.message,
      promptVisible,
    }));
  }

  function check(source: "startup" | "manual"): Promise<AppUpdateMetadata | null> {
    if (inFlightCheck) return inFlightCheck;

    const operation = (async () => {
      if (!deps.isDesktop()) {
        const error = {
          code: "desktop_only",
          message: "检查更新仅在桌面应用中可用",
        };
        setError(error, false);
        throw error;
      }

      store.update((state) => ({
        ...state,
        phase: "checking",
        errorCode: "",
        errorMessage: "",
        promptVisible: false,
      }));
      try {
        const update = (await deps.invoke("check_app_update")) as AppUpdateMetadata | null;
        const checkedAt = deps.now().toISOString();
        store.update((state) => ({
          ...state,
          phase: update ? "available" : "up-to-date",
          update,
          checkedAt,
          downloaded: 0,
          total: null,
          errorCode: "",
          errorMessage: "",
          promptVisible: Boolean(update),
        }));
        return update;
      } catch (error) {
        const normalized = normalizeUpdaterError(error);
        setError(normalized, source === "manual" && get(store).promptVisible);
        throw normalized;
      }
    })();

    inFlightCheck = operation;
    void operation.finally(() => {
      if (inFlightCheck === operation) inFlightCheck = null;
    }).catch(() => undefined);
    return operation;
  }

  function scheduleStartupCheck(): () => void {
    const timer = deps.setTimer(() => {
      void check("startup").catch(() => undefined);
    }, 3000);
    return () => deps.clearTimer(timer);
  }

  async function installAndRestart(): Promise<void> {
    const current = get(store);
    if (!current.update) {
      const error = { code: "no_update", message: "没有可安装的更新" };
      setError(error, false);
      throw error;
    }
    if (!deps.isDesktop()) {
      const error = {
        code: "desktop_only",
        message: "安装更新仅在桌面应用中可用",
      };
      setError(error, false);
      throw error;
    }

    store.update((state) => ({
      ...state,
      phase: "downloading",
      downloaded: 0,
      total: null,
      errorCode: "",
      errorMessage: "",
      promptVisible: true,
    }));
    try {
      await deps.invoke("install_app_update", {
        expectedVersion: current.update.version,
      });
      store.update((state) => ({ ...state, phase: "restarting" }));
    } catch (error) {
      const normalized = normalizeUpdaterError(error);
      setError(normalized, true);
      throw normalized;
    }
  }

  function dismiss(): void {
    store.update((state) => ({ ...state, promptVisible: false }));
  }

  async function startProgressListener(): Promise<() => void> {
    if (!deps.isDesktop()) return () => undefined;
    return deps.listen("app-update-progress", ({ payload }) => {
      store.update((state) => ({
        ...state,
        phase: payload.event === "installing" ? "installing" : "downloading",
        downloaded: payload.downloaded,
        total: payload.total,
        promptVisible: true,
      }));
    });
  }

  return {
    state: { subscribe: store.subscribe },
    snapshot: () => get(store),
    check,
    scheduleStartupCheck,
    installAndRestart,
    dismiss,
    startProgressListener,
  };
}

export const appUpdater = createAppUpdaterController();
export const appUpdaterState = appUpdater.state;
