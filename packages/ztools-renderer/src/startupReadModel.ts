import {
  adapterDisposedError,
  invalidRendererArgument,
  invalidRendererResponse,
  ZToolsRendererHostError,
} from "./errors";
import { parseNamespacedValue, parseSettingsJson } from "./mappers";
import { RENDERER_COMMAND_ALIASES_MAX_BYTES } from "./commandInvalidationEvents";
import { createSettingsGenerations } from "./settingsGenerations";
import type { SettingsGeneration, SettingsGenerations } from "./settingsGenerations";
import { parseRendererLocalShortcuts } from "./localShortcuts";
import type { RendererLocalShortcut } from "./localShortcuts";
import { utf8ByteLength } from "./utf8";

export const NAMESPACED_READ_KEYS = new Set([
  "command-aliases",
  "disable-commands",
  "enabled-main-push-plugin",
  "search-preference",
  "recommendation-pinned",
  "command-history",
  "pinned-commands",
  "out-kill-plugin",
  "auto-detach-plugin",
  "auto-start-plugin",
  "super-panel-pinned",
  "local-shortcuts",
  "command-usage-stats",
]);

const MAX_CONTEXT_QUERY = 8 * 1024;
const MAX_CONTEXT_IMAGE = 8 * 1024 * 1024;
const MAX_CONTEXT_TEXT = 10 * 1024 * 1024;
const MAX_CONTEXT_FILES = 1024;
const MAX_READ_ROWS = 4096;
const MAX_STRING = 16_384;
const MAX_PLAIN_JSON_UTF16_UNITS = 128 * 1024;
const MAX_PLAIN_JSON_KEY_LENGTH = 256;

interface PlainJsonBudget {
  depth: number;
  nodes: number;
  utf16Units: number;
}

export type ZToolsRendererLaunchContext = {
  searchQuery: string;
  pastedImage: string | null;
  pastedFiles: Array<{ path: string; name: string; isDirectory: boolean }> | null;
  pastedText: string | null;
};

export type ZToolsRendererUsageStat = {
  path: string;
  featureCode?: string;
  useCount: number;
};

export type ZToolsRendererSuperPanelPin = {
  path: string;
  name?: string;
  featureCode?: string;
};

export interface StartupReadModel {
  dbGet(key: string): Promise<unknown>;
  getRecommendationPinState(): Promise<{ raw: string | null; value: unknown }>;
  getSuperPanelPinned(): Promise<ZToolsRendererSuperPanelPin[]>;
  getLocalShortcuts(): Promise<RendererLocalShortcut[]>;
  getUsageStats(): Promise<ZToolsRendererUsageStat[]>;
  updateLaunchContext(value: unknown): void;
  acceptWrittenSearchPreference(
    value: Record<string, { path: string; featureCode?: string; name: string }>,
  ): void;
  acceptWrittenRecommendationPins(raw: string | null, value: unknown): void;
  acceptAppState(values: Record<"command-history" | "pinned-commands", string | null>): void;
  invalidateCommandAliases(): void;
  invalidateDisabledCommands(): void;
  invalidateLocalShortcuts(): void;
  snapshot(): { readModelDefaults: string[]; launchContextSet: boolean };
  dispose(): void;
}

