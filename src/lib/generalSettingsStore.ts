import { invoke } from "@tauri-apps/api/core";
import { hasSettingsRuntime, SETTINGS_KEY, SETTINGS_STORAGE_KEY } from "./settingsStorage";

const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_SETTINGS_FIELDS = 128;
const MAX_KEY_BYTES = 128;
const MAX_JSON_DEPTH = 32;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type GeneralSettingsSnapshot = Readonly<{
  raw: string | null;
  value: Readonly<Record<string, unknown>>;
}>;

export type GeneralSettingsReceipt = Readonly<{
  version: 1;
  raw: string;
  notificationDelivered: boolean;
  effectsApplied: boolean;
  aiInvalidated: boolean;
}>;

export type SaveGeneralSettingsOptions = Readonly<{ applyNative?: boolean }>;

export class GeneralSettingsPreviewStorageError extends Error {
  readonly code = "ERR_ATOOLS_GENERAL_SETTINGS_PREVIEW_STORAGE";

  constructor(reason: unknown) {
    super(reason instanceof Error && reason.message ? reason.message : "Preview settings could not be saved");
    this.name = "GeneralSettingsPreviewStorageError";
  }
}

type SaveGeneralSettingsRequest = {
  expected: { raw: string | null };
  changes: Record<string, JsonValue>;
  applyNative: boolean;
};

/** Reads the authoritative raw snapshot; browser preview uses its isolated local cache. */
export async function readGeneralSettingsSnapshot(): Promise<GeneralSettingsSnapshot> {
  let raw: unknown;
  if (hasSettingsRuntime()) {
    raw = await invoke<unknown>("get_setting", { key: SETTINGS_KEY });
  } else {
    try {
      raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    } catch {
      return generalSettingsSnapshotFromRaw(null);
    }
  }
  if (raw !== null && typeof raw !== "string") {
    throw new TypeError("General settings read returned an invalid raw value");
  }
  return generalSettingsSnapshotFromRaw(raw);
}

/** CAS-merges only the caller's patch and validates the native committed receipt. */
export async function saveGeneralSettings(
  snapshot: GeneralSettingsSnapshot,
  changes: Record<string, unknown>,
  options: SaveGeneralSettingsOptions = {},
): Promise<GeneralSettingsReceipt> {
  const base = validateSnapshot(snapshot);
  const safeChanges = cloneJsonRecord(changes, "changes", MAX_SETTINGS_FIELDS);
  const applyNative = readApplyNative(options);
  const request: SaveGeneralSettingsRequest = {
    expected: { raw: base.raw },
    changes: safeChanges,
    applyNative,
  };
  const wire = JSON.stringify(request);
  assertBudget(wire, "General settings request");

  if (hasSettingsRuntime()) {
    const rawReceipt: unknown = await invoke<unknown>("save_general_settings", request);
    return validateReceipt(rawReceipt, base.value, safeChanges);
  }

  let currentRaw: string | null;
  try {
    currentRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  } catch (error) {
    throw new GeneralSettingsPreviewStorageError(error);
  }
  if (currentRaw !== base.raw) throw new Error("General settings changed; reload before applying the patch");
  const next = mergeRecords(base.value, safeChanges);
  const raw = JSON.stringify(next);
  assertBudget(raw, "General settings value");
  const receipt = Object.freeze({
    version: 1 as const,
    raw,
    notificationDelivered: false,
    effectsApplied: false,
    aiInvalidated: false,
  });
  assertBudget(JSON.stringify(receipt), "General settings receipt");
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, raw);
  } catch (error) {
    throw new GeneralSettingsPreviewStorageError(error);
  }
  return receipt;
}

/** Copies a patch through descriptor checks so later normalization cannot execute getters. */
export function cloneGeneralSettingsChanges(changes: Record<string, unknown>): Record<string, unknown> {
  return cloneJsonRecord(changes, "changes", MAX_SETTINGS_FIELDS);
}

/** Parses and freezes a raw value for read leases and post-commit cache refreshes. */
export function generalSettingsSnapshotFromRaw(raw: string | null): GeneralSettingsSnapshot {
  if (raw !== null && typeof raw !== "string") throw new TypeError("General settings raw value must be text or null");
  if (raw !== null) assertBudget(raw, "General settings value");
  let parsed: unknown = {};
  if (raw !== null) {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new TypeError("General settings raw value is not valid JSON");
    }
  }
  const value = cloneJsonRecord(parsed, "General settings value");
  return Object.freeze({ raw, value: deepFreeze(value) });
}

function validateSnapshot(snapshot: GeneralSettingsSnapshot): { raw: string | null; value: Record<string, JsonValue> } {
  const fields = ownDataRecord(snapshot, "snapshot");
  if (Reflect.ownKeys(fields).length !== 2 || !("raw" in fields) || !("value" in fields)) {
    throw new TypeError("General settings snapshot has an invalid shape");
  }
  const raw = fields.raw;
  if (raw !== null && typeof raw !== "string") throw new TypeError("General settings snapshot raw must be text or null");
  const parsed = generalSettingsSnapshotFromRaw(raw);
  const value = cloneJsonRecord(fields.value, "snapshot value");
  if (!sameJson(value, parsed.value)) throw new TypeError("General settings snapshot value does not match its raw value");
  return { raw, value: parsed.value as Record<string, JsonValue> };
}

