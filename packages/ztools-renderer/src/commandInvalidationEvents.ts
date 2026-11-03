import { adapterDisposedError, assertRendererCallback } from "./errors";
import { createRendererNullEventSubscriptions } from "./eventSubscriptions";
import type { RendererEventName, RendererEventSubscriptionsSnapshot } from "./eventSubscriptions";
import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";

export const RENDERER_COMMAND_ALIASES_EVENT = "atools://renderer-command-aliases";
export const RENDERER_DISABLED_COMMANDS_EVENT = "atools://renderer-disabled-commands";
export const RENDERER_COMMAND_ALIASES_MAX_BYTES = 512 * 1024;

export interface RendererCommandInvalidationEventsSnapshot extends RendererEventSubscriptionsSnapshot {
  callbacks: number;
  invalidPayloads: number;
}

export interface RendererCommandInvalidationEvents {
  subscribe(callback: () => unknown): RendererHostUnlisten;
  ready(): Promise<boolean>;
  snapshot(): RendererCommandInvalidationEventsSnapshot;
  dispose(): void;
}

export interface RendererCommandInvalidationEventApi {
  onCommandAliasesChanged(callback: () => unknown): RendererHostUnlisten;
  onDisabledCommandsChanged(callback: () => unknown): RendererHostUnlisten;
}

export interface RendererCommandChangeEvents {
  aliases: RendererCommandInvalidationEvents;
  disabledCommands: RendererCommandInvalidationEvents;
  api: RendererCommandInvalidationEventApi;
  dispose(): void;
}

/** Shares the eager null-event listener while keeping each command setting independently invalidated. */
export function createRendererCommandInvalidationEvents(
  transport: Pick<ZToolsRendererTransport, "listen">,
  event: RendererEventName,
  invalidate: () => void,
): RendererCommandInvalidationEvents {
  let disposed = false;
  let invalidPayloads = 0;
  const subscriptions = createRendererNullEventSubscriptions(
    transport,
    event,
    () => { invalidPayloads += 1; },
    invalidate,
  );
  subscriptions.subscribe(() => undefined);

  return {
    subscribe(callback) {
      if (disposed) throw adapterDisposedError();
      assertRendererCallback(callback);
      return subscriptions.subscribe(() => callback());
    },
    ready: () => subscriptions.ready(),
    snapshot() {
      const snapshot = subscriptions.snapshot();
      return {
        ...snapshot,
        subscribers: snapshot.subscribers === 0 ? 0 : 1,
        callbacks: Math.max(0, snapshot.subscribers - 1),
        invalidPayloads,
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      subscriptions.dispose();
    },
  };
}

export function createRendererCommandInvalidationEventApi(
  aliases: RendererCommandInvalidationEvents,
  disabledCommands: RendererCommandInvalidationEvents,
  ensureActive: () => void,
): RendererCommandInvalidationEventApi {
  return {
    onCommandAliasesChanged(callback) {
      ensureActive();
      return aliases.subscribe(callback);
    },
    onDisabledCommandsChanged(callback) {
      ensureActive();
      return disabledCommands.subscribe(callback);
    },
  };
}

export function createRendererCommandChangeEvents(
  transport: Pick<ZToolsRendererTransport, "listen">,
  invalidateAliases: () => void,
  invalidateDisabledCommands: () => void,
  ensureActive: () => void,
): RendererCommandChangeEvents {
  const aliases = createRendererCommandInvalidationEvents(
    transport,
    RENDERER_COMMAND_ALIASES_EVENT,
    invalidateAliases,
  );
  const disabledCommands = createRendererCommandInvalidationEvents(
    transport,
    RENDERER_DISABLED_COMMANDS_EVENT,
    invalidateDisabledCommands,
  );
  return {
    aliases,
    disabledCommands,
    api: createRendererCommandInvalidationEventApi(aliases, disabledCommands, ensureActive),
    dispose() {
      aliases.dispose();
      disabledCommands.dispose();
    },
  };
}

