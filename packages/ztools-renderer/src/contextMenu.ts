import { createRendererEventSubscriptions } from "./eventSubscriptions";
import { dispatchRendererCallbacks } from "./callbackRegistry";
import { ZToolsRendererHostError } from "./errors";
import { denseEventArrayItem, denseEventArrayLength, selectedEventRecord } from "./safeEventRecord";
import { isRecommendationPinMenuAction } from "./recommendationPins";
import {
  appStateDisposedError,
  appStateInvalidArgument,
  normalizeAppCommand,
  normalizeRemovalIdentity,
} from "./appStateProtocol";
import type { RendererEventSubscriptionsSnapshot } from "./eventSubscriptions";
import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";
import { utf8ByteLength } from "./utf8";

export type RendererContextMenuItem =
  | { type: "separator" }
  | { id: string; label: string; enabled: boolean }
  | { label: string; submenu: { id: string; label: string; enabled: boolean }[] };

export interface RendererContextMenuSnapshot {
  version: 1;
  subscribers: number;
  showInFlight: boolean;
  whitelistedCommands: number;
  showRequests: number;
  showFailures: number;
  acceptedCommands: number;
  ignoredEvents: number;
  invalidEvents: number;
  callbackErrors: number;
  eventSource: RendererEventSubscriptionsSnapshot;
  disposed: boolean;
}

export interface RendererContextMenu {
  showContextMenu(items: unknown): Promise<void>;
  subscribe(callback: (command: string) => unknown): RendererHostUnlisten;
  snapshot(): RendererContextMenuSnapshot;
  dispose(): void;
}

export interface RendererContextMenuOptions {
  transport: Pick<ZToolsRendererTransport, "listen">;
  show(items: RendererContextMenuItem[]): Promise<unknown>;
}

interface NormalizedMenu {
  items: RendererContextMenuItem[];
  enabledCommands: Set<string>;
}

interface ShowWaiter {
  reject(error: unknown): void;
}

const EVENT_NAME = "atools://renderer-context-menu" as const;
const MAX_ITEMS = 64;
const MAX_TOTAL_BYTES = 128 * 1024;
const MAX_LABEL_BYTES = 512;
const MAX_COMMAND_BYTES = 16 * 1024;
const SHORTCUT_COMMAND_BYTES = 128 * 1024;
const commandLimit = (id: string) => id.startsWith("add-global-shortcut:") ? SHORTCUT_COMMAND_BYTES : MAX_COMMAND_BYTES;
const DISABLED_ITEM_ID = "atools-disabled-menu-item";

