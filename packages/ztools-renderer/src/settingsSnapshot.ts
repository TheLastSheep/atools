import {
  adapterDisposedError,
  HOST_ERROR_CODES,
  invalidRendererResponse,
  ZToolsRendererHostError,
} from "./errors";
import { exactEventRecord } from "./safeEventRecord";
import { NAMESPACED_READ_KEYS } from "./startupReadModel";
import { RENDERER_COMMAND_ALIASES_MAX_BYTES } from "./commandInvalidationEvents";
import { createSettingsGenerations } from "./settingsGenerations";
import type { SettingsGeneration, SettingsGenerations } from "./settingsGenerations";
import { utf8ByteLength } from "./utf8";

const MAX_GENERAL_BYTES = 64 * 1024;
const MAX_NAMESPACED_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024;
const COMMAND_ALIASES_KEY = "ztools-renderer:command-aliases";

const NATIVE_KEYS = [
  "settings-general",
  ...[...NAMESPACED_READ_KEYS].map((key) => `ztools-renderer:${key}`),
];
const NATIVE_KEY_SET = new Set(NATIVE_KEYS);

type SettingsValues = ReadonlyMap<string, string | null>;
type DisposeListener = (error: ZToolsRendererHostError) => void;

export interface RendererSettingsSnapshotDiagnostics {
  cached: number;
  inFlight: boolean;
  requests: number;
  failures: number;
  disposed: boolean;
}

export interface RendererSettingsSnapshot {
  read(nativeKey: string): Promise<string | null>;
  snapshot(): RendererSettingsSnapshotDiagnostics;
  dispose(): void;
}

export function createRendererSettingsSnapshot(
  load: () => Promise<unknown>,
  generations: SettingsGenerations = createSettingsGenerations(),
): RendererSettingsSnapshot {
  let values: SettingsValues | undefined;
  let valuesGeneration: SettingsGeneration | undefined;
  let pending: {
    generation: SettingsGeneration;
    promise: Promise<SettingsValues>;
  } | undefined;
  let requests = 0;
  let failures = 0;
  let disposed = false;
  const disposeListeners = new Set<DisposeListener>();

  function unsupportedSetting(): ZToolsRendererHostError {
    return new ZToolsRendererHostError(
      HOST_ERROR_CODES.UNSUPPORTED,
      "ATools does not provide this renderer setting",
    );
  }

  function waitUnlessDisposed<T>(promise: Promise<T>): Promise<T> {
    if (disposed) return Promise.reject(adapterDisposedError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => disposeListeners.delete(onDispose);
      const onDispose: DisposeListener = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };

      disposeListeners.add(onDispose);
      promise.then(
        (value) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (disposed) reject(adapterDisposedError());
          else resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        },
      );
    });
  }

  function startLoad(): {
    generation: SettingsGeneration;
    promise: Promise<SettingsValues>;
  } {
    requests += 1;
    const generation = generations.capture();
    let request: Promise<SettingsValues>;
    request = Promise.resolve()
      .then(load)
      .then(validateSnapshot)
      .then((nextValues) => {
        if (disposed) throw adapterDisposedError();
        values = nextValues;
        valuesGeneration = generation;
        return nextValues;
      })
      .catch(() => {
        if (disposed) throw adapterDisposedError();
        failures += 1;
        throw invalidResponse();
      })
      .finally(() => {
        if (pending?.promise === request) {
          pending = undefined;
        }
      });
    const entry = { generation, promise: request };
    pending = entry;
    return entry;
  }

  function read(nativeKey: string): Promise<string | null> {
    if (disposed) return Promise.reject(adapterDisposedError());
    if (!NATIVE_KEY_SET.has(nativeKey)) return Promise.reject(unsupportedSetting());

    if (values && generations.isCurrent(nativeKey, valuesGeneration)) {
      const value = values.get(nativeKey);
      return value === undefined ? Promise.reject(invalidResponse()) : Promise.resolve(value);
    }
    const request = pending ?? startLoad();
    return waitUnlessDisposed(request.promise.then(
      (loaded) => {
        if (!generations.isCurrent(nativeKey, request.generation)) return read(nativeKey);
        const value = loaded.get(nativeKey);
        if (value === undefined) throw invalidResponse();
        return value;
      },
      (error: unknown) => {
        if (!generations.isCurrent(nativeKey, request.generation)) return read(nativeKey);
        throw error;
      },
    ));
  }

  return {
    read,
    snapshot() {
      return {
        cached: values?.size ?? 0,
        inFlight: pending !== undefined,
        requests,
        failures,
        disposed,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      values = undefined;
      pending = undefined;
      const error = adapterDisposedError();
      for (const listener of [...disposeListeners]) listener(error);
      disposeListeners.clear();
    },
  };
}

function invalidResponse(): ZToolsRendererHostError {
  return invalidRendererResponse("Invalid batched renderer settings response");
}

function validateSnapshot(payload: unknown): SettingsValues {
  try {
    const root = exactEventRecord(payload, ["version", "settings"]);
    if (root.version !== 1) throw invalidResponse();

    const settings = exactEventRecord(root.settings, NATIVE_KEYS);
    const output = new Map<string, string | null>();
    let totalBytes = 0;

    for (const key of NATIVE_KEYS) {
      totalBytes += utf8ByteLength(key);
      if (totalBytes > MAX_TOTAL_BYTES) throw invalidResponse();

      const value = settings[key];
      if (value !== null && typeof value !== "string") throw invalidResponse();
      if (value === null) {
        output.set(key, null);
        continue;
      }

      const byteLength = utf8ByteLength(value);
      const maxBytes = key === "settings-general"
        ? MAX_GENERAL_BYTES
        : key === COMMAND_ALIASES_KEY
          ? RENDERER_COMMAND_ALIASES_MAX_BYTES
          : MAX_NAMESPACED_BYTES;
      if (byteLength > maxBytes) throw invalidResponse();
      totalBytes += byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw invalidResponse();
      output.set(key, value);
    }

    return output;
  } catch {
    throw invalidResponse();
  }
}

