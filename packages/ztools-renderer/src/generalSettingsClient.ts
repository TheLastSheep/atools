import {
  adapterDisposedError,
  HOST_ERROR_CODES,
  invalidRendererArgument,
  invalidRendererResponse,
  ZToolsRendererHostError,
} from "./errors";
import { exactEventRecord, safeEventRecord } from "./safeEventRecord";
import {
  GENERAL_RENDERER_WRITE_FIELDS,
  isGeneralPreferenceValue,
  MAX_GENERAL_PREFERENCE_PLACEHOLDER_WRITE_BYTES,
  MAX_GENERAL_PREFERENCE_RAW_BYTES,
  utf8ByteLength,
} from "./generalPreferenceSchema";

export interface RendererGeneralSettingsReadResponse {
  version: 1;
  raw: string | null;
}

export interface RendererGeneralSettingsMutationRequest {
  expected: string | null;
  changes: Record<string, unknown>;
}

export interface RendererGeneralSettingsMutationResponse {
  version: 1;
  raw: string;
  notificationDelivered: boolean;
}

export interface RendererGeneralSettingsCommit {
  snapshot: Readonly<Record<string, unknown>>;
  notificationDelivered: boolean;
}

export interface RendererGeneralSettingsClientDiagnostics {
  version: 1;
  cached: boolean;
  loadInFlight: boolean;
  pendingSaves: number;
  loadRequests: number;
  loadFailures: number;
  saveRequests: number;
  saveFailures: number;
  committedWrites: number;
  notificationFailures: number;
  callbackErrors: number;
  disposed: boolean;
}

export interface RendererGeneralSettingsClient {
  load(): Promise<Readonly<Record<string, unknown>>>;
  save(changes: Record<string, unknown>): Promise<RendererGeneralSettingsCommit>;
  snapshot(): RendererGeneralSettingsClientDiagnostics;
  dispose(): void;
}

export interface RendererGeneralSettingsClientOptions {
  load(): Promise<unknown>;
  mutate(request: RendererGeneralSettingsMutationRequest): Promise<unknown>;
  onCommitted?(snapshot: Readonly<Record<string, unknown>>): void;
}

export class RendererGeneralSettingsOutcomeUnknownError extends Error {
  readonly code = "ERR_ATOOLS_GENERAL_SETTINGS_OUTCOME_UNKNOWN" as const;
  readonly requiresReload = true as const;

  constructor() {
    super("The General settings write may have committed; reload settings before retrying.");
    this.name = "RendererGeneralSettingsOutcomeUnknownError";
  }
}

interface SettingsValue {
  raw: string | null;
  value: Record<string, unknown>;
}

interface PendingSaveOutcome {
  dispatched: boolean;
  reliableResult?: RendererGeneralSettingsCommit;
}

interface DisposeListener {
  dispose(): void;
}

const MAX_CHANGES = 8;
const MAX_PENDING_SAVES = 32;

function invalidArgument(message = "Invalid renderer General settings argument."): ZToolsRendererHostError {
  return invalidRendererArgument(message);
}

function invalidResponse(): ZToolsRendererHostError {
  return invalidRendererResponse("Invalid renderer General settings response.");
}