export function createStartupReadModel(
  getSetting: (nativeKey: string) => Promise<unknown>,
  onUnsupported: (method: string) => Promise<never>,
  generations: SettingsGenerations = createSettingsGenerations(),
): StartupReadModel {
  type CacheEntry = { generation?: SettingsGeneration; promise: Promise<unknown> };
  const cache = new Map<string, CacheEntry>();
  const readModelDefaults = new Set<string>();
  let recommendationPinRaw: string | null = null;
  let launchContext: ZToolsRendererLaunchContext | undefined;
  let disposed = false;

  function ensureActive(): void {
    if (disposed) throw adapterDisposedError();
  }

  function read(key: string): Promise<unknown> {
    ensureActive();
    if (key !== "settings-general" && !NAMESPACED_READ_KEYS.has(key)) return onUnsupported(`dbGet(${key})`);
    const generation = generations.capture();
    const cached = cache.get(key);
    if (cached && generations.isCurrent(key, cached.generation)) return cached.promise;
    const nativeKey = key === "settings-general" ? key : `ztools-renderer:${key}`;
    let entry!: CacheEntry;
    const pending = getSetting(nativeKey).then((value) => {
      ensureActive();
      const current = cache.get(key);
      if (!generations.isCurrent(key, generation)) return read(key);
      if (current && current !== entry) return current.promise;
      if (value === null) readModelDefaults.add(key);
      if (key === "settings-general") return parseSettingsJson(value);
      const parsed = key === "command-aliases" ? parseCommandAliasesValue(value) : parseNamespacedValue(value);
      if (key === "recommendation-pinned") recommendationPinRaw = value as string | null;
      return key === "search-preference" && parsed !== null
        ? validateSearchPreference(parsed)
        : parsed;
    }).catch((error) => {
      if (!generations.isCurrent(key, generation)) return read(key);
      if (cache.get(key) === entry) cache.delete(key);
      throw error;
    });
    entry = { generation, promise: pending };
    cache.set(key, entry);
    return pending;
  }

  async function readList<T>(
    key: string,
    label: string,
    parse: (value: unknown) => T[],
  ): Promise<T[]> {
    const value = await read(key);
    if (value === null) {
      readModelDefaults.add(label);
      return [];
    }
    return parse(value);
  }

  function updateLaunchContext(value: unknown): void {
    ensureActive();
    const record = asRecord(value, "updateLaunchContext");
    const allowed = new Set(["searchQuery", "pastedImage", "pastedFiles", "pastedText"]);
    if (Object.keys(record).some((key) => !allowed.has(key))
      || Object.keys(record).length !== allowed.size) {
      throw invalidArgument("updateLaunchContext fields");
    }
    const searchQuery = boundedString(record.searchQuery, "searchQuery", MAX_CONTEXT_QUERY, true);
    const pastedImage = nullableBoundedString(record.pastedImage, "pastedImage", MAX_CONTEXT_IMAGE);
    const pastedText = nullableBoundedString(record.pastedText, "pastedText", MAX_CONTEXT_TEXT);
    let pastedFiles: ZToolsRendererLaunchContext["pastedFiles"];
    if (record.pastedFiles === null) {
      pastedFiles = null;
    } else if (Array.isArray(record.pastedFiles) && record.pastedFiles.length <= MAX_CONTEXT_FILES) {
      pastedFiles = record.pastedFiles.map((item) => {
        const file = asRecord(item, "pastedFiles");
        if (Object.keys(file).some((key) => !["path", "name", "isDirectory"].includes(key))
          || Object.keys(file).length !== 3 || typeof file.isDirectory !== "boolean") {
          throw invalidArgument("pastedFiles item");
        }
        return {
          path: boundedString(file.path, "pastedFiles.path", MAX_STRING),
          name: boundedString(file.name, "pastedFiles.name", 1024),
          isDirectory: file.isDirectory,
        };
      });
    } else {
      throw invalidArgument("pastedFiles");
    }
    launchContext = { searchQuery, pastedImage, pastedFiles, pastedText };
  }

  return {
    dbGet: read,
    async getRecommendationPinState() {
      const value = await read("recommendation-pinned");
      ensureActive();
      return { raw: recommendationPinRaw, value };
    },
    getSuperPanelPinned: () => readList("super-panel-pinned", "super-panel-pinned", parsePins),
    getLocalShortcuts: () => readList("local-shortcuts", "local-shortcuts", parseRendererLocalShortcuts),
    getUsageStats: () => readList("command-usage-stats", "command-usage-stats", parseUsageStats),
    updateLaunchContext,
    acceptWrittenSearchPreference(value) {
      ensureActive();
      const normalized = validateSearchPreference(value);
      cache.set("search-preference", { promise: Promise.resolve(normalized) });
      readModelDefaults.delete("search-preference");
    },
    acceptWrittenRecommendationPins(raw, value) {
      ensureActive();
      recommendationPinRaw = raw;
      cache.set("recommendation-pinned", { promise: Promise.resolve(value) });
      if (raw === null) readModelDefaults.add("recommendation-pinned");
      else readModelDefaults.delete("recommendation-pinned");
    },
    acceptAppState(values) {
      ensureActive();
      // Parse both domains before replacing either cache entry.
      const parsed = ["command-history", "pinned-commands"].map((key) => {
        const raw = values[key as keyof typeof values];
        if (raw === null) return [key, null] as const;
        if (typeof raw !== "string" || utf8ByteLength(raw) > 128 * 1024) {
          throw invalidResponse("app-state");
        }
        const rows: unknown = JSON.parse(raw);
        if (!Array.isArray(rows) || rows.length > MAX_READ_ROWS
          || rows.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
          throw invalidResponse("app-state");
        }
        return [key, rows] as const;
      });
      for (const [key, value] of parsed) {
        cache.set(key, { promise: Promise.resolve(value) });
        if (value === null) readModelDefaults.add(key);
        else readModelDefaults.delete(key);
      }
    },
    invalidateCommandAliases() {
      ensureActive();
      generations.invalidate("command-aliases");
      cache.delete("command-aliases");
      readModelDefaults.delete("command-aliases");
    },
    invalidateDisabledCommands() {
      ensureActive();
      generations.invalidate("disable-commands");
      cache.delete("disable-commands");
      readModelDefaults.delete("disable-commands");
    },
    invalidateLocalShortcuts() {
      ensureActive();
      generations.invalidate("local-shortcuts");
      cache.delete("local-shortcuts");
      readModelDefaults.delete("local-shortcuts");
    },
    snapshot: () => ({
      readModelDefaults: [...readModelDefaults].sort(),
      launchContextSet: Boolean(launchContext),
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      launchContext = undefined;
      recommendationPinRaw = null;
      cache.clear();
    },
  };
}

function parseCommandAliasesValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "string"
    || utf8ByteLength(value) > RENDERER_COMMAND_ALIASES_MAX_BYTES) {
    throw invalidResponse("command-aliases");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidResponse("command-aliases");
  }
}

