import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";
import { get, writable, type Readable } from "svelte/store";
import { validLegacyStatus, validUpdate } from "./appUpdateWire";

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
  candidateId: string;
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
    handler: (event: { payload: unknown }) => void,
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
    tauriListen<unknown>(event, (message) => handler(message)),
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
  let statusEpoch = 0;
  let lifecycleEpoch = 0;
  let explicitIntent = false;
  let autoEnabled = false;
  let preferenceReady = false;
  let dismissedCandidate: string | null = null;

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
    if (source === "manual") explicitIntent = true;
    if (inFlightCheck) return inFlightCheck;

    const epoch = statusEpoch;
    const lifecycle = lifecycleEpoch;
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
        const update = await deps.invoke("check_app_update");
        if (update !== null && !validUpdate(update)) throw { code: "invalid_response", message: "更新信息无效" };
        if (lifecycle !== lifecycleEpoch) return update;
        if (epoch !== statusEpoch) {
          if (explicitIntent && update) store.update(state => ({ ...state, promptVisible: true }));
          return update;
        }
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
          promptVisible: Boolean(update) && (explicitIntent || autoEnabled),
        }));
        return update;
      } catch (error) {
        const normalized = normalizeUpdaterError(error);
        if (lifecycle === lifecycleEpoch) setError(normalized, explicitIntent && get(store).promptVisible);
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
    if (!deps.isDesktop()) return () => undefined;
    let active = true, unlisten: (() => void) | undefined, unlistenPreferences: (() => void) | undefined, eventEpoch = 0, preferenceEpoch = 0;
    function applyPreference(raw: unknown): void {
      if (!active || (raw !== null && typeof raw !== "string")) return;
      try {
        const value = raw === null ? {} : JSON.parse(raw);
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const wasEnabled = autoEnabled, first = !preferenceReady;
        autoEnabled = value.autoCheckUpdate === undefined || value.autoCheckUpdate === true;
        preferenceReady = true;
        if (!first && !wasEnabled && autoEnabled) dismissedCandidate = null;
        if (!explicitIntent) store.update(state => {
          if (state.phase !== "available" || !state.update) return state;
          if (!autoEnabled) return state.promptVisible ? { ...state, promptVisible: false } : state;
          if ((first || !wasEnabled) && state.update.candidateId !== dismissedCandidate) return { ...state, promptVisible: true };
          return state;
        });
      } catch { /* Invalid preferences never enable automatic prompts. */ }
    }
    function applyStatus(value: unknown): void {
      if (!active || !validLegacyStatus(value)) return;
      const status = value;
      if (status.lastError) { setError(status.lastError, explicitIntent); return; }
      store.update(state => ({ ...state, update: status.update ?? null,
        phase: status.operation === "checking" ? "checking" : status.operation === "installing" ? "installing" : status.operation === "restarting" ? "restarting" : status.update ? "available" : status.checked ? "up-to-date" : "idle",
        promptVisible: Boolean(status.update) && (explicitIntent || autoEnabled || ["downloading", "installing", "restarting"].includes(state.phase)), errorCode: "", errorMessage: "" }));
    }
    void deps.listen("atools://renderer-general-settings", ({ payload }) => {
      if (payload && typeof payload === "object" && "raw" in payload) { preferenceEpoch++; applyPreference(payload.raw); }
    }).then(stop => { if (!active) {stop(); return;} unlistenPreferences = stop; const epoch = preferenceEpoch;
      return deps.invoke("get_setting", {key:"settings-general"}).then(raw => {if (epoch === preferenceEpoch) applyPreference(raw);});
    }).catch(() => undefined);
    void deps.listen("app-update-status", ({ payload }) => { if (validLegacyStatus(payload)) { eventEpoch++; statusEpoch++; applyStatus(payload); } }).then(async stop => {
      if (!active) { stop(); return; }
      unlisten = stop;
      const epoch = eventEpoch;
      const result = await deps.invoke("startup_app_update");
      if (epoch === eventEpoch) applyStatus(result);
    }).catch(() => undefined);
    return () => {
      if (!active) return;
      active = false;
      statusEpoch++;
      lifecycleEpoch++;
      explicitIntent = false;
      store.update(state => state.phase === "checking"
        ? { ...state, phase: state.update ? "available" : state.checkedAt ? "up-to-date" : "idle", promptVisible: false }
        : state);
      unlisten?.();
      unlistenPreferences?.();
    };
  }

  async function installAndRestart(): Promise<void> {
    explicitIntent = true;
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
        expectedCandidateId: current.update.candidateId,
      });
      store.update((state) => ({ ...state, phase: "restarting" }));
    } catch (error) {
      const normalized = normalizeUpdaterError(error);
      setError(normalized, true);
      throw normalized;
    }
  }

  function dismiss(): void {
    dismissedCandidate = get(store).update?.candidateId ?? null;
    explicitIntent = false;
    store.update((state) => ({ ...state, promptVisible: false }));
  }

  async function startProgressListener(): Promise<() => void> {
    if (!deps.isDesktop()) return () => undefined;
    return deps.listen("app-update-progress", ({ payload: value }) => {
      const payload = value as AppUpdateProgress;
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