function plainDataRecord(value: unknown, error: () => Error): Record<string, unknown> {
  try {
    return safeEventRecord(value);
  } catch {
    throw error();
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  try {
    return exactEventRecord(value, keys);
  } catch {
    throw invalidResponse();
  }
}

function parseRaw(raw: unknown): SettingsValue {
  if (raw === null) return { raw: null, value: Object.create(null) as Record<string, unknown> };
  if (typeof raw !== "string" || utf8ByteLength(raw) > MAX_GENERAL_PREFERENCE_RAW_BYTES) {
    throw invalidResponse();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw invalidResponse();
  }
  return {
    raw,
    value: plainDataRecord(parsed, invalidResponse),
  };
}

function parseReadResponse(payload: unknown): SettingsValue {
  const record = exactRecord(payload, ["version", "raw"]);
  if (record.version !== 1 || (record.raw !== null && typeof record.raw !== "string")) {
    throw invalidResponse();
  }
  return parseRaw(record.raw);
}

function parseMutationResponse(payload: unknown): SettingsValue & { notificationDelivered: boolean } {
  const record = exactRecord(payload, ["version", "raw", "notificationDelivered"]);
  if (
    record.version !== 1 ||
    typeof record.raw !== "string" ||
    typeof record.notificationDelivered !== "boolean"
  ) {
    throw invalidResponse();
  }
  return {
    ...parseRaw(record.raw),
    notificationDelivered: record.notificationDelivered,
  };
}

function cloneSnapshot(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    throw invalidResponse();
  }
}

function normalizeChanges(input: unknown): Record<string, unknown> {
  const changes = plainDataRecord(input, invalidArgument);
  const keys = Object.keys(changes);
  if (keys.length === 0 || keys.length > MAX_CHANGES) throw invalidArgument();

  for (const key of keys) {
    if (!GENERAL_RENDERER_WRITE_FIELDS.has(key) || !isGeneralPreferenceValue(key, changes[key], MAX_GENERAL_PREFERENCE_PLACEHOLDER_WRITE_BYTES)) throw invalidArgument();
  }

  return changes;
}

function mergeSnapshot(
  base: Record<string, unknown>,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  return Object.assign(Object.create(null) as Record<string, unknown>, base, changes);
}

function canonicalJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    if (
      (typeof item === "number" && !Number.isFinite(item)) || item === undefined ||
      typeof item === "function" || typeof item === "symbol" || typeof item === "bigint"
    ) throw invalidResponse();
    return item;
  });
  if (json === undefined) throw invalidResponse();
  return json;
}