function readApplyNative(options: SaveGeneralSettingsOptions): boolean {
  const fields = ownDataRecord(options, "options");
  if (Reflect.ownKeys(fields).some(key => key !== "applyNative")) {
    throw new TypeError("General settings save options have an invalid shape");
  }
  const value = fields.applyNative;
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new TypeError("applyNative must be boolean");
  return value;
}

function validateReceipt(
  receipt: unknown,
  base: Record<string, JsonValue>,
  changes: Record<string, JsonValue>,
): GeneralSettingsReceipt {
  const fields = ownDataRecord(receipt, "receipt");
  const required = ["version", "raw", "notificationDelivered", "effectsApplied", "aiInvalidated"];
  if (Reflect.ownKeys(fields).length !== required.length || required.some(key => !(key in fields))) {
    throw new TypeError("General settings save returned an invalid receipt shape");
  }
  if (fields.version !== 1 || typeof fields.raw !== "string"
    || typeof fields.notificationDelivered !== "boolean"
    || typeof fields.effectsApplied !== "boolean" || typeof fields.aiInvalidated !== "boolean") {
    throw new TypeError("General settings save returned an invalid receipt");
  }

  const committed = generalSettingsSnapshotFromRaw(fields.raw);
  const committedValue = committed.value as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(changes)) {
    if (!Object.prototype.hasOwnProperty.call(committedValue, key) || !sameJson(committedValue[key], value)) {
      throw new TypeError("General settings receipt does not include the requested changes");
    }
  }
  for (const [key, value] of Object.entries(base)) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(committedValue, key) || !sameJson(committedValue[key], value)) {
      throw new TypeError("General settings receipt did not preserve unknown settings");
    }
  }
  const validated = Object.freeze({
    version: 1,
    raw: fields.raw,
    notificationDelivered: fields.notificationDelivered,
    effectsApplied: fields.effectsApplied,
    aiInvalidated: fields.aiInvalidated,
  });
  assertBudget(JSON.stringify(validated), "General settings receipt");
  return validated;
}

function ownDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a plain object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain object`);
  if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} cannot contain symbol keys`);
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (UNSAFE_KEYS.has(key)) throw new TypeError(`${label} contains a forbidden key`);
    if (new TextEncoder().encode(key).byteLength > MAX_KEY_BYTES) {
      throw new TypeError(`${label} contains a key longer than ${MAX_KEY_BYTES} UTF-8 bytes`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label} cannot contain accessors or hidden properties`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function cloneJsonRecord(value: unknown, label: string, maxFields?: number): Record<string, JsonValue> {
  const fields = ownDataRecord(value, label);
  if (maxFields !== undefined && Object.keys(fields).length > maxFields) {
    throw new TypeError(`${label} exceeds the ${maxFields}-field limit`);
  }
  const cloned: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  const stack = new Set<object>();
  for (const [key, entry] of Object.entries(fields)) cloned[key] = cloneJsonValue(entry, `${label}.${key}`, stack, 0);
  return cloned;
}

function cloneJsonValue(value: unknown, label: string, stack: Set<object>, depth: number): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new TypeError(`${label} exceeds the JSON nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object") throw new TypeError(`${label} is not a JSON value`);
  if (stack.has(value)) throw new TypeError(`${label} cannot contain a cycle`);
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getOwnPropertySymbols(value).length > 0) throw new TypeError(`${label} cannot contain symbol keys`);
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.getOwnPropertyNames(value);
      if (keys.length !== value.length + 1 || keys.some(key => key !== "length" && !isArrayIndex(key, value.length))) {
        throw new TypeError(`${label} must be a dense JSON array`);
      }
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError(`${label} cannot contain accessors or sparse items`);
        }
        result.push(cloneJsonValue(descriptor.value, `${label}[${index}]`, stack, depth + 1));
      }
      return result;
    }
    const fields = ownDataRecord(value, label);
    const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, entry] of Object.entries(fields)) {
      result[key] = cloneJsonValue(entry, `${label}.${key}`, stack, depth + 1);
    }
    return result;
  } finally {
    stack.delete(value);
  }
}

function isArrayIndex(key: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length;
}

function mergeRecords(base: Record<string, JsonValue>, changes: Record<string, JsonValue>): Record<string, JsonValue> {
  const merged: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(base)) merged[key] = value;
  for (const [key, value] of Object.entries(changes)) merged[key] = value;
  return merged;
}

function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => sameJson(value, right[index]));
  }
  const a = Object.keys(left as object).sort();
  const b = Object.keys(right as object).sort();
  if (a.length !== b.length || a.some((key, index) => key !== b[index])) return false;
  return a.every(key => sameJson((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry);
  }
  return value;
}

function assertBudget(value: string, label: string): void {
  if (new TextEncoder().encode(value).byteLength > MAX_SETTINGS_BYTES) {
    throw new RangeError(`${label} exceeds the 64 KiB limit`);
  }
}
