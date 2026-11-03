import { adapterDisposedError, assertRendererCallback } from "./errors";
import { dispatchRendererCallbacks } from "./callbackRegistry";
import type { RendererHostUnlisten, ZToolsRendererTransport } from "./types";

export type RendererEventName =
  | "renderer-updater-main-state"
  | "renderer-main-file-drop"
  | "tauri://focus"
  | "atools://renderer-app-state"
  | "atools://renderer-app-launched"
  | "atools://renderer-apps-changed"
  | "atools://renderer-plugins-changed"
  | "atools://renderer-context-menu"
  | "atools://renderer-settings-view"
  | "atools://renderer-general-settings"
  | "atools://renderer-command-aliases"
  | "atools://renderer-disabled-commands"
  | "atools://renderer-local-shortcuts";

export type RendererEventListenerState =
  | "idle"
  | "registering"
  | "listening"
  | "failed"
  | "disposed";

export interface RendererEventSubscriptionsSnapshot {
  subscribers: number;
  listenerState: RendererEventListenerState;
  deliveredEvents: number;
  registrationErrors: number;
  callbackErrors: number;
  registrationsPending: number;
  lateListenerUnlistens: number;
  cleanupPending: number;
  cleanupErrors: number;
}

export interface RendererEventSubscriptions {
  subscribe(callback: (payload: unknown) => unknown): RendererHostUnlisten;
  ready(): Promise<boolean>;
  snapshot(): RendererEventSubscriptionsSnapshot;
  dispose(): void;
}

export function createRendererNullEventSubscriptions(
  transport: Pick<ZToolsRendererTransport, "listen">,
  event: RendererEventName,
  onInvalidPayload: () => void,
  beforeDispatch?: (payload: unknown) => void,
): RendererEventSubscriptions {
  return createRendererEventSubscriptions(
    transport,
    event,
    (payload) => {
      if (payload === null) return true;
      onInvalidPayload();
      return false;
    },
    beforeDispatch,
  );
}

interface Registration {
  active: boolean;
  unlisten: RendererHostUnlisten | undefined;
  ready: Promise<boolean> | undefined;
}

