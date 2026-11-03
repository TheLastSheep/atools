import {
  adapterDisposedError,
  assertRendererCallback,
  HOST_ERROR_MESSAGES,
  invalidRendererArgument,
} from "./errors";
import { createRendererCallbackRegistry, type RendererCallback } from "./callbackRegistry";
import { exactEventRecord, safeEventRecord } from "./safeEventRecord";
import {
  parseRendererSettingsInputEvent,
  RENDERER_SETTINGS_INPUT_CALLBACKS,
  type RendererSettingsInputCallbackName,
  type RendererSettingsInputEvent,
} from "./settingsInputProtocol";
import type { RendererHostCommand, RendererHostUnlisten } from "./types";
import { utf8ByteLength } from "./utf8";

export { RENDERER_SETTINGS_INPUT_CALLBACKS } from "./settingsInputProtocol";
export type { RendererSettingsInputCallbackName, RendererSettingsInputEvent } from "./settingsInputProtocol";

export interface RendererSettingsInputCallbacks {
  onUpdateSubInputVisible: (visible: boolean) => unknown;
  onUpdateSubInputPlaceholder: (payload: { placeholder: string }) => unknown;
  onSetSubInputValue: (value: string) => unknown;
  onFocusSubInput: () => unknown;
  onSelectSubInput: () => unknown;
}

export type RendererSettingsInputSnapshot = {
  callbacks: number;
  invalidPayloads: number;
  stalePayloads: number;
  callbackErrors: number;
  notifyFailures: number;
  staleReplies: number;
  notifyPending: boolean;
  notifyInFlight: boolean;
  disposed: boolean;
};

type Lifecycle = {
  sessionId?: string;
  active: boolean;
  opened: boolean;
  opening: boolean;
  closing: boolean;
  disposed: boolean;
  retired(sessionId: string): boolean;
};

type InputRequest = {
  sessionId: string;
  bundleRevision: string;
  generation: number;
  valueVersion: number;
  sequence: number;
  text: string;
};

const MAX_CALLBACKS = 64;
const MAX_INPUT_REQUEST_BYTES = 32 * 1024;