export function createRendererContextMenu(options: RendererContextMenuOptions): RendererContextMenu {
  const eventSource = createRendererEventSubscriptions(options.transport, EVENT_NAME);
  const subscribers = new Map<number, (command: string) => unknown>();
  const showWaiters = new Set<ShowWaiter>();
  let nextSubscriberId = 0;
  let unsubscribeNative: RendererHostUnlisten | undefined;
  let activeCommands = new Set<string>();
  let showInFlight = false;
  let disposed = false;
  let showRequests = 0;
  let showFailures = 0;
  let acceptedCommands = 0;
  let ignoredEvents = 0;
  let invalidEvents = 0;
  let callbackErrors = 0;
  const recordCallbackError = () => {
    callbackErrors += 1;
  };

  function selectedDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
    try {
      return selectedEventRecord(value, keys);
    } catch (error) {
      if (error instanceof ZToolsRendererHostError) throw error;
      throw appStateInvalidArgument();
    }
  }

  function isEnabledKnownAction(id: string): boolean {
    if (isRecommendationPinMenuAction(id)) return true;
    const separator = id.indexOf(":");
    if (separator <= 0) return false;
    const action = id.slice(0, separator);
    const validStr = (v: unknown, max: number): v is string =>
      typeof v === "string" && !!v && !v.includes("\0") && utf8ByteLength(v) <= max;

    try {
      const payload: unknown = JSON.parse(id.slice(separator + 1));
      if (action === "add-global-shortcut") {
        const app = payload && typeof payload === "object" && !Array.isArray(payload) &&
          Object.keys(payload).sort().join(",") === "name,path,subType" ? (payload as Record<string, unknown>) : null;
        return !!app && app.subType === "app" && validStr(app.path, 16 * 1024) && validStr(app.name, 4 * 1024);
      }
      if (action === "pin-app") return !normalizeAppCommand(payload).path.includes("\0");
      if (action === "unpin-app" || action === "remove-from-history") {
        const record = selectedDataRecord(payload, ["path", "featureCode", "name", "subType"]);
        return hasSupportedSubType(record) && !normalizeRemovalIdentity(record.path, record.featureCode, record.name).path.includes("\0");
      }
      if (action === "reveal-in-finder") {
        const record = selectedDataRecord(payload, ["path", "subType"]);
        return hasSupportedSubType(record) && !normalizeRemovalIdentity(record.path).path.includes("\0");
      }
      return false;
    } catch {
      return false;
    }
  }

  function normalizeItems(value: unknown): NormalizedMenu {
    let length: number;
    try {
      length = denseEventArrayLength(value, MAX_ITEMS);
    } catch (error) {
      if (error instanceof ZToolsRendererHostError) throw error;
      throw appStateInvalidArgument();
    }

    const items: RendererContextMenuItem[] = [];
    const enabledCommands = new Set<string>();
    const source = value as unknown[];
    for (let index = 0; index < length; index += 1) {
      let item: unknown;
      try {
        item = denseEventArrayItem(source, index);
      } catch {
        throw appStateInvalidArgument();
      }

      const typeRecord = selectedDataRecord(item, ["type"]);
      if (typeRecord.type === "separator") {
        items.push({ type: "separator" });
        continue;
      }

      const record = selectedDataRecord(item, ["type", "id", "label", "enabled", "submenu"]);
      const validLabel = (v: unknown): v is string =>
        typeof v === "string" && !!v && utf8ByteLength(v) <= MAX_LABEL_BYTES;
      const validId = (v: unknown): v is string =>
        typeof v === "string" && utf8ByteLength(v) <= commandLimit(v);
      if (
        !validLabel(record.label) ||
        (record.id !== undefined && !validId(record.id)) ||
        (record.enabled !== undefined && typeof record.enabled !== "boolean")
      ) {
        throw appStateInvalidArgument();
      }
      const id = record.id;
      const hasSubmenu = Object.hasOwn(record, "submenu");
      if (hasSubmenu && record.label === "更多" && record.enabled !== false) {
        let childCount: number;
        try { childCount = denseEventArrayLength(record.submenu, MAX_ITEMS); } catch { throw appStateInvalidArgument(); }
        const children: { id: string; label: string; enabled: boolean }[] = [];
        for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
          const child = selectedDataRecord(denseEventArrayItem(record.submenu as unknown[], childIndex), ["id", "label", "enabled", "submenu"]);
          if (Object.hasOwn(child, "submenu") || !validId(child.id) || !validLabel(child.label) ||
            (child.enabled !== undefined && typeof child.enabled !== "boolean")) throw appStateInvalidArgument();
          if (!child.id.startsWith("add-global-shortcut:") || !isEnabledKnownAction(child.id)) continue;
          const enabled = child.enabled !== false;
          children.push({ id: child.id, label: child.label, enabled });
          if (enabled) enabledCommands.add(child.id);
        }
        if (children.length) { items.push({ label: record.label, submenu: children }); continue; }
      }
      if (!hasSubmenu && id === undefined) throw appStateInvalidArgument();
      const enabled =
        !hasSubmenu &&
        id !== undefined &&
        !id.startsWith("add-global-shortcut:") &&
        record.enabled !== false &&
        isEnabledKnownAction(id);
      items.push({ id: id ?? DISABLED_ITEM_ID, label: record.label, enabled });
      if (enabled && id !== undefined) enabledCommands.add(id);
    }

    let totalBytes: number;
    try {
      totalBytes = utf8ByteLength(JSON.stringify(items));
    } catch {
      throw appStateInvalidArgument();
    }
    if (totalBytes > MAX_TOTAL_BYTES) throw appStateInvalidArgument();
    return { items, enabledCommands };
  }

  function deliverEvent(payload: unknown): void {
    if (typeof payload !== "string" || utf8ByteLength(payload) > commandLimit(payload)) {
      invalidEvents += 1;
      return;
    }
    if (!activeCommands.has(payload)) {
      ignoredEvents += 1;
      return;
    }

    activeCommands.clear();
    acceptedCommands += 1;
    dispatchRendererCallbacks(subscribers, [payload], recordCallbackError, () => !disposed);
  }

  function ensureNativeListener(): void {
    if (disposed || unsubscribeNative || subscribers.size === 0) return;
    unsubscribeNative = eventSource.subscribe(deliverEvent);
  }

  function releaseNativeListenerIfIdle(): void {
    if (subscribers.size > 0) return;
    const unlisten = unsubscribeNative;
    unsubscribeNative = undefined;
    if (unlisten) unlisten();
  }

  function settleShowFailure(waiter: ShowWaiter, error: unknown): void {
    if (!showWaiters.has(waiter)) return;
    showWaiters.delete(waiter);
    showInFlight = false;
    waiter.reject(error);
  }

  function showContextMenu(input: unknown): Promise<void> {
    if (disposed) return Promise.reject(appStateDisposedError());
    if (showInFlight) return Promise.reject(appStateInvalidArgument());
    let normalized: NormalizedMenu;
    try {
      normalized = normalizeItems(input);
    } catch (error) {
      return Promise.reject(error);
    }

    showInFlight = true;
    activeCommands = normalized.enabledCommands;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: ShowWaiter = {
        reject(error) {
          if (settled) return;
          settled = true;
          reject(error);
        },
      };
      showWaiters.add(waiter);
      void Promise.resolve()
        .then(() => {
          if (disposed || settled) throw appStateDisposedError();
          showRequests += 1;
          return options.show(normalized.items);
        })
        .then(() => {
          if (disposed || settled) return;
          showInFlight = false;
          settled = true;
          showWaiters.delete(waiter);
          resolve();
        }, (error: unknown) => {
          if (disposed || settled) return;
          showFailures += 1;
          activeCommands.clear();
          settleShowFailure(waiter, error);
        });
    });
  }

  return {
    showContextMenu,

    subscribe(callback) {
      if (disposed) throw appStateDisposedError();
      if (typeof callback !== "function") throw appStateInvalidArgument();
      const id = ++nextSubscriberId;
      subscribers.set(id, callback);
      ensureNativeListener();
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(id);
        releaseNativeListenerIfIdle();
      };
    },

    snapshot(): RendererContextMenuSnapshot {
      const eventSnapshot = eventSource.snapshot();
      return {
        version: 1,
        subscribers: subscribers.size,
        showInFlight,
        whitelistedCommands: activeCommands.size,
        showRequests,
        showFailures,
        acceptedCommands,
        ignoredEvents,
        invalidEvents,
        callbackErrors: callbackErrors + eventSnapshot.callbackErrors,
        eventSource: eventSnapshot,
        disposed,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      activeCommands.clear();
      showInFlight = false;
      const error = appStateDisposedError();
      for (const waiter of [...showWaiters]) settleShowFailure(waiter, error);
      showWaiters.clear();
      subscribers.clear();
      const unlisten = unsubscribeNative;
      unsubscribeNative = undefined;
      if (unlisten) unlisten();
      eventSource.dispose();
    },
  };
}

function hasSupportedSubType(record: Record<string, unknown>): boolean {
  if (!Object.hasOwn(record, "subType")) return true;
  return record.subType === "app" || record.subType === "local-shortcut";
}
