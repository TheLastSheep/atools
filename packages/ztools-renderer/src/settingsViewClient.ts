import {
  assertRendererCallback,
  HOST_ERROR_CODES,
  HOST_ERROR_MESSAGES,
  invalidRendererArgument,
  rendererHostError as hostError,
} from "./errors";
import { createRendererCallbackRegistry, type RendererCallback } from "./callbackRegistry";
import { createRendererEventSubscriptions } from "./eventSubscriptions";
import { createRendererSettingsInput } from "./settingsInput";
import type { RendererSettingsInputCallbackName, RendererSettingsInputCallbacks, RendererSettingsInputSnapshot } from "./settingsInput";
import {
  parseRendererSettingsViewEvent,
  parseRendererSettingsViewOpenReceipt,
  RENDERER_SETTINGS_VIEW_EVENT,
} from "./settingsViewProtocol";
import type { RendererSettingsViewEvent, RendererSettingsViewPhase, RendererSettingsViewPlugin } from "./settingsViewProtocol";
import type { RendererHostCommand, RendererHostUnlisten, ZToolsRendererTransport } from "./types";

export { RENDERER_SETTINGS_VIEW_EVENT } from "./settingsViewProtocol";
export type { RendererSettingsViewEvent, RendererSettingsViewPlugin } from "./settingsViewProtocol";
const MAX_CALLBACKS = 64;
const MAX_RETIRED_SESSIONS = 16;
export const RENDERER_SETTINGS_VIEW_CALLBACKS = ["onShowPluginPlaceholder", "onPluginOpened", "onPluginLoaded", "onPluginClosed", "onBackToSearch"] as const;

export type { RendererSettingsViewPhase } from "./settingsViewProtocol";
export type RendererSettingsViewCallbackName = typeof RENDERER_SETTINGS_VIEW_CALLBACKS[number];
export type RendererSettingsViewCloseReason = "main-hide";

export interface RendererSettingsViewCallbacks {
  onShowPluginPlaceholder: () => unknown;
  onPluginOpened: (plugin: RendererSettingsViewPlugin) => unknown;
  onPluginLoaded: (plugin: { name: string; path: string }) => unknown;
  onPluginClosed: () => unknown;
  onBackToSearch: () => unknown;
}

export type RendererSettingsViewSnapshot = {
  version: 1;
  listenerState: "idle" | "registering" | "listening" | "failed" | "disposed";
  activePhase: "open-requested" | RendererSettingsViewPhase | null;
  input: RendererSettingsInputSnapshot;
  pendingOpen: boolean;
  openFailures: number;
  closeFailures: number;
  invalidPayloads: number;
  registrationErrors: number;
  lateListenerUnlistens: number;
  cleanupErrors: number;
};

export interface RendererSettingsViewClient {
  open(): void;
  close(reason: RendererSettingsViewCloseReason): void;
  subscribe<K extends RendererSettingsViewCallbackName>(name: K, callback: RendererSettingsViewCallbacks[K]): RendererHostUnlisten;
  subscribeInput<K extends RendererSettingsInputCallbackName>(name: K, callback: RendererSettingsInputCallbacks[K]): RendererHostUnlisten;
  notifySubInputChange(text: string): void;
  inputSnapshot(): RendererSettingsInputSnapshot;
  snapshot(): RendererSettingsViewSnapshot;
  dispose(): void;
}

