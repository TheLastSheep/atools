import {
  HOST_ERROR_MESSAGES,
  adapterDisposedError,
  assertRendererCallback,
  invalidRendererArgument,
  invalidRendererResponse,
} from "./errors";
import { denseEventArrayItem, denseEventArrayLength, exactEventRecord, safeEventRecord } from "./safeEventRecord";
import { createRendererEventSubscriptions } from "./eventSubscriptions";
import { dispatchRendererCallbacks } from "./callbackRegistry";
import { utf8ByteLength } from "./utf8";
import type { RendererEventSubscriptionsSnapshot } from "./eventSubscriptions";
import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";

const MAX_SHORTCUTS = 4096;
const MAX_ID_BYTES = 256;
const MAX_NAME_BYTES = 4096;
const MAX_PATH_BYTES = 16 * 1024;
const MAX_ALIAS_BYTES = 4096;
const MAX_ICON_BYTES = 64 * 1024;
const MAX_KEYWORDS = 128;
const MAX_KEYWORD_BYTES = 512;
const MAX_PINYIN_BYTES = 16 * 1024;
const MAX_EVENT_CALLBACKS = 64;

export const RENDERER_LOCAL_SHORTCUTS_EVENT = "atools://renderer-local-shortcuts";

export type RendererLocalShortcutType = "file" | "folder" | "app";

export interface RendererLocalShortcut {
  id: string;
  name: string;
  path: string;
  type: RendererLocalShortcutType;
  addedAt: number;
  alias?: string;
  icon?: string;
  keywords?: string[];
  pinyin?: string;
  pinyinAbbr?: string;
}

export interface RendererLocalShortcutEventsSnapshot extends RendererEventSubscriptionsSnapshot {
  invalidEvents: number;
  staleEvents: number;
  latestRevision: number | null;
  replayPending: boolean;
}

export interface RendererLocalShortcutEvents {
  ready(): Promise<boolean>;
  subscribe(callback: () => unknown): RendererHostUnlisten;
  snapshot(): RendererLocalShortcutEventsSnapshot;
  dispose(): void;
}

function invalidShortcuts(): ReturnType<typeof invalidRendererResponse> {
  return invalidRendererResponse("Invalid renderer local-shortcuts response.");
}

function boundedString(value: unknown, maxBytes: number, route: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)
    || utf8ByteLength(value) > maxBytes || value.includes("\0")) {
    throw invalidRendererResponse(`Invalid renderer local-shortcuts ${route}.`);
  }
  return value;
}

export function parseRendererLocalShortcuts(value: unknown): RendererLocalShortcut[] {
  try {
    const length = denseEventArrayLength(value, MAX_SHORTCUTS);
    const source = value as unknown[];
    const result: RendererLocalShortcut[] = [];
    for (let index = 0; index < length; index += 1) {
      const row = safeEventRecord(denseEventArrayItem(source, index));
      const allowed = new Set([
        "id", "name", "path", "type", "addedAt", "alias", "icon", "keywords", "pinyin", "pinyinAbbr",
      ]);
      if (Object.keys(row).some((key) => !allowed.has(key))
        || !["id", "name", "path", "type", "addedAt"].every((key) => Object.hasOwn(row, key))) {
        throw invalidShortcuts();
      }
      if (row.type !== "file" && row.type !== "folder" && row.type !== "app") throw invalidShortcuts();
      if (!Number.isSafeInteger(row.addedAt) || Number(row.addedAt) < 0) throw invalidShortcuts();
      const shortcut: RendererLocalShortcut = {
        id: boundedString(row.id, MAX_ID_BYTES, "id"),
        name: boundedString(row.name, MAX_NAME_BYTES, "name"),
        path: boundedString(row.path, MAX_PATH_BYTES, "path"),
        type: row.type,
        addedAt: Number(row.addedAt),
      };
      if (Object.hasOwn(row, "alias")) shortcut.alias = boundedString(row.alias, MAX_ALIAS_BYTES, "alias", true);
      if (Object.hasOwn(row, "icon")) shortcut.icon = boundedString(row.icon, MAX_ICON_BYTES, "icon", true);
      if (Object.hasOwn(row, "keywords")) {
        const keywords = row.keywords;
        const keywordCount = denseEventArrayLength(keywords, MAX_KEYWORDS);
        shortcut.keywords = Array.from({ length: keywordCount }, (_, keywordIndex) =>
          boundedString(denseEventArrayItem(keywords as unknown[], keywordIndex), MAX_KEYWORD_BYTES, "keyword", true));
      }
      for (const field of ["pinyin", "pinyinAbbr"] as const) {
        if (Object.hasOwn(row, field)) shortcut[field] = boundedString(row[field], MAX_PINYIN_BYTES, field, true);
      }
      result.push(shortcut);
    }
    return result;
  } catch {
    throw invalidShortcuts();
  }
}