/** Settings input shares the settings-view listener and owns only its legacy callbacks and bounded text queue. */
export function createRendererSettingsInput(options: {
  invoke(command: RendererHostCommand, args?: Record<string, unknown>): Promise<unknown>;
  lifecycle(): Lifecycle;
}): {
  subscribe<K extends RendererSettingsInputCallbackName>(name: K, callback: RendererSettingsInputCallbacks[K]): RendererHostUnlisten;
  receive(payload: unknown): boolean;
  lifecycleChanged(): void;
  notifySubInputChange(text: string): void;
  callbackCount(): number;
  snapshot(): RendererSettingsInputSnapshot;
  dispose(): void;
} {
  let callbackErrors = 0;
  const callbacks = createRendererCallbackRegistry<RendererSettingsInputCallbackName>(
    RENDERER_SETTINGS_INPUT_CALLBACKS,
    MAX_CALLBACKS,
    () => { callbackErrors += 1; },
  );
  let disposed = false;
  let invalidPayloads = 0;
  let stalePayloads = 0;
  let notifyFailures = 0;
  let staleReplies = 0;
  let currentSession: string | undefined;
  let current: RendererSettingsInputEvent | undefined;
  let pendingPacket: RendererSettingsInputEvent | undefined;
  let pendingInput: InputRequest | undefined;
  let inFlight: InputRequest | undefined;
  let scheduled = false;
  let sequence = 0;

  function isLive(event: RendererSettingsInputEvent): boolean {
    const state = options.lifecycle();
    return !disposed && !state.disposed && state.active && state.opened && !state.closing &&
      !state.retired(event.sessionId) && state.sessionId === event.sessionId;
  }

  function newer(event: RendererSettingsInputEvent, previous?: RendererSettingsInputEvent): boolean {
    return !previous || (event.revision > previous.revision && event.generation >= previous.generation &&
      (event.generation > previous.generation || event.valueVersion >= previous.valueVersion));
  }

  function currentFor(event: RendererSettingsInputEvent): boolean {
    return isLive(event) && current?.sessionId === event.sessionId && current.generation === event.generation && current.revision === event.revision;
  }

  function emit<K extends RendererSettingsInputCallbackName>(name: K, ...args: Parameters<RendererSettingsInputCallbacks[K]>): void {
    callbacks.emit(name, args as unknown[]);
  }

  function deferFocus(event: RendererSettingsInputEvent, select: boolean): void {
    queueMicrotask(() => {
      if (!currentFor(event)) return;
      emit("onFocusSubInput");
      if (select && currentFor(event)) emit("onSelectSubInput");
    });
  }

  function deliver(event: RendererSettingsInputEvent, replay: boolean): void {
    if (!currentFor(event)) return;
    const fullState = replay || event.action === "set";
    if (fullState) {
      emit("onUpdateSubInputVisible", event.visible);
      if (!currentFor(event)) return;
      if (event.visible) {
        emit("onUpdateSubInputPlaceholder", { placeholder: event.placeholder });
        if (!currentFor(event)) return;
        emit("onSetSubInputValue", event.value);
      }
    } else if (event.action === "remove") {
      emit("onUpdateSubInputVisible", false);
      return;
    } else if (event.action === "value") {
      emit("onSetSubInputValue", event.value);
    }
    if (!currentFor(event)) return;
    const focus = event.action === "value" || event.action === "focus" || event.action === "select" ||
      (event.action === "set" && event.focus) || (replay && event.focus);
    if (focus) deferFocus(event, event.action === "select");
  }

  function accept(event: RendererSettingsInputEvent, state: Lifecycle): void {
    if (state.retired(event.sessionId) || state.closing) {
      stalePayloads += 1;
      return;
    }
    if (state.active && state.sessionId !== event.sessionId) {
      stalePayloads += 1;
      return;
    }
    const matches = state.active && state.sessionId === event.sessionId;
    const previous = matches ? current : pendingPacket?.sessionId === event.sessionId ? pendingPacket : undefined;
    if (!newer(event, previous)) {
      stalePayloads += 1;
      return;
    }
    if (!matches && !state.opening) {
      stalePayloads += 1;
      return;
    }
    current = matches ? event : current;
    pendingPacket = state.opened && matches ? undefined : event;
    if (pendingInput && (pendingInput.sessionId !== event.sessionId || pendingInput.generation !== event.generation || pendingInput.valueVersion !== event.valueVersion)) {
      pendingInput = undefined;
    }
    if (state.opened && matches) deliver(event, false);
  }

  function receive(payload: unknown): boolean {
    let record: Record<string, unknown>;
    try { record = safeEventRecord(payload); } catch { return false; }
    if (record.kind !== "subInput") return false;
    try {
      const event = parseRendererSettingsInputEvent(record);
      accept(event, options.lifecycle());
    } catch {
      invalidPayloads += 1;
    }
    return true;
  }

  function lifecycleChanged(): void {
    const state = options.lifecycle();
    if (state.sessionId !== currentSession) {
      const matchingPending = pendingPacket?.sessionId === state.sessionId ? pendingPacket : undefined;
      currentSession = state.sessionId;
      current = matchingPending;
      pendingPacket = matchingPending;
      pendingInput = undefined;
      sequence = 0;
    }
    if (disposed || state.disposed || state.closing || (state.sessionId && state.retired(state.sessionId))) {
      if (pendingPacket?.sessionId === state.sessionId) pendingPacket = undefined;
      pendingInput = undefined;
      return;
    }
    if (!state.opening && !state.active) pendingPacket = undefined;
    if (pendingPacket && state.sessionId && pendingPacket.sessionId !== state.sessionId) pendingPacket = undefined;
    if (pendingPacket && state.opened && pendingPacket.sessionId === state.sessionId) {
      const event = pendingPacket;
      pendingPacket = undefined;
      deliver(event, true);
    }
  }

  function requestIsCurrent(request: InputRequest): boolean {
    const state = options.lifecycle();
    return !disposed && !state.disposed && state.active && state.opened && !state.closing &&
      state.sessionId === request.sessionId && !state.retired(request.sessionId) && current?.visible === true &&
      current.sessionId === request.sessionId && current.bundleRevision === request.bundleRevision &&
      current.generation === request.generation && current.valueVersion === request.valueVersion;
  }

  function schedule(): void {
    if (disposed || scheduled || inFlight || !pendingInput) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (disposed || inFlight || !pendingInput) return;
      const request = pendingInput;
      pendingInput = undefined;
      if (!requestIsCurrent(request)) {
        stalePayloads += 1;
        schedule();
        return;
      }
      inFlight = request;
      void send(request);
    });
  }

  async function send(request: InputRequest): Promise<void> {
    try {
      const { sessionId, bundleRevision, generation, valueVersion, sequence: inputSequence, text } = request;
      const reply = parseInputReply(await options.invoke("notify_renderer_settings_input", {
        request: { sessionId, bundleRevision, generation, valueVersion, sequence: inputSequence, text },
      }));
      if (disposed || inFlight !== request) return;
      if (!reply.applied || reply.generation !== request.generation || reply.valueVersion !== request.valueVersion) {
        notifyFailures += 1;
      } else if (current?.sessionId === request.sessionId && current.generation === request.generation && current.valueVersion === request.valueVersion) {
        if (reply.revision < current.revision) staleReplies += 1;
        else current = { ...current, revision: reply.revision, value: request.text };
      } else staleReplies += 1;
    } catch {
      if (!disposed && inFlight === request) notifyFailures += 1;
    } finally {
      if (inFlight === request) inFlight = undefined;
      if (!disposed) schedule();
    }
  }

  return {
    subscribe(name, callback) {
      if (disposed) throw adapterDisposedError();
      assertRendererCallback(callback);
      if (!callbacks.has(name)) throw invalidRendererArgument(HOST_ERROR_MESSAGES.UNKNOWN_CALLBACK);
      const unsubscribe = callbacks.add(name, callback as RendererCallback);
      if (!unsubscribe) throw invalidRendererArgument(HOST_ERROR_MESSAGES.CALLBACK_LIMIT(name));
      return unsubscribe;
    },
    receive,
    lifecycleChanged,
    notifySubInputChange(text) {
      if (disposed) throw adapterDisposedError();
      if (typeof text !== "string" || utf8ByteLength(text) > 16 * 1024) {
        notifyFailures += 1;
        return;
      }
      const event = current;
      const state = options.lifecycle();
      if (!event || !isLive(event) || !event.visible || sequence >= Number.MAX_SAFE_INTEGER) {
        notifyFailures += 1;
        return;
      }
      const request: InputRequest = {
        sessionId: event.sessionId,
        bundleRevision: event.bundleRevision,
        generation: event.generation,
        valueVersion: event.valueVersion,
        sequence: sequence + 1,
        text,
      };
      let serializedRequest: string | undefined;
      try { serializedRequest = JSON.stringify(request); } catch {}
      if (typeof serializedRequest !== "string" || utf8ByteLength(serializedRequest) > MAX_INPUT_REQUEST_BYTES) {
        notifyFailures += 1;
        return;
      }
      sequence = request.sequence;
      pendingInput = request;
      if (!state.opened) return;
      schedule();
    },
    callbackCount: () => callbacks.count(),
    snapshot: () => ({
      callbacks: callbacks.count(), invalidPayloads, stalePayloads, callbackErrors, notifyFailures, staleReplies,
      notifyPending: pendingInput !== undefined, notifyInFlight: inFlight !== undefined, disposed,
    }),
    dispose() {
      if (disposed) return;
      disposed = true;
      pendingPacket = undefined;
      pendingInput = undefined;
      inFlight = undefined;
      callbacks.clear();
    },
  };
}

function parseInputReply(value: unknown): { version: 1; generation: number; revision: number; valueVersion: number; applied: boolean } {
  const record = exactEventRecord(value, ["version", "generation", "revision", "valueVersion", "applied"]);
  if (
    record.version !== 1 || !Number.isSafeInteger(record.generation) || (record.generation as number) < 1 ||
    !Number.isSafeInteger(record.revision) || (record.revision as number) < 1 ||
    !Number.isSafeInteger(record.valueVersion) || (record.valueVersion as number) < 0 || typeof record.applied !== "boolean"
  ) throw new Error("Invalid settings input reply.");
  return record as unknown as { version: 1; generation: number; revision: number; valueVersion: number; applied: boolean };
}
