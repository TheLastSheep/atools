import {
  MAX_NATIVE_RESPONSE_BYTES,
  MAX_OPERATION_PAYLOAD_BYTES,
  MAX_PENDING_GENERAL_WRITES,
  SettingsBridgeDisposedError,
  SettingsBridgeError,
  SettingsBridgeProtocolError,
  assertJsonByteBudget,
  boundedUtf8String,
  cloneJson,
  isRecord,
} from "./childBridgeProtocol";
import type { SettingsNativeInvoke } from "./childBridgeTypes";

const MAX_READ_RESPONSE_BYTES = 256 * 1024;
const MAX_SHORTCUTS = 4096;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_NAME_BYTES = 4 * 1024;
const MAX_ID_BYTES = 256;
const MAX_ALIAS_BYTES = 4 * 1024;
const MAX_ICON_BYTES = 64 * 1024;
const MAX_KEYWORDS = 128;
const MAX_KEYWORD_BYTES = 512;
const MAX_PINYIN_BYTES = 16 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;

export type SettingsLocalShortcutType = "file" | "folder" | "app";

export interface SettingsLocalShortcut {
  id: string;
  name: string;
  path: string;
  type: SettingsLocalShortcutType;
  addedAt: number;
  alias?: string;
  icon?: string;
  keywords?: string[];
  pinyin?: string;
  pinyinAbbr?: string;
}

export type SettingsLocalShortcutReply =
  | { success: true; deletedCount?: number }
  | { success: false; error: string; deletedCount?: number };

export interface SettingsChildLocalShortcuts {
  getAll(): Promise<SettingsLocalShortcut[]>;
  add(type: unknown): Promise<SettingsLocalShortcutReply>;
  addByPath(path: unknown): Promise<SettingsLocalShortcutReply>;
  delete(id: unknown): Promise<SettingsLocalShortcutReply>;
  updateAlias(id: unknown, alias: unknown): Promise<SettingsLocalShortcutReply>;
  open(path: unknown): Promise<SettingsLocalShortcutReply>;
  deleteWhenNotExist(): Promise<SettingsLocalShortcutReply>;
}

export interface SettingsChildLocalShortcutsBridge extends SettingsChildLocalShortcuts {
  dispose(): void;
}

export interface SettingsChildLocalShortcutsOptions {
  invokeNative(operation: Parameters<SettingsNativeInvoke>[0], payload: Record<string, unknown>): Promise<unknown>;
  isLive(): boolean;
}

interface QueueEntry<T> {
  operation: Parameters<SettingsNativeInvoke>[0];
  payload: Record<string, unknown>;
  read(value: unknown): T;
  resolve(value: T): void;
  reject(error: unknown): void;
  settled: boolean;
}