export function createRendererLocalShortcutEvents(
  transport: Pick<ZToolsRendererTransport, "listen">,
  invalidate: () => void,
  ensureActive: () => void,
): RendererLocalShortcutEvents {
  let disposed = false;
  let lastRevision: number | null = null;
  let invalidEvents = 0;
  let staleEvents = 0;
  let callbackErrors = 0;
  let replayPending = false;
  let nextSubscriberId = 0;
  let monitorUnlisten: RendererHostUnlisten | undefined;
  const subscribers = new Map<number, () => unknown>();
  const recordCallbackError = () => { callbackErrors += 1; };
  const subscriptions = createRendererEventSubscriptions(
    transport,
    RENDERER_LOCAL_SHORTCUTS_EVENT,
    (payload) => {
      try {
        const record = exactEventRecord(payload, ["version", "revision"]);
        if (record.version !== 1 || !Number.isSafeInteger(record.revision) || Number(record.revision) < 0) {
          invalidEvents += 1;
          return false;
        }
        const revision = Number(record.revision);
        if (lastRevision !== null && revision <= lastRevision) {
          staleEvents += 1;
          return false;
        }
        lastRevision = revision;
        return true;
      } catch {
        invalidEvents += 1;
        return false;
      }
    },
    invalidate,
  );

  function ensureMonitor(): Promise<boolean> {
    ensureActive();
    if (disposed) return Promise.reject(adapterDisposedError());
    if (!monitorUnlisten) {
      monitorUnlisten = subscriptions.subscribe(() => {
        if (subscribers.size === 0) {
          replayPending = true;
          return;
        }
        replayPending = false;
        dispatchRendererCallbacks(subscribers, [], recordCallbackError, () => !disposed);
      });
    }
    return subscriptions.ready();
  }

  return {
    ready: ensureMonitor,
    subscribe(callback) {
      ensureActive();
      if (disposed) throw adapterDisposedError();
      assertRendererCallback(callback);
      if (subscribers.size >= MAX_EVENT_CALLBACKS) {
        throw invalidRendererArgument(HOST_ERROR_MESSAGES.CALLBACK_LIMIT("onLocalShortcutsChanged"));
      }
      const id = ++nextSubscriberId;
      subscribers.set(id, callback);
      void ensureMonitor();
      if (replayPending) {
        replayPending = false;
        dispatchRendererCallbacks(new Map([[id, callback]]), [], recordCallbackError, () => !disposed);
      }
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(id);
      };
    },
    snapshot() {
      const eventSnapshot = subscriptions.snapshot();
      return {
        ...eventSnapshot,
        subscribers: subscribers.size,
        callbackErrors: callbackErrors + eventSnapshot.callbackErrors,
        invalidEvents,
        staleEvents,
        latestRevision: lastRevision,
        replayPending,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      replayPending = false;
      lastRevision = null;
      subscribers.clear();
      const unlisten = monitorUnlisten;
      monitorUnlisten = undefined;
      if (unlisten) unlisten();
      subscriptions.dispose();
    },
  };
}
