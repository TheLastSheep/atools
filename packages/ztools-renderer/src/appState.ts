import { createRendererEventSubscriptions } from "./eventSubscriptions";
import { dispatchRendererCallbacks } from "./callbackRegistry";
import type { RendererHostUnlisten } from "./types";
import {
  appStateDisposedError,
  appStateInvalidArgument,
  appStateInvalidResponse,
  cloneAppMutation,
  normalizeAppCommand,
  normalizeAppCommands,
  normalizeAppIdentity,
  normalizeRemovalIdentity,
  validateAppStatePayload,
  type AppIdentity,
  type AppMutationRequest,
  type NativePayload,
  type RendererAppState,
  type RendererAppStateOptions,
  type RendererAppStateSnapshot,
  type RendererAppStateValues,
} from "./appStateProtocol";

export type {
  AppIdentity,
  AppMutationRequest,
  RendererAppState,
  RendererAppStateOptions,
  RendererAppStateSnapshot,
  RendererAppStateValues,
} from "./appStateProtocol";

interface MutationEntry {
  request: AppMutationRequest;
  resolve(): void;
  reject(error: unknown): void;
  settled: boolean;
}

const EVENT_NAME = "atools://renderer-app-state" as const;
const MAX_PENDING_MUTATIONS = 16;