export function createRendererGeneralSettingsClient(
  options: RendererGeneralSettingsClientOptions,
): RendererGeneralSettingsClient {
  let cached: SettingsValue | undefined;
  let pendingLoad: Promise<SettingsValue> | undefined;
  let mutationTail: Promise<void> = Promise.resolve();
  let pendingSaves = 0;
  let loadRequests = 0;
  let loadFailures = 0;
  let saveRequests = 0;
  let saveFailures = 0;
  let committedWrites = 0;
  let notificationFailures = 0;
  let callbackErrors = 0;
  let commitRevision = 0;
  let readSequence = 0;
  let disposed = false;
  const disposeListeners = new Set<DisposeListener>();

  function ensureActive(): void {
    if (disposed) throw adapterDisposedError();
  }

  function waitUnlessDisposed<T>(
    promise: Promise<T>,
    onDispose?: (resolve: (value: T) => void, reject: (reason: unknown) => void) => void,
  ): Promise<T> {
    if (disposed) return Promise.reject(adapterDisposedError());
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => disposeListeners.delete(listener);
      const listener: DisposeListener = {
        dispose() {
          if (settled) return;
          settled = true;
          cleanup();
          try {
            if (onDispose) onDispose(resolve, reject);
            else reject(adapterDisposedError());
          } catch {
            reject(adapterDisposedError());
          }
        },
      };
      disposeListeners.add(listener);
      promise.then((value) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (disposed) reject(adapterDisposedError());
        else resolve(value);
      }, (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
    });
  }

  function startLoad(): Promise<SettingsValue> {
    const sequence = ++readSequence;
    const revisionAtStart = commitRevision;
    loadRequests += 1;

    let request!: Promise<SettingsValue>;
    request = Promise.resolve()
      .then(() => {
        ensureActive();
        return options.load();
      })
      .then(parseReadResponse)
      .then((result) => {
        ensureActive();
        if (sequence === readSequence && revisionAtStart === commitRevision) {
          cached = result;
        }
        return result;
      })
      .catch((error: unknown) => {
        if (disposed) throw adapterDisposedError();
        loadFailures += 1;
        if (error instanceof ZToolsRendererHostError && error.code === HOST_ERROR_CODES.INVALID_RESPONSE) {
          throw error;
        }
        throw invalidResponse();
      })
      .finally(() => {
        if (pendingLoad === request) pendingLoad = undefined;
      });
    pendingLoad = request;
    return request;
  }

  async function settingsForSave(): Promise<SettingsValue> {
    ensureActive();
    if (pendingLoad) {
      const loaded = await pendingLoad;
      ensureActive();
      return cached ?? loaded;
    }
    if (cached !== undefined) return cached;
    const loaded = await startLoad();
    ensureActive();
    return cached ?? loaded;
  }

  async function commit(
    changes: Record<string, unknown>,
    outcome: PendingSaveOutcome,
  ): Promise<RendererGeneralSettingsCommit> {
    ensureActive();
    const base = await settingsForSave();
    ensureActive();

    const request: RendererGeneralSettingsMutationRequest = {
      expected: base.raw,
      changes: Object.assign(Object.create(null) as Record<string, unknown>, changes),
    };
    outcome.dispatched = true;
    const receipt = parseMutationResponse(await options.mutate(request));

    const expectedSnapshot = mergeSnapshot(base.value, changes);
    if (canonicalJson(receipt.value) !== canonicalJson(expectedSnapshot)) throw invalidResponse();
    outcome.reliableResult = {
      snapshot: cloneSnapshot(receipt.value),
      notificationDelivered: receipt.notificationDelivered,
    };
    ensureActive();

    cached = { raw: receipt.raw, value: receipt.value };
    commitRevision += 1;
    committedWrites += 1;
    if (!receipt.notificationDelivered) notificationFailures += 1;

    const callbackSnapshot = cloneSnapshot(receipt.value);
    try {
      options.onCommitted?.(callbackSnapshot);
    } catch {
      callbackErrors += 1;
    }

    return {
      snapshot: cloneSnapshot(receipt.value),
      notificationDelivered: receipt.notificationDelivered,
    };
  }

  return {
    load() {
      if (disposed) return Promise.reject(adapterDisposedError());
      const request = pendingLoad ?? startLoad();
      return waitUnlessDisposed(request.then((result) => {
        const latest = cached ?? result;
        return cloneSnapshot(latest.value);
      }));
    },

    save(input) {
      if (disposed) return Promise.reject(adapterDisposedError());
      if (pendingSaves >= MAX_PENDING_SAVES) {
        return Promise.reject(invalidArgument("Renderer General settings write queue is full."));
      }
      let changes: Record<string, unknown>;
      try {
        changes = normalizeChanges(input);
      } catch (error) {
        return Promise.reject(error);
      }

      saveRequests += 1;
      pendingSaves += 1;
      const outcome: PendingSaveOutcome = { dispatched: false };
      const operation = mutationTail
        .then(() => commit(changes, outcome))
        .catch((error: unknown) => {
          if (disposed) throw adapterDisposedError();
          saveFailures += 1;
          throw error;
        })
        .finally(() => {
          pendingSaves -= 1;
        });
      mutationTail = operation.then(() => undefined, () => undefined);
      return waitUnlessDisposed(operation, (resolve, reject) => {
        if (outcome.reliableResult) resolve(outcome.reliableResult);
        else if (outcome.dispatched) reject(new RendererGeneralSettingsOutcomeUnknownError());
        else reject(adapterDisposedError());
      });
    },

    snapshot() {
      return {
        version: 1,
        cached: cached !== undefined,
        loadInFlight: pendingLoad !== undefined,
        pendingSaves,
        loadRequests,
        loadFailures,
        saveRequests,
        saveFailures,
        committedWrites,
        notificationFailures,
        callbackErrors,
        disposed,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cached = undefined;
      pendingLoad = undefined;
      for (const listener of [...disposeListeners]) listener.dispose();
      disposeListeners.clear();
    },
  };
}
