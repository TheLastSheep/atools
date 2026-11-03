import {
  assertRendererCallback,
  HOST_ERROR_CODES,
  HOST_ERROR_MESSAGES,
  invalidRendererArgument,
  invalidRendererResponse,
  rendererHostError as hostError,
  ZToolsRendererHostError,
} from "./errors";
import { createRendererCallbackRegistry, dispatchRendererCallbacks, type RendererCallback } from "./callbackRegistry";
import { createRendererEventSubscriptions } from "./eventSubscriptions";
import { safeEventRecord } from "./safeEventRecord";
import {
  GENERAL_RENDERER_EVENT_FIELDS,
  isGeneralPreferenceValue,
  MAX_GENERAL_PREFERENCE_RAW_BYTES,
  type RendererGeneralPreferenceField,
  type RendererGeneralPreferenceValues,
  utf8ByteLength,
} from "./generalPreferenceSchema";
import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";

export const RENDERER_GENERAL_SETTINGS_EVENT = "atools://renderer-general-settings" as const;

export interface RendererGeneralPreferenceCallbacks {
  onAutoCheckUpdateChanged: (value: boolean) => unknown;
  onUpdatePlaceholder: (value: string) => unknown;
  onUpdateAutoPaste: (value: RendererGeneralPreferenceValues["autoPaste"]) => unknown;
  onUpdateAutoClear: (value: string) => unknown;
  onUpdatePrimaryColor: (value: { primaryColor: string; customColor?: string }) => unknown;
  onUpdateShowRecentInSearch: (value: boolean) => unknown;
  onUpdateRecentRows: (value: number) => unknown;
  onUpdatePinnedRows: (value: number) => unknown;
  onUpdateSearchMode: (value: "aggregate" | "list") => unknown;
  onUpdateMatchRecommendation: (value: boolean) => unknown;
  onUpdateTabKeyFunction: (value: "navigate" | "target-command") => unknown;
  onUpdateTabTarget: (value: string) => unknown;
  onUpdateSpaceOpenCommand: (value: boolean) => unknown;
  onUpdateLocalAppSearch: (value: boolean) => unknown;
  onUpdateBuiltinAppShortcutsEnabled: (value: Readonly<RendererGeneralPreferenceValues["builtinAppShortcutsEnabled"]>) => unknown;
}

export type RendererGeneralPreferenceCallbackName = keyof RendererGeneralPreferenceCallbacks;

export interface RendererGeneralPreferenceSnapshot {
  version: 1;
  invalidPayloads: number;
  notifiedFields: { placeholder: number };
}

export interface RendererGeneralPreferenceEvents {
  subscribe<K extends RendererGeneralPreferenceCallbackName>(
    name: K,
    callback: RendererGeneralPreferenceCallbacks[K],
  ): RendererHostUnlisten;
  observeLocalAppSearch(callback: (enabled: boolean) => unknown): RendererHostUnlisten;
  autoCheckBaseline(initial: boolean): boolean;
  ready(): Promise<boolean>;
  snapshot(): RendererGeneralPreferenceSnapshot;
  dispose(): void;
}

type Preferences = Partial<RendererGeneralPreferenceValues>;
type RendererCallbackRegistry<Name extends string> = {
  has(name: string): boolean;
  add(name: Name, callback: RendererCallback): (() => void) | undefined;
};

function callbackName(field: RendererGeneralPreferenceField): RendererGeneralPreferenceCallbackName {
  if (field === "autoCheckUpdate") return "onAutoCheckUpdateChanged";
  const name = field.startsWith("showMatch")
    ? field.slice(4)
    : field.startsWith("tabTarget")
      ? field[0].toUpperCase() + field.slice(1, -7)
      : field[0].toUpperCase() + field.slice(1);
  return `onUpdate${name}` as RendererGeneralPreferenceCallbackName;
}

export const RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS = GENERAL_RENDERER_EVENT_FIELDS
  .filter((field) => field !== "theme" && field !== "customColor")
  .map((field) => [field, callbackName(field)] as const);