export function createRendererAppState(options: RendererAppStateOptions): RendererAppState {
  const eventSource = createRendererEventSubscriptions(options.transport, EVENT_NAME);
  const historySubscribers = new Map<number, () => unknown>();
  const pinnedSubscribers = new Map<number, () => unknown>();
  const disposeWaiters = new Set<(error: ReturnType<typeof appStateDisposedError>) => void>();
  const mutationQueue: MutationEntry[] = [];
  let nextSubscriberId = 0;
  let activeMutation: MutationEntry | undefined;
  let unsubscribeNative: RendererHostUnlisten | undefined;
  let revision: number | null = null;
  let lastAcceptedValues: RendererAppStateValues | undefined;
  let disposed = false;
  let acceptedReplies = 0;
  let acceptedEvents = 0;
  let stalePayloads = 0;
  let invalidPayloads = 0;
  let mutationFailures = 0;
  let applyErrors = 0;
  let callbackErrors = 0;
  const recordCallbackError = () => {
    callbackErrors += 1;
  };

  function invokeCallbacks(subscribers: Map<number, () => unknown>): void {
    dispatchRendererCallbacks(subscribers, [], recordCallbackError, () => !disposed);
  }

  function acceptPayload(payload: unknown, source: "event" | "reply"): void {
    let next: NativePayload;
    try {
      next = validateAppStatePayload(payload);
    } catch {
      invalidPayloads += 1;
      throw appStateInvalidResponse();
    }
    if (disposed) throw appStateDisposedError();
    if (revision !== null && next.revision <= revision) {
      stalePayloads += 1;
      return;
    }

    const previousValues = lastAcceptedValues;
    try {
      options.applyValues({
        "command-history": next.values["command-history"],
        "pinned-commands": next.values["pinned-commands"],
      });
    } catch {
      applyErrors += 1;
      throw appStateInvalidResponse();
    }

    if (disposed) throw appStateDisposedError();
    revision = next.revision;
    lastAcceptedValues = {
      "command-history": next.values["command-history"],
      "pinned-commands": next.values["pinned-commands"],
    };
    if (source === "event") acceptedEvents += 1;
    else acceptedReplies += 1;

    const historyChanged =
      previousValues === undefined ||
      next.changed.includes("command-history") ||
      next.values["command-history"] !== previousValues["command-history"];
    const pinsChanged =
      previousValues === undefined ||
      next.changed.includes("pinned-commands") ||
      next.values["pinned-commands"] !== previousValues["pinned-commands"];
    if (historyChanged) invokeCallbacks(historySubscribers);
    if (pinsChanged) invokeCallbacks(pinnedSubscribers);
  }

  function ensureNativeListener(): void {
    if (disposed || (historySubscribers.size === 0 && pinnedSubscribers.size === 0)) return;
    if (unsubscribeNative) {
      if (eventSource.snapshot().listenerState !== "failed") return;
      const failedSubscription = unsubscribeNative;
      unsubscribeNative = undefined;
      failedSubscription();
    }
    unsubscribeNative = eventSource.subscribe((payload) => acceptPayload(payload, "event"));
  }

  function releaseNativeListenerIfIdle(): void {
    if (historySubscribers.size > 0 || pinnedSubscribers.size > 0) return;
    const unlisten = unsubscribeNative;
    unsubscribeNative = undefined;
    if (unlisten) unlisten();
  }

  function subscribe(
    subscribers: Map<number, () => unknown>,
    callback: () => unknown,
  ): RendererHostUnlisten {
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
  }

  function settleMutation(entry: MutationEntry, succeeded: true): void;
  function settleMutation(entry: MutationEntry, succeeded: false, error: unknown): void;
  function settleMutation(entry: MutationEntry, succeeded: boolean, error?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (succeeded) entry.resolve();
    else entry.reject(error);
  }

  function startNextMutation(): void {
    if (disposed || activeMutation || mutationQueue.length === 0) return;
    const entry = mutationQueue.shift();
    if (!entry) return;
    activeMutation = entry;
    void Promise.resolve()
      .then(() => {
        if (disposed || activeMutation !== entry || entry.settled) throw appStateDisposedError();
        return options.mutate(cloneAppMutation(entry.request));
      })
      .then((payload) => {
        if (disposed || activeMutation !== entry || entry.settled) return;
        try {
          acceptPayload(payload, "reply");
          settleMutation(entry, true);
        } catch (error) {
          mutationFailures += 1;
          settleMutation(entry, false, error);
        }
      })
      .catch((error: unknown) => {
        if (!entry.settled) {
          if (!disposed) mutationFailures += 1;
          settleMutation(entry, false, disposed ? appStateDisposedError() : error);
        }
      })
      .finally(() => {
        if (activeMutation === entry) activeMutation = undefined;
        if (!disposed) startNextMutation();
      });
  }

  function enqueueMutation(request: AppMutationRequest): Promise<void> {
    if (disposed) return Promise.reject(appStateDisposedError());
    if (mutationQueue.length + (activeMutation ? 1 : 0) >= MAX_PENDING_MUTATIONS) {
      return Promise.reject(appStateInvalidArgument());
    }
    return new Promise<void>((resolve, reject) => {
      mutationQueue.push({ request, resolve, reject, settled: false });
      startNextMutation();
    });
  }

  function launchApp(target: AppIdentity): Promise<unknown> {
    if (disposed) return Promise.reject(appStateDisposedError());
    let safeTarget: AppIdentity;
    try {
      safeTarget = normalizeAppIdentity(target);
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const succeed = (value: unknown) => {
        if (settled) return;
        settled = true;
        disposeWaiters.delete(onDispose);
        resolve(value);
      };
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        disposeWaiters.delete(onDispose);
        reject(error);
      };
      const onDispose = (error: ReturnType<typeof appStateDisposedError>) => fail(error);
      disposeWaiters.add(onDispose);
      void Promise.resolve()
        .then(() => {
          if (settled || disposed) throw appStateDisposedError();
          return options.launch({ ...safeTarget });
        })
        .then((payload) => {
          try {
            acceptPayload(payload, "reply");
            succeed(payload);
          } catch (error) {
            fail(error);
          }
        }, fail);
    });
  }

  return {
    pinApp(command) {
      let app: AppIdentity;
      try {
        app = normalizeAppCommand(command);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueueMutation({ operation: "pin", app });
    },

    unpinApp(path, featureCode, name) {
      let identity: { path: string; name?: string };
      try {
        identity = normalizeRemovalIdentity(path, featureCode, name);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueueMutation({ operation: "unpin", ...identity });
    },

    removeFromHistory(path, featureCode, name) {
      let identity: { path: string; name?: string };
      try {
        identity = normalizeRemovalIdentity(path, featureCode, name);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueueMutation({ operation: "remove_history", ...identity });
    },

    updatePinnedOrder(commands) {
      let apps: AppIdentity[];
      try {
        apps = normalizeAppCommands(commands);
      } catch (error) {
        return Promise.reject(error);
      }
      return enqueueMutation({ operation: "reorder_pins", apps });
    },

    clearPins() {
      return enqueueMutation({ operation: "clear_pins" });
    },

    clearHistory() {
      return enqueueMutation({ operation: "clear_history" });
    },

    launchApp,

    onHistoryChanged(callback) {
      return subscribe(historySubscribers, callback);
    },

    onPinnedChanged(callback) {
      return subscribe(pinnedSubscribers, callback);
    },

    snapshot(): RendererAppStateSnapshot {
      const eventSnapshot = eventSource.snapshot();
      return {
        version: 1,
        revision,
        historySubscribers: historySubscribers.size,
        pinnedSubscribers: pinnedSubscribers.size,
        listenerState: eventSnapshot.listenerState,
        eventSource: eventSnapshot,
        queuedMutations: mutationQueue.length + (activeMutation ? 1 : 0),
        acceptedReplies,
        acceptedEvents,
        stalePayloads,
        invalidPayloads,
        mutationFailures,
        applyErrors,
        callbackErrors: callbackErrors + eventSnapshot.callbackErrors,
        disposed,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      const error = appStateDisposedError();
      const active = activeMutation;
      activeMutation = undefined;
      if (active) settleMutation(active, false, error);
      for (const entry of mutationQueue.splice(0)) settleMutation(entry, false, error);
      for (const waiter of [...disposeWaiters]) waiter(error);
      disposeWaiters.clear();
      historySubscribers.clear();
      pinnedSubscribers.clear();
      const unlisten = unsubscribeNative;
      unsubscribeNative = undefined;
      if (unlisten) unlisten();
      eventSource.dispose();
    },
  };
}