export function createRendererSettingsViewClient(options: {
  invoke(command: RendererHostCommand, args?: Record<string, unknown>): Promise<unknown>;
  transport: Pick<ZToolsRendererTransport, "listen">;
  onLifecycleChanged?: (blocked: boolean) => void;
}): RendererSettingsViewClient {
  const callbacks = createRendererCallbackRegistry<RendererSettingsViewCallbackName>(RENDERER_SETTINGS_VIEW_CALLBACKS, MAX_CALLBACKS);
  const events = createRendererEventSubscriptions(options.transport, RENDERER_SETTINGS_VIEW_EVENT);
  let eventUnlisten: RendererHostUnlisten | undefined;
  let invalidPayloads = 0;
  let openFailures = 0;
  let closeFailures = 0;
  let disposed = false;
  let sessionId: string | undefined;
  let activePhase: RendererSettingsViewSnapshot["activePhase"] = null;
  let openPromise: Promise<void> | undefined;
  let openGeneration = 0;
  let queuedClose = false;
  const closing = new Set<string>();
  const retired = new Set<string>();

  function stopListener(): void {
    eventUnlisten?.();
    eventUnlisten = undefined;
  }

  function ensureListener(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (!eventUnlisten) eventUnlisten = events.subscribe(receive);
    return events.ready();
  }

  const input = createRendererSettingsInput({
    invoke: options.invoke,
    lifecycle: () => ({
      sessionId, active: isActiveSession(), opened: activePhase === "opened" || activePhase === "loaded",
      opening: Boolean(openPromise) && !queuedClose, closing: queuedClose || Boolean(sessionId && closing.has(sessionId)),
      disposed, retired: (target) => retired.has(target),
    }),
  });

  function lifecycleChanged(): void {
    input.lifecycleChanged();
    options.onLifecycleChanged?.(Boolean(openPromise) || isActiveSession());
  }

  function retire(sessionId: string | undefined): void {
    if (!sessionId) return;
    retired.add(sessionId);
    if (retired.size > MAX_RETIRED_SESSIONS) retired.delete(retired.values().next().value!);
  }

  function emit<K extends RendererSettingsViewCallbackName>(name: K, ...args: Parameters<RendererSettingsViewCallbacks[K]>): void {
    callbacks.emit(name, args as unknown[]);
  }

  function receive(payload: unknown): void {
    if (disposed) return;
    if (input.receive(payload)) return;
    let event: ReturnType<typeof parseRendererSettingsViewEvent>;
    try {
      event = parseRendererSettingsViewEvent(payload);
    } catch {
      invalidPayloads += 1;
      return;
    }
    if (event.phase === "auto-back-to-search") {
      if (!isActiveSession() && !openPromise && !queuedClose) emit("onBackToSearch");
      return;
    }
    if (event.phase === "placeholder") return placeholder(event);
    if (event.phase === "opened") return opened(event);
    if (event.phase === "loaded") return loaded(event);
    if (event.phase === "closed") return closed(event);
    backToSearch(event);
  }

  function placeholder(event: RendererSettingsViewEvent): void {
    if (retired.has(event.sessionId)) return;
    if (event.sessionId === sessionId && activePhase === "open-requested") {
      activePhase = "placeholder";
      emit("onShowPluginPlaceholder");
      lifecycleChanged();
      return;
    }
    if (event.sessionId === sessionId) return;
    if (isActiveSession() || !openPromise) return;
    retire(sessionId);
    if (sessionId) closing.delete(sessionId);
    sessionId = event.sessionId;
    activePhase = "placeholder";
    emit("onShowPluginPlaceholder");
    lifecycleChanged();
  }

  function opened(event: RendererSettingsViewEvent): void {
    if (!isCurrent(event.sessionId)) return;
    if (activePhase === "opened" || activePhase === "loaded") {
      return;
    }
    if (activePhase !== "placeholder" || !event.plugin) {
      return;
    }
    activePhase = "opened";
    emit("onPluginOpened", event.plugin);
    lifecycleChanged();
  }

  function loaded(event: RendererSettingsViewEvent): void {
    if (!isCurrent(event.sessionId)) return;
    if (activePhase === "loaded") {
      return;
    }
    if (activePhase !== "opened") {
      return;
    }
    activePhase = "loaded";
    emit("onPluginLoaded", { name: "setting", path: "atools:internal/setting" });
    lifecycleChanged();
  }

  function closed(event: RendererSettingsViewEvent): void {
    if (!isCurrent(event.sessionId)) return;
    retire(event.sessionId);
    activePhase = "closed";
    emit("onPluginClosed");
    lifecycleChanged();
    stopWhenUnused();
  }

  function backToSearch(event: RendererSettingsViewEvent): void {
    if (event.sessionId !== sessionId || closing.has(event.sessionId) || activePhase === "back-to-search") return;
    if (activePhase !== "closed" && retired.has(event.sessionId)) return;
    retire(event.sessionId);
    activePhase = "back-to-search";
    emit("onBackToSearch");
    lifecycleChanged();
    stopWhenUnused();
  }

  function isCurrent(targetSessionId: string): boolean {
    return targetSessionId === sessionId && isActiveSession();
  }

  function isActiveSession(): boolean {
    return activePhase !== null && activePhase !== "closed" && activePhase !== "back-to-search";
  }

  function stopWhenUnused(): void {
    if (callbacks.count() + input.callbackCount() === 0 && !openPromise && !isActiveSession()) stopListener();
  }

  function sendClose(targetSessionId: string, reason: RendererSettingsViewCloseReason): void {
    if (closing.has(targetSessionId)) return;
    closing.add(targetSessionId);
    lifecycleChanged();
    void Promise.resolve().then(() => options.invoke("close_renderer_settings", { sessionId: targetSessionId, reason }))
      .catch(() => { closeFailures += 1; })
      .finally(() => {
        if (targetSessionId !== sessionId) closing.delete(targetSessionId);
      });
  }

  function acceptOpenReceipt(payload: unknown, generation: number): boolean {
    const receipt = parseRendererSettingsViewOpenReceipt(payload);
    if (disposed || generation !== openGeneration) return false;
    if (retired.has(receipt.sessionId)) {
      if (receipt.sessionId === sessionId) queuedClose = false;
      return false;
    }
    if (receipt.sessionId === sessionId && !isActiveSession()) {
      queuedClose = false;
      return true;
    }
    if (isActiveSession() && sessionId !== receipt.sessionId) {
      invalidPayloads += 1;
      return false;
    }
    if (!isActiveSession()) {
      if (sessionId) closing.delete(sessionId);
      sessionId = receipt.sessionId;
      activePhase = "open-requested";
      lifecycleChanged();
    }
    if (queuedClose) {
      queuedClose = false;
      sendClose(receipt.sessionId, "main-hide");
    }
    return true;
  }

  return {
    open() {
      if (disposed) return;
      if (openPromise || isActiveSession()) {
        return;
      }
      options.onLifecycleChanged?.(true);
      const generation = ++openGeneration;
      let acceptedReceipt = false;
      const operation = (async () => {
        if (!await ensureListener() || disposed || generation !== openGeneration) {
          openFailures += 1;
          return;
        }
        if (isActiveSession()) {
          return;
        }
        try {
          acceptedReceipt = acceptOpenReceipt(await options.invoke("open_renderer_settings"), generation);
        } catch {
          openFailures += 1;
        }
      })();
      let tracked!: Promise<void>;
      tracked = operation.finally(() => {
        if (openPromise === tracked) openPromise = undefined;
        if (generation === openGeneration && queuedClose && !acceptedReceipt) {
          queuedClose = false;
          if (!disposed && isActiveSession() && sessionId) sendClose(sessionId, "main-hide");
        }
        lifecycleChanged();
        stopWhenUnused();
      }).catch(() => { openFailures += 1; });
      openPromise = tracked;
    },
    close(reason) {
      if (disposed) return;
      if (isActiveSession() && sessionId) {
        sendClose(sessionId, reason);
      } else if (openPromise) {
        queuedClose = true;
        lifecycleChanged();
      }
    },
    subscribe(name, callback) {
      if (disposed) throw hostError(HOST_ERROR_CODES.DISPOSED, HOST_ERROR_MESSAGES.DISPOSED);
      assertRendererCallback(callback);
      if (!callbacks.has(name)) throw invalidRendererArgument(HOST_ERROR_MESSAGES.UNKNOWN_CALLBACK);
      const unsubscribe = callbacks.add(name, callback as RendererCallback);
      if (!unsubscribe) {
        throw invalidRendererArgument(HOST_ERROR_MESSAGES.CALLBACK_LIMIT(name));
      }
      void ensureListener();
      return () => {
        unsubscribe();
        stopWhenUnused();
      };
    },
    subscribeInput(name, callback) {
      if (disposed) throw hostError(HOST_ERROR_CODES.DISPOSED, HOST_ERROR_MESSAGES.DISPOSED);
      const unsubscribe = input.subscribe(name, callback);
      void ensureListener();
      return () => {
        unsubscribe();
        stopWhenUnused();
      };
    },
    notifySubInputChange(text) {
      if (disposed) throw hostError(HOST_ERROR_CODES.DISPOSED, HOST_ERROR_MESSAGES.DISPOSED);
      input.notifySubInputChange(text);
    },
    inputSnapshot: () => input.snapshot(),
    snapshot() {
      const listener = events.snapshot();
      return {
        version: 1,
        listenerState: listener.listenerState,
        activePhase,
        input: input.snapshot(),
        pendingOpen: Boolean(openPromise),
        openFailures,
        closeFailures,
        invalidPayloads,
        registrationErrors: listener.registrationErrors,
        lateListenerUnlistens: listener.lateListenerUnlistens,
        cleanupErrors: listener.cleanupErrors,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      openGeneration += 1;
      queuedClose = false;
      input.dispose();
      callbacks.clear();
      stopListener();
      events.dispose();
    },
  };
}

