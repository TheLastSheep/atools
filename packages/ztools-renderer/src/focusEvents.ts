import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";
import {
  createRendererEventSubscriptions,
  type RendererEventListenerState,
  type RendererEventSubscriptionsSnapshot,
} from "./eventSubscriptions";

export type RendererFocusListenerState = RendererEventListenerState;

export interface RendererFocusEventsSnapshot extends RendererEventSubscriptionsSnapshot {
  windowContextAvailable: false;
}

export interface RendererFocusEvents {
  subscribe(callback: () => unknown): RendererHostUnlisten;
  snapshot(): RendererFocusEventsSnapshot;
  dispose(): void;
}

/** Applies focus policy while the shared event module owns native listener lifecycle. */
export function createRendererFocusEvents(
  transport: Pick<ZToolsRendererTransport, "listen">,
): RendererFocusEvents {
  const subscriptions = createRendererEventSubscriptions(transport, "tauri://focus");

  return {
    subscribe(callback) {
      const focusCallback =
        typeof callback === "function"
          ? () => callback()
          : (callback as unknown as (payload: unknown) => unknown);
      return subscriptions.subscribe(focusCallback);
    },

    snapshot() {
      return {
        ...subscriptions.snapshot(),
        windowContextAvailable: false,
      };
    },

    dispose() {
      subscriptions.dispose();
    },
  };
}