export function createRendererGeneralPreferenceEvents(transport: Pick<ZToolsRendererTransport, "listen">) {
  const events = createRendererEventSubscriptions(transport, RENDERER_GENERAL_SETTINGS_EVENT);
  const callbacks = createRendererCallbackRegistry<RendererGeneralPreferenceCallbackName>(
    RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS.map(([, name]) => name),
    64,
  );
  const localAppSearchObservers = createRendererCallbackRegistry<"localAppSearch">(
    ["localAppSearch"],
    64,
  );
  let eventUnlisten: RendererHostUnlisten | undefined;
  let invalidPayloads = 0;
  let disposed = false;
  let latestAutoCheck: boolean | undefined;
  let latestAutoPaste: RendererGeneralPreferenceValues["autoPaste"] | undefined;
  let latestBuiltinShortcuts: Readonly<RendererGeneralPreferenceValues["builtinAppShortcutsEnabled"]> | undefined;
  const notifiedFields = { placeholder: 0 };

  function receive(value: unknown): void {
    if (disposed) return;
    let preferences: Preferences;
    try {
      preferences = parsePreferences(value);
    } catch {
      invalidPayloads += 1;
      return;
    }
    const autoCheckChanged = preferences.autoCheckUpdate !== latestAutoCheck;
    if (preferences.autoCheckUpdate !== undefined) latestAutoCheck = preferences.autoCheckUpdate;
    if (preferences.autoPaste !== undefined) latestAutoPaste = preferences.autoPaste;
    if (preferences.builtinAppShortcutsEnabled !== undefined) {
      latestBuiltinShortcuts = Object.freeze({ ...preferences.builtinAppShortcutsEnabled });
      preferences.builtinAppShortcutsEnabled = latestBuiltinShortcuts;
    }
    localAppSearchObservers.emit("localAppSearch", [preferences.localAppSearch ?? true]);
    for (const [field, name] of RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS) {
      const preference = preferences[field];
      if (preference === undefined || (field === "autoCheckUpdate" && !autoCheckChanged)) continue;
      let notification: unknown = preference;
      if (field === "placeholder") notifiedFields.placeholder += 1;
      if (field === "primaryColor") {
        const primaryColor = preferences.primaryColor;
        if (primaryColor === undefined) continue;
        const color: { primaryColor: string; customColor?: string } = { primaryColor };
        if (preferences.customColor !== undefined) color.customColor = preferences.customColor;
        notification = color;
      }
      callbacks.emit(name, [notification]);
    }
  }

  function ensureEventSubscription(): void {
    if (eventUnlisten || disposed || (callbacks.count() === 0 && localAppSearchObservers.count() === 0)) return;
    eventUnlisten = events.subscribe(receive);
  }

  function stopEventSubscriptionIfUnused(): void {
    if (callbacks.count() !== 0 || localAppSearchObservers.count() !== 0) return;
    eventUnlisten?.();
    eventUnlisten = undefined;
  }

  function registerCallback<Name extends string>(
    registry: RendererCallbackRegistry<Name>,
    name: Name,
    callback: unknown,
    limitName: string = name,
  ): RendererHostUnlisten {
    if (disposed) throw hostError(HOST_ERROR_CODES.DISPOSED, HOST_ERROR_MESSAGES.DISPOSED);
    assertRendererCallback(callback);
    if (!registry.has(name)) throw invalidRendererArgument(HOST_ERROR_MESSAGES.UNKNOWN_CALLBACK);
    const unsubscribe = registry.add(name, callback as RendererCallback);
    if (!unsubscribe) {
      throw invalidRendererArgument(HOST_ERROR_MESSAGES.CALLBACK_LIMIT(limitName));
    }
    if (name === "onAutoCheckUpdateChanged" && latestAutoCheck !== undefined) {
      dispatchRendererCallbacks(new Map([[0, callback as RendererCallback]]), [latestAutoCheck]);
    }
    if (name === "onUpdateAutoPaste" && latestAutoPaste !== undefined) {
      dispatchRendererCallbacks(new Map([[0, callback as RendererCallback]]), [latestAutoPaste]);
    }
    if (name === "onUpdateBuiltinAppShortcutsEnabled" && latestBuiltinShortcuts !== undefined) {
      dispatchRendererCallbacks(new Map([[0, callback as RendererCallback]]), [latestBuiltinShortcuts]);
    }
    ensureEventSubscription();
    return () => {
      unsubscribe();
      stopEventSubscriptionIfUnused();
    };
  }

  return {
    subscribe<K extends RendererGeneralPreferenceCallbackName>(name: K, callback: RendererGeneralPreferenceCallbacks[K]): RendererHostUnlisten {
      return registerCallback(callbacks, name, callback);
    },
    observeLocalAppSearch(callback: (enabled: boolean) => unknown): RendererHostUnlisten {
      return registerCallback(
        localAppSearchObservers,
        "localAppSearch",
        callback,
        "onUpdateLocalAppSearch",
      );
    },
    autoCheckBaseline(initial: boolean): boolean {
      if (disposed) throw hostError(HOST_ERROR_CODES.DISPOSED, HOST_ERROR_MESSAGES.DISPOSED);
      latestAutoCheck ??= initial;
      return latestAutoCheck;
    },
    ready(): Promise<boolean> {
      if (disposed) throw hostError(HOST_ERROR_CODES.DISPOSED, HOST_ERROR_MESSAGES.DISPOSED);
      ensureEventSubscription();
      return events.ready();
    },
    snapshot(): RendererGeneralPreferenceSnapshot {
      return {
        version: 1,
        invalidPayloads,
        notifiedFields: { ...notifiedFields },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      latestAutoCheck = undefined;
      latestAutoPaste = undefined;
      latestBuiltinShortcuts = undefined;
      callbacks.clear();
      localAppSearchObservers.clear();
      eventUnlisten?.();
      eventUnlisten = undefined;
      events.dispose();
    },
  };
}

function parsePreferences(value: unknown): Preferences {
  const envelope = safeEventRecord(value);
  if (Object.keys(envelope).length !== 2 || envelope.version !== 1 || typeof envelope.raw !== "string" || utf8ByteLength(envelope.raw) > MAX_GENERAL_PREFERENCE_RAW_BYTES) throw invalidResponse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(envelope.raw);
  } catch {
    throw invalidResponse();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidResponse();
  const raw = parsed as Record<string, unknown>;
  const result: Preferences = {};
  for (const field of GENERAL_RENDERER_EVENT_FIELDS) {
    if (!Object.hasOwn(raw, field)) continue;
    const preference = raw[field];
    if (!isGeneralPreferenceValue(field, preference)) throw invalidResponse();
    if (field !== "theme") Object.assign(result, { [field]: preference });
  }
  return result;
}

function invalidResponse(): ZToolsRendererHostError {
  return invalidRendererResponse("Invalid renderer General settings event payload.");
}