export function createSettingsChildLocalShortcutsBridge(
  options: SettingsChildLocalShortcutsOptions,
): SettingsChildLocalShortcutsBridge {
  const queue: QueueEntry<unknown>[] = [];
  let active: QueueEntry<unknown> | undefined;
  let disposed = false;

  function ensureLive(): void {
    if (disposed || !options.isLive()) throw new SettingsBridgeDisposedError();
  }

  function settle<T>(entry: QueueEntry<T>, result: { ok: true; value: T } | { ok: false; error: unknown }): void {
    if (entry.settled) return;
    entry.settled = true;
    if (result.ok) entry.resolve(result.value);
    else entry.reject(result.error);
  }

  function startNext(): void {
    if (disposed || active || queue.length === 0) return;
    const entry = queue.shift();
    if (!entry) return;
    active = entry;
    void Promise.resolve()
      .then(() => {
        ensureLive();
        return options.invokeNative(entry.operation, entry.payload);
      })
      .then((value) => {
        try {
          ensureLive();
          settle(entry, { ok: true, value: entry.read(value) });
        } catch (error) {
          settle(entry, { ok: false, error });
        }
      }, (error: unknown) => settle(entry, { ok: false, error }))
      .finally(() => {
        if (active === entry) active = undefined;
        if (!disposed) startNext();
      });
  }

  function enqueue<T>(
    operation: Parameters<SettingsNativeInvoke>[0],
    payload: Record<string, unknown>,
    read: (value: unknown) => T,
  ): Promise<T> {
    try {
      ensureLive();
      assertJsonByteBudget(payload, MAX_OPERATION_PAYLOAD_BYTES);
    } catch (error) {
      return Promise.reject(error);
    }
    if (queue.length + (active ? 1 : 0) >= MAX_PENDING_GENERAL_WRITES) {
      return Promise.reject(new SettingsBridgeError(
        "ERR_ATOOLS_SETTINGS_QUEUE_FULL",
        "本地启动项请求过多，请稍后重试。",
      ));
    }
    const snapshot = cloneJson(payload) as Record<string, unknown>;
    return new Promise<T>((resolve, reject) => {
      queue.push({ operation, payload: snapshot, read, resolve, reject, settled: false });
      startNext();
    });
  }

  function readShortcuts(value: unknown): SettingsLocalShortcut[] {
    try {
      assertJsonByteBudget(value, MAX_READ_RESPONSE_BYTES);
      const cloned = cloneJson(value);
      if (!Array.isArray(cloned) || cloned.length > MAX_SHORTCUTS) throw new SettingsBridgeProtocolError();
      return cloned.map(readShortcut);
    } catch {
      throw new SettingsBridgeProtocolError();
    }
  }

  function mutateReply(value: unknown): SettingsLocalShortcutReply {
    try {
      assertJsonByteBudget(value, MAX_NATIVE_RESPONSE_BYTES);
      if (!isRecord(value)) throw new SettingsBridgeProtocolError();
      const keys = Object.keys(value);
      const hasError = Object.hasOwn(value, "error");
      const hasCount = Object.hasOwn(value, "deletedCount");
      if (keys.some((key) => key !== "success" && key !== "error" && key !== "deletedCount")
        || typeof value.success !== "boolean"
        || (hasError && !boundedUtf8String(value.error, MAX_ERROR_BYTES))
        || (hasCount && (!Number.isSafeInteger(value.deletedCount) || Number(value.deletedCount) < 0))) {
        throw new SettingsBridgeProtocolError();
      }
      if (value.success && hasError) throw new SettingsBridgeProtocolError();
      if (!value.success && !hasError) throw new SettingsBridgeProtocolError();
      if (hasCount && value.success !== true) throw new SettingsBridgeProtocolError();
      return cloneJson(value) as SettingsLocalShortcutReply;
    } catch {
      throw new SettingsBridgeProtocolError();
    }
  }

  function boundedInput(value: unknown, maxBytes: number, allowEmpty = false): string {
    if (!boundedUtf8String(value, maxBytes) || (!allowEmpty && value.length === 0) || value.includes("\0")) {
      throw new SettingsBridgeProtocolError();
    }
    return value;
  }

  return {
    getAll: () => enqueue("readLocalShortcuts", {}, readShortcuts),
    add(type) {
      if (type !== "file" && type !== "folder") return Promise.reject(new SettingsBridgeProtocolError());
      return enqueue("addLocalShortcut", { type }, mutateReply);
    },
    addByPath(path) {
      try {
        return enqueue("addLocalShortcutByPath", { path: boundedInput(path, MAX_PATH_BYTES) }, mutateReply);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    delete(id) {
      try {
        return enqueue("deleteLocalShortcut", { id: boundedInput(id, MAX_ID_BYTES) }, mutateReply);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    updateAlias(id, alias) {
      try {
        return enqueue("updateLocalShortcutAlias", {
          id: boundedInput(id, MAX_ID_BYTES),
          alias: boundedInput(alias, MAX_ALIAS_BYTES, true),
        }, mutateReply);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    open(path) {
      try {
        return enqueue("openLocalShortcut", { path: boundedInput(path, MAX_PATH_BYTES) }, mutateReply);
      } catch (error) {
        return Promise.reject(error);
      }
    },
    deleteWhenNotExist: () => enqueue("deleteMissingLocalShortcuts", {}, mutateReply),
    dispose() {
      if (disposed) return;
      disposed = true;
      const error = new SettingsBridgeDisposedError();
      for (const entry of queue.splice(0)) settle(entry, { ok: false, error });
      if (active) settle(active, { ok: false, error });
    },
  };
}

function readShortcut(value: unknown): SettingsLocalShortcut {
  if (!isRecord(value)) throw new SettingsBridgeProtocolError();
  const keys = Object.keys(value);
  const allowed = new Set(["id", "name", "path", "type", "addedAt", "alias", "icon", "keywords", "pinyin", "pinyinAbbr"]);
  if (keys.some((key) => !allowed.has(key))
    || !["id", "name", "path", "type", "addedAt"].every((key) => Object.hasOwn(value, key))
    || !boundedUtf8String(value.id, MAX_ID_BYTES) || value.id.length === 0
    || !boundedUtf8String(value.name, MAX_NAME_BYTES) || value.name.length === 0
    || !boundedUtf8String(value.path, MAX_PATH_BYTES) || value.path.length === 0
    || value.path.includes("\0")
    || (value.type !== "file" && value.type !== "folder" && value.type !== "app")
    || !Number.isSafeInteger(value.addedAt) || Number(value.addedAt) < 0) {
    throw new SettingsBridgeProtocolError();
  }
  const shortcut: SettingsLocalShortcut = {
    id: value.id,
    name: value.name,
    path: value.path,
    type: value.type,
    addedAt: Number(value.addedAt),
  };
  if (Object.hasOwn(value, "alias")) {
    if (!boundedUtf8String(value.alias, MAX_ALIAS_BYTES)) throw new SettingsBridgeProtocolError();
    shortcut.alias = value.alias;
  }
  if (Object.hasOwn(value, "icon")) {
    if (!boundedUtf8String(value.icon, MAX_ICON_BYTES)) throw new SettingsBridgeProtocolError();
    shortcut.icon = value.icon;
  }
  if (Object.hasOwn(value, "keywords")) {
    if (!Array.isArray(value.keywords) || value.keywords.length > MAX_KEYWORDS
      || !value.keywords.every((keyword: unknown) => boundedUtf8String(keyword, MAX_KEYWORD_BYTES))) {
      throw new SettingsBridgeProtocolError();
    }
    shortcut.keywords = [...value.keywords] as string[];
  }
  for (const field of ["pinyin", "pinyinAbbr"] as const) {
    if (Object.hasOwn(value, field)) {
      if (!boundedUtf8String(value[field], MAX_PINYIN_BYTES)) throw new SettingsBridgeProtocolError();
      shortcut[field] = value[field];
    }
  }
  return shortcut;
}