function parsePins(value: unknown): ZToolsRendererSuperPanelPin[] {
  return parseArray(value, "super-panel-pinned").map((item) => {
    const row = asRecord(item, "super-panel-pinned");
    const pin: ZToolsRendererSuperPanelPin = { path: boundedString(row.path, "pin.path", MAX_STRING) };
    if (typeof row.name === "string") pin.name = row.name.slice(0, 1024);
    if (typeof row.featureCode === "string") pin.featureCode = row.featureCode.slice(0, 1024);
    return pin;
  });
}

function parseUsageStats(value: unknown): ZToolsRendererUsageStat[] {
  return parseArray(value, "command-usage-stats").map((item) => {
    const row = asRecord(item, "command-usage-stats");
    if (!Number.isSafeInteger(row.useCount) || Number(row.useCount) < 0) {
      throw invalidResponse("command-usage-stats");
    }
    const stat: ZToolsRendererUsageStat = {
      path: boundedString(row.path, "usage.path", MAX_STRING),
      useCount: Number(row.useCount),
    };
    if (typeof row.featureCode === "string") stat.featureCode = row.featureCode.slice(0, 1024);
    return stat;
  });
}

function validateSearchPreference(
  value: unknown,
): Record<string, { path: string; featureCode?: string; name: string }> {
  const record = asRecord(value, "search-preference");
  const entries = Object.entries(record);
  if (entries.length > 1024) throw invalidArgument("search-preference size");
  const output = Object.create(null) as Record<string, { path: string; featureCode?: string; name: string }>;
  for (const [query, item] of entries) {
    if (!query || query.length > 256 || /[\u0000-\u001f\u007f]/.test(query)) {
      throw invalidArgument("search-preference query");
    }
    const row = asRecord(item, "search-preference.item");
    const allowed = new Set(["path", "featureCode", "name"]);
    if (Object.keys(row).some((key) => !allowed.has(key))
      || typeof row.name !== "string" || row.name.length === 0 || row.name.length > 1024
      || typeof row.path !== "string" || row.path.length === 0 || row.path.length > MAX_STRING
      || (row.featureCode !== undefined
        && (typeof row.featureCode !== "string" || row.featureCode.length > 1024))) {
      throw invalidArgument("search-preference.item");
    }
    output[query] = {
      path: row.path,
      name: row.name,
      ...(typeof row.featureCode === "string" ? { featureCode: row.featureCode } : {}),
    };
  }
  return output;
}