/** Shares one native event listener and drops stale registrations by generation. */
export function createRendererEventSubscriptions(
  transport: Pick<ZToolsRendererTransport, "listen">,
  event: RendererEventName,
  acceptPayload?: (payload: unknown) => boolean,
  beforeDispatch?: (payload: unknown) => void,
): RendererEventSubscriptions {
  const subscribers = new Map<number, (payload: unknown) => unknown>();
  let nextSubscriberId = 0;
  let current: Registration | undefined;
  let disposed = false;
  let listenerState: RendererEventListenerState = "idle";
  let deliveredEvents = 0;
  let registrationErrors = 0;
  let callbackErrors = 0;
  const recordCallbackError = () => {
    callbackErrors += 1;
  };
  let registrationsPending = 0;
  let lateListenerUnlistens = 0;
  let cleanupPending = 0;
  let cleanupErrors = 0;
  let readiness: Promise<boolean> | undefined;

  function safelyUnlisten(unlisten: RendererHostUnlisten): void {
    let result: unknown;
    try {
      result = (unlisten as () => unknown)();
    } catch {
      cleanupErrors += 1;
      return;
    }

    if (result === null || (typeof result !== "object" && typeof result !== "function")) {
      return;
    }

    try {
      if (typeof (result as { then?: unknown }).then !== "function") return;
    } catch {
      cleanupErrors += 1;
      return;
    }

    cleanupPending += 1;
    void Promise.resolve(result).then(
      () => {
        cleanupPending -= 1;
      },
      () => {
        cleanupPending -= 1;
        cleanupErrors += 1;
      },
    );
  }

  function stopCurrentRegistration(): void {
    const registration = current;
    if (!registration) {
      if (!disposed && listenerState !== "failed") listenerState = "idle";
      return;
    }

    current = undefined;
    registration.active = false;
    if (registration.ready === readiness) readiness = undefined;
    registration.ready = undefined;
    const unlisten = registration.unlisten;
    registration.unlisten = undefined;
    if (unlisten) safelyUnlisten(unlisten);

    if (disposed) listenerState = "disposed";
    else if (listenerState !== "failed") listenerState = "idle";
  }

  function recordRegistrationFailure(registration: Registration): void {
    registrationErrors += 1;
    registration.active = false;
    registration.unlisten = undefined;

    if (current !== registration) return;
    current = undefined;
    listenerState = disposed ? "disposed" : "failed";
  }

  function deliver(registration: Registration, payload: unknown): void {
    if (
      disposed ||
      !registration.active ||
      current !== registration ||
      subscribers.size === 0
    ) {
      return;
    }

    if (acceptPayload) {
      try {
        if (!acceptPayload(payload)) return;
      } catch {
        return;
      }
    }
    deliveredEvents += 1;
    if (beforeDispatch) {
      try {
        beforeDispatch(payload);
      } catch {
        callbackErrors += 1;
        return;
      }
    }
    dispatchRendererCallbacks(subscribers, [payload], recordCallbackError);
  }

  function trackReadiness(registration: Registration, result: Promise<boolean>): Promise<boolean> {
    let tracked!: Promise<boolean>;
    tracked = result.finally(() => {
      if (readiness === tracked) readiness = undefined;
      if (registration.ready === tracked) registration.ready = undefined;
    });
    registration.ready = tracked;
    readiness = tracked;
    return tracked;
  }

  function startRegistration(): Promise<boolean> {
    if (disposed || subscribers.size === 0) return Promise.resolve(false);
    if (current?.active) return current.ready ?? Promise.resolve(listenerState === "listening");
    const registration: Registration = {
      active: true,
      unlisten: undefined,
      ready: undefined,
    };
    current = registration;
    listenerState = "registering";

    let pending: Promise<RendererHostUnlisten>;
    registrationsPending += 1;
    try {
      pending = Promise.resolve(transport.listen(event, (payload) => deliver(registration, payload)));
    } catch {
      registrationsPending -= 1;
      recordRegistrationFailure(registration);
      return trackReadiness(registration, Promise.resolve(false));
    }

    return trackReadiness(registration, pending.then(
      (unlisten) => {
        registrationsPending -= 1;
        if (typeof unlisten !== "function") {
          recordRegistrationFailure(registration);
          return false;
        }

        if (
          disposed ||
          !registration.active ||
          current !== registration ||
          subscribers.size === 0
        ) {
          registration.active = false;
          lateListenerUnlistens += 1;
          safelyUnlisten(unlisten);
          return false;
        }

        registration.unlisten = unlisten;
        listenerState = "listening";
        return true;
      },
      () => {
        registrationsPending -= 1;
        recordRegistrationFailure(registration);
        return false;
      },
    ));
  }

  return {
    subscribe(callback) {
      if (disposed) {
        throw adapterDisposedError();
      }
      assertRendererCallback(callback);

      const id = ++nextSubscriberId;
      subscribers.set(id, callback);
      if (!current && !readiness) void startRegistration();

      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(id);
        if (subscribers.size === 0) stopCurrentRegistration();
      };
    },

    ready() {
      if (disposed || subscribers.size === 0) return Promise.resolve(false);
      if (current?.active && listenerState === "listening") return Promise.resolve(true);
      return readiness ?? startRegistration();
    },

    snapshot() {
      return {
        subscribers: subscribers.size,
        listenerState,
        deliveredEvents,
        registrationErrors,
        callbackErrors,
        registrationsPending,
        lateListenerUnlistens,
        cleanupPending,
        cleanupErrors,
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      subscribers.clear();
      stopCurrentRegistration();
      listenerState = "disposed";
    },
  };
}
