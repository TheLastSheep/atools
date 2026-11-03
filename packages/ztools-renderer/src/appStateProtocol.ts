import {
  HOST_ERROR_CODES,
  invalidRendererArgument,
  invalidRendererResponse,
  ZToolsRendererHostError,
} from "./errors";
import { denseEventArrayItem, denseEventArrayLength, exactEventRecord, selectedEventRecord } from "./safeEventRecord";
import { utf8ByteLength } from "./utf8";
import type { RendererEventSubscriptionsSnapshot } from "./eventSubscriptions";
import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";

export type RendererAppStateKey = "command-history" | "pinned-commands";
export type RendererAppStateValues = Record<RendererAppStateKey, string | null>;
export type RendererAppSubType = "app" | "local-shortcut";

export interface AppIdentity {
  path: string;
  name: string;
  subType?: "local-shortcut";
}

export type AppMutationRequest =
  | { operation: "pin"; app: AppIdentity }
  | { operation: "unpin" | "remove_history"; path: string; name?: string }
  | { operation: "reorder_pins"; apps: AppIdentity[] }
  | { operation: "clear_pins" | "clear_history" };

export interface RendererAppStateSnapshot {
  version: 1;
  revision: number | null;
  historySubscribers: number;
  pinnedSubscribers: number;
  listenerState: string;
  eventSource: RendererEventSubscriptionsSnapshot;
  queuedMutations: number;
  acceptedReplies: number;
  acceptedEvents: number;
  stalePayloads: number;
  invalidPayloads: number;
  mutationFailures: number;
  applyErrors: number;
  callbackErrors: number;
  disposed: boolean;
}

export interface RendererAppState {
  pinApp(command: unknown): Promise<void>;
  unpinApp(path: unknown, featureCode?: unknown, name?: unknown): Promise<void>;
  removeFromHistory(path: unknown, featureCode?: unknown, name?: unknown): Promise<void>;
  updatePinnedOrder(commands: unknown): Promise<void>;
  clearPins(): Promise<void>;
  clearHistory(): Promise<void>;
  launchApp(target: AppIdentity): Promise<unknown>;
  onHistoryChanged(callback: () => unknown): RendererHostUnlisten;
  onPinnedChanged(callback: () => unknown): RendererHostUnlisten;
  snapshot(): RendererAppStateSnapshot;
  dispose(): void;
}

export interface RendererAppStateOptions {
  transport: Pick<ZToolsRendererTransport, "listen">;
  mutate(request: AppMutationRequest): Promise<unknown>;
  launch(target: AppIdentity): Promise<unknown>;
  applyValues(values: RendererAppStateValues): void;
}

export interface NativePayload {
  revision: number;
  values: RendererAppStateValues;
  changed: RendererAppStateKey[];
}

const MAX_VALUE_BYTES = 128 * 1024;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_NAME_BYTES = 4 * 1024;
const MAX_PINNED_APP_ITEMS = 4_096;
const KEYS: readonly RendererAppStateKey[] = ["command-history", "pinned-commands"];

export function appStateDisposedError(): ZToolsRendererHostError {
  return new ZToolsRendererHostError(
    HOST_ERROR_CODES.DISPOSED,
    "The renderer app state client has been disposed.",
  );
}

export function appStateInvalidArgument(): ZToolsRendererHostError {
  return invalidRendererArgument("Invalid renderer app state argument.");
}

export function appStateUnsupported(method: string): ZToolsRendererHostError {
  return new ZToolsRendererHostError(
    HOST_ERROR_CODES.UNSUPPORTED,
    "ATools does not support this ZTools app state operation: " + method,
  );
}

export function appStateInvalidResponse(): ZToolsRendererHostError {
  return invalidRendererResponse("Invalid renderer app state response.");
}

function selectedDataRecord(
  value: unknown,
  selectedKeys: readonly string[],
): Record<string, unknown> | undefined {
  try {
    return selectedEventRecord(value, selectedKeys);
  } catch {
    return undefined;
  }
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    return exactEventRecord(value, keys);
  } catch {
    throw appStateInvalidResponse();
  }
}

function boundedString(value: unknown, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw appStateInvalidArgument();
  }
  if (utf8ByteLength(value) > maxBytes) throw appStateInvalidArgument();
  return value;
}

function optionalName(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return boundedString(value, MAX_NAME_BYTES);
}

function hasPluginFeatureCode(record: Record<string, unknown>): boolean {
  const featureCode = record.featureCode;
  if (featureCode === undefined || featureCode === null || featureCode === "") return false;
  if (typeof featureCode !== "string") throw appStateInvalidArgument();
  return true;
}

export function normalizeAppIdentity(value: unknown): AppIdentity {
  const record = selectedDataRecord(value, ["path", "name", "featureCode", "subType"]);
  if (!record) throw appStateInvalidArgument();
  if (hasPluginFeatureCode(record)) throw appStateUnsupported("launch for plugin features");
  const subType = normalizeAppSubType(record.subType);
  const identity: AppIdentity = {
    path: boundedString(record.path, MAX_PATH_BYTES),
    name: boundedString(record.name, MAX_NAME_BYTES),
  };
  if (subType === "local-shortcut") identity.subType = subType;
  return identity;
}