export function serializeSearchPreferenceForWrite(value: unknown): {
  serialized: string;
  value: Record<string, { path: string; featureCode?: string; name: string }>;
} {
  assertPlainJson(value, new Set(), { depth: 0, nodes: 0, utf16Units: 0 });
  const normalized = validateSearchPreference(value);
  const serialized = JSON.stringify(normalized);
  if (utf8ByteLength(serialized) > 128 * 1024) {
    throw invalidArgument("search-preference exceeds 128 KiB");
  }
  return { serialized, value: normalized };
}

export function snapshotPlainJson(
  value: unknown,
  route: string,
  maxObjectKeyLength = MAX_PLAIN_JSON_KEY_LENGTH,
): unknown {
  try {
    return copyPlainJson(value, new Set(), { depth: 0, nodes: 0, utf16Units: 0 }, route, true, maxObjectKeyLength);
  } catch (error) {
    if (error instanceof ZToolsRendererHostError) throw error;
    throw invalidArgument(`${route} JSON value`);
  }
}

function assertPlainJson(
  value: unknown,
  ancestors: Set<object>,
  budget: PlainJsonBudget,
): void {
  copyPlainJson(value, ancestors, budget, "search-preference", true, MAX_PLAIN_JSON_KEY_LENGTH);
}

function copyPlainJson(
  value: unknown,
  ancestors: Set<object>,
  budget: PlainJsonBudget,
  route: string,
  countSerializedStrings: boolean,
  maxObjectKeyLength: number,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > 8192 || budget.depth > 8) throw invalidArgument(`${route} complexity`);
  if (typeof value === "string") {
    if (countSerializedStrings) addPlainJsonStringUnits(value.length, budget, route);
    return value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw invalidArgument(`${route} number`);
  }
  if (typeof value !== "object") throw invalidArgument(`${route} JSON value`);
  const object = value as object;
  if (ancestors.has(object)) throw invalidArgument(`${route} circular value`);
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw invalidArgument(`${route} prototype`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw invalidArgument(`${route} symbol`);
  ancestors.add(object);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  let result: unknown;
  if (isArray) {
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number") {
      throw invalidArgument(`${route} array length`);
    }
    const length = lengthDescriptor.value;
    const output = new Array<unknown>(length);
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor)) throw invalidArgument(`${route} sparse array`);
      budget.depth += 1;
      try {
        output[index] = copyPlainJson(
          descriptor.value,
          ancestors,
          budget,
          route,
          countSerializedStrings,
          maxObjectKeyLength,
        );
      } finally {
        budget.depth -= 1;
      }
    }
    for (const key of Object.keys(descriptors)) {
      if (key !== "length" && !/^\d+$/.test(key)) throw invalidArgument(`${route} array field`);
    }
    result = output;
  } else {
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) {
      const includeInJson = countSerializedStrings && descriptor.enumerable === true;
      if (includeInJson) addPlainJsonStringUnits(key.length, budget, route);
      if (!("value" in descriptor)) throw invalidArgument(`${route} accessor`);
      if (key.length > maxObjectKeyLength) throw invalidArgument(`${route} key`);
      budget.depth += 1;
      let child: unknown;
      try {
        child = copyPlainJson(descriptor.value, ancestors, budget, route, includeInJson, maxObjectKeyLength);
      } finally {
        budget.depth -= 1;
      }
      Object.defineProperty(output, key, {
        value: child,
        enumerable: descriptor.enumerable,
        writable: true,
        configurable: true,
      });
    }
    result = output;
  }
  ancestors.delete(object);
  return result;
}

function addPlainJsonStringUnits(length: number, budget: PlainJsonBudget, route: string): void {
  budget.utf16Units += length;
  if (budget.utf16Units > MAX_PLAIN_JSON_UTF16_UNITS) {
    throw invalidArgument(`${route} UTF-16 string-unit limit`);
  }
}

function parseArray(value: unknown, route: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_READ_ROWS) throw invalidResponse(route);
  return value;
}

function asRecord(value: unknown, route: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(route);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, route: string, limit: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > limit) {
    throw invalidArgument(route);
  }
  return value;
}

function nullableBoundedString(value: unknown, route: string, limit: number): string | null {
  if (value === null) return null;
  return boundedString(value, route, limit, true);
}

function invalidArgument(field: string): ZToolsRendererHostError {
  return invalidRendererArgument(`Invalid ZTools renderer input: ${field}`);
}

function invalidResponse(route: string): ZToolsRendererHostError {
  return invalidRendererResponse(`Invalid read: ${route}`);
}
