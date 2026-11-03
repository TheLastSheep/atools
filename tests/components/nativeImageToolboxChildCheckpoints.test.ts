import { afterEach, expect, it, vi } from "vitest";
import { listenForNativeImageToolboxChildCheckpoints } from "./nativeImageToolboxChildCheckpoints";

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

type Listener = (event: Event) => void;
function messageTarget() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    addEventListener(_type: string, listener: EventListenerOrEventListenerObject | null) {
      if (typeof listener === "function") listeners.add(listener as Listener);
    },
    removeEventListener(_type: string, listener: EventListenerOrEventListenerObject | null) {
      if (typeof listener === "function") listeners.delete(listener as Listener);
    },
    emit(event: Partial<MessageEvent>) {
      for (const listener of [...listeners]) listener(event as MessageEvent as Event);
    },
  };
}
function post(target: ReturnType<typeof messageTarget>, source: MessageEventSource, data: unknown, origin = "null") {
  target.emit({ source, data, origin });
}

it("accepts ordered opaque-frame checkpoints and preserves unknown, false, then true", () => {
  const events = messageTarget();
  const frame = {} as MessageEventSource;
  const received = vi.fn();
  const exhausted = vi.fn();
  dispose = listenForNativeImageToolboxChildCheckpoints(events, () => frame, received, exhausted);
  post(events, frame, { kind: "atools-image-toolbox-child-checkpoint", code: "child-observer-started", observed: true });
  post(events, frame, { kind: "atools-image-toolbox-child-checkpoint", code: "child-domcontentloaded", observed: true });
  post(events, frame, { kind: "atools-image-toolbox-child-checkpoint", code: "child-enter-received", observed: true });
  post(events, frame, { kind: "atools-image-toolbox-child-checkpoint", code: "child-app-instance-present", observed: false });
  post(events, frame, { kind: "atools-image-toolbox-child-checkpoint", code: "child-app-instance-present", observed: true });
  expect(received.mock.calls.map(([value]) => [value.code, value.observed])).toEqual([
    ["child-observer-started", true], ["child-domcontentloaded", true],
    ["child-enter-received", true], ["child-app-instance-present", false],
    ["child-app-instance-present", true],
  ]);
  expect(exhausted).not.toHaveBeenCalled();
});

it("allows enter and DCL in either order and retries checkpoints rejected before prerequisites", () => {
  const events = messageTarget();
  const frame = {} as MessageEventSource;
  const received = vi.fn();
  dispose = listenForNativeImageToolboxChildCheckpoints(events, () => frame, received, vi.fn());
  const send = (code: string, observed = true) => post(events, frame, {
    kind: "atools-image-toolbox-child-checkpoint", code, observed,
  });

  send("child-enter-received");
  send("child-app-instance-present", false);
  send("child-observer-started");
  send("child-app-instance-present", true);
  send("child-enter-received");
  send("child-app-instance-present", false);
  send("child-domcontentloaded");
  send("child-app-instance-present", true);
  expect(received.mock.calls.map(([value]) => [value.code, value.observed])).toEqual([
    ["child-observer-started", true],
    ["child-enter-received", true],
    ["child-app-instance-present", false],
    ["child-domcontentloaded", true],
    ["child-app-instance-present", true],
  ]);
});


it("accepts fixed head CSP checkpoints before body observer and keeps them diagnostic-only", () => {
  const events = messageTarget();
  const frame = {} as MessageEventSource;
  const received = vi.fn();
  dispose = listenForNativeImageToolboxChildCheckpoints(events, () => frame, received, vi.fn());
  const send = (code: string, observed = true) => post(events, frame, {
    kind: "atools-image-toolbox-child-checkpoint", code, observed,
  });
  send("child-csp-observer-installed");
  send("child-module-lease-script-csp-blocked");
  send("child-observer-started");
  send("child-enter-received");
  expect(received.mock.calls.map(([value]) => [value.code, value.observed])).toEqual([
    ["child-csp-observer-installed", true],
    ["child-module-lease-script-csp-blocked", true],
    ["child-observer-started", true],
    ["child-enter-received", true],
  ]);
});

it("does not poison CSP checkpoint order when a block arrives before observer installation", () => {
  const events = messageTarget();
  const frame = {} as MessageEventSource;
  const received = vi.fn();
  dispose = listenForNativeImageToolboxChildCheckpoints(events, () => frame, received, vi.fn());
  const send = (code: string, observed = true) => post(events, frame, {
    kind: "atools-image-toolbox-child-checkpoint", code, observed,
  });
  send("child-module-lease-script-csp-blocked");
  send("child-csp-observer-installed", false);
  send("child-csp-observer-installed");
  send("child-module-lease-script-csp-blocked");
  expect(received.mock.calls.map(([value]) => [value.code, value.observed])).toEqual([
    ["child-csp-observer-installed", true],
    ["child-module-lease-script-csp-blocked", true],
  ]);
});

it("rejects wrong source, non-opaque origin, unknown kind and malformed messages", () => {
  const events = messageTarget();
  const frame = {} as MessageEventSource;
  const other = {} as MessageEventSource;
  const received = vi.fn();
  dispose = listenForNativeImageToolboxChildCheckpoints(events, () => frame, received, vi.fn());
  const data = { kind: "atools-image-toolbox-child-checkpoint", code: "child-observer-started", observed: true };
  post(events, other, data);
  post(events, frame, data, "https://example.invalid");
  post(events, frame, { ...data, kind: "other" });
  post(events, frame, { ...data, observed: "true" });
  post(events, frame, { ...data, payload: "must-not-be-carried" });
  post(events, frame, { ...data, code: "unknown-child-event" });
  expect(received).not.toHaveBeenCalled();
});

it("deduplicates checkpoints and detaches after the fixed matching-message budget", () => {
  const events = messageTarget();
  const frame = {} as MessageEventSource;
  const received = vi.fn();
  const exhausted = vi.fn();
  dispose = listenForNativeImageToolboxChildCheckpoints(events, () => frame, received, exhausted);
  const started = { kind: "atools-image-toolbox-child-checkpoint", code: "child-observer-started", observed: true };
  post(events, frame, started);
  post(events, frame, started);
  for (let i = 0; i < 20; i++) post(events, frame, { kind: "atools-image-toolbox-child-checkpoint", code: `unknown-${i}`, observed: true });
  expect(received).toHaveBeenCalledTimes(1);
  expect(exhausted).toHaveBeenCalledTimes(1);
  post(events, frame, started);
  expect(received).toHaveBeenCalledTimes(1);
});

it("ignores late messages after dispose", () => {
  const events = messageTarget();
  const frame = {} as MessageEventSource;
  const received = vi.fn();
  dispose = listenForNativeImageToolboxChildCheckpoints(events, () => frame, received, vi.fn());
  dispose();
  post(events, frame, { kind: "atools-image-toolbox-child-checkpoint", code: "child-observer-started", observed: true });
  expect(received).not.toHaveBeenCalled();
});