export function normalizeAppCommand(command: unknown): AppIdentity {
  const record = selectedDataRecord(command, [
    "type", "subType", "path", "name", "persistedName", "featureCode",
  ]);
  if (!record) throw appStateInvalidArgument();
  if (hasPluginFeatureCode(record)) throw appStateUnsupported("app history and pins for plugin features");
  const subType = normalizeAppSubType(record.subType);
  const isLegacyApp = record.type === "app";
  const isDirectApp = record.type === "direct" && subType !== "local-shortcut";
  const isLocalShortcut = record.type === "direct" && subType === "local-shortcut";
  if ((!isLegacyApp && !isDirectApp && !isLocalShortcut)
    || (isLegacyApp && subType === "local-shortcut")) {
    throw appStateUnsupported("app history and pins for this command type");
  }
  const persistedName = record.persistedName;
  const name = typeof persistedName === "string" && persistedName.length > 0
    ? persistedName
    : record.name;
  const identity: AppIdentity = {
    path: boundedString(record.path, MAX_PATH_BYTES),
    name: boundedString(name, MAX_NAME_BYTES),
  };
  if (isLocalShortcut) identity.subType = "local-shortcut";
  return identity;
}

function normalizeAppSubType(value: unknown): RendererAppSubType | undefined {
  if (value === undefined || value === "app") return value;
  if (value === "local-shortcut") return value;
  throw appStateInvalidArgument();
}

export function normalizeAppCommands(commands: unknown): AppIdentity[] {
  let length: number;
  try {
    length = denseEventArrayLength(commands, MAX_PINNED_APP_ITEMS);
  } catch (error) {
    if (error instanceof ZToolsRendererHostError) throw error;
    throw appStateInvalidArgument();
  }

  const commandArray = commands as unknown[];
  const apps: AppIdentity[] = [];
  for (let index = 0; index < length; index += 1) {
    let command: unknown;
    try {
      command = denseEventArrayItem(commandArray, index);
    } catch {
      throw appStateInvalidArgument();
    }
    apps.push(normalizeAppCommand(command));
  }
  return apps;
}

export function normalizeRemovalIdentity(
  path: unknown,
  featureCode?: unknown,
  name?: unknown,
): { path: string; name?: string } {
  if (featureCode !== undefined && featureCode !== null && featureCode !== "") {
    if (typeof featureCode !== "string") throw appStateInvalidArgument();
    throw appStateUnsupported("history and pins for plugin features");
  }
  const identity: { path: string; name?: string } = {
    path: boundedString(path, MAX_PATH_BYTES),
  };
  const safeName = optionalName(name);
  if (safeName !== undefined) identity.name = safeName;
  return identity;
}

export function validateAppStatePayload(payload: unknown): NativePayload {
  try {
    const root = exactRecord(payload, ["version", "revision", "values", "changed"]);
    if (root.version !== 1 || !Number.isSafeInteger(root.revision) || (root.revision as number) < 0) {
      throw appStateInvalidResponse();
    }
    const valuesRecord = exactRecord(root.values, KEYS);
    const values = Object.create(null) as RendererAppStateValues;
    for (const key of KEYS) {
      const value = valuesRecord[key];
      if (value !== null && typeof value !== "string") throw appStateInvalidResponse();
      if (typeof value === "string" && utf8ByteLength(value) > MAX_VALUE_BYTES) {
        throw appStateInvalidResponse();
      }
      values[key] = value as string | null;
    }

    const changedLength = denseEventArrayLength(root.changed, KEYS.length);
    const parsedChanged: RendererAppStateKey[] = [];
    for (let index = 0; index < changedLength; index += 1) {
      const key = denseEventArrayItem(root.changed as unknown[], index);
      if (typeof key !== "string" || !KEYS.includes(key as RendererAppStateKey)) {
        throw appStateInvalidResponse();
      }
      if (parsedChanged.includes(key as RendererAppStateKey)) throw appStateInvalidResponse();
      parsedChanged.push(key as RendererAppStateKey);
    }

    return {
      revision: root.revision as number,
      values,
      changed: parsedChanged,
    };
  } catch {
    throw appStateInvalidResponse();
  }
}

export function cloneAppMutation(request: AppMutationRequest): AppMutationRequest {
  if (request.operation === "pin") {
    return { operation: "pin", app: cloneAppIdentity(request.app) };
  }
  if (request.operation === "reorder_pins") {
    return {
      operation: "reorder_pins",
      apps: request.apps.map(cloneAppIdentity),
    };
  }
  if (request.operation === "unpin" || request.operation === "remove_history") {
    const copy: AppMutationRequest = { operation: request.operation, path: request.path };
    if (request.name !== undefined) (copy as { name?: string }).name = request.name;
    return copy;
  }
  return { operation: request.operation };
}

function cloneAppIdentity(app: AppIdentity): AppIdentity {
  const identity: AppIdentity = { path: app.path, name: app.name };
  if (app.subType === "local-shortcut") identity.subType = app.subType;
  return identity;
}
